import { randomUUID } from "node:crypto";
import type { Database } from "@main/db/database";
import {
  webIdentitySchema,
  globalWorkSchema,
  globalPublishRecordSchema,
  globalPublishInputSchema,
  webCollectJobSchema,
  type WebIdentity,
  type GlobalWork,
  type GlobalPublishInput,
  type GlobalPublishRecord,
  type WebCollectJob,
} from "@shared/global-workspace";
import type { GlobalPlatformId } from "@shared/platforms";

export class GlobalWorkspaceRepository {
  constructor(readonly db: Database) {}
  identity(id: string): WebIdentity | null {
    const row = this.db.get("SELECT identity_json FROM global_web_identity WHERE account_id=?", [id]);
    return row ? webIdentitySchema.parse(JSON.parse(String(row.identity_json))) : null;
  }
  saveIdentity(id: string, identity: WebIdentity): void {
    this.db.run(
      "INSERT INTO global_web_identity(account_id,identity_json) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET identity_json=excluded.identity_json",
      [id, JSON.stringify(webIdentitySchema.parse(identity))],
    );
  }
  works(id: string, subjectId = this.identity(id)?.subjectId): GlobalWork[] {
    if (!subjectId)
      subjectId = this.db.get(
        "SELECT subject_id FROM global_web_works WHERE account_id=? ORDER BY json_extract(work_json,'$.capturedAt') DESC LIMIT 1",
        [id],
      )?.subject_id as string | undefined;
    if (!subjectId) return [];
    return this.db
      .all(
        "SELECT work_json FROM global_web_works WHERE account_id=? AND subject_id=? ORDER BY json_extract(work_json,'$.capturedAt') DESC LIMIT 30",
        [id, subjectId],
      )
      .map((row) => globalWorkSchema.parse(JSON.parse(String(row.work_json))));
  }
  saveWorks(works: GlobalWork[]): void {
    this.db.transaction(() => {
      for (const row of works) {
        const work = globalWorkSchema.parse(row);
        this.db.run(
          "INSERT INTO global_web_works(account_id,subject_id,remote_id,work_json) VALUES (?,?,?,?) ON CONFLICT(account_id,subject_id,remote_id) DO UPDATE SET work_json=excluded.work_json",
          [work.accountId, work.subjectId, work.remoteId, JSON.stringify(work)],
        );
      }
    });
  }
  publishList(accountId?: string): GlobalPublishRecord[] {
    return (
      accountId
        ? this.db.all(
            "SELECT record_json FROM global_publish_records WHERE account_id=? ORDER BY updated_at DESC",
            [accountId],
          )
        : this.db.all("SELECT record_json FROM global_publish_records ORDER BY updated_at DESC")
    ).map((row) => globalPublishRecordSchema.parse(JSON.parse(String(row.record_json))));
  }
  publishSave(raw: GlobalPublishInput, platformId: GlobalPlatformId): GlobalPublishRecord {
    const input = globalPublishInputSchema.parse(raw),
      now = new Date().toISOString();
    const row = input.id
      ? this.db.get("SELECT account_id,record_json FROM global_publish_records WHERE id=?", [input.id])
      : undefined;
    if (row && row.account_id !== input.accountId) throw new Error("发布计划不属于当前账号");
    const existing = row ? globalPublishRecordSchema.parse(JSON.parse(String(row.record_json))) : undefined;
    const record = globalPublishRecordSchema.parse({
      ...input,
      id: input.id ?? randomUUID(),
      platformId,
      description: input.description ?? "",
      tags: input.tags ?? [],
      status: input.status ?? "planned",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.db.run(
      "INSERT INTO global_publish_records(id,account_id,record_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at",
      [record.id, record.accountId, JSON.stringify(record), now],
    );
    return record;
  }
  publishDelete(id: string): void {
    this.db.run("DELETE FROM global_publish_records WHERE id=?", [id]);
  }
  jobs(accountId?: string): WebCollectJob[] {
    return (
      accountId
        ? this.db.all(
            "SELECT job_json FROM global_web_collect_jobs WHERE account_id=? ORDER BY updated_at DESC LIMIT 100",
            [accountId],
          )
        : this.db.all("SELECT job_json FROM global_web_collect_jobs ORDER BY updated_at DESC LIMIT 200")
    ).map((row) => webCollectJobSchema.parse(JSON.parse(String(row.job_json))));
  }
  job(id: string): WebCollectJob | null {
    const row = this.db.get("SELECT job_json FROM global_web_collect_jobs WHERE id=?", [id]);
    return row ? webCollectJobSchema.parse(JSON.parse(String(row.job_json))) : null;
  }
  saveJob(job: WebCollectJob): void {
    const row = webCollectJobSchema.parse(job);
    this.db.run(
      "INSERT INTO global_web_collect_jobs(id,account_id,state,job_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,job_json=excluded.job_json,updated_at=excluded.updated_at",
      [row.id, row.accountId, row.state, JSON.stringify(row), row.updatedAt],
    );
    this.db.run(
      "DELETE FROM global_web_collect_jobs WHERE state IN ('done','failed','cancelled') AND id NOT IN (SELECT id FROM global_web_collect_jobs ORDER BY updated_at DESC LIMIT 500)",
    );
  }
}
