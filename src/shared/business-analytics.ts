import { z } from "zod";
import { CN_PLATFORM_IDS, type CnPlatformId } from "./platforms";

export const BUSINESS_METRICS = ["completionRate", "averageWatchTime", "contentRevenue", "audience", "trafficSources"] as const;
export type BusinessMetric = (typeof BUSINESS_METRICS)[number];
export const BUSINESS_LABELS: Record<BusinessMetric, string> = {
  completionRate: "完播率", averageWatchTime: "平均观看时长", contentRevenue: "内容收益", audience: "粉丝画像", trafficSources: "流量来源",
};
export const AVAILABILITY_LABELS = {
  available: "已取得", unavailable: "后台未提供", "permission-required": "需要权限",
  "pending-validation": "待核对", failed: "暂时失败", disabled: "未启用",
} as const;
export type AnalyticsAvailability = keyof typeof AVAILABILITY_LABELS;
const scalar = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rate"), value: z.number().min(0).max(1), unit: z.literal("ratio") }),
  z.object({ kind: z.literal("duration"), value: z.number().finite().nonnegative(), unit: z.literal("seconds") }),
  z.object({ kind: z.literal("money"), value: z.number().finite(), currency: z.string().regex(/^[A-Z]{3}$/), settlement: z.enum(["estimated", "settled"]) }),
  z.object({ kind: z.literal("distribution"), dimension: z.string().min(1).max(80), entries: z.array(z.object({
    label: z.string().min(1).max(80), value: z.number().finite().nonnegative(),
  })).min(1).max(100), unit: z.enum(["ratio", "people", "views"]) }),
]);
export const analyticsRecordSchema = z.object({
  accountId: z.string().uuid(), platformId: z.enum(CN_PLATFORM_IDS), metric: z.enum(BUSINESS_METRICS),
  workId: z.string().max(1000).nullable(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granularity: z.enum(["day", "range", "snapshot"]), capturedAt: z.string().datetime({ offset: true }),
  platformLabel: z.string().min(1).max(100), source: z.enum(["official-response", "official-page"]),
  data: scalar,
}).superRefine((row, ctx) => {
  const expected = { completionRate: "rate", averageWatchTime: "duration", contentRevenue: "money", audience: "distribution", trafficSources: "distribution" };
  if (row.data.kind !== expected[row.metric]) ctx.addIssue({ code: "custom", message: "指标和单位类型不一致" });
  if (row.startDate > row.endDate || [row.startDate, row.endDate].some((date) => !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date))
    ctx.addIssue({ code: "custom", message: "统计日期无效" });
  if ((row.granularity === "day" || row.granularity === "snapshot") && row.startDate !== row.endDate)
    ctx.addIssue({ code: "custom", message: "单日/时点记录不能跨日期" });
  if (row.data.kind === "distribution" && row.data.unit === "ratio" && row.data.entries.some((entry) => entry.value > 1))
    ctx.addIssue({ code: "custom", message: "分布比例超出范围" });
  if (row.data.kind === "distribution" && new Set(row.data.entries.map((entry) => entry.label)).size !== row.data.entries.length)
    ctx.addIssue({ code: "custom", message: "分布分类重复" });
});
export type AnalyticsRecord = z.infer<typeof analyticsRecordSchema>;
export interface AnalyticsState { metric: BusinessMetric; state: AnalyticsAvailability; reason: string; checkedAt: string | null }
export interface AnalyticsView {
  accountId: string; platformId: CnPlatformId; enabled: boolean; records: AnalyticsRecord[]; states: AnalyticsState[];
  requestedStart: string; requestedEnd: string; lastAttemptAt: string | null;
  recordsTotal?: number;
}
export interface AnalyticsApi {
  get(accountId: string, days?: 7 | 30 | 90): Promise<AnalyticsView>;
  setEnabled(platformId: CnPlatformId, enabled: boolean): Promise<void>;
  readCurrentPage(accountId: string): Promise<AnalyticsView>;
}
