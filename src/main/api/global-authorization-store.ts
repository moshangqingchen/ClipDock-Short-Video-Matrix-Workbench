import type { Database } from "@main/db/database";
import { globalAccountIdSchema, type GlobalAccount } from "@shared/global-accounts";
import { GlobalAccountRepository } from "./global-account-repository";

export type GlobalAuthorizationErrorCode =
  | "GLOBAL_AUTHORIZATION_INVALID_ACCOUNT_ID"
  | "GLOBAL_AUTHORIZATION_ACCOUNT_NOT_FOUND"
  | "GLOBAL_AUTHORIZATION_DISCONNECT_FAILED";

/** Local-only fixed errors; database messages, account names and credentials are not propagated. */
export class GlobalAuthorizationStoreError extends Error {
  constructor(readonly code: GlobalAuthorizationErrorCode) {
    super(code);
    this.name = "GlobalAuthorizationStoreError";
  }
}

/**
 * Removes this application's local grant. This performs no provider request and cannot claim
 * remote consent/revocation. Remote revocation needs a future platform-specific API policy.
 *
 * Callers must cancel the account's pending OAuth flow/API operations before disconnecting;
 * this synchronous storage transaction does not own or abort those runtime operations.
 */
export class GlobalAuthorizationStore {
  private readonly accounts: GlobalAccountRepository;

  constructor(private readonly db: Database) {
    this.accounts = new GlobalAccountRepository(db);
  }

  /** Also removes intentionally discarded, unreadable portable ciphertext without decrypting it. */
  disconnect(accountId: string): GlobalAccount {
    const parsed = globalAccountIdSchema.safeParse(accountId);
    if (!parsed.success) throw new GlobalAuthorizationStoreError("GLOBAL_AUTHORIZATION_INVALID_ACCOUNT_ID");
    const id = parsed.data;
    const fail = () => {
      throw new GlobalAuthorizationStoreError("GLOBAL_AUTHORIZATION_DISCONNECT_FAILED");
    };
    try {
      return this.db.transaction(() => {
        const previous = this.accounts.get(id);
        if (!previous) throw new GlobalAuthorizationStoreError("GLOBAL_AUTHORIZATION_ACCOUNT_NOT_FOUND");
        const tokenPresent = () =>
          Boolean(
            this.db.get("SELECT 1 AS present FROM credentials WHERE kind = 'oauth_token' AND owner_id = ?", [
              id,
            ]),
          );
        const hadToken = tokenPresent();
        const removed = this.db.run("DELETE FROM credentials WHERE kind = 'oauth_token' AND owner_id = ?", [
          id,
        ]);
        // SQLite RAISE(IGNORE) is not an exception; check real changes and the postcondition.
        if (removed.changes !== (hadToken ? 1 : 0) || tokenPresent()) fail();
        const uploadSecrets = () =>
          this.db.all(
            "SELECT id FROM credentials WHERE kind = 'upload_session' AND owner_id IN (SELECT id FROM global_upload_jobs WHERE account_id = ?)",
            [id],
          );
        const uploadCount = uploadSecrets().length;
        const uploadsRemoved = this.db.run(
          "DELETE FROM credentials WHERE kind = 'upload_session' AND owner_id IN (SELECT id FROM global_upload_jobs WHERE account_id = ?)",
          [id],
        );
        if (uploadsRemoved.changes !== uploadCount || uploadSecrets().length !== 0) fail();
        const now = new Date().toISOString();
        const updated = this.db.run(
          "UPDATE global_accounts SET remote_id = NULL, auth_status = 'unauthorized', updated_at = ? WHERE id = ?",
          [now, id],
        );
        if (updated.changes !== 1) fail();
        const details = JSON.stringify({
          event: "local_disconnected",
          platformId: previous.platformId,
          remoteRevoked: false,
        });
        const audit = this.db.run(
          "INSERT INTO audit_events (action, account_id, details_json, created_at) VALUES (?, ?, ?, ?)",
          ["OAuthEvent", id, details, now],
        );
        if (audit.changes !== 1) fail();
        const auditRow = this.db.get(
          "SELECT action, account_id, details_json, created_at FROM audit_events WHERE id = ?",
          [audit.lastInsertRowid],
        );
        if (
          !auditRow ||
          auditRow.action !== "OAuthEvent" ||
          auditRow.account_id !== id ||
          auditRow.details_json !== details ||
          auditRow.created_at !== now
        )
          fail();
        const saved = this.accounts.get(id);
        if (
          !saved ||
          saved.id !== previous.id ||
          saved.platformId !== previous.platformId ||
          saved.displayName !== previous.displayName ||
          saved.createdAt !== previous.createdAt ||
          saved.updatedAt !== now ||
          saved.remoteId !== null ||
          saved.authStatus !== "unauthorized" ||
          tokenPresent() ||
          uploadSecrets().length !== 0
        )
          return fail();
        return saved;
      });
    } catch (error) {
      if (error instanceof GlobalAuthorizationStoreError) throw error;
      throw new GlobalAuthorizationStoreError("GLOBAL_AUTHORIZATION_DISCONNECT_FAILED");
    }
  }
}
