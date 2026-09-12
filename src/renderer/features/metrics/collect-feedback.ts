import type { CollectJob } from "@shared/collect-jobs";
import { useToasts } from "@renderer/store";

export function showCollectAccepted(jobs: CollectJob[]): void {
  const waiting = jobs.filter((j) => j.state === "waiting-network").length;
  const rejected = jobs.filter((j) => j.state === "failed" || j.state === "cancelled").length;
  useToasts.getState().push({
    kind: rejected === jobs.length ? "warning" : "info",
    title:
      jobs.length === 0 ? "没有可采集的账号" : rejected === jobs.length ? "未开始采集" : "采集任务已受理",
    message: waiting
      ? waiting + " 个任务等待国内网络，可在总览队列取消"
      : rejected
        ? rejected + " 个账号未开始，其余任务可在总览队列查看"
        : "可在总览队列查看进度或取消",
  });
}
