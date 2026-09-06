import type { WebContents } from "electron";
import type { Account, MetricName, MetricSnapshot, Work } from "@shared/types";
import type { PlatformId } from "@shared/platforms";
import type { ProfileInfo } from "@main/services/account-service";

export interface CollectorContext {
  webContents: WebContents;
  account: Account;
}

export interface CollectorProfile extends ProfileInfo {
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
  profile: CollectorProfile | null;
  metrics: MetricSnapshot[];
  works: Work[];
  warnings: string[];
  loggedOut: boolean;
  rateLimited: boolean;
}

export interface Collector {
  readonly platformId: PlatformId;
  /** Page (same-origin) the view should be on before collecting. */
  readonly workingUrl: string;
  fetchProfile(ctx: CollectorContext): Promise<CollectorProfile | null>;
  collect(ctx: CollectorContext): Promise<CollectorResult>;
}

export interface PageResponse {
  ok: boolean;
  status: number;
  text: string;
  url: string;
}

export class RateLimitedError extends Error {
  constructor(message = "rate-limited") {
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
  const script = `
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(init.method ?? "GET")},
          headers: ${JSON.stringify(init.headers ?? {})},
          body: ${init.body === undefined ? "undefined" : JSON.stringify(init.body)},
          credentials: "include",
          cache: "no-store",
        });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text: text.slice(0, 2_000_000), url: response.url };
      } catch (error) {
        return { ok: false, status: 0, text: String(error && error.message || error), url: ${JSON.stringify(url)} };
      }
    })()
  `;
  const result = (await wc.executeJavaScript(script, true)) as PageResponse;
  if (result.status === 429) throw new RateLimitedError();
  return result;
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
      if (json && accept(json)) return json as T;
    } catch (error) {
      if (error instanceof RateLimitedError || error instanceof LoggedOutError) throw error;
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
  const script = `
    (() => {
      const labels = ${JSON.stringify(labels)};
      const out = {};
      const numberPattern = /^\\s*-?\\d[\\d,.]*\\s*(万|亿|w|W|k|K)?\\s*$/;
      const nodes = Array.from(document.querySelectorAll("body *")).filter((el) => el.children.length === 0 && el.textContent && el.textContent.trim().length <= 12);
      const textOf = (el) => (el.textContent || "").trim();
      for (const [metric, names] of Object.entries(labels)) {
        for (const el of nodes) {
          const text = textOf(el);
          if (!names.includes(text)) continue;
          const candidates = [];
          let scope = el.parentElement;
          for (let depth = 0; depth < 3 && scope; depth += 1, scope = scope.parentElement) {
            candidates.push(...Array.from(scope.querySelectorAll("*")).filter((c) => c !== el && c.children.length === 0));
          }
          const hit = candidates.find((c) => numberPattern.test(textOf(c)));
          if (hit) { out[metric] = textOf(hit); break; }
        }
      }
      return out;
    })()
  `;
  try {
    const raw = (await wc.executeJavaScript(script, true)) as Record<string, string>;
    const parsed: Partial<Record<MetricName, number>> = {};
    for (const [metric, text] of Object.entries(raw)) {
      const n = toNumber(text);
      if (n != null) parsed[metric as MetricName] = n;
    }
    return parsed;
  } catch {
    return {};
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
      out.push({
        accountId: work.accountId,
        platformId: work.platformId,
        metric,
        value,
        capturedAt,
        source: "session",
        workId: work.id,
      });
    }
  }
  return out;
}

export function makeWork(
  account: Account,
  remoteId: string,
  partial: Partial<Work>,
  fetchedAt: string,
): Work {
  return {
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

/** Sum work-level totals when the platform gives no account-level counters. */
export function aggregateFromWorks(
  works: Work[],
): Pick<CollectorProfile, "plays" | "comments" | "shares" | "favorites"> {
  return {
    plays: works.reduce((sum, w) => sum + w.plays, 0),
    comments: works.reduce((sum, w) => sum + w.comments, 0),
    shares: works.reduce((sum, w) => sum + w.shares, 0),
    favorites: works.reduce((sum, w) => sum + w.favorites, 0),
  };
}

export function emptyResult(): CollectorResult {
  return { profile: null, metrics: [], works: [], warnings: [], loggedOut: false, rateLimited: false };
}
