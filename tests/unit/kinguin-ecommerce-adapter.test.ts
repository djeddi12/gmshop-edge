import { describe, expect, it } from "vitest";
import { KinguinEcommerceAdapter } from "#/features/suppliers/providers/kinguin-ecommerce";

const product = {
	productId: "product-uuid-1",
	kinguinId: 1949,
	name: "Example Game",
	description: "Example description",
	platform: "Steam",
	genres: ["Action"],
	tags: ["base"],
	qty: 3,
	price: 5.79,
	updatedAt: "2026-10-16T10:00:00Z",
	images: { cover: { url: "https://cdn.example/game.jpg" } },
	offers: [{
		offerId: "offer-1",
		name: "Example Game Steam Key",
		price: 5.79,
		qty: 3,
		availableQty: 3,
		textQty: 3,
		availableTextQty: 3,
		isPreorder: false,
	}],
	cheapestOfferId: ["offer-1"],
};

describe("Kinguin eCommerce adapter", () => {
	it("checks EUR balance and maps catalog offers as supplier SKUs", async () => {
		const requests: Request[] = [];
		const adapter = new KinguinEcommerceAdapter({
			baseUrl: "https://gateway.kinguin.net",
			apiKey: "test-api-key",
			currency: "EUR",
			currencyDecimals: 2,
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith("/v1/balance")) return Response.json({ balance: 12.45 });
				return Response.json({ results: [product], item_count: 1 });
			},
		});

		await expect(adapter.testConnection()).resolves.toEqual({
			siteName: "Kinguin eCommerce API",
			balance: { amountMinor: "1245", currency: "EUR" },
		});
		const catalog = await adapter.listProducts({ page: 1, pageSize: 100 });
		expect(catalog.total).toBe(1);
		expect(catalog.products[0]).toMatchObject({
			id: "product-uuid-1",
			name: "Example Game",
			active: true,
			skus: [{
				id: "product-uuid-1::offer-1",
				costMinor: "579",
				stockQuantity: 3,
				active: true,
			}],
		});
		expect(requests[0]?.headers.get("X-Api-Key")).toBe("test-api-key");
		expect(requests[0]?.url).toBe("https://gateway.kinguin.net/esa/api/v1/balance");
	});

	it("places an order and reconciles delivery keys", async () => {
		const requests: Request[] = [];
		const adapter = new KinguinEcommerceAdapter({
			baseUrl: "https://gateway.kinguin.net",
			apiKey: "test-api-key",
			currency: "EUR",
			currencyDecimals: 2,
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.includes("/v2/order/ORDER123/keys")) {
					return Response.json([{ serial: "AAAA-BBBB-CCCC" }]);
				}
				if (request.method === "POST" && request.url.endsWith("/v2/order")) {
					return new Response(JSON.stringify({ orderId: "ORDER123", status: "processing" }), { status: 201 });
				}
				return Response.json({ results: [product], item_count: 1 });
			},
		});

		const submitted = await adapter.submitOrder({
			skuId: "product-uuid-1::offer-1",
			quantity: 1,
			requestNo: "external-order-1",
			callbackUrl: "https://shop.example/callback",
			traceId: "trace-1",
		});
		expect(submitted).toEqual({ status: "processing", upstreamOrderId: "ORDER123" });
		const orderRequest = requests.find((request) => request.method === "POST");
		expect(await orderRequest?.json()).toEqual({
			products: [{ productId: "product-uuid-1", qty: 1, price: 5.79, keyType: "text", offerId: "offer-1" }],
			orderExternalId: "external-order-1",
		});

		await expect(adapter.reconcileOrder({
			upstreamOrderId: "ORDER123",
			skuId: "product-uuid-1::offer-1",
			quantity: 1,
			requestNo: "external-order-1",
			callbackUrl: "https://shop.example/callback",
			traceId: "trace-1",
		})).resolves.toEqual({
			status: "supplied",
			upstreamOrderId: "ORDER123",
			cards: ["AAAA-BBBB-CCCC"],
		});
	});

	it("looks up uncertain orders by the external request ID without placing a duplicate order", async () => {
		const urls: string[] = [];
		const adapter = new KinguinEcommerceAdapter({
			baseUrl: "https://gateway.kinguin.net",
			apiKey: "test-api-key",
			currency: "EUR",
			currencyDecimals: 2,
			fetcher: async (input) => {
				const url = String(input);
				urls.push(url);
				if (url.includes("/v1/order?")) {
					return Response.json({ results: [{ orderId: "RECOVERED123", status: "processing" }], item_count: 1 });
				}
				if (url.includes("/v2/order/RECOVERED123/keys")) {
					return Response.json([{ serial: "RECOVERED-KEY" }]);
				}
				return Response.json({ results: [], item_count: 0 });
			},
		});
		await expect(adapter.reconcileOrder({
			upstreamOrderId: null,
			skuId: "product-uuid-1::offer-1",
			quantity: 1,
			requestNo: "external-order-recovery",
			callbackUrl: "https://shop.example/callback",
			traceId: "trace-recovery",
		})).resolves.toEqual({
			status: "supplied",
			upstreamOrderId: "RECOVERED123",
			cards: ["RECOVERED-KEY"],
		});
		expect(urls.some((url) => url.includes("orderExternalId=external-order-recovery"))).toBe(true);
		expect(urls).toHaveLength(2);
	});

	it("rejects non-EUR account settings", async () => {
		const adapter = new KinguinEcommerceAdapter({
			baseUrl: "https://gateway.kinguin.net",
			apiKey: "test-api-key",
			currency: "USD",
			currencyDecimals: 2,
			fetcher: async () => Response.json({ balance: 10 }),
		});
		await expect(adapter.testConnection()).rejects.toMatchObject({
			code: "supplier_currency_mismatch",
		});
	});
});
