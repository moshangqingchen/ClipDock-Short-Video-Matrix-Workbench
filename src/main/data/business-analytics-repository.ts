import { analyticsRecordSchema, BUSINESS_METRICS, type AnalyticsRecord, type AnalyticsState, type AnalyticsView } from "@shared/business-analytics";
import type { CnPlatformId } from "@shared/platforms";
import { beijingDay } from "@shared/metric-quality";
import type { Database } from "@main/db/database";

export class BusinessAnalyticsRepository {
  constructor(private readonly db: Database) {}
  enabled(platformId: CnPlatformId): boolean {
    return this.db.get<{ enabled: number }>("SELECT enabled FROM analytics_platforms WHERE platform_id=?", [platformId])?.enabled === 1;
  }
  setEnabled(platformId: CnPlatformId, enabled: boolean): void {
    this.db.run("INSERT INTO analytics_platforms(platform_id,enabled) VALUES(?,?) ON CONFLICT(platform_id) DO UPDATE SET enabled=excluded.enabled", [platformId, enabled ? 1 : 0]);
  }
  save(records: readonly AnalyticsRecord[]): number {
    return this.db.transaction(() => {
      let count = 0;
      for (const input of records) {
        const row = analyticsRecordSchema.parse(input);
        const platform = this.db.get<{ platform_id: string }>("SELECT platform_id FROM accounts WHERE id=?", [row.accountId])?.platform_id;
        if (platform !== row.platformId) throw new Error("经营数据账号不匹配");
        if (row.workId && !this.db.get("SELECT id FROM works WHERE id=? AND account_id=?", [row.workId, row.accountId])) throw new Error("经营数据作品不属于该账号");
        const dimension = row.data.kind === "distribution" ? row.data.dimension : row.data.kind === "money" ? row.data.currency + ":" + row.data.settlement : "";
        const key = JSON.stringify([row.metric, row.workId, row.startDate, row.endDate, row.granularity, row.platformLabel, dimension]);
        count += this.db.run(`INSERT INTO business_analytics(account_id,record_key,start_date,end_date,captured_at,record_json) VALUES(?,?,?,?,?,?)
          ON CONFLICT(account_id,record_key) DO UPDATE SET captured_at=excluded.captured_at, record_json=excluded.record_json
          WHERE excluded.captured_at >= business_analytics.captured_at`,
        [row.accountId, key, row.startDate, row.endDate, row.capturedAt, JSON.stringify(row)]).changes;
      }
      return count;
    });
  }
  status(accountId: string, states: AnalyticsState[]): void {
    this.db.run("INSERT INTO analytics_status(account_id,states_json,attempted_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET states_json=excluded.states_json, attempted_at=excluded.attempted_at",
      [accountId, JSON.stringify(states), new Date().toISOString()]);
  }
  view(accountId: string, days = 90): AnalyticsView {
    const account = this.db.get<{ platform_id: CnPlatformId }>("SELECT platform_id FROM accounts WHERE id=?", [accountId]);
    if (!account) throw new Error("账号不存在");
    const requestedStart = beijingDay(Date.now() - (days - 1) * 86400_000), requestedEnd = beijingDay();
    const state = this.db.get<{ states_json: string; attempted_at: string }>("SELECT states_json,attempted_at FROM analytics_status WHERE account_id=?", [accountId]);
    const enabled = this.enabled(account.platform_id);
    return { accountId, platformId: account.platform_id, enabled, requestedStart, requestedEnd,
      recordsTotal: Number(this.db.get("SELECT COUNT(*) AS n FROM business_analytics WHERE account_id=? AND end_date>=? AND start_date<=?", [accountId, requestedStart, requestedEnd])?.n ?? 0),
      records: this.db.all<{ record_json: string }>("SELECT record_json FROM business_analytics WHERE account_id=? AND end_date>=? AND start_date<=? ORDER BY end_date DESC,captured_at DESC LIMIT 5000", [accountId, requestedStart, requestedEnd]).map((r) => analyticsRecordSchema.parse(JSON.parse(r.record_json))),
      states: enabled && state ? JSON.parse(state.states_json) as AnalyticsState[] : BUSINESS_METRICS.map((metric) => ({ metric,
        state: enabled ? "pending-validation" : "disabled", reason: enabled ? "等待官方分析页面提供带日期和单位的数据" : "该平台尚未启用经营观测", checkedAt: null })),
      lastAttemptAt: state?.attempted_at ?? null,
    };
  }
  all(): AnalyticsRecord[] {
    const count = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM business_analytics")?.count ?? 0;
    if (count > 100_000) throw new Error("经营数据超过当前备份容量，未导出不完整备份");
    return this.db.all<{ record_json: string }>("SELECT record_json FROM business_analytics ORDER BY account_id,record_key").map((r) => analyticsRecordSchema.parse(JSON.parse(r.record_json)));
  }
}
