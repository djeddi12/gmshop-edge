import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { readImageDimensions } from "#/features/catalog/server/image-dimensions";
import { readBoundedResponseBytes } from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getAdminRuntimeServerContext } from "#/server/context";
import { markupMinor } from "../money";
import {
	supplierBindingSwitchSchema,
	supplierImportSchema,
	supplierProductListSchema,
} from "../schema";
import { assertPublicSupplierHostname } from "./destination-security";
import { readCachedSupplierCatalog } from "./source-sync";
import { normalizeSupplierSource } from "./source-url";

type BindingRow = {
	id: string;
	upstream_product_id: string;
	upstream_sku_id: string;
	upstream_product_name: string;
	upstream_sku_name: string;
	reference_cost_minor: string;
	max_cost_minor: string;
	stock_quantity: number;
	remote_status: string;
	last_synced_at: number | null;
	last_error_code: string | null;
	enabled: number;
	sellable_item_id: string;
	sellable_item_name: string;
	price_minor: string;
	import_cost_minor: string | null;
	supplier_status: string | null;
	local_product_id: string;
	local_product_name: string;
	local_product_status: string;
};

type SupplierProductAdminRow = {
	key: string;
	productId: string;
	productName: string;
	skuId: string;
	skuName: string;
	costMinor: string;
	stockQuantity: number;
	remoteStatus: string;
	imported: boolean;
	bindingId: string | null;
	maxCostMinor: string;
	localProductId: string | null;
	localProductName: string | null;
	localProductStatus: string | null;
	sellableItemId: string | null;
	sellableItemName: string | null;
	priceMinor: string | null;
	importCostMinor: string | null;
	supplierStatus: string | null;
	availableAccountCount: number;
	lastSyncedAt: number | null;
	lastErrorCode: string | null;
	currency: string;
	currencyDecimals: number;
};

export const listSupplierSourcesFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "read"),
		);
		const rows = await db
			.prepare(
				`SELECT provider, normalized_api_origin, protocol_version,
				        MIN(base_url) AS base_url, COUNT(*) AS account_count,
				        SUM(CASE WHEN enabled = 1 AND health_status <> 'unavailable'
				                 AND (cooldown_until IS NULL OR cooldown_until <= ?)
				                 THEN 1 ELSE 0 END) AS available_account_count,
				        MAX(updated_at) AS updated_at
				 FROM supplier_accounts
				 GROUP BY provider, normalized_api_origin, protocol_version
				 ORDER BY provider, normalized_api_origin`,
			)
			.bind(Date.now())
			.all<{
				provider: "acg" | "dujiao_next" | "gmshop_edge" | "kinguin_ecommerce";
				normalized_api_origin: string;
				protocol_version: string;
				base_url: string;
				account_count: number;
				available_account_count: number;
				updated_at: number;
			}>();
		return rows.results.map((row) => ({
			provider: row.provider,
			baseUrl: row.base_url,
			normalizedApiOrigin: row.normalized_api_origin,
			protocolVersion: row.protocol_version,
			accountCount: Number(row.account_count),
			availableAccountCount: Number(row.available_account_count),
			updatedAt: row.updated_at,
		}));
	},
);

export const listSupplierProductsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof supplierProductListSchema>) =>
		supplierProductListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "read"),
		);
		const normalized = normalizeSupplierSource(data.provider, data.baseUrl);
		const source = {
			provider: normalized.provider,
			normalizedApiOrigin: normalized.normalizedApiOrigin,
			protocolVersion: normalized.protocolVersion,
		};
		const [catalog, bindingResult, accountCount] = await Promise.all([
			readCachedSupplierCatalog(context.env.CACHE, source),
			context.db
				.prepare(
					`SELECT sb.*, psi.name AS sellable_item_name, psi.price_minor,
					        psi.cost_minor AS import_cost_minor,
					        psi.supplier_status, p.id AS local_product_id,
					        p.name AS local_product_name, p.status AS local_product_status
					 FROM supplier_bindings sb
					 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
					 JOIN products p ON p.id = psi.product_id
					 WHERE sb.provider = ? AND sb.normalized_api_origin = ?
					  AND sb.protocol_version = ?
					 ORDER BY sb.upstream_product_name, sb.upstream_sku_name, sb.id`,
				)
				.bind(
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
				)
				.all<BindingRow>(),
			context.db
				.prepare(
					`SELECT MIN(currency) AS currency,
					        MIN(currency_decimals) AS currency_decimals,
					        SUM(CASE WHEN enabled = 1
					                  AND health_status <> 'unavailable'
					                  AND (cooldown_until IS NULL OR cooldown_until <= ?)
					                 THEN 1 ELSE 0 END) AS total
					 FROM supplier_accounts
					 WHERE provider = ? AND normalized_api_origin = ?
					  AND protocol_version = ?`,
				)
				.bind(
					Date.now(),
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
				)
				.first<{
					total: number;
					currency: string | null;
					currency_decimals: number | null;
				}>(),
		]);
		const availableAccountCount = Number(accountCount?.total ?? 0);
		const currency = accountCount?.currency ?? "CNY";
		const currencyDecimals = Number(accountCount?.currency_decimals ?? 2);
		const bindings = new Map(
			bindingResult.results.map((row) => [
				`${row.upstream_product_id}\0${row.upstream_sku_id}`,
				row,
			]),
		);
		const rows: SupplierProductAdminRow[] = [];
		for (const product of catalog?.products ?? []) {
			for (const sku of product.skus) {
				const key = `${product.id}\0${sku.id}`;
				const binding = bindings.get(key);
				bindings.delete(key);
				rows.push(
					presentSku({
						product,
						sku,
						binding,
						availableAccountCount,
						currency,
						currencyDecimals,
					}),
				);
			}
		}
		for (const binding of bindings.values())
			rows.push(
				presentMissingBinding(
					binding,
					availableAccountCount,
					currency,
					currencyDecimals,
				),
			);
		const search = data.search.toLocaleLowerCase();
		return {
			syncedAt: catalog?.syncedAt ?? null,
			cacheAvailable: Boolean(catalog),
			data: search
				? rows.filter((row) =>
						[
							row.productName,
							row.skuName,
							row.localProductName,
							row.sellableItemName,
						].some((value) =>
							String(value ?? "")
								.toLocaleLowerCase()
								.includes(search),
						),
					)
				: rows,
		};
	});

export const importSupplierProductsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierImportSchema>) =>
		supplierImportSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "create"),
		);
		const normalized = normalizeSupplierSource(data.provider, data.baseUrl);
		const source = {
			provider: normalized.provider,
			normalizedApiOrigin: normalized.normalizedApiOrigin,
			protocolVersion: normalized.protocolVersion,
		};
		const catalog = await readCachedSupplierCatalog(context.env.CACHE, source);
		if (!catalog)
			throw new DomainError(
				"supplier_catalog_cache_missing",
				409,
				"Synchronize the supplier catalog before importing products",
			);
		const account = await context.db
			.prepare(
				`SELECT currency, currency_decimals FROM supplier_accounts
				 WHERE provider = ? AND normalized_api_origin = ?
				  AND protocol_version = ? ORDER BY enabled DESC, id LIMIT 1`,
			)
			.bind(source.provider, source.normalizedApiOrigin, source.protocolVersion)
			.first<{ currency: string; currency_decimals: number }>();
		if (!account)
			throw new DomainError(
				"supplier_source_has_no_account",
				409,
				"Supplier source has no account",
			);
		if (data.publish) {
			const eligible = await context.db
				.prepare(
					`SELECT 1 FROM supplier_accounts
					 WHERE provider = ? AND normalized_api_origin = ?
					  AND protocol_version = ? AND enabled = 1
					  AND health_status <> 'unavailable'
					  AND (cooldown_until IS NULL OR cooldown_until <= ?)
					  AND balance_minor IS NOT NULL LIMIT 1`,
				)
				.bind(
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
					Date.now(),
				)
				.first();
			if (!eligible)
				throw new DomainError(
					"supplier_publish_blocked",
					409,
					"A usable supplier account is required before publishing",
				);
		}
		const selected = new Set(
			data.items.map((item) => `${item.productId}\0${item.skuId}`),
		);
		const statements: D1PreparedStatement[] = [];
		const imported: string[] = [];
		const productIds = new Map<string, string>();
		const uploadedObjectKeys: string[] = [];
		const now = Date.now();
		for (const product of catalog.products) {
			const wanted = product.skus.filter((sku) =>
				selected.has(`${product.id}\0${sku.id}`),
			);
			if (!wanted.length) continue;
			if (
				data.publish &&
				(!product.active ||
					wanted.some((sku) => !sku.active || sku.stockQuantity < 1))
			)
				throw new DomainError(
					"supplier_publish_blocked",
					409,
					"Only active supplier SKUs with stock can be published directly",
				);
			const existingProduct = await context.db
				.prepare(
					`SELECT psi.product_id FROM supplier_bindings sb
					 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
					 WHERE sb.provider = ? AND sb.normalized_api_origin = ?
					  AND sb.protocol_version = ? AND sb.upstream_product_id = ?
					 ORDER BY sb.enabled DESC, sb.created_at, sb.id LIMIT 1`,
				)
				.bind(
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
					product.id,
				)
				.first<{ product_id: string }>();
			const localProductId =
				existingProduct?.product_id ??
				productIds.get(product.id) ??
				crypto.randomUUID();
			productIds.set(product.id, localProductId);
			if (!existingProduct) {
				const tagNames = uniqueCategoryNames(product.categoryNames);
				const cover = await importProductCover(
					context.env.FILES,
					localProductId,
					product.imageUrls[0],
				);
				if (cover) uploadedObjectKeys.push(cover.objectKey);
				statements.push(
					context.db
						.prepare(
							`INSERT INTO products
							 (id, name, description, tag_names, product_type, status,
							  cover_object_key, created_at, updated_at)
							 VALUES (?, ?, ?, ?, 'stock', ?, ?, ?, ?)`,
						)
						.bind(
							localProductId,
							product.name,
							product.description,
							JSON.stringify(tagNames),
							data.publish ? "active" : "draft",
							cover?.objectKey ?? null,
							now,
							now,
						),
				);
				if (cover)
					statements.push(
						context.db
							.prepare(
								`INSERT INTO product_media
								 (id, product_id, object_key, alt_text, content_type,
								  size_bytes, sort_order, created_at, updated_at)
								 VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?)`,
							)
							.bind(
								cover.id,
								localProductId,
								cover.objectKey,
								product.name,
								cover.contentType,
								cover.sizeBytes,
								now,
								now,
							),
					);
			}
			for (const sku of wanted) {
				const exists = await context.db
					.prepare(
						`SELECT id FROM supplier_bindings WHERE provider = ?
						 AND normalized_api_origin = ? AND protocol_version = ?
						 AND upstream_product_id = ? AND upstream_sku_id = ?
						 AND enabled = 1 LIMIT 1`,
					)
					.bind(
						source.provider,
						source.normalizedApiOrigin,
						source.protocolVersion,
						product.id,
						sku.id,
					)
					.first();
				if (exists) continue;
				const sellableItemId = crypto.randomUUID();
				const bindingId = crypto.randomUUID();
				const priceMinor = markupMinor(
					sku.costMinor,
					data.fixedMarkupMinor,
					data.markupBps,
				);
				statements.push(
					context.db
						.prepare(
							`INSERT INTO product_sellable_items
							 (id, product_id, name, fulfillment_source, supplier_status,
							  currency, currency_decimals, price_minor, cost_minor,
							  minimum_quantity, maximum_quantity, enabled,
							  created_at, updated_at)
							 VALUES (?, ?, ?, 'supplier', ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
						)
						.bind(
							sellableItemId,
							localProductId,
							`${sku.name} · ${sku.id}`,
							product.active && sku.active ? "available" : "unavailable",
							account.currency,
							account.currency_decimals,
							priceMinor,
							sku.costMinor,
							now,
							now,
						),
					context.db
						.prepare(
							`INSERT INTO supplier_bindings
							 (id, sellable_item_id, provider, normalized_api_origin,
							  protocol_version, upstream_product_id, upstream_sku_id,
							  upstream_product_name, upstream_sku_name,
							  reference_cost_minor, max_cost_minor, stock_quantity,
							  remote_status, last_synced_at, enabled, created_at, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
						)
						.bind(
							bindingId,
							sellableItemId,
							source.provider,
							source.normalizedApiOrigin,
							source.protocolVersion,
							product.id,
							sku.id,
							product.name,
							sku.name,
							sku.costMinor,
							sku.costMinor,
							sku.stockQuantity,
							product.active && sku.active ? "active" : "inactive",
							catalog.syncedAt,
							now,
							now,
						),
				);
				imported.push(bindingId);
			}
		}
		if (!imported.length)
			throw new DomainError(
				"supplier_products_already_imported",
				409,
				"Selected supplier products are already imported",
			);
		statements.push(
			createAuditStatement(
				context.db,
				context.request,
				context.currentUser.id,
				{
					action: "supplier_products.imported",
					targetType: "supplier_source",
					targetId: source.normalizedApiOrigin,
					after: {
						provider: source.provider,
						protocolVersion: source.protocolVersion,
						importedCount: imported.length,
						published: data.publish,
					},
				},
			),
		);
		try {
			await context.db.batch(statements);
		} catch (error) {
			await Promise.all(
				uploadedObjectKeys.map((key) =>
					context.env.FILES?.delete(key).catch(() => undefined),
				),
			);
			throw error;
		}
		return { imported: imported.length };
	});

export const listSupplierBindingTargetsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminRuntimeServerContext(
		systemPermission("suppliers", "read"),
	);
	const rows = await db
		.prepare(
			`SELECT psi.id, psi.name AS sellable_item_name,
			        p.name AS product_name, psi.currency, psi.currency_decimals,
			        sb.provider, sb.normalized_api_origin,
			        sb.upstream_product_name, sb.upstream_sku_name
			 FROM supplier_bindings sb
			 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
			 JOIN products p ON p.id = psi.product_id
			 WHERE sb.enabled = 1 AND psi.fulfillment_source = 'supplier'
			 ORDER BY p.name, psi.name, psi.id LIMIT 1000`,
		)
		.all<{
			id: string;
			sellable_item_name: string;
			product_name: string;
			currency: string;
			currency_decimals: number;
			provider: string;
			normalized_api_origin: string;
			upstream_product_name: string;
			upstream_sku_name: string;
		}>();
	return rows.results;
});

export const switchSupplierBindingFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierBindingSwitchSchema>) =>
		supplierBindingSwitchSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "update"),
		);
		const normalized = normalizeSupplierSource(data.provider, data.baseUrl);
		const source = {
			provider: normalized.provider,
			normalizedApiOrigin: normalized.normalizedApiOrigin,
			protocolVersion: normalized.protocolVersion,
		};
		const [catalog, target, account] = await Promise.all([
			readCachedSupplierCatalog(context.env.CACHE, source),
			context.db
				.prepare(
					`SELECT psi.id, psi.currency, psi.currency_decimals,
					        sb.id AS binding_id, sb.provider,
					        sb.normalized_api_origin, sb.protocol_version
					 FROM product_sellable_items psi
					 JOIN products p ON p.id = psi.product_id
					 JOIN supplier_bindings sb ON sb.sellable_item_id = psi.id
					  AND sb.enabled = 1
					 WHERE psi.id = ? AND psi.fulfillment_source = 'supplier'
					  AND p.product_type = 'stock' LIMIT 1`,
				)
				.bind(data.sellableItemId)
				.first<{
					id: string;
					currency: string;
					currency_decimals: number;
					binding_id: string;
					provider: string;
					normalized_api_origin: string;
					protocol_version: string;
				}>(),
			context.db
				.prepare(
					`SELECT currency, currency_decimals FROM supplier_accounts
					 WHERE provider = ? AND normalized_api_origin = ?
					  AND protocol_version = ? AND enabled = 1
					 ORDER BY id LIMIT 1`,
				)
				.bind(
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
				)
				.first<{ currency: string; currency_decimals: number }>(),
		]);
		if (!catalog)
			throw new DomainError(
				"supplier_catalog_cache_missing",
				409,
				"Synchronize the supplier catalog before switching source",
			);
		if (!target || !account)
			throw new DomainError(
				"supplier_binding_target_unavailable",
				409,
				"Supplier binding target is unavailable",
			);
		if (
			target.currency !== account.currency ||
			target.currency_decimals !== account.currency_decimals
		)
			throw new DomainError(
				"supplier_currency_mismatch",
				409,
				"The new source currency does not match the local sellable item",
			);
		const product = catalog.products.find((item) => item.id === data.productId);
		const sku = product?.skus.find((item) => item.id === data.skuId);
		if (!product || !sku)
			throw new DomainError(
				"supplier_sku_not_found",
				404,
				"Supplier SKU was not found in the synchronized catalog",
			);
		const duplicate = await context.db
			.prepare(
				`SELECT 1 FROM supplier_bindings WHERE provider = ?
				 AND normalized_api_origin = ? AND protocol_version = ?
				 AND upstream_product_id = ? AND upstream_sku_id = ?
				 AND enabled = 1 LIMIT 1`,
			)
			.bind(
				source.provider,
				source.normalizedApiOrigin,
				source.protocolVersion,
				product.id,
				sku.id,
			)
			.first();
		if (duplicate)
			throw new DomainError(
				"supplier_binding_duplicate",
				409,
				"Supplier SKU is already bound",
			);
		const now = Date.now();
		const bindingId = crypto.randomUUID();
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE supplier_bindings SET enabled = 0, updated_at = ?
					 WHERE id = ? AND enabled = 1`,
				)
				.bind(now, target.binding_id),
			context.db
				.prepare(
					`INSERT INTO supplier_bindings
					 (id, sellable_item_id, provider, normalized_api_origin,
					  protocol_version, upstream_product_id, upstream_sku_id,
					  upstream_product_name, upstream_sku_name, reference_cost_minor,
					  max_cost_minor, stock_quantity, remote_status, last_synced_at,
					  enabled, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				)
				.bind(
					bindingId,
					target.id,
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
					product.id,
					sku.id,
					product.name,
					sku.name,
					sku.costMinor,
					sku.costMinor,
					sku.stockQuantity,
					product.active && sku.active ? "active" : "inactive",
					catalog.syncedAt,
					now,
					now,
				),
			context.db
				.prepare(
					`UPDATE product_sellable_items SET supplier_status = ?,
					 cost_minor = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(
					product.active && sku.active ? "available" : "unavailable",
					sku.costMinor,
					now,
					target.id,
				),
			createAuditStatement(
				context.db,
				context.request,
				context.currentUser.id,
				{
					action: "supplier_binding.switched",
					targetType: "supplier_binding",
					targetId: bindingId,
					before: {
						bindingId: target.binding_id,
						provider: target.provider,
						normalizedApiOrigin: target.normalized_api_origin,
						protocolVersion: target.protocol_version,
					},
					after: { ...source, productId: product.id, skuId: sku.id },
				},
			),
		]);
		return { id: bindingId };
	});

async function importProductCover(
	bucket: R2Bucket | undefined,
	productId: string,
	rawUrl: string | undefined,
) {
	if (!bucket || !rawUrl) return null;
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "https:" || url.port || url.username || url.password)
			return null;
		await assertPublicSupplierHostname(url.hostname);
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok || (response.status >= 300 && response.status < 400))
			return null;
		const contentType = normalizeImageContentType(
			response.headers.get("content-type"),
		);
		if (!contentType) return null;
		const bytes = await readBoundedResponseBytes(response, 5_000_000);
		if (!bytes.length || bytes.length > 5_000_000) return null;
		const dimensions = readImageDimensions(bytes, contentType);
		if (!dimensions) return null;
		const id = crypto.randomUUID();
		const extension =
			contentType === "image/jpeg" ? "jpg" : contentType.slice(6);
		const objectKey = `products/${productId}/media/${id}.${extension}`;
		await bucket.put(objectKey, bytes, {
			httpMetadata: {
				contentType,
				cacheControl: "public, max-age=31536000, immutable",
			},
		});
		return { id, objectKey, contentType, sizeBytes: bytes.length };
	} catch {
		return null;
	}
}

function normalizeImageContentType(value: string | null) {
	const normalized = value?.split(";")[0]?.trim().toLowerCase();
	return normalized &&
		["image/jpeg", "image/png", "image/webp", "image/gif"].includes(normalized)
		? normalized
		: null;
}

function uniqueCategoryNames(values: string[]) {
	return [
		...new Set(
			values
				.map((value) => value.trim())
				.filter(Boolean)
				.slice(0, 100),
		),
	];
}

function presentSku(input: {
	product: {
		id: string;
		name: string;
		active: boolean;
	};
	sku: {
		id: string;
		name: string;
		costMinor: string;
		stockQuantity: number;
		active: boolean;
	};
	binding?: BindingRow;
	availableAccountCount: number;
	currency: string;
	currencyDecimals: number;
}): SupplierProductAdminRow {
	return {
		key: `${input.product.id}\0${input.sku.id}`,
		productId: input.product.id,
		productName: input.product.name,
		skuId: input.sku.id,
		skuName: input.sku.name,
		costMinor: input.sku.costMinor,
		stockQuantity: input.sku.stockQuantity,
		remoteStatus:
			input.product.active && input.sku.active ? "active" : "inactive",
		imported: Boolean(input.binding),
		bindingId: input.binding?.id ?? null,
		maxCostMinor: input.binding?.max_cost_minor ?? input.sku.costMinor,
		localProductId: input.binding?.local_product_id ?? null,
		localProductName: input.binding?.local_product_name ?? null,
		localProductStatus: input.binding?.local_product_status ?? null,
		sellableItemId: input.binding?.sellable_item_id ?? null,
		sellableItemName: input.binding?.sellable_item_name ?? null,
		priceMinor: input.binding?.price_minor ?? null,
		importCostMinor: input.binding?.import_cost_minor ?? null,
		supplierStatus: input.binding?.supplier_status ?? null,
		availableAccountCount: input.availableAccountCount,
		lastSyncedAt: input.binding?.last_synced_at ?? null,
		lastErrorCode: input.binding?.last_error_code ?? null,
		currency: input.currency,
		currencyDecimals: input.currencyDecimals,
	};
}

function presentMissingBinding(
	binding: BindingRow,
	availableAccountCount: number,
	currency: string,
	currencyDecimals: number,
): SupplierProductAdminRow {
	return {
		key: `${binding.upstream_product_id}\0${binding.upstream_sku_id}`,
		productId: binding.upstream_product_id,
		productName: binding.upstream_product_name,
		skuId: binding.upstream_sku_id,
		skuName: binding.upstream_sku_name,
		costMinor: binding.reference_cost_minor,
		stockQuantity: binding.stock_quantity,
		remoteStatus: binding.remote_status,
		imported: true,
		bindingId: binding.id,
		maxCostMinor: binding.max_cost_minor,
		localProductId: binding.local_product_id,
		localProductName: binding.local_product_name,
		localProductStatus: binding.local_product_status,
		sellableItemId: binding.sellable_item_id,
		sellableItemName: binding.sellable_item_name,
		priceMinor: binding.price_minor,
		importCostMinor: binding.import_cost_minor,
		supplierStatus: binding.supplier_status,
		availableAccountCount,
		lastSyncedAt: binding.last_synced_at,
		lastErrorCode: binding.last_error_code,
		currency,
		currencyDecimals,
	};
}
