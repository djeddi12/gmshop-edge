import {
	acgCredentialsSchema,
	dujiaoNextCredentialsSchema,
	gmshopEdgeCredentialsSchema,
	kinguinEcommerceCredentialsSchema,
	type SupplierProvider,
} from "../schema";
import type { SupplierCredentials } from "../secrets";
import { AcgAdapter } from "./acg";
import { DujiaoNextAdapter } from "./dujiao-next";
import { GmshopEdgeAdapter } from "./gmshop-edge";
import { KinguinEcommerceAdapter } from "./kinguin-ecommerce";
import type { SupplierAdapter } from "./types";

export function createSupplierAdapter(input: {
	provider: SupplierProvider;
	baseUrl: string;
	credentials: SupplierCredentials;
	currency: string;
	currencyDecimals: number;
	fetcher?: typeof fetch;
}): SupplierAdapter {
	if (input.provider === "acg") {
		const credentials = acgCredentialsSchema.parse(input.credentials);
		return new AcgAdapter({
			baseUrl: input.baseUrl,
			apiId: credentials.apiId,
			appKey: credentials.appKey,
			currency: input.currency,
			currencyDecimals: input.currencyDecimals,
			fetcher: input.fetcher,
		});
	}
	if (input.provider === "dujiao_next") {
		const credentials = dujiaoNextCredentialsSchema.parse(input.credentials);
		return new DujiaoNextAdapter({
			baseUrl: input.baseUrl,
			apiKey: credentials.apiKey,
			apiSecret: credentials.apiSecret,
			currency: input.currency,
			currencyDecimals: input.currencyDecimals,
			fetcher: input.fetcher,
		});
	}
	if (input.provider === "kinguin_ecommerce") {
		const credentials = kinguinEcommerceCredentialsSchema.parse(input.credentials);
		return new KinguinEcommerceAdapter({
			baseUrl: input.baseUrl,
			apiKey: credentials.apiKey,
			currency: input.currency,
			currencyDecimals: input.currencyDecimals,
			fetcher: input.fetcher,
		});
	}
	const credentials = gmshopEdgeCredentialsSchema.parse(input.credentials);
	return new GmshopEdgeAdapter({
		baseUrl: input.baseUrl,
		apiKey: credentials.apiKey,
		apiSecret: credentials.apiSecret,
		currency: input.currency,
		currencyDecimals: input.currencyDecimals,
		fetcher: input.fetcher,
	});
}
