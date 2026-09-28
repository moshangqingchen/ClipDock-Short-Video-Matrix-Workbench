import type { WebContents } from "electron";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import { beginBusinessOperation, withBusinessTaskSignal } from "@main/network/business-access";
import { evaluateWithLease } from "@main/network/page-evaluation";
import { BUSINESS_METRICS } from "@shared/business-analytics";
import type { CnPlatformId } from "@shared/platforms";
import { BusinessAnalyticsRepository } from "./business-analytics-repository";
import { analyticsPageAllowed, analyticsPageScript, parseAnalyticsPage, type AnalyticsPageSample } from "./business-analytics-page";

export class BusinessAnalyticsService {
  readonly repository: BusinessAnalyticsRepository;
  constructor(private readonly store: Store, private readonly pool: ViewPool, private readonly accounts: AccountService, private readonly changed: (accountId: string) => void) {
    this.repository = new BusinessAnalyticsRepository(store.db);
  }
  enabled(platform: CnPlatformId): boolean { return this.repository.enabled(platform); }
  due(accountId: string): boolean {
    const row = this.store.db.get<{ attempted_at: string }>("SELECT attempted_at FROM analytics_status WHERE account_id=?", [accountId]);
    return !row || Date.now() - Date.parse(row.attempted_at) >= 86400_000;
  }
  attempt(accountId: string): void {
    const at = new Date().toISOString();
    const states = BUSINESS_METRICS.map((metric) => ({ metric, state: "pending-validation", reason: "本次读取尚未完成，保留已有记录", checkedAt: at }));
    this.store.db.run("INSERT INTO analytics_status(account_id,states_json,attempted_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET attempted_at=excluded.attempted_at", [accountId, JSON.stringify(states), at]);
  }
  defer(accountId: string): void {
    this.repository.status(accountId, BUSINESS_METRICS.map((metric) => ({ metric, state: "pending-validation",
      reason: "当前页面正在使用，请打开官方分析页面后读取；原有经营数据保留", checkedAt: new Date().toISOString() })));
  }
  assertCurrentPage(accountId: string): void {
    const wc = this.pool.getWebContents(accountId);
    if (!wc) throw new Error("请先打开该账号的官方分析页面");
    const account = this.accounts.get(accountId);
    if (!this.enabled(account.platformId)) throw new Error("该平台经营观测尚未启用");
    if (!analyticsPageAllowed(account.platformId, wc.getURL())) throw new Error("请先打开该账号的官方分析页面");
  }
  async collect(accountId: string, wc: WebContents, check: () => void): Promise<number> {
    const account = this.accounts.get(accountId);
    if (!this.enabled(account.platformId)) throw new Error("该平台经营观测尚未启用");
    if (wc.isDestroyed() || !analyticsPageAllowed(account.platformId, wc.getURL())) throw new Error("请打开官方数据分析、收益或粉丝分析页面");
    const url = wc.getURL();
    const state = this.pool.getState(accountId);
    let subject: string | null = null;
    let identityChecked = false;
    const operation = beginBusinessOperation(accountId, url);
    const current = () => {
      check(); operation.assertCurrent();
      if (!this.enabled(account.platformId)) throw new Error("该平台经营观测已暂停");
      const next = this.pool.getState(accountId);
      if (wc.isDestroyed() || wc.getURL() !== url || wc.isLoading() || next?.instanceId !== state?.instanceId || next?.navigationId !== state?.navigationId ||
          identityChecked && this.pool.getIdentitySubject(accountId) !== subject)
        throw new Error("页面已变化，未保存经营数据");
    };
    try {
      const checked = await withBusinessTaskSignal(operation.signal, () => this.accounts.checkStatus(accountId, { force: true }));
      current();
      const evidence = this.pool.getIdentityEvidence(accountId);
      if ((checked.status !== "online" && checked.status !== "expiring") ||
          checked.checkInfo?.state !== "confirmed" && evidence?.kind !== "online") throw new Error("请先完成管理页登录或验证");
      subject = this.pool.getIdentitySubject(accountId);
      identityChecked = true;
      const sample = await evaluateWithLease<AnalyticsPageSample>(wc, analyticsPageScript(account.platformId), operation, 10_000);
      current();
      const keys: Record<CnPlatformId, string[]> = {
        douyin: ["aweme_id", "item_id"], kuaishou: ["photoId", "photo_id"], xiaohongshu: ["noteId", "note_id"],
        bilibili: ["bvid", "aid"], baijiahao: ["article_id"], weixin_channels: ["objectId", "object_id", "exportId"],
      };
      const target = new URL(url), remoteIds = [...new Set(keys[account.platformId].map((key) => target.searchParams.get(key)).filter((value): value is string => Boolean(value)))];
      let workId: string | null = null;
      if (remoteIds.length > 1) throw new Error("作品归属不明确，未保存经营数据");
      if (remoteIds.length) {
        workId = this.store.db.get<{ id: string }>("SELECT id FROM works WHERE account_id=? AND remote_id=?", [accountId, remoteIds[0]])?.id ?? null;
        if (!workId) throw new Error("请先采集该作品，再读取其经营分析");
      } else if (sample.workDetail || /(?:detail|single|\/item\/)/i.test(target.pathname)) {
        throw new Error("未确认单作品归属，未写入账号级经营数据");
      }
      const parsed = parseAnalyticsPage(account, sample, new Date().toISOString(), workId);
      const count = this.store.db.transaction(() => {
        current();
        const written = this.repository.save(parsed.records);
        this.repository.status(accountId, parsed.states);
        return written;
      });
      this.changed(accountId);
      return count;
    } catch (error) {
      // Leave previous observations intact. Never store page text or exception messages.
      current();
      this.repository.status(accountId, BUSINESS_METRICS.map((metric) => ({ metric, state: "failed",
        reason: "读取未完成，请确认官方页面、登录与网络后重试", checkedAt: new Date().toISOString() })));
      this.changed(accountId);
      throw error;
    } finally { operation.release(); }
  }
}
