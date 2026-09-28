import type { Work, WorkMetric } from "./types";

export function workMetric(work: Work, metric: WorkMetric): number | null {
  if (work.observations && !work.observations[metric]) return null;
  return Number.isFinite(work[metric]) ? work[metric] : null;
}
export function beijingDay(time: number | string = Date.now()): string {
  return new Date((typeof time === "number" ? time : Date.parse(time)) + 8 * 3600_000).toISOString().slice(0, 10);
}
export function beijingDayStart(daysAgo = 0, now = Date.now()): string {
  return new Date(Date.parse(`${beijingDay(now)}T00:00:00+08:00`) - daysAgo * 86400_000).toISOString();
}
