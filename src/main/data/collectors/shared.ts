import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { CollectionProgress } from "@shared/collect-jobs";
import { WORK_METRICS, type Account, type MetricName, type MetricSnapshot, type Work, type WorkMetric, type MetricOrigin } from "@shared/types";
import type { PlatformId } from "@shared/platforms";
import type { ProfileInfo } from "@main/services/account-service";
import { evaluateWithLease } from "@main/network/page-evaluation";
import {
  accountForWebContents,
  beginBusinessOperation,
  BusinessTaskCancelledError,
  isNetworkDormantError,
} from "@main/network/business-access";

export interface CollectorContext {
  progress?: CollectionProgress;
  pageResult?: WorkPageInfo;
  skipProfile?: boolean;
  /** In-memory request from the same live document; never sent through IPC or persisted. */
  observedWorksRequest?: () => { url: string; method: string; body?: string } | null;
  webContents: WebContents;
  account: Account;
  identityProfile?: CollectorProfile | null;
}

export interface CollectorProfile extends ProfileInfo {
  origins?: Partial<Record<MetricName, MetricOrigin>>;
  followers?: number | null;
  following?: number | null;
  likes?: number | null;
  works?: number | null;
  plays?: number | null;
  comments?: number | null;
  shares?: number | null;
  favorites?: number | null;
}

export interface CollectorResult {
  page?: WorkPageInfo;
  profile: CollectorProfile | null;
  metrics: MetricSnapshot[];
  works: Work[];
  warnings: string[];
  loggedOut: boolean;
  rateLimited: boolean;
}
export interface WorkPageInfo {
  receivedCount?: number;
  nextCursor: string;
  nextPage: number;
  hasMore: boolean | null;
  total?: number;
  variant?: number;
  reason?: string;
}

/** Keep the selected API variant stable across pages; a new variant may use different cursors. */
export async function worksJson(ctx: CollectorContext, candidates: Parameters<typeof firstJson>[1], accept: (json: any) => boolean): Promise<any> {
  const variant = ctx.progress?.variant;
  const indexes = variant === undefined ? candidates.map((_, i) => i) : [variant];
  for (const index of indexes) {
    if (!candidates[index]) continue;
    const json = await firstJson(ctx.webContents, [candidates[index]], accept);
    if (json) {
      ctx.pageResult = { nextPage: (ctx.progress?.page ?? 1) + 1, nextCursor: "", hasMore: null, variant: index };
      return json;
    }
  }
  return null;
}
export function recordWorksPage(ctx: CollectorContext, json: unknown, list: unknown[], kind: "page" | "cursor", cursorPaths: string[] = []): void {
  const total = toNumber(firstDefined(json, ["data.totalCount", "data.total_count", "data.total", "total", "total_count", "data.page.count"]));
  const more = firstDefined(json, ["has_more", "hasMore", "data.has_more", "data.hasMore", "data.hasNext"]);
  const cursorValue = firstDefined(json, cursorPaths);
  const cursor = cursorValue == null ? "" : String(cursorValue);
  let hasMore: boolean | null = more === true || more === 1 || more === "1" ? true : more === false || more === 0 || more === "0" ? false : null;
  if (list.length === 0 && hasMore === true) {
    ctx.pageResult = { ...ctx.pageResult, receivedCount: 0, nextPage: ctx.progress?.page ?? 1, nextCursor: ctx.progress?.cursor ?? "", hasMore: null,
      reason: "平台返回空页但仍声明存在后续作品，请重新核对分页" };
    return;
  }
  if (list.length === 0 && hasMore !== true) hasMore = false;
  if (cursor.toLowerCase() === "no_more") hasMore = false;
  if (hasMore === null && (kind === "page" || cursor)) hasMore = true;
  if (kind === "cursor" && hasMore !== false && (!cursor || cursor === (ctx.progress?.cursor ?? ""))) hasMore = null;
  ctx.pageResult = { ...ctx.pageResult, receivedCount: list.length, nextPage: (ctx.progress?.page ?? 1) + 1, nextCursor: cursor, hasMore,
    ...(total != null && total >= 0 ? { total } : {}),
    ...(hasMore === null ? { reason: "分页游标未提供或未前进，已保留数据，请在官方作品页复核" } : {}),
  };
}

export interface Collector {
  readonly platformId: PlatformId;
  /** Page (same-origin) the view should be on before collecting. */
  readonly workingUrl: string;
  fetchProfile(ctx: CollectorContext): Promise<CollectorProfile | null>;
  collect(ctx: CollectorContext): Promise<CollectorResult>;
}

export interface PageResponse {
  retryAfterMs?: number;
  ok: boolean;
  status: number;
  text: string;
  url: string;
}
let diagnosticSink: ((entry: { accountId: string; stage: "request" | "response"; code: string; status?: number }) => void) | undefined;
export function setCollectorDiagnosticSink(sink: typeof diagnosticSink): void { diagnosticSink = sink; }
function requestDiagnostic(wc: WebContents, stage: "request" | "response", code: string, status?: number): void {
  if (!diagnosticSink) return;
  try { diagnosticSink({ accountId: accountForWebContents(wc), stage, code, ...(status == null ? {} : { status }) }); } catch { /* best effort */ }
}

export class RateLimitedError extends Error {
  constructor(message = "rate-limited", readonly retryAfterMs = 0) {
    super(message);
    this.name = "RateLimitedError";
  }
}

export class LoggedOutError extends Error {
  constructor(message = "logged-out") {
    super(message);
    this.name = "LoggedOutError";
  }
}

/**
 * Issue a fetch *from inside the account's page*. The request therefore
 * carries the page's cookies, UA, referer and any signature headers the site's
 * own fetch interceptors add. Nothing is written; this is what the browser
 * does when the operator opens the data tab.
 */
export async function pageFetch(
  wc: WebContents,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<PageResponse> {
  if (wc.isDestroyed()) throw new Error("view-destroyed");
  const accountId = accountForWebContents(wc);
  const targetUrl = new URL(url, wc.getURL()).href;
  const operation = beginBusinessOperation(accountId, targetUrl);
  const requestId = randomUUID();
  const cancel = () => {
    if (wc.isDestroyed()) return;
    void wc
      .executeJavaScript(
        `(() => {
      const key = Symbol.for("clipdock.collect.aborts");
      const pending = globalThis[key] || (globalThis[key] = new Map());
      const id = ${JSON.stringify(requestId)};
      const controller = pending.get(id);
      if (controller) controller.abort(); else pending.set(id, null);
    })()`,
      )
      .catch(() => undefined);
  };
  operation.signal.addEventListener("abort", cancel, { once: true });
  try {
    operation.assertCurrent();
    const script = `
    (async () => {
      const key = Symbol.for("clipdock.collect.aborts");
      const pending = globalThis[key] || (globalThis[key] = new Map());
      const id = ${JSON.stringify(requestId)};
      const controller = new AbortController();
      if (pending.has(id) && pending.get(id) === null) controller.abort();
      pending.set(id, controller);
      try {
        const response = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(init.method ?? "GET")},
          headers: ${JSON.stringify(init.headers ?? {})},
          body: ${init.body === undefined ? "undefined" : JSON.stringify(init.body)},
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const text = await response.text();
        const retry = response.headers?.get('retry-after');
        const delay = retry == null ? 0 : /^\\d+(?:\\.\\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        return { ok: response.ok, status: response.status, text: text.slice(0, 2_000_000), url: response.url,
          retryAfterMs: Number.isFinite(delay) && delay > 0 ? delay : 0 };
      } catch (error) {
        return { ok: false, status: 0, text: String(error && error.message || error), url: ${JSON.stringify(url)} };
      } finally { pending.delete(id); }
    })()
  `;
    const result = await evaluateWithLease<PageResponse>(wc, script, operation, 20_000);
    operation.assertCurrent();
    if (result.status === 429) throw new RateLimitedError("rate-limited", result.retryAfterMs ?? 0);
    return result;
  } catch (error) {
    cancel();
    requestDiagnostic(wc, "request", error instanceof Error && error.message === "page-evaluation-timeout" ? "TIMEOUT" : "INTERRUPTED");
    operation.assertCurrent();
    throw error;
  } finally {
    operation.signal.removeEventListener("abort", cancel);
    operation.release();
  }
}

export async function pageJson<T = unknown>(
  wc: WebContents,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; json: T | null; text: string }> {
  const response = await pageFetch(wc, url, init);
  let json: T | null;
  try {
    json = JSON.parse(response.text) as T;
  } catch {
    json = null;
  }
  return { status: response.status, json, text: response.text };
}

/** First candidate URL whose JSON response passes `accept`. */
export async function firstJson<T = any>(
  wc: WebContents,
  candidates: Array<{
    url: string;
    init?: { method?: string; headers?: Record<string, string>; body?: string };
  }>,
  accept: (json: any) => boolean,
): Promise<T | null> {
  for (const candidate of candidates) {
    try {
      const { json, status } = await pageJson<any>(wc, candidate.url, candidate.init);
      if (status === 401) throw new LoggedOutError();
      if (json && [300330, 300333, 300334].includes(Number(pick(json, "errCode")))) throw new LoggedOutError();
      if (status >= 200 && status < 300 && json && accept(json)) return json as T;
      requestDiagnostic(wc, "response", status >= 400 ? "HTTP_ERROR" : json ? "SCHEMA_MISMATCH" : "INVALID_JSON", status);
    } catch (error) {
      if (
        error instanceof RateLimitedError ||
        error instanceof LoggedOutError ||
        error instanceof BusinessTaskCancelledError ||
        isNetworkDormantError(error)
      )
        throw error;
    }
  }
  return null;
}

/** Safe deep read: pick(obj, "a.b.0.c"). */
export function pick(value: unknown, path: string): unknown {
  let current: any = value;
  for (const key of path.split(".")) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

export function firstDefined(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const found = pick(value, path);
    if (found !== undefined && found !== null && found !== "") return found;
  }
  return undefined;
}

/** Parse "1.2万", "3,456", "12w", 789 into a number. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.replace(/[,\s]/g, "").trim();
  if (!text) return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*(万|w|W|亿|k|K|m|M)?/.exec(text);
  if (!match) return null;
  let n = Number(match[1]);
  switch (match[2]) {
    case "万":
    case "w":
    case "W":
      n *= 10_000;
      break;
    case "亿":
      n *= 100_000_000;
      break;
    case "k":
    case "K":
      n *= 1_000;
      break;
    case "m":
    case "M":
      n *= 1_000_000;
      break;
  }
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") return toIso(numeric);
    const date = new Date(value.replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function firstUrl(value: unknown): string | null {
  if (typeof value === "string") return value.startsWith("//") ? `https:${value}` : value || null;
  if (Array.isArray(value)) return firstUrl(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstUrl(record.url_list ?? record.url ?? record.uri ?? record.src ?? null);
  }
  return null;
}

/**
 * Last-resort profile numbers: scan the rendered page for label/number pairs
 * (粉丝 12.3万 / 获赞 4567 ...). Used only when the JSON endpoints changed.
 */
export async function domScrapeNumbers(
  wc: WebContents,
  labels: Record<MetricName, string[]>,
): Promise<Partial<Record<MetricName, number>>> {
  if (wc.isDestroyed()) return {};
  const operation = beginBusinessOperation(accountForWebContents(wc));
  const script = `
    (() => {
      const labels = ${JSON.stringify(labels)};
      const out = {};
      const numberPattern = /^\\s*-?\\d[\\d,.]*\\s*(万|亿|w|W|k|K)?\\s*$/;
      const nodes = Array.from(document.querySelectorAll("body *")).filter((el) => el.children.length === 0 && el.textContent && el.textContent.trim().length <= 12);
      const textOf = (el) => (el.textContent || "").trim();
      for (const [metric, names] of Object.entries(labels)) {
        const matches = nodes.filter(el => names.includes(textOf(el)) && !el.closest('tr,[role=row],a,button'));
        if (matches.length !== 1) continue;
        for (const el of matches) {
          const text = textOf(el);
          if (!names.includes(text)) continue;
          const candidates = [];
          let scope = el.parentElement;
          for (let depth = 0; depth < 3 && scope; depth += 1, scope = scope.parentElement) {
            if (/今日|昨日|近\\s*\\d+\\s*天|过去\\s*\\d+\\s*天/.test(scope.textContent || '')) break;
            candidates.push(...Array.from(scope.querySelectorAll("*")).filter((c) => c !== el && c.children.length === 0));
            if (candidates.some(c => numberPattern.test(textOf(c)))) break;
          }
          const numbers = candidates.filter((c) => numberPattern.test(textOf(c)));
          const hit = numbers.length === 1 ? numbers[0] : null;
          if (hit) { out[metric] = textOf(hit); break; }
        }
      }
      return out;
    })()
  `;
  try {
    const raw = await evaluateWithLease<Record<string, string>>(wc, script, operation, 5_000);
    operation.assertCurrent();
    const parsed: Partial<Record<MetricName, number>> = {};
    for (const [metric, text] of Object.entries(raw)) {
      const n = toNumber(text);
      if (n != null) parsed[metric as MetricName] = n;
    }
    return parsed;
  } catch (error) {
    operation.assertCurrent();
    if (isNetworkDormantError(error) || error instanceof BusinessTaskCancelledError) throw error;
    return {};
  } finally {
    operation.release();
  }
}

export const DEFAULT_LABELS: Record<MetricName, string[]> = {
  followers: ["粉丝", "粉丝数", "粉丝量", "关注者"],
  following: ["关注", "关注数"],
  likes: ["获赞", "点赞", "获赞数", "赞", "点赞量"],
  comments: ["评论", "评论数", "评论量"],
  plays: ["播放", "播放量", "总播放", "阅读", "浏览量"],
  shares: ["分享", "转发", "分享量"],
  favorites: ["收藏", "收藏量"],
  works: ["作品", "作品数", "视频", "视频数", "笔记"],
};

export function completeProfile(profile: CollectorProfile | null, scraped: Partial<Record<MetricName, number>>, warnings: string[]): CollectorProfile | null {
  const names = Object.keys(DEFAULT_LABELS) as MetricName[];
  if (profile && names.every((name) => profile[name] != null)) return profile;
  const merged: CollectorProfile = { ...profile, origins: { ...profile?.origins } };
  let added = false;
  for (const name of names) if (merged[name] == null && scraped[name] != null) {
    merged[name] = scraped[name];
    merged.origins![name] = "page";
    added = true;
  }
  if (added) warnings.push("部分数据从页面读取");
  if (!profile && !added) { warnings.push("无法读取账号概览"); return null; }
  return merged;
}

export function profileToMetrics(
  account: Account,
  profile: CollectorProfile,
  capturedAt: string,
): MetricSnapshot[] {
  const entries: Array<[MetricName, number | null | undefined]> = [
    ["followers", profile.followers],
    ["following", profile.following],
    ["likes", profile.likes],
    ["works", profile.works],
    ["plays", profile.plays],
    ["comments", profile.comments],
    ["shares", profile.shares],
    ["favorites", profile.favorites],
  ];
  return entries
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([metric, value]) => ({
      accountId: account.id,
      platformId: account.platformId,
      metric,
      value: value as number,
      capturedAt,
      source: "session" as const,
      origin: profile.origins?.[metric] ?? "official",
      workId: null,
    }));
}

export function worksToMetrics(works: Work[], capturedAt: string): MetricSnapshot[] {
  const out: MetricSnapshot[] = [];
  for (const work of works) {
    const pairs: Array<[MetricName, number]> = [
      ["plays", work.plays],
      ["likes", work.likes],
      ["comments", work.comments],
      ["shares", work.shares],
      ["favorites", work.favorites],
    ];
    for (const [metric, value] of pairs) {
      if (work.observations && !work.observations[metric as WorkMetric]) continue;
      if (!Number.isFinite(value)) continue;
      out.push({
        accountId: work.accountId,
        platformId: work.platformId,
        metric,
        value,
        capturedAt,
        source: "session",
        origin: work.observations?.[metric as WorkMetric]?.origin ?? "legacy",
        workId: work.id,
      });
    }
  }
  return out;
}

export function makeWork(
  account: Account,
  remoteId: string,
  partial: Omit<Partial<Work>, WorkMetric> & Partial<Record<WorkMetric, number | null>>,
  fetchedAt: string,
): Work {
  return {
    observations: Object.fromEntries(WORK_METRICS.filter((metric) =>
      typeof partial[metric] === "number" && Number.isFinite(partial[metric]),
    ).map((metric) => [metric, { capturedAt: fetchedAt, origin: "official" as const }])),
    id: `${account.id}:${remoteId}`,
    accountId: account.id,
    platformId: account.platformId,
    remoteId,
    title: partial.title ?? "",
    coverUrl: partial.coverUrl ?? null,
    url: partial.url ?? null,
    publishedAt: partial.publishedAt ?? null,
    status: partial.status ?? null,
    plays: partial.plays ?? 0,
    likes: partial.likes ?? 0,
    comments: partial.comments ?? 0,
    shares: partial.shares ?? 0,
    favorites: partial.favorites ?? 0,
    fetchedAt,
  };
}

export function emptyResult(): CollectorResult {
  return { profile: null, metrics: [], works: [], warnings: [], loggedOut: false, rateLimited: false };
}
