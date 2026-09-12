import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "@main/db/database";
import {
  globalAccountCreateSchema,
  globalAccountUpdateSchema,
  type GlobalAccountUpdate,
  globalAccountIdSchema,
  globalAccountSchema,
  type GlobalAccount,
  type GlobalAccountCreateInput,
} from "@shared/global-accounts";

export const MAX_GLOBAL_ACCOUNTS = 30;
const COLUMNS =
  "id, platform_id, display_name, remote_id, auth_status, created_at, updated_at, note, browser_engine";
const authorizationSchema = z.object({ remoteId: z.string().trim().min(1).max(256) }).strict();
const NAMES = { youtube: "YouTube", tiktok: "TikTok", x: "X" } as const;

export type GlobalAccountErrorCode =
  | "GLOBAL_ACCOUNT_INPUT_INVALID"
  | "GLOBAL_ACCOUNT_DATA_INVALID"
  | "GLOBAL_ACCOUNT_LIMIT_REACHED"
  | "GLOBAL_ACCOUNT_READ_FAILED"
  | "GLOBAL_ACCOUNT_SAVE_FAILED"
  | "GLOBAL_ACCOUNT_DELETE_FAILED";

/** Database and validation diagnostics may contain private input; expose fixed codes only. */
export class GlobalAccountRepositoryError extends Error {
  constructor(readonly code: GlobalAccountErrorCode) {
    super(code);
    this.name = "GlobalAccountRepositoryError";
  }
}

function accountFromRow(row: Record<string, unknown>): GlobalAccount {
  const result = globalAccountSchema.safeParse({
    id: row.id,
    platformId: row.platform_id,
    displayName: row.display_name,
    remoteId: row.remote_id,
    note: row.note ?? null,
    browserEngine: row.browser_engine ?? "embedded",
    authStatus: row.auth_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!result.success) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_DATA_INVALID");
  return result.data;
}

function parseId(value: string): string {
  const result = globalAccountIdSchema.safeParse(value);
  if (!result.success) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_INPUT_INVALID");
  return result.data;
}

function fixedFailure<T>(code: GlobalAccountErrorCode, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GlobalAccountRepositoryError) throw error;
    throw new GlobalAccountRepositoryError(code);
  }
}

export class GlobalAccountRepository {
  constructor(private readonly db: Database) {}

  update(id: string, input: GlobalAccountUpdate): GlobalAccount {
    const key = parseId(id),
      patch = globalAccountUpdateSchema.parse(input);
    if (!this.get(key)) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_INPUT_INVALID");
    this.db.run("UPDATE global_accounts SET display_name=?, note=?, updated_at=? WHERE id=?", [
      patch.displayName,
      patch.note ?? null,
      new Date().toISOString(),
      key,
    ]);
    return this.get(key)!;
  }
  setBrowserEngine(id: string, engine: "chrome" | "embedded"): void {
    this.db.run("UPDATE global_accounts SET browser_engine=? WHERE id=?", [engine, parseId(id)]);
  }

  list(): GlobalAccount[] {
    return fixedFailure("GLOBAL_ACCOUNT_READ_FAILED", () => {
      const rows = this.db.all(
        `SELECT ${COLUMNS} FROM global_accounts ORDER BY platform_id, created_at, id LIMIT ?`,
        [MAX_GLOBAL_ACCOUNTS + 1],
      );
      if (rows.length > MAX_GLOBAL_ACCOUNTS)
        throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_LIMIT_REACHED");
      return rows.map(accountFromRow);
    });
  }

  get(id: string): GlobalAccount | undefined {
    const key = parseId(id);
    return fixedFailure("GLOBAL_ACCOUNT_READ_FAILED", () => {
      const row = this.db.get(`SELECT ${COLUMNS} FROM global_accounts WHERE id = ?`, [key]);
      return row ? accountFromRow(row) : undefined;
    });
  }

  create(input: GlobalAccountCreateInput): GlobalAccount {
    const result = globalAccountCreateSchema.safeParse(input);
    if (!result.success) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_INPUT_INVALID");
    return fixedFailure("GLOBAL_ACCOUNT_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const total = Number(this.db.get("SELECT COUNT(*) AS n FROM global_accounts")?.n ?? 0);
        if (total >= MAX_GLOBAL_ACCOUNTS)
          throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_LIMIT_REACHED");
        const { platformId } = result.data;
        const siblings = Number(
          this.db.get("SELECT COUNT(*) AS n FROM global_accounts WHERE platform_id = ?", [platformId])?.n ??
            0,
        );
        const now = new Date().toISOString();
        const account: GlobalAccount = {
          id: randomUUID(),
          platformId,
          displayName: result.data.displayName ?? `${NAMES[platformId]}账号 ${siblings + 1}`,
          remoteId: null,
          authStatus: "unauthorized",
          createdAt: now,
          updatedAt: now,
        };
        const inserted = this.db.run(
          `INSERT INTO global_accounts (${COLUMNS}) VALUES (?, ?, ?, NULL, 'unauthorized', ?, ?, NULL, 'chrome')`,
          [account.id, platformId, account.displayName, now, now],
        );
        const saved = this.get(account.id);
        if (
          inserted.changes !== 1 ||
          !saved ||
          saved.id !== account.id ||
          saved.platformId !== account.platformId ||
          saved.displayName !== account.displayName ||
          saved.remoteId !== null ||
          saved.authStatus !== "unauthorized" ||
          saved.createdAt !== now ||
          saved.updatedAt !== now
        )
          throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_SAVE_FAILED");
        return saved;
      }),
    );
  }

  /** Main only: caller must already have verified the provider identity and saved its token.
   * This metadata is not a grant of network access and is never exposed as a renderer patch.
   */
  markAuthorized(id: string, input: { remoteId: string }): GlobalAccount | undefined {
    const key = parseId(id);
    const result = authorizationSchema.safeParse(input);
    if (!result.success) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_INPUT_INVALID");
    return fixedFailure("GLOBAL_ACCOUNT_SAVE_FAILED", () =>
      this.db.transaction(() => {
        if (!this.get(key)) return undefined;
        const updated = this.db.run(
          "UPDATE global_accounts SET remote_id = ?, auth_status = 'authorized', updated_at = ?, grant_revision = ? WHERE id = ?",
          [result.data.remoteId, new Date().toISOString(), randomUUID(), key],
        );
        if (updated.changes !== 1) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_SAVE_FAILED");
        return this.get(key);
      }),
    );
  }

  /** Retain the known remote identity while an expired/revoked grant requires user consent. */
  requireReauthorization(id: string): GlobalAccount | undefined {
    const key = parseId(id);
    return fixedFailure("GLOBAL_ACCOUNT_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const current = this.get(key);
        if (!current || current.authStatus === "unauthorized") return current;
        const updated = this.db.run(
          "UPDATE global_accounts SET auth_status = 'reauthorization_required', updated_at = ? WHERE id = ?",
          [new Date().toISOString(), key],
        );
        if (updated.changes !== 1) throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_SAVE_FAILED");
        return this.get(key);
      }),
    );
  }

  delete(id: string): boolean {
    const key = parseId(id);
    return fixedFailure("GLOBAL_ACCOUNT_DELETE_FAILED", () =>
      this.db.transaction(() => {
        if (!this.get(key)) return false;
        const tokenPresent = () =>
          Boolean(
            this.db.get("SELECT 1 AS present FROM credentials WHERE kind = 'oauth_token' AND owner_id = ?", [
              key,
            ]),
          );
        const hadToken = tokenPresent();
        const removed = this.db.run("DELETE FROM credentials WHERE kind = 'oauth_token' AND owner_id = ?", [
          key,
        ]);
        if (removed.changes !== (hadToken ? 1 : 0) || tokenPresent())
          throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_DELETE_FAILED");
        if (this.db.run("DELETE FROM global_accounts WHERE id = ?", [key]).changes !== 1)
          throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_DELETE_FAILED");
        if (tokenPresent() || this.db.get("SELECT 1 AS present FROM global_accounts WHERE id = ?", [key]))
          throw new GlobalAccountRepositoryError("GLOBAL_ACCOUNT_DELETE_FAILED");
        return true;
      }),
    );
  }
}
