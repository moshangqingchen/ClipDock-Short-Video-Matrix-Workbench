import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Database } from "@main/db/database";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { globalAccountIdSchema, globalPlatformIdSchema, type GlobalAccount } from "@shared/global-accounts";
import { GlobalAccountRepository } from "./global-account-repository";
import type { OAuthTransactionContext } from "./oauth-flow";

const secretSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[\x21-\x7e]+$/);
export const globalTokenEnvelopeSchema = z
  .object({
    version: z.literal(1),
    accountId: globalAccountIdSchema,
    platformId: globalPlatformIdSchema,
    remoteId: z.string().trim().min(1).max(256),
    tokenType: z.literal("Bearer"),
    accessToken: secretSchema,
    refreshToken: secretSchema.optional(),
    refreshExpiresAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
      )
      .max(64),
  })
  .strict()
  .refine((input) => new Set(input.scopes).size === input.scopes.length)
  .refine((input) => input.refreshExpiresAt === undefined || input.refreshToken !== undefined);

/** Deliberately main-only: neither this type nor its schema belongs in shared/IPC. */
export type GlobalTokenEnvelope = z.infer<typeof globalTokenEnvelopeSchema>;
type TokenErrorCode =
  | "GLOBAL_TOKEN_INVALID"
  | "GLOBAL_TOKEN_ACCOUNT_MISMATCH"
  | "GLOBAL_TOKEN_SAVE_FAILED"
  | "GLOBAL_TOKEN_READ_FAILED"
  | "GLOBAL_TOKEN_STALE";
export class GlobalTokenStoreError extends Error {
  constructor(readonly code: TokenErrorCode) {
    super(code);
    this.name = "GlobalTokenStoreError";
  }
}

/** Vault, account identity and audit commit on the same synchronous SQLite transaction. */
export class GlobalTokenStore {
  private readonly accounts: GlobalAccountRepository;
  private readonly vault: CredentialVault;
  constructor(
    private readonly db: Database,
    encryption?: CredentialEncryptionProvider,
  ) {
    this.accounts = new GlobalAccountRepository(db);
    this.vault = new CredentialVault(db, encryption);
  }

  commitAuthorization(
    input: GlobalTokenEnvelope,
    context: Pick<OAuthTransactionContext, "accountId" | "platformId" | "assertCurrent">,
  ): GlobalAccount {
    return this.commit(input, context, "authorized");
  }

  /** Compare-and-swap prevents a delayed refresh from replacing a newer grant or rotation. */
  commitRefresh(
    input: GlobalTokenEnvelope,
    previous: GlobalTokenEnvelope,
    context: Pick<OAuthTransactionContext, "accountId" | "platformId" | "assertCurrent">,
  ): GlobalAccount {
    const parsed = globalTokenEnvelopeSchema.safeParse(previous);
    if (!parsed.success) throw new GlobalTokenStoreError("GLOBAL_TOKEN_INVALID");
    if (
      input.accountId !== parsed.data.accountId ||
      input.platformId !== parsed.data.platformId ||
      input.remoteId !== parsed.data.remoteId
    )
      throw new GlobalTokenStoreError("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
    return this.commit(input, context, "refreshed", parsed.data);
  }

  private commit(
    input: GlobalTokenEnvelope,
    context: Pick<OAuthTransactionContext, "accountId" | "platformId" | "assertCurrent">,
    event: "authorized" | "refreshed",
    previous?: GlobalTokenEnvelope,
  ): GlobalAccount {
    const parsed = globalTokenEnvelopeSchema.safeParse(input);
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now())
      throw new GlobalTokenStoreError("GLOBAL_TOKEN_INVALID");
    const token = parsed.data;
    if (context?.accountId !== token.accountId || context?.platformId !== token.platformId)
      throw new GlobalTokenStoreError("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
    const check = () => {
      try {
        if (typeof context.assertCurrent === "function") {
          context.assertCurrent();
          if (Date.parse(token.expiresAt) > Date.now()) return;
        }
      } catch {
        /* fixed error */
      }
      throw new GlobalTokenStoreError("GLOBAL_TOKEN_STALE");
    };
    try {
      return this.db.transaction(() => {
        check();
        if (previous && JSON.stringify(this.read(token.accountId)) !== JSON.stringify(previous))
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_STALE");
        const account = this.accounts.get(token.accountId);
        if (
          !account ||
          account.platformId !== token.platformId ||
          (account.remoteId !== null && account.remoteId !== token.remoteId)
        )
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
        const ref = { kind: "oauth_token" as const, ownerId: token.accountId };
        const serialized = JSON.stringify(token);
        const credential = this.vault.set({ ...ref, secret: serialized });
        if (!credential.available || this.vault.get(ref) !== serialized)
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
        check();
        const now = new Date().toISOString();
        const grantRevision =
          event === "authorized"
            ? randomUUID()
            : this.db.get("SELECT grant_revision FROM global_accounts WHERE id = ?", [token.accountId])
                ?.grant_revision;
        if (typeof grantRevision !== "string" || !/^[a-f0-9-]{32,36}$/.test(grantRevision))
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
        // A previous authorized row can look identical after RAISE(IGNORE); require this UPDATE.
        const update = this.db.run(
          "UPDATE global_accounts SET remote_id = ?, auth_status = 'authorized', updated_at = ?, grant_revision = ? WHERE id = ?",
          [token.remoteId, now, grantRevision, token.accountId],
        );
        if (
          update.changes !== 1 ||
          this.db.get("SELECT grant_revision FROM global_accounts WHERE id = ?", [token.accountId])
            ?.grant_revision !== grantRevision
        )
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
        const details = JSON.stringify({
          event,
          platformId: token.platformId,
          scopeCount: token.scopes.length,
        });
        const audit = this.db.run(
          "INSERT INTO audit_events (action, account_id, details_json, created_at) VALUES (?, ?, ?, ?)",
          ["OAuthEvent", account.id, details, now],
        );
        if (audit.changes !== 1) throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
        const auditRow = this.db.get(
          "SELECT action, account_id, details_json, created_at FROM audit_events WHERE id = ?",
          [audit.lastInsertRowid],
        );
        if (
          !auditRow ||
          auditRow.action !== "OAuthEvent" ||
          auditRow.account_id !== account.id ||
          auditRow.details_json !== details ||
          auditRow.created_at !== now
        )
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
        const saved = this.accounts.get(token.accountId);
        if (
          !saved ||
          saved.authStatus !== "authorized" ||
          saved.remoteId !== token.remoteId ||
          saved.id !== account.id ||
          saved.platformId !== account.platformId ||
          saved.displayName !== account.displayName ||
          saved.createdAt !== account.createdAt ||
          saved.updatedAt !== now ||
          this.db.get("SELECT grant_revision FROM global_accounts WHERE id = ?", [token.accountId])
            ?.grant_revision !== grantRevision ||
          this.vault.get(ref) !== serialized
        )
          throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
        check();
        return saved;
      });
    } catch (error) {
      if (error instanceof GlobalTokenStoreError) throw error;
      throw new GlobalTokenStoreError("GLOBAL_TOKEN_SAVE_FAILED");
    }
  }

  /** Expiry remains part of the envelope so an authorized main consumer can refresh it.
   * Reading a token never supplies network permission; ProxyTransport still needs a live lease.
   */
  read(accountId: string): GlobalTokenEnvelope | null {
    try {
      const account = this.accounts.get(accountId);
      if (!account || account.authStatus !== "authorized") return null;
      const secret = this.vault.get({ kind: "oauth_token", ownerId: accountId });
      if (secret === null) return null;
      const parsed = globalTokenEnvelopeSchema.safeParse(JSON.parse(secret));
      if (
        !parsed.success ||
        parsed.data.accountId !== account.id ||
        parsed.data.platformId !== account.platformId ||
        parsed.data.remoteId !== account.remoteId
      )
        throw new GlobalTokenStoreError("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
      return parsed.data;
    } catch (error) {
      if (error instanceof GlobalTokenStoreError) throw error;
      throw new GlobalTokenStoreError("GLOBAL_TOKEN_READ_FAILED");
    }
  }
}
