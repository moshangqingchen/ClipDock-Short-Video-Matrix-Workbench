import { randomUUID } from "node:crypto";
import type { Account, AccountCreateInput, AccountStatus, AccountUpdateInput } from "@shared/types";
import { getPlatform, isPlatformId } from "@shared/platforms";
import { partitionForAccount } from "@main/browser/partition";
import type { Database } from "../database";

interface AccountRow extends Record<string, unknown> {
  id: string;
  platform_id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  external_id: string | null;
  partition: string;
  status: string;
  status_message: string | null;
  last_online_at: string | null;
  last_checked_at: string | null;
  session_expires_at: string | null;
  sort_order: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_ACCOUNTS = 30;

function toAccount(row: AccountRow): Account {
  if (!isPlatformId(row.platform_id)) throw new Error(`Corrupt account row: ${row.id}`);
  return {
    id: row.id,
    platformId: row.platform_id,
    displayName: row.display_name,
    handle: row.handle,
    avatarUrl: row.avatar_url,
    externalId: row.external_id,
    partition: row.partition,
    status: row.status as AccountStatus,
    statusMessage: row.status_message,
    lastOnlineAt: row.last_online_at,
    lastCheckedAt: row.last_checked_at,
    sessionExpiresAt: row.session_expires_at,
    sortOrder: Number(row.sort_order),
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountsRepository {
  constructor(private readonly db: Database) {}

  list(): Account[] {
    return this.db
      .all<AccountRow>("SELECT * FROM accounts ORDER BY platform_id, sort_order, created_at")
      .map(toAccount);
  }

  get(id: string): Account | undefined {
    const row = this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
    return row ? toAccount(row) : undefined;
  }

  count(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")?.n ?? 0);
  }

  create(input: AccountCreateInput): Account {
    if (this.count() >= MAX_ACCOUNTS) throw new Error(`最多支持 ${MAX_ACCOUNTS} 个账号`);
    const id = randomUUID();
    const now = new Date().toISOString();
    const platform = getPlatform(input.platformId);
    const siblings = Number(
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts WHERE platform_id = ?", [
        input.platformId,
      ])?.n ?? 0,
    );
    const displayName = input.displayName?.trim() || `${platform.shortName}账号 ${siblings + 1}`;
    this.db.run(
      `INSERT INTO accounts (id, platform_id, display_name, partition, status, sort_order, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?)`,
      [id, input.platformId, displayName, partitionForAccount(id), siblings, input.note ?? null, now, now],
    );
    return this.get(id)!;
  }

  update(id: string, patch: AccountUpdateInput): Account | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE accounts SET display_name = ?, handle = ?, avatar_url = ?, external_id = ?, note = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.displayName ?? current.displayName,
        patch.handle === undefined ? (current.handle ?? null) : patch.handle,
        patch.avatarUrl === undefined ? (current.avatarUrl ?? null) : patch.avatarUrl,
        patch.externalId === undefined ? (current.externalId ?? null) : patch.externalId,
        patch.note === undefined ? (current.note ?? null) : patch.note,
        patch.sortOrder ?? current.sortOrder,
        now,
        id,
      ],
    );
    return this.get(id);
  }

  updateStatus(
    id: string,
    status: AccountStatus,
    message: string | null,
    extra: { sessionExpiresAt?: string | null; online?: boolean } = {},
  ): Account | undefined {
    const now = new Date().toISOString();
    const online = extra.online ?? (status === "online" || status === "expiring");
    this.db.run(
      `UPDATE accounts SET status = ?, status_message = ?, last_checked_at = ?,
         last_online_at = CASE WHEN ? THEN ? ELSE last_online_at END,
         session_expires_at = COALESCE(?, session_expires_at),
         updated_at = ?
       WHERE id = ?`,
      [status, message, now, online ? 1 : 0, now, extra.sessionExpiresAt ?? null, now, id],
    );
    return this.get(id);
  }

  clearSessionState(id: string): Account | undefined {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE accounts SET status = 'offline', status_message = '登录环境已重置', last_online_at = NULL, session_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [now, id],
    );
    return this.get(id);
  }

  reorder(ids: string[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      ids.forEach((id, index) => {
        this.db.run("UPDATE accounts SET sort_order = ?, updated_at = ? WHERE id = ?", [index, now, id]);
      });
    });
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM accounts WHERE id = ?", [id]).changes > 0;
  }

  /** Used by backup restore; keeps the stored partition. */
  upsertRaw(account: Account): void {
    this.db.run(
      `INSERT INTO accounts (id, platform_id, display_name, handle, avatar_url, external_id, partition, status, status_message,
         last_online_at, last_checked_at, session_expires_at, sort_order, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, handle = excluded.handle,
         avatar_url = excluded.avatar_url, external_id = excluded.external_id, note = excluded.note,
         sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
      [
        account.id,
        account.platformId,
        account.displayName,
        account.handle ?? null,
        account.avatarUrl ?? null,
        account.externalId ?? null,
        partitionForAccount(account.id),
        "unknown",
        null,
        null,
        null,
        null,
        account.sortOrder,
        account.note ?? null,
        account.createdAt,
        account.updatedAt,
      ],
    );
  }
}
