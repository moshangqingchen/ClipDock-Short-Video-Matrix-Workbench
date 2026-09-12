import { randomUUID } from "node:crypto";
import type { Database } from "@main/db/database";
import { globalPlatformIdSchema } from "@shared/global-accounts";
import type { GlobalPlatformId } from "@shared/platforms";
import {
  globalAppConfigSchema,
  globalAppConfigurationSchema,
  type GlobalAppConfiguration,
  type GlobalAppConfigInput,
} from "@shared/global-apps";

const COLUMNS = "id, platform_id, client_id, redirect_port, created_at, updated_at";
type GlobalAppErrorCode =
  | "GLOBAL_APP_INPUT_INVALID"
  | "GLOBAL_APP_DATA_INVALID"
  | "GLOBAL_APP_READ_FAILED"
  | "GLOBAL_APP_SAVE_FAILED";

export class GlobalAppRepositoryError extends Error {
  constructor(readonly code: GlobalAppErrorCode) {
    super(code);
    this.name = "GlobalAppRepositoryError";
  }
}

function fixedFailure<T>(code: GlobalAppErrorCode, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GlobalAppRepositoryError) throw error;
    throw new GlobalAppRepositoryError(code);
  }
}

function platform(value: GlobalPlatformId): GlobalPlatformId {
  const parsed = globalPlatformIdSchema.safeParse(value);
  if (!parsed.success) throw new GlobalAppRepositoryError("GLOBAL_APP_INPUT_INVALID");
  return parsed.data;
}

function fromRow(row: Record<string, unknown>): GlobalAppConfiguration {
  const parsed = globalAppConfigurationSchema.safeParse({
    id: row.id,
    platformId: row.platform_id,
    clientId: row.client_id,
    redirectPort: row.redirect_port,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) throw new GlobalAppRepositoryError("GLOBAL_APP_DATA_INVALID");
  return parsed.data;
}

export class GlobalAppRepository {
  constructor(private readonly db: Database) {}

  get(platformId: GlobalPlatformId): GlobalAppConfiguration | null {
    const id = platform(platformId);
    return fixedFailure("GLOBAL_APP_READ_FAILED", () => {
      const row = this.db.get(`SELECT ${COLUMNS} FROM global_apps WHERE platform_id = ?`, [id]);
      return row ? fromRow(row) : null;
    });
  }

  list(): GlobalAppConfiguration[] {
    return fixedFailure("GLOBAL_APP_READ_FAILED", () =>
      this.db.all(`SELECT ${COLUMNS} FROM global_apps ORDER BY platform_id`).map(fromRow),
    );
  }

  /** Composes with the service's vault transaction via Database's nested savepoints. */
  put(input: GlobalAppConfigInput): GlobalAppConfiguration {
    const parsed = globalAppConfigSchema.safeParse(input);
    if (!parsed.success) throw new GlobalAppRepositoryError("GLOBAL_APP_INPUT_INVALID");
    return fixedFailure("GLOBAL_APP_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const value = parsed.data;
        const previous = this.get(value.platformId);
        if (previous?.clientId === value.clientId && previous.redirectPort === value.redirectPort)
          return previous;
        const now = new Date().toISOString();
        const next: GlobalAppConfiguration = {
          ...value,
          id: previous?.id ?? randomUUID(),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        const saved = this.db.run(
          `INSERT INTO global_apps (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform_id) DO UPDATE SET client_id = excluded.client_id,
             redirect_port = excluded.redirect_port, updated_at = excluded.updated_at`,
          [next.id, next.platformId, next.clientId, next.redirectPort, next.createdAt, next.updatedAt],
        );
        if (saved.changes !== 1) throw new GlobalAppRepositoryError("GLOBAL_APP_SAVE_FAILED");
        this.invalidatePlatformAuthorization(next.platformId);
        return next;
      }),
    );
  }

  /** Main-only: also used when an app secret changes without changing public configuration. */
  invalidatePlatformAuthorization(platformId: GlobalPlatformId): void {
    const id = platform(platformId);
    fixedFailure("GLOBAL_APP_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const expectedTokens = Number(
          this.db.get(
            "SELECT COUNT(*) AS n FROM credentials WHERE kind = 'oauth_token' AND owner_id IN (SELECT id FROM global_accounts WHERE platform_id = ?)",
            [id],
          )?.n ?? 0,
        );
        const expectedAccounts = Number(
          this.db.get(
            "SELECT COUNT(*) AS n FROM global_accounts WHERE platform_id = ? AND auth_status != 'unauthorized'",
            [id],
          )?.n ?? 0,
        );
        const removed = this.db.run(
          "DELETE FROM credentials WHERE kind = 'oauth_token' AND owner_id IN (SELECT id FROM global_accounts WHERE platform_id = ?)",
          [id],
        );
        const uploadSecrets = () =>
          this.db.all(
            "SELECT id FROM credentials WHERE kind = 'upload_session' AND owner_id IN (SELECT j.id FROM global_upload_jobs j JOIN global_accounts a ON a.id = j.account_id WHERE a.platform_id = ?)",
            [id],
          );
        const uploadCount = uploadSecrets().length;
        const uploadsRemoved = this.db.run(
          "DELETE FROM credentials WHERE kind = 'upload_session' AND owner_id IN (SELECT j.id FROM global_upload_jobs j JOIN global_accounts a ON a.id = j.account_id WHERE a.platform_id = ?)",
          [id],
        );
        if (uploadsRemoved.changes !== uploadCount || uploadSecrets().length !== 0)
          throw new GlobalAppRepositoryError("GLOBAL_APP_SAVE_FAILED");
        const updated = this.db.run(
          "UPDATE global_accounts SET auth_status = 'reauthorization_required', updated_at = ? WHERE platform_id = ? AND auth_status != 'unauthorized'",
          [new Date().toISOString(), id],
        );
        if (removed.changes !== expectedTokens || updated.changes !== expectedAccounts)
          throw new GlobalAppRepositoryError("GLOBAL_APP_SAVE_FAILED");
      }),
    );
  }
}
