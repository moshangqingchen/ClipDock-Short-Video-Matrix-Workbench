import { z } from "zod";

export const CREDENTIAL_KINDS = [
  "clash_secret",
  "proxy_password",
  "oauth_token",
  "oauth_client_secret",
  "upload_session",
] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export const credentialOwnerSchema = z.union([z.literal("default"), z.string().uuid()]);

export const credentialRefSchema = z
  .object({
    kind: credentialKindSchema,
    ownerId: credentialOwnerSchema,
  })
  .strict();

/** OAuth writes use dedicated main-process services; generic renderer writes cannot supply them. */
export const credentialSetSchema = credentialRefSchema.extend({
  secret: z.string().min(1).max(65_536),
});

export const credentialWriteSchema = credentialSetSchema.extend({
  kind: z.enum(["clash_secret", "proxy_password"]),
});

/** OAuth deletion must also invalidate its application/account state in the dedicated service. */
export const credentialDeleteSchema = credentialRefSchema.extend({
  kind: z.enum(["clash_secret", "proxy_password"]),
});

export type CredentialKind = z.infer<typeof credentialKindSchema>;
export type CredentialRef = z.infer<typeof credentialRefSchema>;
export type CredentialSetInput = z.infer<typeof credentialSetSchema>;
export type CredentialWriteInput = z.infer<typeof credentialWriteSchema>;
export type CredentialDeleteInput = z.infer<typeof credentialDeleteSchema>;

export type CredentialState =
  "missing" | "available" | "encryption_unavailable" | "decryption_failed" | "unsupported_version";

/** Public DTO: existence is deliberately separate from current decryptability. */
export interface CredentialMetadata extends CredentialRef {
  hasCredential: boolean;
  available: boolean;
  encryptionAvailable: boolean;
  state: CredentialState;
  createdAt: string | null;
  updatedAt: string | null;
}

export const CREDENTIAL_IPC = {
  credentialMeta: "credentials:meta",
  credentialSet: "credentials:set",
  credentialDelete: "credentials:delete",
} as const;

export interface CredentialApi {
  meta(ref: CredentialRef): Promise<CredentialMetadata>;
  set(input: CredentialWriteInput): Promise<CredentialMetadata>;
  delete(ref: CredentialDeleteInput): Promise<CredentialMetadata>;
}
