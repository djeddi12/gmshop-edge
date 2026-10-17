import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "../money";
import type { SupplierPurchaseResult } from "../schema";
import { supplierFetchJson } from "./http";
import type { SupplierAdapter, SupplierProduct, SupplierSku } from "./types";

const offerSchema = z.object({
	offerId: z.string().min(1),
	name: z.string().default(""),
	price: z.number().finite().nonnegative(),
	qty: z.number().int().nonnegative().default(0),
	availableQty: z.number().int().nonnegative().optional(),
	textQty: z.number().int().nonnegative().optional(),
	availableTextQty: z.number().int().nonnegative().optional(),
	isPreorder: z.boolean().optional(),
});
const productSchema = z.object({
	productId: z.string().min(1),
	kinguinId: z.union([z.string(), z.number()]).optional(),
	name: z.string().min(1),
	description: z.string().default(""),
	platform: z.string().optional(),
	genres: z.array(z.string()).default([]),
	tags: z.array(z.string()).default([]),
	qty: z.number().int().nonnegative().default(0),
	price: z.number().finite().nonnegative().default(0),
	updatedAt: z.string().optional(),
	images: z.object({
		cover: z.object({ url: z.string().url().optional() }).optional(),
		screenshots: z.array(z.object({ url: z.string().url().optional() })).optional(),
	}).optional(),
	offers: z.array(offerSchema).default([]),
	cheapestOfferId: z.array(z.string()).default([]),
});
const productPageSchema = z.object({
	results: z.array(productSchema),
	item_count: z.number().int().nonnegative(),
});
const balanceSchema = z.object({ balance: z.number().finite() });
const orderSchema = z.object({
	orderId: z.union([z.string(), z.number()]).optional(),
	id: z.union([z.string(), z.number()]).optional(),
	status: z.string().optional(),
});

export class KinguinEcommerceAdapter implements SupplierAdapter {
	constructor(private readonly input: {
		baseUrl: string;
		apiKey: string;
		currency: string;
		currencyDecimals: number;
		fetcher?: typeof fetch;
	}) {}

	async testConnection() {
		this.assertCurrency();
		const body = await this.request("GET", "/v1/balance");
		const parsed = balanceSchema.parse(body);
		return {
			siteName: "Kinguin eCommerce API",
			balance: {
				amountMinor: decimalToMinor(String(parsed.balance), this.input.currencyDecimals),
				currency: this.input.currency,
			},
		};
	}

	async listProducts(input: {
		page: number;
		pageSize: number;
		updatedAfter?: string;
		includeInactive?: boolean;
	}) {
		this.assertCurrency();
		const query = new URLSearchParams({
			page: String(Math.max(1, input.page)),
			limit: String(Math.min(100, Math.max(1, input.pageSize))),
			sortBy: "updatedAt",
			sortType: "desc",
		});
		if (input.updatedAfter) query.set("updatedSince", input.updatedAfter);
		const parsed = productPageSchema.parse(
			await this.request("GET", `/v1/products?${query.toString()}`),
		);
		return {
			total: parsed.item_count,
			products: parsed.results.map((product) => this.mapProduct(product)),
		};
	}

	async getSku(productId: string, skuId: string) {
		this.assertCurrency();
		const query = new URLSearchParams({ productId, limit: "100" });
		const parsed = productPageSchema.parse(
			await this.request("GET", `/v1/products?${query.toString()}`),
		);
		const product = parsed.results.find((item) => item.productId === productId);
		if (!product) throw notFound();
		const sku = this.mapProduct(product).skus.find((item) => item.id === skuId);
		if (!sku) throw notFound();
		return sku;
	}

	async submitOrder(input: {
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		const { productId, offerId } = parseSkuId(input.skuId);
		if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 9) {
			throw new DomainError("supplier_quantity_not_supported", 400, "Kinguin supports up to 9 items per offer per order");
		}
		const sku = await this.getSku(productId, input.skuId);
		const price = Number(sku.costMinor) / 100;
		const { status, body } = await this.requestWithStatus("POST", "/v2/order", {
			products: [{
				productId,
				qty: input.quantity,
				price,
				keyType: "text",
				offerId,
			}],
			orderExternalId: input.requestNo,
		});
		if (status !== 201 && status !== 200) {
			throw new DomainError("supplier_order_rejected", 502, "Kinguin rejected the order");
		}
		const parsed = orderSchema.parse(body);
		const orderId = parsed.orderId ?? parsed.id;
		if (orderId == null || String(orderId).length === 0) {
			return { status: "uncertain", upstreamOrderId: null, errorCode: "kinguin_order_id_missing" };
		}
		return { status: "processing", upstreamOrderId: String(orderId) };
	}

	async reconcileOrder(input: {
		upstreamOrderId: string | null;
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		let upstreamOrderId = input.upstreamOrderId;
		if (!upstreamOrderId) {
			const query = new URLSearchParams({ orderExternalId: input.requestNo, limit: "100" });
			const lookup = await this.requestWithStatus("GET", `/v1/order?${query.toString()}`);
			if (lookup.status < 200 || lookup.status >= 300) {
				return { status: "uncertain", upstreamOrderId: null, errorCode: "kinguin_order_lookup_failed" };
			}
			const orders = z.object({
				results: z.array(z.object({
					orderId: z.union([z.string(), z.number()]),
					status: z.string().optional(),
				})),
			}).safeParse(lookup.body);
			if (!orders.success || orders.data.results.length === 0) {
				return { status: "uncertain", upstreamOrderId: null, errorCode: "kinguin_order_not_found_yet" };
			}
			upstreamOrderId = String(orders.data.results[0]!.orderId);
		}
		const { status, body } = await this.requestWithStatus(
			"GET",
			`/v2/order/${encodeURIComponent(upstreamOrderId)}/keys?page=1&limit=100`,
		);
		if (status < 200 || status >= 300) {
			return { status: "uncertain", upstreamOrderId, errorCode: "kinguin_keys_not_ready" };
		}
		const parsed = z.array(z.object({ serial: z.string().min(1) })).max(100).safeParse(body);
		if (!parsed.success) {
			return { status: "uncertain", upstreamOrderId, errorCode: "kinguin_invalid_keys_response" };
		}
		const cards = parsed.data.map((item) => item.serial.trim()).filter(Boolean);
		if (cards.length >= input.quantity) {
			return { status: "supplied", upstreamOrderId, cards: cards.slice(0, input.quantity) };
		}
		return { status: "processing", upstreamOrderId };
	}

	private mapProduct(value: z.infer<typeof productSchema>): SupplierProduct {
		const offers = value.offers.length
			? value.offers
			: value.cheapestOfferId.length
				? value.cheapestOfferId.map((offerId) => ({
						offerId,
						name: value.name,
						price: value.price,
						qty: value.qty,
						availableQty: value.qty,
					}))
				: [];
		return {
			id: value.productId,
			name: value.name,
			description: value.description,
			imageUrls: value.images?.cover?.url ? [value.images.cover.url] : [],
			categoryNames: [...(value.platform ? [value.platform] : []), ...value.genres, ...value.tags].slice(0, 100),
			active: value.qty > 0 && offers.length > 0,
			...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
			skus: offers.map((offer): SupplierSku => ({
				id: encodeSkuId(value.productId, offer.offerId),
				name: offer.name || value.name,
				costMinor: decimalToMinor(String(offer.price), this.input.currencyDecimals),
				stockQuantity: offer.availableTextQty ?? offer.textQty ?? offer.availableQty ?? offer.qty,
				active:
					(offer.availableTextQty ?? offer.textQty ?? offer.availableQty ?? offer.qty) > 0 &&
					!offer.isPreorder,
			})),
		};
	}

	private assertCurrency() {
		if (this.input.currency.toUpperCase() !== "EUR" || this.input.currencyDecimals !== 2) {
			throw new DomainError("supplier_currency_mismatch", 400, "Kinguin eCommerce API prices and balance are denominated in EUR; configure EUR with 2 decimal places");
		}
	}

	private async request(method: string, path: string, value?: unknown) {
		const result = await this.requestWithStatus(method, path, value);
		if (result.status < 200 || result.status >= 300) {
			if (result.status === 401 || result.status === 403) {
				throw new DomainError("supplier_authentication_failed", 502, "Kinguin API key was rejected");
			}
			throw new DomainError("supplier_request_failed", 502, "Kinguin API request failed");
		}
		return result.body;
	}

	private async requestWithStatus(method: string, path: string, value?: unknown) {
		const rawBody = value === undefined ? undefined : JSON.stringify(value);
		const result = await supplierFetchJson(
			this.input.fetcher ?? fetch,
			`${this.input.baseUrl.replace(/\/$/, "")}/esa/api${path}`,
			{
				method,
				headers: {
					"X-Api-Key": this.input.apiKey,
					...(rawBody === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(rawBody === undefined ? {} : { body: rawBody }),
			},
			{ validateDestination: !this.input.fetcher },
		);
		return result;
	}
}

function encodeSkuId(productId: string, offerId: string) {
	return `${productId}::${offerId}`;
}

function parseSkuId(value: string) {
	const separator = value.indexOf("::");
	if (separator < 1 || separator + 2 >= value.length) {
		throw new DomainError("supplier_sku_not_found", 404, "Kinguin offer reference is invalid");
	}
	return { productId: value.slice(0, separator), offerId: value.slice(separator + 2) };
}

function notFound() {
	return new DomainError("supplier_sku_not_found", 404, "Kinguin product or offer was not found");
}
