import type { Account } from "@shared/types";
import { analyticsRecordSchema, BUSINESS_METRICS, type AnalyticsRecord, type AnalyticsState, type BusinessMetric } from "@shared/business-analytics";
import { beijingDay } from "@shared/metric-quality";
import { PLATFORMS, type CnPlatformId } from "@shared/platforms";

export interface AnalyticsPageSample {
  dates: string[];
  cards: Array<{ label: string; text: string; dates: string[] }>;
  groups: Array<{ dimension: string; entries: Array<{ label: string; text: string }>; dates: string[] }>;
  permissionRequired: boolean;
  workDetail?: boolean;
}
export const ANALYTICS_LABELS: Record<CnPlatformId, Record<BusinessMetric, string[]>> = Object.fromEntries(
  Object.keys(PLATFORMS).map((platform) => [platform, {
    completionRate: ["完播率", "整体完播率", "视频完播率"],
    averageWatchTime: ["平均观看时长", "平均播放时长", "人均观看时长"],
    contentRevenue: ["预估收益", "已结算收益", "创作激励收益", "内容收益"],
    audience: ["粉丝性别", "粉丝年龄", "粉丝地区", "粉丝兴趣", "性别分布", "年龄分布", "地域分布", "兴趣分布"],
    trafficSources: ["流量来源", "播放来源", "观看来源"],
  }]),
) as Record<CnPlatformId, Record<BusinessMetric, string[]>>;

export function analyticsPageAllowed(platform: CnPlatformId, url: string): boolean {
  try {
    const target = new URL(url), known = new URL(PLATFORMS[platform].routes.analytics);
    return target.origin === known.origin && /(?:statistic|statistics|data-center|data-up|analysis|income|earning|revenue|audience|fans)/i.test(target.pathname);
  } catch { return false; }
}

/** Extract bounded, visible label/value groups, never whole-page text or account identifiers. */
export function analyticsPageScript(platform: CnPlatformId): string {
  return `(() => {
    const labels = ${JSON.stringify(ANALYTICS_LABELS[platform])};
    const visible = el => el.getClientRects().length > 0;
    const leaves = [...document.querySelectorAll('body *')].filter(el => !el.children.length && visible(el));
    const dates = root => [...new Set((root.innerText || '').match(/20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}/g) || [])].slice(0, 8).map(s => s.split(/[-/]/).map((n,i) => i ? n.padStart(2,'0') : n).join('-'));
    const globalDates = [...new Set([...document.querySelectorAll('input')].filter(visible).flatMap(el => (el.value || '').match(/20\\d{2}-\\d{2}-\\d{2}/g) || []))];
    const explicitDates = leaves.filter(el => /^(统计周期|统计时间|数据周期|数据时间)[:：\\s]/.test(el.textContent.trim())).flatMap(el => dates(el));
    const cards = [], groups = [];
    for (const [metric, names] of Object.entries(labels)) for (const label of names) {
      const matching = leaves.filter(el => el.textContent.trim() === label);
      if (matching.length !== 1) continue;
      const el = matching[0];
      if (metric === 'audience' || metric === 'trafficSources') {
        const scope = el.closest('section,article,[role=region]') || el.parentElement?.parentElement;
        if (!scope) continue;
        const entries = [...scope.querySelectorAll('tr,[role=row]')].filter(visible).map(row => {
          const cells = [...row.querySelectorAll('td,[role=cell]')].filter(visible);
          return cells.length === 2 ? { label: cells[0].innerText.trim().slice(0,80), text: cells[1].innerText.trim().slice(0,80) } : null;
        }).filter(Boolean).slice(0,100);
        if (entries.length) groups.push({ dimension: label, entries, dates: dates(scope) });
      } else {
        const scope = el.parentElement;
        const values = scope ? [...scope.querySelectorAll('*')].filter(n => n !== el && !n.children.length && visible(n) && /[0-9]/.test(n.textContent) && n.textContent.trim().length <= 80) : [];
        if (values.length === 1) cards.push({ label, text: values[0].textContent.trim(), dates: dates(scope) });
      }
    }
    return { cards, groups, dates: globalDates.length ? globalDates : [...new Set(explicitDates)],
      workDetail: leaves.some(el => /^(作品详情|视频详情|稿件详情|笔记详情|单作品分析|单条视频分析)$/.test(el.textContent.trim())),
      permissionRequired: leaves.some(el => /^(暂无查看权限|无权限查看|请开通数据权限|当前账号无权限)$/.test(el.textContent.trim())) };
  })()`;
}
function period(dates: string[]): { startDate: string; endDate: string; granularity: "day" | "range" } | null {
  const values = [...new Set(dates)];
  if (values.length !== 1 && values.length !== 2) return null;
  const [startDate, endDate = startDate] = values;
  if (startDate > endDate || endDate > beijingDay()) return null;
  return { startDate, endDate, granularity: startDate === endDate ? "day" : "range" };
}
export function parseRate(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[%％]\s*$/.exec(text);
  const value = match ? Number(match[1]) / 100 : NaN;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
export function parseDuration(text: string): number | null {
  const scalar = /^\s*(\d+(?:\.\d+)?)\s*(秒|s|分钟|分|min|小时|h)\s*$/i.exec(text);
  if (scalar) return Number(scalar[1]) * (/^(分钟|分|min)$/i.test(scalar[2]) ? 60 : /^(小时|h)$/i.test(scalar[2]) ? 3600 : 1);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  return clock && Number(clock[2]) < 60 && Number(clock[3]) < 60 ? Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : null;
}
export function parseAnalyticsPage(account: Pick<Account, "id" | "platformId">, sample: AnalyticsPageSample, capturedAt = new Date().toISOString(), workId: string | null = null): { records: AnalyticsRecord[]; states: AnalyticsState[] } {
  const records: AnalyticsRecord[] = [];
  const labels = ANALYTICS_LABELS[account.platformId];
  const add = (metric: BusinessMetric, platformLabel: string, dates: string[], data: AnalyticsRecord["data"]) => {
    const range = period(dates.length ? dates : sample.dates);
    if (!range) return;
    const parsed = analyticsRecordSchema.safeParse({ accountId: account.id, platformId: account.platformId,
      metric, workId, ...range, capturedAt, platformLabel, source: "official-page", data });
    if (parsed.success) records.push(parsed.data);
  };
  if (!sample.permissionRequired) {
    for (const card of sample.cards) {
      if (labels.completionRate.includes(card.label)) {
        const value = parseRate(card.text);
        if (value != null) add("completionRate", card.label, card.dates, { kind: "rate", value, unit: "ratio" });
      } else if (labels.averageWatchTime.includes(card.label)) {
        const value = parseDuration(card.text);
        if (value != null) add("averageWatchTime", card.label, card.dates, { kind: "duration", value, unit: "seconds" });
      } else if (labels.contentRevenue.includes(card.label)) {
        const value = /^\s*(?:¥|￥)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(?:元|CNY)?\s*$/.exec(card.text);
        const currencyKnown = /[¥￥]|元|CNY/.test(card.text);
        const settlement = card.label.includes("预估") ? "estimated" : card.label.includes("已结算") ? "settled" : null;
        if (value && currencyKnown && settlement) add("contentRevenue", card.label, card.dates,
          { kind: "money", value: Number(value[1].replaceAll(",", "")), currency: "CNY", settlement });
      }
    }
    for (const group of sample.groups) {
      const metric = labels.audience.includes(group.dimension) ? "audience" : labels.trafficSources.includes(group.dimension) ? "trafficSources" : null;
      if (!metric) continue;
      const entries = group.entries.map((entry) => ({ label: entry.label, value: parseRate(entry.text) }));
      if (entries.every((entry) => entry.value != null)) add(metric, group.dimension, group.dates,
        { kind: "distribution", dimension: group.dimension, entries: entries as Array<{ label: string; value: number }>, unit: "ratio" });
    }
  }
  return { records, states: BUSINESS_METRICS.map((metric) => ({ metric,
    state: sample.permissionRequired ? "permission-required" : records.some((row) => row.metric === metric) ? "available" : "pending-validation",
    reason: sample.permissionRequired ? "官方页面提示需要查看权限" : records.some((row) => row.metric === metric) ? "已保存页面原始统计区间；不代表最近90天已全部补齐" : "当前页面未取得具有明确日期、单位及口径的数据",
    checkedAt: capturedAt,
  })) };
}
