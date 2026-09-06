import { randomUUID } from "node:crypto";
import type { PublishRecord, PublishRecordInput } from "@shared/types";
import type { PlatformId } from "@shared/platforms";
import type { Database } from "../database";

interface Row extends Record<string, unknown> {
  id: string;
  account_id: string;
  platform_id: string;
  asset_ids_json: string;
  title: string;
  description: string;
  tags_json: string;
  scheduled_at: string | null;
  status: string;
  published_at: string | null;
  work_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: Row): PublishRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    platformId: row.platform_id as PlatformId,
    assetIds: parseJson<string[]>(row.asset_ids_json, []),
    title: row.title,
    description: row.description,
    tags: parseJson<string[]>(row.tags_json, []),
    scheduledAt: row.scheduled_at,
    status: row.status as PublishRecord["status"],
    publishedAt: row.published_at,
    workId: row.work_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PublishRepository {
  constructor(private readonly db: Database) {}

  list(accountId?: string): PublishRecord[] {
    const rows = accountId
      ? this.db.all<Row>("SELECT * FROM publish_records WHERE account_id = ? ORDER BY created_at DESC", [
          accountId,
        ])
      : this.db.all<Row>("SELECT * FROM publish_records ORDER BY created_at DESC");
    return rows.map(toRecord);
  }

  get(id: string): PublishRecord | undefined {
    const row = this.db.get<Row>("SELECT * FROM publish_records WHERE id = ?", [id]);
    return row ? toRecord(row) : undefined;
  }

  save(input: PublishRecordInput, platformId: PlatformId): PublishRecord {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    const status = input.status ?? existing?.status ?? "planned";
    const publishedAt =
      status === "published" ? (existing?.publishedAt ?? now) : (existing?.publishedAt ?? null);
    this.db.run(
      `INSERT INTO publish_records (id, account_id, platform_id, asset_ids_json, title, description, tags_json, scheduled_at, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET asset_ids_json = excluded.asset_ids_json, title = excluded.title, description = excluded.description,
         tags_json = excluded.tags_json, scheduled_at = excluded.scheduled_at, status = excluded.status, published_at = excluded.published_at,
         updated_at = excluded.updated_at`,
      [
        id,
        input.accountId,
        platformId,
        JSON.stringify(input.assetIds),
        input.title,
        input.description ?? "",
        JSON.stringify(input.tags ?? []),
        input.scheduledAt ?? null,
        status,
        publishedAt,
        existing?.createdAt ?? now,
        now,
      ],
    );
    return this.get(id)!;
  }

  upsertRaw(record: PublishRecord): void {
    this.db.run(
      `INSERT INTO publish_records (id, account_id, platform_id, asset_ids_json, title, description, tags_json, scheduled_at, status, published_at, work_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        record.id,
        record.accountId,
        record.platformId,
        JSON.stringify(record.assetIds),
        record.title,
        record.description,
        JSON.stringify(record.tags),
        record.scheduledAt ?? null,
        record.status,
        record.publishedAt ?? null,
        record.workId ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM publish_records WHERE id = ?", [id]).changes > 0;
  }
}
