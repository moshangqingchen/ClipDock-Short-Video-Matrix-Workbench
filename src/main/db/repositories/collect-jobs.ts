import { randomUUID } from "node:crypto";
import { isCnPlatformId } from "@shared/platforms";
import { initialProgress, isActiveCollectJob, type CollectionProgress, type CollectJob, type CollectJobState } from "@shared/collect-jobs";
import type { Database } from "../database";

interface JobRow extends Record<string, unknown> {
  progress_json: string | null;
  not_before: number;
  paused: number;
  id: string;
  account_id: string;
  trigger_kind: CollectJob["trigger"];
  state: CollectJobState;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
  run_id: number | null;
  attempts: number;
}
const toJob = (row: JobRow): CollectJob => ({
  ...(row.progress_json ? { progress: JSON.parse(row.progress_json) as CollectionProgress } : {}),
  notBefore: Number(row.not_before ?? 0),
  paused: row.paused === 1,
  id: row.id,
  accountId: row.account_id,
  trigger: row.trigger_kind,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  message: row.message,
  runId: row.run_id,
  attempts: row.attempts,
});

/** Only data collection/keepalive jobs are persisted, never navigation or publishing intents. */
export class CollectJobsRepository {
  constructor(private readonly db: Database) {}

  get(id: string): CollectJob | null {
    const row = this.db.get<JobRow>("SELECT * FROM cn_jobs WHERE id = ?", [id]);
    return row ? toJob(row) : null;
  }

  list(accountId?: string, activeOnly = false, limit = 200): CollectJob[] {
    const where = [
      accountId ? "account_id = ?" : "1 = 1",
      activeOnly ? "state IN ('queued','waiting-network','running')" : "1 = 1",
    ].join(" AND ");
    const order = activeOnly
      ? "updated_at ASC, rowid ASC"
      : "CASE WHEN state IN ('queued','waiting-network','running') THEN 0 ELSE 1 END, created_at DESC, rowid DESC";
    return this.db
      .all<JobRow>(
        `SELECT * FROM cn_jobs WHERE ${where} ORDER BY ${order} LIMIT ?`,
        accountId ? [accountId, limit] : [limit],
      )
      .map(toJob);
  }

  enqueue(accountId: string, trigger: CollectJob["trigger"], waiting: boolean, scope: CollectionProgress["scope"] = "recent"): CollectJob {
    return this.db.transaction(() => {
      const account = this.db.get<{ platform_id: string }>("SELECT platform_id FROM accounts WHERE id = ?", [
        accountId,
      ]);
      if (!account || !isCnPlatformId(account.platform_id)) throw new Error("国内账号不存在");
      const existing = this.list(accountId, true, 1)[0];
      if (existing) {
        if (scope === "history" && existing.progress?.scope !== "history" && existing.progress?.scope !== "analytics") {
          const progress = { ...(existing.progress ?? initialProgress()), scope: "history" as const, cutoff: null };
          this.db.run("UPDATE cn_jobs SET progress_json=? WHERE id=?", [JSON.stringify(progress), existing.id]);
        }
        const rank = { keepalive: 0, scheduled: 1, login: 2, manual: 3 };
        if (rank[trigger] > rank[existing.trigger]) {
          this.db.run("UPDATE cn_jobs SET trigger_kind = ?, updated_at = ? WHERE id = ?", [
            trigger,
            new Date().toISOString(),
            existing.id,
          ]);
        }
        return this.get(existing.id)!;
      }
      const id = randomUUID(),
        now = new Date().toISOString();
      this.db.run(
        "INSERT INTO cn_jobs (id,account_id,trigger_kind,state,created_at,updated_at,message,progress_json) VALUES (?,?,?,?,?,?,?,?)",
        [
          id,
          accountId,
          trigger,
          waiting ? "waiting-network" : "queued",
          now,
          now,
          waiting ? "等待国内网络" : null,
          trigger === "keepalive" ? null : JSON.stringify(initialProgress(scope)),
        ],
      );
      return this.get(id)!;
    });
  }

  checkpoint(id: string, progress: CollectionProgress): void {
    const current = this.get(id);
    if (!current || current.state !== "running" || current.paused) throw new Error("COLLECTION_NO_LONGER_RUNNING");
    // A history request can join a running recent refresh.
    if (current.progress?.scope === "history") { progress.scope = "history"; progress.cutoff = null; }
    this.db.run("UPDATE cn_jobs SET progress_json=?,updated_at=? WHERE id=?", [JSON.stringify(progress), new Date().toISOString(), id]);
  }
  defer(id: string, until: number, message: string): CollectJob | null {
    this.db.run("UPDATE cn_jobs SET not_before=? WHERE id=? AND state='running'", [until, id]);
    return this.transition(id, ["running"], "queued", message);
  }
  pause(id: string, paused: boolean): CollectJob | null {
    const job = this.get(id);
    if (!job || !isActiveCollectJob(job)) return job;
    this.db.run("UPDATE cn_jobs SET paused=?,state=CASE WHEN state='running' THEN 'queued' ELSE state END, updated_at=? WHERE id=?",
      [paused ? 1 : 0, new Date().toISOString(), id]);
    return this.get(id);
  }
  lastHistoryAt(accountId: string): string | null {
    return this.db.get<{ finished_at: string }>("SELECT finished_at FROM cn_jobs WHERE account_id=? AND state='done' AND json_extract(progress_json,'$.scope')='history' AND json_extract(progress_json,'$.complete')=1 ORDER BY finished_at DESC LIMIT 1", [accountId])?.finished_at ?? null;
  }
  lastHistoryAttemptAt(accountId: string): string | null {
    return this.db.get<{ at: string | null }>("SELECT MAX(COALESCE(started_at,created_at)) AS at FROM cn_jobs WHERE account_id=? AND json_extract(progress_json,'$.scope')='history'", [accountId])?.at ?? null;
  }

  recheckCursor(id: string): void {
    const job = this.get(id);
    if (!job || job.state !== "failed" || !job.progress || !/重复页|游标/.test(job.progress.reason ?? "")) return;
    const progress: CollectionProgress = { ...job.progress, page: 1, cursor: "", variant: undefined, fingerprints: [], complete: false,
      reason: "重新核对分页，已采作品与去重记录保留" };
    this.db.run("UPDATE cn_jobs SET progress_json=? WHERE id=? AND state='failed'", [JSON.stringify(progress), id]);
  }

  /** A compare-and-set prevents a cancelled or completed task from being resurrected. */
  transition(
    id: string,
    from: readonly CollectJobState[],
    state: CollectJobState,
    message: string | null = null,
    runId: number | null = null,
  ): CollectJob | null {
    if (!from.length) return null;
    const now = new Date().toISOString();
    const terminal = state === "done" || state === "failed" || state === "cancelled";
    const result = this.db.run(
      `UPDATE cn_jobs SET state = ?, updated_at = ?, message = ?, run_id = COALESCE(?,run_id),
      started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
      attempts = attempts + CASE WHEN ? = 'running' THEN 1 ELSE 0 END,
      finished_at = ? WHERE id = ? AND state IN (${from.map(() => "?").join(",")})`,
      [state, now, message, runId, state, now, state, terminal ? now : null, id, ...from],
    );
    return result.changes ? this.get(id) : null;
  }

  cancel(id: string): CollectJob | null {
    const job = this.get(id);
    if (!job || !isActiveCollectJob(job)) return job;
    return this.transition(id, ["queued", "waiting-network", "running"], "cancelled", "已取消");
  }

  recoverInterrupted(): void {
    this.db.run(
      "UPDATE cn_jobs SET state = 'waiting-network', updated_at = ?, message = '重启后等待网络与登录状态确认' WHERE state IN ('queued','running')",
      [new Date().toISOString()],
    );
  }
}
