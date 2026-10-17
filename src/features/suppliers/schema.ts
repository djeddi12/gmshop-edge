import { z } from "zod";

export const supplierProviderSchema = z.enum([
	"acg",
	"dujiao_next",
	"gmshop_edge",
	"kinguin_ecommerce",
]);
export type SupplierProvider = z.infer<typeof supplierProviderSchema>;

export const supplierProtocolVersions = {
	acg: "3.5.5-v4",
	dujiao_next: "1.3.1-upstream-v1",
	gmshop_edge: "gmshop-edge-upstream-v1",
	kinguin_ecommerce: "kinguin-esa-v1-v2",
} as const satisfies Record<SupplierProvider, string>;

const minorAmountSchema = z
	.string()
	.regex(/^(0|[1-9]\d*)$/)
	.max(64);

export const supplierAccountInputSchema = z.object({
	id: z.uuid().optional(),
	provider: supplierProviderSchema,
	baseUrl: z.string().trim().min(1).max(2048),
	name: z.string().trim().min(1).max(120),
	currency: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/),
	currencyDecimals: z.number().int().min(0).max(8),
	reserveBalanceMinor: minorAmountSchema,
	lowBalanceMinor: minorAmountSchema,
	maxOrderCostMinor: minorAmountSchema.nullable(),
	enabled: z.boolean(),
	credentials: z.unknown().optional(),
});

export const supplierAccountIdSchema = z.object({ id: z.uuid() });

export const supplierAccountListSchema = z.object({
	search: z.string().trim().max(120).default(""),
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(20),
	enabledSort: z.enum(["asc", "desc"]).optional(),
});

export const supplierAccountEnabledSchema = supplierAccountIdSchema.extend({
	enabled: z.boolean(),
});

export const supplierSourceInputSchema = z.object({
	provider: supplierProviderSchema,
	baseUrl: z.string().trim().min(1).max(2048),
});

export const supplierSyncSettingsSchema = z.object({
	enabled: z.boolean(),
	intervalMs: z
		.number()
		.int()
		.min(10 * 60_000)
		.max(30 * 86_400_000),
});

export const supplierSyncNowSchema = z.object({
	full: z.boolean().default(false),
});

export const supplierProductListSchema = supplierSourceInputSchema.extend({
	search: z.string().trim().max(120).default(""),
});

export const supplierImportSchema = supplierSourceInputSchema.extend({
	items: z
		.array(
			z.object({
				productId: z.string().min(1).max(512),
				skuId: z.string().min(1).max(512),
			}),
		)
		.min(1)
		.max(100),
	fixedMarkupMinor: minorAmountSchema.default("0"),
	markupBps: z.number().int().min(0).max(100_000).default(0),
	publish: z.boolean().default(false),
});

export const supplierBindingSwitchSchema = supplierSourceInputSchema.extend({
	sellableItemId: z.uuid(),
	productId: z.string().min(1).max(512),
	skuId: z.string().min(1).max(512),
});

export const supplierOrderListSchema = z.object({
	search: z.string().trim().max(120).default(""),
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(20),
});

export const supplierOrderActionSchema = z.object({
	id: z.uuid(),
	action: z.enum(["reconcile", "reselect"]),
});

export const acgCredentialsSchema = z.object({
	apiId: z.string().trim().min(1).max(256),
	appKey: z.string().min(1).max(1024),
});

export const dujiaoNextCredentialsSchema = z.object({
	apiKey: z.string().trim().min(1).max(512),
	apiSecret: z.string().min(1).max(1024),
});

export const gmshopEdgeCredentialsSchema = z.object({
	apiKey: z.string().trim().min(1).max(512),
	apiSecret: z.string().min(32).max(1024),
});

export const kinguinEcommerceCredentialsSchema = z.object({
	apiKey: z.string().trim().min(1).max(512),
});

export const supplierCredentialsSchema = z.discriminatedUnion("provider", [
	z.object({ provider: z.literal("acg"), credentials: acgCredentialsSchema }),
	z.object({
		provider: z.literal("dujiao_next"),
		credentials: dujiaoNextCredentialsSchema,
	}),
	z.object({
		provider: z.literal("gmshop_edge"),
		credentials: gmshopEdgeCredentialsSchema,
	}),
	z.object({
		provider: z.literal("kinguin_ecommerce"),
		credentials: kinguinEcommerceCredentialsSchema,
	}),
]);

export const supplierPurchaseResultSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("supplied"),
		upstreamOrderId: z.string().min(1).max(512),
		cards: z.array(z.string().min(1).max(64_000)).min(1).max(10_000),
	}),
	z.object({
		status: z.literal("processing"),
		upstreamOrderId: z.string().min(1).max(512),
	}),
	z.object({
		status: z.literal("definitively_failed"),
		errorCode: z.string().min(1).max(120),
	}),
	z.object({
		status: z.literal("uncertain"),
		upstreamOrderId: z.string().min(1).max(512).nullable(),
		errorCode: z.string().min(1).max(120),
	}),
]);

export type SupplierPurchaseResult = z.infer<
	typeof supplierPurchaseResultSchema
>;
