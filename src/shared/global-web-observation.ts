import { z } from "zod";
import { globalAccountIdSchema } from "./global-accounts";

export const WEB_METRICS = {
  followers: "粉丝 / 订阅者",
  views: "观看 / 浏览",
  likes: "点赞",
  comments: "评论",
  shares: "分享",
  watchHours: "观看时长（小时）",
  impressions: "展示次数",
  engagements: "互动次数",
  profileVisits: "主页访问",
  works: "作品数",
} as const;
export const webObservationSchema = z
  .object({
    accountId: globalAccountIdSchema,
    platformId: z.enum(["youtube", "tiktok", "x"]),
    source: z.literal("webpage"),
    subjectId: z.string().max(256).nullable().optional(),
    engine: z.enum(["embedded", "chrome"]),
    capturedAt: z.iso.datetime(),
    page: z.string().min(1).max(300),
    period: z.string().max(100).nullable(),
    metrics: z
      .array(
        z
          .object({
            key: z.enum(
              Object.keys(WEB_METRICS) as [keyof typeof WEB_METRICS, ...(keyof typeof WEB_METRICS)[]],
            ),
            label: z.string().min(1).max(60),
            value: z.string().min(1).max(40),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type WebObservation = z.infer<typeof webObservationSchema>;
export const webObservationHistorySchema = z.array(webObservationSchema).max(1000);
export const WEB_OBSERVE_ERRORS = [
  "WEB_OBSERVE_CLOSED",
  "WEB_OBSERVE_PAGE_REQUIRED",
  "WEB_OBSERVE_UNAVAILABLE",
  "WEB_OBSERVE_CANCELLED",
  "WEB_OBSERVE_BUSY",
] as const;
export function webObserveErrorCode(error: unknown): (typeof WEB_OBSERVE_ERRORS)[number] {
  const code = error instanceof Error && /(?:^|Error: )(WEB_OBSERVE_[A-Z_]+)$/.exec(error.message)?.[1];
  return WEB_OBSERVE_ERRORS.find((item) => item === code) ?? "WEB_OBSERVE_UNAVAILABLE";
}
