import type { CollectRun, MetricName, MetricSnapshot, Work, MetricOrigin, WorkMetric } from "@shared/types";
import { METRIC_NAMES, WORK_METRICS } from "@shared/types";
import type { PlatformId } from "@shared/platforms";
import type { Database } from "../database";

interface SnapshotRow extends Record<string, unknown> {
  id: number;
  account_id: string;
  platform_id: string;
  metric: string;
  value: number;
  captured_at: string;
  source: string;
  work_id: string | null;
  origin: MetricOrigin;
}

interface WorkRow extends Record<string, unknown> {
  observations_json: string | null;
  id: string;
  account_id: string;
  platform_id: string;
  remote_id: string;
  title: string;
  cover_url: string | null;
  url: string | null;
  published_at: string | null;
  status: string | null;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
  fetched_at: string;
}

interface RunRow extends Record<string, unknown> {
  id: number;
  account_id: string;
  platform_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger_kind: string;
  message: string | null;
  metrics_written: number;
  works_written: number;
}

function toSnapshot(row: SnapshotRow): MetricSnapshot {
  return {
    id: Number(row.id),
    accountId: row.account_id,
    platformId: row.platform_id as PlatformId,
    metric: row.metric as MetricName,
    value: Number(row.value),
    capturedAt: row.captured_at,
    source: row.source as MetricSnapshot["source"],
    workId: row.work_id,
    origin: row.origin ?? "legacy",
  };
}

function toWork(row: WorkRow): Work {
  return {
    ...(row.observations_json ? { observations: JSON.parse(row.observations_json) as Work["observations"] } : {}),
    id: row.id,
    accountId: row.account_id,
    platformId: row.platform_id as PlatformId,
    remoteId: row.remote_id,
    title: row.title,
    coverUrl: row.cover_url,
    url: row.url,
    publishedAt: row.published_at,
    status: row.status,
    plays: Number(row.plays),
    likes: Number(row.likes),
    comments: Number(row.comments),
    shares: Number(row.shares),
    favorites: Number(row.favorites),
    fetchedAt: row.fetched_at,
  };
}

function toRun(row: RunRow): CollectRun {
  return {
    id: Number(row.id),
    accountId: row.account_id,
    platformId: row.platform_id as PlatformId,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as CollectRun["status"],
    trigger: row.trigger_kind as CollectRun["trigger"],
    message: row.message,
    metricsWritten: Number(row.metrics_written),
    worksWritten: Number(row.works_written),
  };
}

export class MetricsRepository {
  constructor(private readonly db: Database) {}

  saveSnapshots(snapshots: readonly MetricSnapshot[], deduplicate = false): number {
    if (snapshots.length === 0) return 0;
    return this.db.transaction(() => {
      let written = 0;
      for (const s of snapshots) {
        if (!METRIC_NAMES.includes(s.metric) || !Number.isFinite(s.value)) continue;
        if (deduplicate && this.db.get("SELECT id FROM metric_snapshots WHERE account_id=? AND metric=? AND captured_at=? AND source=? AND work_id IS ? AND value=? LIMIT 1",
          [s.accountId, s.metric, s.capturedAt, s.source, s.workId ?? null, s.value])) continue;
        this.db.run(
          `INSERT INTO metric_snapshots (account_id, platform_id, metric, value, captured_at, source, work_id, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.accountId, s.platformId, s.metric, s.value, s.capturedAt, s.source, s.workId ?? null, s.origin ?? "legacy"],
        );
        written += 1;
      }
      return written;
    });
  }

  /** Latest account-level value per metric. */
  workSummary(accountId: string): { count: number; capturedAt: string | null; totals: Partial<Record<WorkMetric, number>> } {
    const summary = this.db.get<{ count: number; capturedAt: string | null }>("SELECT COUNT(*) AS count,MAX(fetched_at) AS capturedAt FROM works WHERE account_id=?", [accountId]);
    const count = Number(summary?.count ?? 0);
    const row = this.db.get<Record<WorkMetric, number | null>>(`SELECT ${WORK_METRICS.map((metric) =>
      `SUM(CASE WHEN observations_json IS NULL OR json_extract(observations_json, '$.${metric}') IS NOT NULL THEN ${metric} END) AS ${metric}`,
    ).join(",")} FROM works WHERE account_id=?`, [accountId]);
    return { count, capturedAt: summary?.capturedAt ?? null, totals: Object.fromEntries(WORK_METRICS.filter((metric) => row?.[metric] != null).map((metric) => [metric, Number(row![metric])])) };
  }

  latest(accountId: string): Map<MetricName, { value: number; capturedAt: string; origin: MetricOrigin }> {
    const rows = this.db.all<SnapshotRow>(
      `SELECT m.* FROM metric_snapshots m
       INNER JOIN (
         SELECT metric, MAX(captured_at) AS captured_at FROM metric_snapshots
         WHERE account_id = ? AND work_id IS NULL GROUP BY metric
       ) latest ON latest.metric = m.metric AND latest.captured_at = m.captured_at
       WHERE m.account_id = ? AND m.work_id IS NULL`,
      [accountId, accountId],
    );
    const map = new Map<MetricName, { value: number; capturedAt: string; origin: MetricOrigin }>();
    for (const row of rows)
      map.set(row.metric as MetricName, { value: Number(row.value), capturedAt: row.captured_at, origin: row.origin });
    return map;
  }

  /** Most recent value captured at or before `beforeIso`. */
  valueAt(accountId: string, metric: MetricName, beforeIso: string): number | null {
    const row = this.db.get<{ value: number }>(
      `SELECT value FROM metric_snapshots WHERE account_id = ? AND metric = ? AND work_id IS NULL AND captured_at <= ?
       ORDER BY captured_at DESC LIMIT 1`,
      [accountId, metric, beforeIso],
    );
    return row ? Number(row.value) : null;
  }

  /** Earliest value captured at or after `sinceIso`. */
  firstValueSince(accountId: string, metric: MetricName, sinceIso: string): number | null {
    const row = this.db.get<{ value: number }>(
      `SELECT value FROM metric_snapshots WHERE account_id = ? AND metric = ? AND work_id IS NULL AND captured_at >= ?
       ORDER BY captured_at ASC LIMIT 1`,
      [accountId, metric, sinceIso],
    );
    return row ? Number(row.value) : null;
  }

  /** Daily last-value series for a metric within the window. */
  dailySeries(
    accountId: string,
    metric: MetricName,
    sinceIso: string,
  ): Array<{ date: string; value: number }> {
    const rows = this.db.all<{ date: string; value: number }>(
      `SELECT date(captured_at, '+8 hours') AS date, value FROM metric_snapshots m
       WHERE account_id = ? AND metric = ? AND work_id IS NULL AND captured_at >= ?
         AND captured_at = (
           SELECT MAX(captured_at) FROM metric_snapshots
           WHERE account_id = m.account_id AND metric = m.metric AND work_id IS NULL
             AND date(captured_at, '+8 hours') = date(m.captured_at, '+8 hours')
         )
       ORDER BY date`,
      [accountId, metric, sinceIso],
    );
    return rows.map((r) => ({ date: r.date, value: Number(r.value) }));
  }

  listSnapshots(accountId?: string, limit = 5000): MetricSnapshot[] {
    const rows = accountId
      ? this.db.all<SnapshotRow>(
          "SELECT * FROM metric_snapshots WHERE account_id = ? ORDER BY captured_at DESC LIMIT ?",
          [accountId, limit],
        )
      : this.db.all<SnapshotRow>("SELECT * FROM metric_snapshots ORDER BY captured_at DESC LIMIT ?", [limit]);
    return rows.map(toSnapshot);
  }

  upsertWorks(works: readonly Work[]): number {
    if (works.length === 0) return 0;
    return this.db.transaction(() => {
      let written = 0;
      for (const incoming of works) {
        const row = this.db.get<WorkRow>("SELECT * FROM works WHERE account_id=? AND remote_id=?", [incoming.accountId, incoming.remoteId]);
        const old = row ? toWork(row) : null;
        const w = { ...incoming };
          if (old) {
            w.id = old.id;
            if (incoming.fetchedAt < old.fetchedAt) {
              w.title = old.title; w.coverUrl = old.coverUrl; w.url = old.url;
              w.publishedAt = old.publishedAt; w.status = old.status;
            }
          w.title ||= old.title;
          w.coverUrl ||= old.coverUrl;
          w.url ||= old.url;
          w.publishedAt ||= old.publishedAt;
          w.status ||= old.status;
          const observations = { ...(old.observations ?? Object.fromEntries(WORK_METRICS.map((metric) =>
            [metric, { capturedAt: old.fetchedAt, origin: "legacy" as const }]))), };
          for (const metric of WORK_METRICS) {
            const next = incoming.observations === undefined ? { capturedAt: incoming.fetchedAt, origin: "legacy" as const } : incoming.observations[metric];
            if (next && (!observations[metric] || next.capturedAt >= observations[metric]!.capturedAt)) observations[metric] = next;
            else w[metric] = old[metric];
          }
          w.observations = observations;
          w.fetchedAt = incoming.fetchedAt > old.fetchedAt ? incoming.fetchedAt : old.fetchedAt;
        }
        this.db.run(
          `INSERT INTO works (id, account_id, platform_id, remote_id, title, cover_url, url, published_at, status,
             plays, likes, comments, shares, favorites, fetched_at, observations_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, remote_id) DO UPDATE SET title = excluded.title, cover_url = excluded.cover_url,
             url = excluded.url, published_at = COALESCE(excluded.published_at, works.published_at), status = excluded.status,
             plays = excluded.plays, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
             favorites = excluded.favorites, fetched_at = excluded.fetched_at, observations_json = excluded.observations_json`,
          [
            w.id,
            w.accountId,
            w.platformId,
            w.remoteId,
            w.title,
            w.coverUrl ?? null,
            w.url ?? null,
            w.publishedAt ?? null,
            w.status ?? null,
            w.plays,
            w.likes,
            w.comments,
            w.shares,
            w.favorites,
            w.fetchedAt,
            w.observations ? JSON.stringify(w.observations) : null,
          ],
        );
        written += 1;
      }
      return written;
    });
  }

  listWorks(accountId: string, limit = 50, offset = 0): Work[] {
    return this.db
      .all<WorkRow>(
        "SELECT * FROM works WHERE account_id = ? ORDER BY COALESCE(published_at, fetched_at) DESC, id LIMIT ? OFFSET ?",
        [accountId, limit, offset],
      )
      .map(toWork);
  }

  allWorks(): Work[] {
    return this.db.all<WorkRow>("SELECT * FROM works").map(toWork);
  }

  startRun(run: Omit<CollectRun, "id" | "finishedAt" | "metricsWritten" | "worksWritten">): number {
    return this.db.run(
      `INSERT INTO collect_runs (account_id, platform_id, started_at, status, trigger_kind, message) VALUES (?, ?, ?, ?, ?, ?)`,
      [run.accountId, run.platformId, run.startedAt, run.status, run.trigger, run.message ?? null],
    ).lastInsertRowid;
  }

  finishRun(
    id: number,
    patch: Pick<CollectRun, "status" | "message" | "metricsWritten" | "worksWritten">,
  ): CollectRun {
    this.db.run(
      `UPDATE collect_runs SET finished_at = ?, status = ?, message = ?, metrics_written = ?, works_written = ? WHERE id = ?`,
      [
        new Date().toISOString(),
        patch.status,
        patch.message ?? null,
        patch.metricsWritten,
        patch.worksWritten,
        id,
      ],
    );
    return toRun(this.db.get<RunRow>("SELECT * FROM collect_runs WHERE id = ?", [id])!);
  }

  listRuns(accountId: string, limit = 20): CollectRun[] {
    return this.db
      .all<RunRow>("SELECT * FROM collect_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?", [
        accountId,
        limit,
      ])
      .map(toRun);
  }

  lastRun(accountId: string): CollectRun | null {
    const row = this.db.get<RunRow>(
      "SELECT * FROM collect_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 1",
      [accountId],
    );
    return row ? toRun(row) : null;
  }

  /** Last run that actually attempted collection (skips are not attempts). */
  lastAttemptedRun(accountId: string): CollectRun | null {
    const row = this.db.get<RunRow>(
      "SELECT * FROM collect_runs WHERE account_id = ? AND status <> 'skipped' AND trigger_kind <> 'keepalive' ORDER BY started_at DESC LIMIT 1",
      [accountId],
    );
    return row ? toRun(row) : null;
  }

  /** Attempts have their own durable clock; patrol checks must not postpone keepalive. */
  lastKeepaliveRun(accountId: string): CollectRun | null {
    const row = this.db.get<RunRow>(
      "SELECT * FROM collect_runs WHERE account_id = ? AND trigger_kind = 'keepalive' ORDER BY started_at DESC, id DESC LIMIT 1",
      [accountId],
    );
    return row ? toRun(row) : null;
  }

  /** A bounded history distinguishes confirmed checks from skipped/failed attempts after restart. */
  recentKeepaliveRuns(accountId: string): CollectRun[] {
    return this.db.all<RunRow>(
      "SELECT * FROM collect_runs WHERE account_id = ? AND trigger_kind = 'keepalive' ORDER BY started_at DESC, id DESC LIMIT 6",
      [accountId],
    ).map(toRun);
  }

  pruneRuns(keepPerAccount = 200): void {
    this.db.run(
      `DELETE FROM collect_runs WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY started_at DESC) AS rn FROM collect_runs
         ) WHERE rn > ?
       )`,
      [keepPerAccount],
    );
  }
}
