import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@main/db/database";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { globalJobSchema, isActiveGlobalJob, type GlobalJob, type GlobalJobState } from "@shared/global-jobs";
import { GLOBAL_READ_ERRORS, type GlobalReadErrorCode } from "@shared/global-read";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";

export interface StoredGlobalJob {
  job: GlobalJob;
  bindingHash: string;
}
const ACTIVE = "state IN ('queued','waiting-proxy','running')";
function fail(code: GlobalReadErrorCode = "GLOBAL_READ_SAVE_FAILED"): never {
  throw new Error(code);
}
function fixed<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && GLOBAL_READ_ERRORS.some((code) => code === error.message)) throw error;
    return fail();
  }
}
function id(value: string): void {
  if (!globalAccountIdSchema.safeParse(value).success) fail("GLOBAL_READ_INPUT_INVALID");
}
function fromRow(row: Record<string, unknown>): StoredGlobalJob {
  const parsed = globalJobSchema.safeParse({
    id: row.id,
    accountId: row.account_id,
    platformId: row.platform_id,
    kind: row.kind,
    state: row.state,
    errorCode: row.error_code,
    revision: row.revision,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  });
  if (!parsed.success || typeof row.binding_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.binding_hash))
    return fail("GLOBAL_READ_UNAVAILABLE");
  return { job: parsed.data, bindingHash: row.binding_hash };
}

/** The private binding is neither a credential nor proof of a usable route. Never project it. */
export class GlobalJobsRepository {
  constructor(private readonly db: Database) {}

  binding(accountId: string): { platformId: GlobalJob["platformId"]; hash: string } {
    id(accountId);
    return fixed(() => {
      const account = new GlobalAccountRepository(this.db).get(accountId);
      if (!account || account.authStatus !== "authorized" || !account.remoteId)
        fail("GLOBAL_READ_UNAUTHORIZED");
      const app = new GlobalAppRepository(this.db).get(account.platformId);
      if (!app) fail("GLOBAL_READ_UNAVAILABLE");
      const revision = this.db.get("SELECT grant_revision FROM global_accounts WHERE id = ?", [
        accountId,
      ])?.grant_revision;
      if (
        typeof revision !== "string" ||
        !/^[a-f0-9-]{32,36}$/.test(revision) ||
        !this.db.get("SELECT 1 AS present FROM credentials WHERE kind = 'oauth_token' AND owner_id = ?", [
          accountId,
        ])
      )
        fail("GLOBAL_READ_REAUTHORIZE");
      const secret = this.db.get(
        "SELECT id,ciphertext,encryption_version,created_at,updated_at FROM credentials WHERE kind = 'oauth_client_secret' AND owner_id = ?",
        [app.id],
      );
      return {
        platformId: account.platformId,
        hash: createHash("sha256")
          .update(
            JSON.stringify({
              accountId,
              remoteId: account.remoteId,
              platformId: account.platformId,
              revision,
              app,
              secret: secret ?? null,
            }),
          )
          .digest("hex"),
      };
    });
  }
  get(jobId: string): StoredGlobalJob | null {
    id(jobId);
    return fixed(() => {
      const row = this.db.get("SELECT * FROM global_jobs WHERE id = ?", [jobId]);
      return row ? fromRow(row) : null;
    });
  }
  list(accountId: string): GlobalJob[] {
    id(accountId);
    return fixed(() =>
      this.db
        .all(
          `SELECT * FROM global_jobs WHERE account_id = ? ORDER BY CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END, rowid DESC LIMIT 20`,
          [accountId],
        )
        .map((row) => fromRow(row).job),
    );
  }
  active(): StoredGlobalJob[] {
    return fixed(() =>
      this.db.all(`SELECT * FROM global_jobs WHERE ${ACTIVE} ORDER BY rowid ASC`).map(fromRow),
    );
  }
  submit(accountId: string): GlobalJob {
    return fixed(() =>
      this.db.transaction(() => {
        const binding = this.binding(accountId);
        const existing = this.active().find((item) => item.job.accountId === accountId);
        if (existing?.bindingHash === binding.hash) return existing.job;
        if (existing) this.transition(existing, "cancelled", "GLOBAL_READ_CANCELLED");
        const now = new Date().toISOString(),
          jobId = randomUUID();
        const result = this.db.run(
          "INSERT INTO global_jobs (id,account_id,platform_id,kind,binding_hash,state,error_code,created_at,updated_at) VALUES (?,?,?,'read',?,'waiting-proxy','GLOBAL_READ_WAITING_PROXY',?,?)",
          [jobId, accountId, binding.platformId, binding.hash, now, now],
        );
        const saved = this.get(jobId);
        if (
          result.changes !== 1 ||
          !saved ||
          saved.bindingHash !== binding.hash ||
          saved.job.accountId !== accountId ||
          saved.job.state !== "waiting-proxy"
        )
          return fail();
        this.audit(saved.job);
        this.prune(accountId);
        return saved.job;
      }),
    );
  }
  /** Revision CAS and an irreversible terminal state keep old completions from resurrecting work. */
  transition(
    previous: StoredGlobalJob,
    state: GlobalJobState,
    errorCode: GlobalReadErrorCode | null = null,
  ): StoredGlobalJob | null {
    return fixed(() =>
      this.db.transaction(() => {
        const live = this.get(previous.job.id);
        if (!live || live.job.revision !== previous.job.revision || !isActiveGlobalJob(live.job)) return null;
        const now = new Date().toISOString();
        const next = globalJobSchema.parse({
          ...live.job,
          state,
          errorCode,
          revision: live.job.revision + 1,
          attempts: live.job.attempts + (state === "running" ? 1 : 0),
          updatedAt: now,
          finishedAt: ["done", "failed", "cancelled"].includes(state) ? now : null,
        });
        const result = this.db.run(
          `UPDATE global_jobs SET state=?, error_code=?, revision=?, attempts=?, updated_at=?, finished_at=? WHERE id=? AND revision=? AND ${ACTIVE}`,
          [
            next.state,
            next.errorCode,
            next.revision,
            next.attempts,
            next.updatedAt,
            next.finishedAt,
            next.id,
            live.job.revision,
          ],
        );
        const saved = this.get(next.id);
        if (
          result.changes !== 1 ||
          !saved ||
          JSON.stringify(saved.job) !== JSON.stringify(next) ||
          saved.bindingHash !== live.bindingHash
        )
          return fail();
        this.audit(saved.job);
        if (!isActiveGlobalJob(saved.job)) this.prune(saved.job.accountId);
        return saved;
      }),
    );
  }
  assertCurrent(item: StoredGlobalJob): void {
    const current = this.get(item.job.id);
    if (
      !current ||
      current.job.revision !== item.job.revision ||
      current.job.state !== "running" ||
      this.binding(item.job.accountId).hash !== item.bindingHash
    )
      fail("GLOBAL_READ_CANCELLED");
  }
  recover(): void {
    fixed(() =>
      this.db.transaction(() => {
        for (const item of this.active()) this.transition(item, "waiting-proxy", "GLOBAL_READ_WAITING_PROXY");
      }),
    );
  }
  private prune(accountId: string): void {
    this.db.run(
      `DELETE FROM global_jobs WHERE id IN (SELECT id FROM global_jobs WHERE account_id = ? AND NOT (${ACTIVE}) ORDER BY rowid DESC LIMIT -1 OFFSET 20)`,
      [accountId],
    );
  }
  private audit(job: GlobalJob): void {
    const details = JSON.stringify({
      jobId: job.id,
      kind: job.kind,
      state: job.state,
      revision: job.revision,
      errorCode: job.errorCode,
    });
    const result = this.db.run(
      "INSERT INTO audit_events (action,account_id,details_json,created_at) VALUES ('GlobalJob',?,?,?)",
      [job.accountId, details, job.updatedAt],
    );
    const row = this.db.get(
      "SELECT action,account_id,details_json,created_at FROM audit_events WHERE id = ?",
      [result.lastInsertRowid],
    );
    if (
      result.changes !== 1 ||
      row?.action !== "GlobalJob" ||
      row.account_id !== job.accountId ||
      row.details_json !== details ||
      row.created_at !== job.updatedAt
    )
      fail();
  }
}
