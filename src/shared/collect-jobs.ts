import type { CollectRun } from "./types";

export const COLLECT_JOB_STATES = [
  "queued",
  "waiting-network",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type CollectJobState = (typeof COLLECT_JOB_STATES)[number];
export interface CollectJob {
  id: string;
  accountId: string;
  trigger: CollectRun["trigger"];
  state: CollectJobState;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  runId: number | null;
  attempts: number;
}
export const COLLECT_JOB_LABELS: Record<CollectJobState, string> = {
  queued: "排队中",
  "waiting-network": "等待国内网络",
  running: "采集中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
export function isActiveCollectJob(job: CollectJob): boolean {
  return job.state === "queued" || job.state === "waiting-network" || job.state === "running";
}
