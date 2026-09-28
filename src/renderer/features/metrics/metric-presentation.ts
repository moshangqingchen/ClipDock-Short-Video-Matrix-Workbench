import type { CollectRunStatus, MetricName, MetricOrigin } from "@shared/types";

export const METRIC_LABELS: Record<MetricName, string> = {
  followers: "粉丝", following: "关注", likes: "获赞", comments: "评论",
  plays: "播放", shares: "分享", favorites: "收藏", works: "作品",
};
export const RUN_LABELS: Record<CollectRunStatus, string> = {
  success: "采集成功", partial: "部分完成", failed: "采集失败", skipped: "暂未执行",
};
export function originLabel(origin?: MetricOrigin): string {
  return origin === "official" ? "官方接口" : origin === "page" ? "页面读取" : "历史记录，来源未验证";
}
