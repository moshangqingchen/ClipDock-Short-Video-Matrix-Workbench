import type {
  Account, AccountMetricsView, MetricDelta, MetricName, MetricTrendPoint,
  OverviewView, PlatformSummaryView,
} from "@shared/types";
import { METRIC_NAMES } from "@shared/types";
import { PLATFORM_IDS, type PlatformId } from "@shared/platforms";
import type { Store } from "@main/db";
import type { MetricBoundary, ObservedMetric } from "@main/db/repositories/metrics";
import { beijingDayStart } from "@shared/metric-quality";

function validateDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("时间范围须为 1–365 天的整数");
}

function emptyPoint(date: string): MetricTrendPoint {
  return { date, followers: null, following: null, likes: null, comments: null, plays: null,
    shares: null, favorites: null, works: null, coverage: {} };
}

/** Include explicit gaps between observations so charts cannot join across missing days. */
function calendarPoints(byDate: Map<string, MetricTrendPoint>): MetricTrendPoint[] {
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return [];
  const result: MetricTrendPoint[] = [];
  const last = Date.parse(dates.at(-1)! + "T00:00:00Z");
  for (let time = Date.parse(dates[0] + "T00:00:00Z"); time <= last; time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? emptyPoint(date));
  }
  return result;
}

function observedDelta(current: ObservedMetric, previous: ObservedMetric | undefined, boundary: string): number | null {
  // Stale values are not observations for this period; missing history is unknown.
  if (!previous || Date.parse(current.capturedAt) < Date.parse(boundary)) return null;
  return current.value - previous.value;
}

export class ReadModel {
  constructor(private readonly store: Store) {}

  account(accountId: string, days = 30): AccountMetricsView {
    validateDays(days);
    const account = this.store.accounts.get(accountId);
    if (!account) throw new Error("账号不存在");
    return this.readAccounts([account], days).get(accountId)!;
  }

  platform(platformId: PlatformId, days = 30): PlatformSummaryView {
    validateDays(days);
    const accounts = this.store.accounts.list().filter((a) => a.platformId === platformId);
    return this.summarize(platformId, accounts, this.readAccounts(accounts, days));
  }

  overview(days = 30): OverviewView {
    validateDays(days);
    const accounts = this.store.accounts.list();
    const views = this.readAccounts(accounts, days);
    const platforms = PLATFORM_IDS.map((id) => this.summarize(
      id, accounts.filter((a) => a.platformId === id), views,
    )).filter((p) => p.accountCount > 0);
    const totals: Partial<Record<MetricName, number>> = {};
    const dayDelta: Partial<Record<MetricName, number>> = {};
    const coverage: Partial<Record<MetricName, number>> = {};
    const dayCoverage: Partial<Record<MetricName, number>> = {};
    for (const platform of platforms) for (const metric of METRIC_NAMES) {
      if (platform.totals[metric] != null) totals[metric] = (totals[metric] ?? 0) + platform.totals[metric]!;
      if (platform.dayDelta[metric] != null) dayDelta[metric] = (dayDelta[metric] ?? 0) + platform.dayDelta[metric]!;
      if (platform.coverage?.[metric]) coverage[metric] = (coverage[metric] ?? 0) + platform.coverage[metric]!;
      if (platform.dayCoverage?.[metric]) dayCoverage[metric] = (dayCoverage[metric] ?? 0) + platform.dayCoverage[metric]!;
    }
    const attention = accounts
      .filter((a) => a.status === "offline" || a.status === "needs_verification" || a.status === "expiring")
      .map((a) => ({ accountId: a.id, displayName: a.displayName, platformId: a.platformId,
        status: a.status, message: a.statusMessage ?? "" }));
    return {
      accountCount: accounts.length,
      onlineCount: accounts.filter((a) => a.status === "online" || a.status === "expiring").length,
      attentionCount: attention.length, totals, dayDelta, coverage, dayCoverage, platforms,
      trend: this.globalTrend(views), attention,
    };
  }

  /** Four batched reads shared by account rows, summaries and all eight trends. */
  private readAccounts(accounts: Account[], days: number): Map<string, AccountMetricsView> {
    const ids = accounts.map((a) => a.id);
    const now = Date.now();
    const boundaries: Record<MetricBoundary, string> = {
      current: new Date(now).toISOString(), day: beijingDayStart(0, now),
      week: beijingDayStart(6, now), month: beijingDayStart(29, now),
    };
    const values = this.store.metrics.boundaryValues(ids, boundaries);
    const daily = this.store.metrics.dailySeriesBatch(ids, beijingDayStart(days - 1, now), boundaries.current);
    const works = this.store.metrics.workSummaries(ids);
    const runs = this.store.metrics.lastAttemptedRuns(ids);
    return new Map(accounts.map((account) => {
      const snapshots = values.get(account.id)!;
      const metrics: Partial<Record<MetricName, MetricDelta>> = {};
      let capturedAt: string | null = null;
      for (const metric of METRIC_NAMES) {
        const current = snapshots.current.get(metric);
        if (!current) continue;
        if (!capturedAt || Date.parse(current.capturedAt) > Date.parse(capturedAt)) capturedAt = current.capturedAt;
        metrics[metric] = {
          capturedAt: current.capturedAt, origin: current.origin, current: current.value,
          day: observedDelta(current, snapshots.day.get(metric), boundaries.day),
          week: observedDelta(current, snapshots.week.get(metric), boundaries.week),
          month: observedDelta(current, snapshots.month.get(metric), boundaries.month),
        };
      }
      const byDate = new Map<string, MetricTrendPoint>();
      for (const item of daily.get(account.id)!) {
        const point = byDate.get(item.date) ?? emptyPoint(item.date);
        point[item.metric] = item.value;
        point.coverage![item.metric] = 1;
        byDate.set(item.date, point);
      }
      const summary = works.get(account.id)!;
      if (summary.capturedAt && (!capturedAt || Date.parse(summary.capturedAt) > Date.parse(capturedAt))) capturedAt = summary.capturedAt;
      return [account.id, {
        accountId: account.id, platformId: account.platformId, capturedAt, metrics,
        collectedWorkCount: summary.count, workTotals: summary.totals, workCoverage: summary.coverage,
        trend: calendarPoints(byDate), lastRun: runs.get(account.id) ?? null,
      }];
    }));
  }

  private summarize(platformId: PlatformId, accounts: Account[], views: Map<string, AccountMetricsView>): PlatformSummaryView {
    const coverage: Partial<Record<MetricName, number>> = {};
    const dayCoverage: Partial<Record<MetricName, number>> = {};
    const totals: Partial<Record<MetricName, number>> = {};
    const dayDelta: Partial<Record<MetricName, number>> = {};
    const rows = accounts.map((account) => {
      const view = views.get(account.id)!;
      for (const metric of METRIC_NAMES) {
        const value = view.metrics[metric];
        if (value?.current == null) continue;
        coverage[metric] = (coverage[metric] ?? 0) + 1;
        totals[metric] = (totals[metric] ?? 0) + value.current;
        if (value.day != null) {
          dayDelta[metric] = (dayDelta[metric] ?? 0) + value.day;
          dayCoverage[metric] = (dayCoverage[metric] ?? 0) + 1;
        }
      }
      return {
        accountId: account.id, displayName: account.displayName, avatarUrl: account.avatarUrl,
        status: account.status, metrics: view.metrics, capturedAt: view.capturedAt, lastRun: view.lastRun,
        spark: view.trend.slice(-14).map((point) => point.followers),
      };
    });
    return {
      platformId, coverage, dayCoverage, accountCount: accounts.length,
      onlineCount: accounts.filter((a) => a.status === "online" || a.status === "expiring").length,
      totals, dayDelta, accounts: rows,
    };
  }

  private globalTrend(views: Map<string, AccountMetricsView>): MetricTrendPoint[] {
    const byDate = new Map<string, MetricTrendPoint>();
    for (const view of views.values()) for (const daily of view.trend) {
      const point = byDate.get(daily.date) ?? emptyPoint(daily.date);
      for (const metric of METRIC_NAMES) {
        if (daily[metric] == null) continue;
        point[metric] = (point[metric] ?? 0) + daily[metric]!;
        point.coverage![metric] = (point.coverage![metric] ?? 0) + 1;
      }
      byDate.set(daily.date, point);
    }
    return calendarPoints(byDate);
  }
}

export { METRIC_NAMES };
