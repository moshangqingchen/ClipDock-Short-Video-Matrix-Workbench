import type { WebObservation, WEB_METRICS } from "./global-web-observation";

export type WebMetricKey = keyof typeof WEB_METRICS;
export function observationDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** Convert only unambiguous display numbers. The original string remains the card value. */
export function observationNumber(raw: string): number | null {
  const match = /^(\d{1,3}(?:[,，\u00a0 ]\d{3})+|\d+)(\.\d+)?\s*([KMBkmb万亿千]|million|billion)?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  const units: Record<string, number> = {
    k: 1e3,
    m: 1e6,
    b: 1e9,
    千: 1e3,
    万: 1e4,
    亿: 1e8,
    million: 1e6,
    billion: 1e9,
  };
  const value =
    Number(match[1].replace(/[,，\u00a0 ]/g, "") + (match[2] ?? "")) *
    (units[(match[3] ?? "").toLowerCase()] ?? 1);
  return Number.isFinite(value) ? value : null;
}
export function observationScope(value: WebObservation, key: WebMetricKey): string | null {
  const label = value.metrics.find((metric) => metric.key === key)?.label;
  if (!label) return null;
  // Only explicitly named current/total subscribers are a lifetime total.
  if (
    key === "followers" &&
    /^(current subscribers|total followers|当前订阅人数|当前订阅者人数|当前订阅人数总计|总粉丝数)$/i.test(
      label,
    )
  )
    return `${value.page.split("/analytics")[0].replace(/\/dashboard\/?$/, "")}|followers-total`;
  if (!value.period) return null;
  const period = value.period.trim().toLowerCase().replace(/\s+/g, " ");
  return `${value.page}|${period}|${key}`;
}
export function observationTrend(
  history: WebObservation[],
  latest: WebObservation | null,
  key: WebMetricKey,
  days: number,
  now = new Date(),
) {
  if (!latest) return [];
  const scope = observationScope(latest, key);
  if (!scope) return [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  const daily = new Map<string, { day: string; value: number; display: string; capturedAt: string }>();
  for (const item of [...history, latest].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    if (
      item.accountId !== latest.accountId ||
      item.platformId !== latest.platformId ||
      (item.subjectId ?? null) !== (latest.subjectId ?? null) ||
      observationScope(item, key) !== scope
    )
      continue;
    const date = new Date(item.capturedAt);
    if (date < start || date > now) continue;
    const metric = item.metrics.find((metric) => metric.key === key);
    const number = metric ? observationNumber(metric.value) : null;
    if (metric && number !== null) {
      const day = observationDay(item.capturedAt);
      daily.set(day, { day, value: number, display: metric.value, capturedAt: item.capturedAt });
    }
  }
  return [...daily.values()];
}
