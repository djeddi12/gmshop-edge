import { z } from "zod";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import {
	acgCredentialsSchema,
	dujiaoNextCredentialsSchema,
	gmshopEdgeCredentialsSchema,
	kinguinEcommerceCredentialsSchema,
	type SupplierProvider,
} from "./schema";

const credentialValueSchema = z.union([
	acgCredentialsSchema,
	dujiaoNextCredentialsSchema,
	gmshopEdgeCredentialsSchema,
	kinguinEcommerceCredentialsSchema,
]);

const credentialVaultSchema = z.object({
	version: z.literal(1),
	revisions: z
		.array(
			z.object({
				revision: z.number().int().positive(),
				credentials: credentialValueSchema,
			}),
		)
		.min(1)
		.max(32),
});

export type SupplierCredentials = z.infer<typeof credentialValueSchema>;
type CredentialVault = z.infer<typeof credentialVaultSchema>;

export function parseSupplierCredentials(
	provider: SupplierProvider,
	value: unknown,
): SupplierCredentials {
	if (provider === "acg") return acgCredentialsSchema.parse(value);
	if (provider === "dujiao_next")
		return dujiaoNextCredentialsSchema.parse(value);
	if (provider === "gmshop_edge") return gmshopEdgeCredentialsSchema.parse(value);
	return kinguinEcommerceCredentialsSchema.parse(value);
}

export async function createSupplierCredentialVault(
	provider: SupplierProvider,
	value: unknown,
	commerceSecret: string,
) {
	const credentials = parseSupplierCredentials(provider, value);
	return encryptVault(
		{ version: 1, revisions: [{ revision: 1, credentials }] },
		commerceSecret,
	);
}

export async function rotateSupplierCredentialVault(
	encrypted: string,
	provider: SupplierProvider,
	value: unknown,
	commerceSecret: string,
) {
	const vault = await decryptVault(encrypted, commerceSecret);
	const revision =
		Math.max(...vault.revisions.map((entry) => entry.revision)) + 1;
	const credentials = parseSupplierCredentials(provider, value);
	return {
		revision,
		encrypted: await encryptVault(
			{
				version: 1,
				revisions: [...vault.revisions, { revision, credentials }],
			},
			commerceSecret,
		),
	};
}

export async function readSupplierCredentials(
	encrypted: string,
	revision: number,
	provider: SupplierProvider,
	commerceSecret: string,
) {
	const vault = await decryptVault(encrypted, commerceSecret);
	const credentials = vault.revisions.find(
		(entry) => entry.revision === revision,
	)?.credentials;
	if (!credentials) throw new Error("supplier_credential_revision_unavailable");
	return parseSupplierCredentials(provider, credentials);
}

export async function findDujiaoCredentialRevision(
	encrypted: string,
	apiKey: string,
	commerceSecret: string,
) {
	const vault = await decryptVault(encrypted, commerceSecret);
	for (const entry of vault.revisions) {
		const parsed = dujiaoNextCredentialsSchema.safeParse(entry.credentials);
		if (parsed.success && constantTimeEqual(parsed.data.apiKey, apiKey))
			return { revision: entry.revision, credentials: parsed.data };
	}
	return null;
}

export async function supplierCredentialFingerprint(
	provider: SupplierProvider,
	value: unknown,
	commerceSecret: string,
) {
	const credentials = parseSupplierCredentials(provider, value);
	const payload = new TextEncoder().encode(
		`${provider}\0${canonicalJson(credentials)}`,
	);
	const material = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`gmshop:supplier-fingerprint\0${commerceSecret}`),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		material,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, payload),
	);
	return Array.from(signature, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function decryptVault(encrypted: string, commerceSecret: string) {
	return credentialVaultSchema.parse(
		JSON.parse(
			await decryptSecret(
				encrypted,
				commerceSecret,
				"supplier-account-credentials",
			),
		),
	);
}

function encryptVault(vault: CredentialVault, commerceSecret: string) {
	return encryptSecret(
		JSON.stringify(credentialVaultSchema.parse(vault)),
		commerceSecret,
		"supplier-account-credentials",
	);
}

function canonicalJson(value: SupplierCredentials) {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(value).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
}

function constantTimeEqual(left: string, right: string) {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1)
		difference |=
			(leftBytes[index % Math.max(1, leftBytes.length)] ?? 0) ^
			(rightBytes[index % Math.max(1, rightBytes.length)] ?? 0);
	return difference === 0;
}
