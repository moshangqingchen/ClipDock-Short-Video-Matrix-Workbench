import type { Database } from "@main/db/database";
import { globalAccountIdSchema, type GlobalAccount } from "@shared/global-accounts";
import {
  GLOBAL_READ_ERRORS,
  globalReadSnapshotSchema,
  type GlobalReadErrorCode,
  type GlobalReadSnapshot,
} from "@shared/global-read";
import { GlobalAccountRepository } from "./global-account-repository";

export class GlobalReadRepositoryError extends Error {
  constructor(readonly code: GlobalReadErrorCode) {
    super(code);
    this.name = "GlobalReadRepositoryError";
  }
}

function id(value: string): string {
  const parsed = globalAccountIdSchema.safeParse(value);
  if (!parsed.success) throw new GlobalReadRepositoryError("GLOBAL_READ_INPUT_INVALID");
  return parsed.data;
}

function fixed<T>(code: GlobalReadErrorCode, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GlobalReadRepositoryError) throw error;
    throw new GlobalReadRepositoryError(code);
  }
}

/** One bounded, public-data snapshot per international account. No credential or network state storage. */
export class GlobalReadRepository {
  private readonly accounts: GlobalAccountRepository;
  constructor(private readonly db: Database) {
    this.accounts = new GlobalAccountRepository(db);
  }

  get(accountId: string): GlobalReadSnapshot | null {
    const key = id(accountId);
    return fixed("GLOBAL_READ_UNAVAILABLE", () => {
      const account = this.accounts.get(key);
      if (!account || account.authStatus !== "authorized") return null;
      const row = this.db.get("SELECT * FROM global_read_snapshots WHERE account_id = ?", [key]);
      if (!row || row.platform_id !== account.platformId || row.remote_id !== account.remoteId) return null;
      if (typeof row.snapshot_json !== "string" || row.snapshot_json.length > 262144)
        throw new GlobalReadRepositoryError("GLOBAL_READ_RESPONSE_INVALID");
      let raw: unknown;
      try {
        raw = JSON.parse(row.snapshot_json);
      } catch {
        throw new GlobalReadRepositoryError("GLOBAL_READ_RESPONSE_INVALID");
      }
      const parsed = globalReadSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new GlobalReadRepositoryError("GLOBAL_READ_RESPONSE_INVALID");
      const snapshot = parsed.data;
      if (
        snapshot.accountId !== key ||
        snapshot.platformId !== account.platformId ||
        snapshot.remoteId !== account.remoteId ||
        snapshot.fetchedAt !== row.fetched_at
      )
        return null;
      return snapshot;
    });
  }

  save(input: GlobalReadSnapshot, assertCurrent: () => void): GlobalReadSnapshot {
    // Parsing also detaches caller-owned nested objects before an external guard can mutate them.
    const parsed = globalReadSnapshotSchema.safeParse(input);
    if (!parsed.success || typeof assertCurrent !== "function")
      throw new GlobalReadRepositoryError("GLOBAL_READ_INPUT_INVALID");
    const snapshot = parsed.data;
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > 262144) throw new GlobalReadRepositoryError("GLOBAL_READ_INPUT_INVALID");
    const check = () => {
      try {
        assertCurrent();
      } catch (error) {
        const code =
          error instanceof Error ? GLOBAL_READ_ERRORS.find((value) => value === error.message) : null;
        throw new GlobalReadRepositoryError(code ?? "GLOBAL_READ_CANCELLED");
      }
    };
    const accountMatches = (account: GlobalAccount | undefined) => {
      if (!account || account.authStatus !== "authorized")
        throw new GlobalReadRepositoryError("GLOBAL_READ_UNAUTHORIZED");
      if (account.platformId !== snapshot.platformId || account.remoteId !== snapshot.remoteId)
        throw new GlobalReadRepositoryError("GLOBAL_READ_IDENTITY_MISMATCH");
    };
    return fixed("GLOBAL_READ_SAVE_FAILED", () => {
      check();
      return this.db.transaction(() => {
        check();
        accountMatches(this.accounts.get(snapshot.accountId));
        const written = this.db.run(
          `INSERT INTO global_read_snapshots (account_id, platform_id, remote_id, fetched_at, snapshot_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET platform_id=excluded.platform_id,
             remote_id=excluded.remote_id, fetched_at=excluded.fetched_at, snapshot_json=excluded.snapshot_json`,
          [snapshot.accountId, snapshot.platformId, snapshot.remoteId, snapshot.fetchedAt, serialized],
        );
        if (written.changes !== 1) throw new GlobalReadRepositoryError("GLOBAL_READ_SAVE_FAILED");
        check();
        const saved = this.get(snapshot.accountId);
        if (!saved || JSON.stringify(saved) !== serialized)
          throw new GlobalReadRepositoryError("GLOBAL_READ_SAVE_FAILED");
        const details = JSON.stringify({
          platformId: snapshot.platformId,
          workCount: snapshot.works.length,
          capabilities: snapshot.capabilities,
        });
        const audit = this.db.run(
          "INSERT INTO audit_events (action, account_id, details_json, created_at) VALUES ('GlobalRead', ?, ?, ?)",
          [snapshot.accountId, details, snapshot.fetchedAt],
        );
        const checkAudit = () => {
          const row = this.db.get(
            "SELECT action, account_id, details_json, created_at FROM audit_events WHERE id = ?",
            [audit.lastInsertRowid],
          );
          if (
            audit.changes !== 1 ||
            row?.action !== "GlobalRead" ||
            row.account_id !== snapshot.accountId ||
            row.details_json !== details ||
            row.created_at !== snapshot.fetchedAt
          )
            throw new GlobalReadRepositoryError("GLOBAL_READ_SAVE_FAILED");
        };
        checkAudit();
        // Final guard and postconditions remain inside the transaction: revocation rolls back the write.
        check();
        accountMatches(this.accounts.get(snapshot.accountId));
        const final = this.db.get(
          "SELECT platform_id, remote_id, fetched_at, snapshot_json FROM global_read_snapshots WHERE account_id = ?",
          [snapshot.accountId],
        );
        if (
          final?.snapshot_json !== serialized ||
          final.platform_id !== snapshot.platformId ||
          final.remote_id !== snapshot.remoteId ||
          final.fetched_at !== snapshot.fetchedAt
        )
          throw new GlobalReadRepositoryError("GLOBAL_READ_SAVE_FAILED");
        checkAudit();
        return saved;
      });
    });
  }

  remove(accountId: string): void {
    const key = id(accountId);
    fixed("GLOBAL_READ_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const present = () =>
          Boolean(this.db.get("SELECT 1 AS present FROM global_read_snapshots WHERE account_id = ?", [key]));
        const expected = present() ? 1 : 0;
        const removed = this.db.run("DELETE FROM global_read_snapshots WHERE account_id = ?", [key]);
        if (removed.changes !== expected || present())
          throw new GlobalReadRepositoryError("GLOBAL_READ_SAVE_FAILED");
      }),
    );
  }
}
