import type {
  Account,
  AccountMetricsView,
  MetricDelta,
  MetricName,
  OverviewView,
  PlatformSummaryView,
} from "@shared/types";
import { METRIC_NAMES } from "@shared/types";
import { PLATFORM_IDS, type PlatformId } from "@shared/platforms";
import type { Store } from "@main/db";

const ACCOUNT_METRICS: readonly MetricName[] = [
  "followers",
  "following",
  "likes",
  "comments",
  "plays",
  "shares",
  "favorites",
  "works",
];
const TOTAL_METRICS: readonly MetricName[] = [
  "followers",
  "likes",
  "comments",
  "plays",
  "shares",
  "favorites",
  "works",
];

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** Local-time start of the day `daysAgo` days back, as an ISO (UTC) string. */
function startOfLocalDayIso(daysAgo: number, now = Date.now()): string {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

function delta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return current - previous;
}

export class ReadModel {
  constructor(private readonly store: Store) {}

  account(accountId: string, days = 30): AccountMetricsView {
    const account = this.store.accounts.get(accountId);
    if (!account) throw new Error("账号不存在");
    const latest = this.store.metrics.latest(accountId);
    const now = Date.now();
    const metrics: Partial<Record<MetricName, MetricDelta>> = {};
    let capturedAt: string | null = null;
    for (const metric of ACCOUNT_METRICS) {
      const current = latest.get(metric);
      if (!current) continue;
      if (capturedAt === null || current.capturedAt > capturedAt) capturedAt = current.capturedAt;
      // "今日" is measured against the last value before local midnight; when
      // the account was first collected today, the day's earliest snapshot is
      // the baseline so a fresh account shows +0 rather than "—".
      const baseline = (daysAgo: number) => {
        const boundary = startOfLocalDayIso(daysAgo, now);
        return (
          this.store.metrics.valueAt(accountId, metric, boundary) ??
          this.store.metrics.firstValueSince(accountId, metric, boundary)
        );
      };
      metrics[metric] = {
        current: current.value,
        day: delta(current.value, baseline(0)),
        week: delta(current.value, baseline(6)),
        month: delta(current.value, baseline(29)),
      };
    }
    const since = isoDaysAgo(days, now);
    const followers = this.store.metrics.dailySeries(accountId, "followers", since);
    const likes = this.store.metrics.dailySeries(accountId, "likes", since);
    const plays = this.store.metrics.dailySeries(accountId, "plays", since);
    const dates = new Set([...followers, ...likes, ...plays].map((p) => p.date));
    const byDate = (series: Array<{ date: string; value: number }>) =>
      new Map(series.map((p) => [p.date, p.value]));
    const f = byDate(followers);
    const l = byDate(likes);
    const p = byDate(plays);
    const trend = [...dates].sort().map((date) => ({
      date,
      followers: f.get(date) ?? null,
      likes: l.get(date) ?? null,
      plays: p.get(date) ?? null,
    }));
    return {
      accountId,
      platformId: account.platformId,
      capturedAt,
      metrics,
      trend: fillForward(trend),
      lastRun: this.store.metrics.lastRun(accountId),
    };
  }

  platform(platformId: PlatformId, days = 30): PlatformSummaryView {
    const accounts = this.store.accounts.list().filter((a) => a.platformId === platformId);
    return this.summarize(platformId, accounts, days);
  }

  overview(days = 30): OverviewView {
    const accounts = this.store.accounts.list();
    const platforms = PLATFORM_IDS.map((id) =>
      this.summarize(
        id,
        accounts.filter((a) => a.platformId === id),
        days,
      ),
    ).filter((p) => p.accountCount > 0);
    const totals: Partial<Record<MetricName, number>> = {};
    const dayDelta: Partial<Record<MetricName, number>> = {};
    for (const platform of platforms) {
      for (const metric of TOTAL_METRICS) {
        if (platform.totals[metric] != null)
          totals[metric] = (totals[metric] ?? 0) + (platform.totals[metric] ?? 0);
        if (platform.dayDelta[metric] != null)
          dayDelta[metric] = (dayDelta[metric] ?? 0) + (platform.dayDelta[metric] ?? 0);
      }
    }
    const attention = accounts
      .filter((a) => a.status === "offline" || a.status === "needs_verification" || a.status === "expiring")
      .map((a) => ({
        accountId: a.id,
        displayName: a.displayName,
        platformId: a.platformId,
        status: a.status,
        message: a.statusMessage ?? "",
      }));
    return {
      accountCount: accounts.length,
      onlineCount: accounts.filter((a) => a.status === "online" || a.status === "expiring").length,
      attentionCount: attention.length,
      totals,
      dayDelta,
      platforms,
      trend: this.globalTrend(accounts, days),
      attention,
    };
  }

  private summarize(platformId: PlatformId, accounts: Account[], days: number): PlatformSummaryView {
    const now = Date.now();
    const totals: Partial<Record<MetricName, number>> = {};
    const dayDelta: Partial<Record<MetricName, number>> = {};
    const rows = accounts.map((account) => {
      const view = this.account(account.id, Math.min(days, 14));
      for (const metric of TOTAL_METRICS) {
        const value = view.metrics[metric];
        if (!value || value.current == null) continue;
        totals[metric] = (totals[metric] ?? 0) + value.current;
        if (value.day != null) dayDelta[metric] = (dayDelta[metric] ?? 0) + value.day;
      }
      const spark = view.trend.map((point) => point.followers ?? 0).slice(-14);
      return {
        accountId: account.id,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        status: account.status,
        metrics: view.metrics,
        capturedAt: view.capturedAt,
        spark,
      };
    });
    void now;
    return {
      platformId,
      accountCount: accounts.length,
      onlineCount: accounts.filter((a) => a.status === "online" || a.status === "expiring").length,
      totals,
      dayDelta,
      accounts: rows,
    };
  }

  private globalTrend(accounts: Account[], days: number): OverviewView["trend"] {
    const since = isoDaysAgo(days);
    const perDate = new Map<string, { followers: number; likes: number; plays: number }>();
    const dates = new Set<string>();
    const series = accounts.map((account) => ({
      followers: fillMap(this.store.metrics.dailySeries(account.id, "followers", since)),
      likes: fillMap(this.store.metrics.dailySeries(account.id, "likes", since)),
      plays: fillMap(this.store.metrics.dailySeries(account.id, "plays", since)),
    }));
    for (const s of series)
      for (const map of [s.followers, s.likes, s.plays]) for (const date of map.keys()) dates.add(date);
    const sorted = [...dates].sort();
    for (const date of sorted) {
      const point = { followers: 0, likes: 0, plays: 0 };
      for (const s of series) {
        point.followers += lastAtOrBefore(s.followers, date);
        point.likes += lastAtOrBefore(s.likes, date);
        point.plays += lastAtOrBefore(s.plays, date);
      }
      perDate.set(date, point);
    }
    return sorted.map((date) => ({ date, ...perDate.get(date)! }));
  }
}

function fillMap(series: Array<{ date: string; value: number }>): Map<string, number> {
  return new Map(series.map((p) => [p.date, p.value]));
}

function lastAtOrBefore(map: Map<string, number>, date: string): number {
  let best: number | null = null;
  let bestDate = "";
  for (const [d, v] of map) {
    if (d <= date && d >= bestDate) {
      best = v;
      bestDate = d;
    }
  }
  return best ?? 0;
}

/** Carry forward the last known value so charts have no holes. */
function fillForward<T extends { followers: number | null; likes: number | null; plays: number | null }>(
  points: T[],
): T[] {
  let f: number | null = null;
  let l: number | null = null;
  let p: number | null = null;
  return points.map((point) => {
    f = point.followers ?? f;
    l = point.likes ?? l;
    p = point.plays ?? p;
    return { ...point, followers: f, likes: l, plays: p };
  });
}

export { METRIC_NAMES };
