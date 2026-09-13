import type { Cookie, Session } from "electron";
import {
  getPlatform,
  hostMatches,
  isLoginUrl,
  isPlatformHost,
  isVerificationUrl,
  type PlatformId,
} from "@shared/platforms";
import type { AccountStatus } from "@shared/types";
import { gatedSessionFetch } from "@main/network/gated-session-fetch";
import { gatedSessionProbe } from "@main/network/gated-session-probe";
import { isNetworkDormantError } from "@main/network/business-access";
import { parseIdentityResponse, type IdentityEvidence } from "./identity-evidence";
import { isHomepageContext, type HomepageLoginVerdict } from "./homepage-login";

export interface ProbeResponse {
  status: number;
  text: string;
  /** Final URL after redirects, when known. */
  url?: string;
}

export interface DetectionInput {
  accountId: string;
  platformId: PlatformId;
  session: Session;
  /** Current top-level URL of the account view, if one exists. */
  currentUrl?: string | null;
  loading?: boolean;
  /** A stopped load can be an error document, not a successfully loaded login page. */
  lastError?: string | null;
  /** Skip the network probe; cookies and ordinary page URLs cannot confirm a fresh login check. */
  skipProbe?: boolean;
  /**
   * Preferred probe: runs the request inside the account's own page so it
   * carries the page's Referer/Origin and any signature interceptors. When
   * omitted, the detector falls back to a main-process fetch — but only for
   * platforms whose `probeFromMain` flag says that is trustworthy.
   */
  probe?: () => Promise<ProbeResponse | null>;
  /** Status recorded by the previous check; used to avoid blind downgrades. */
  previousStatus?: AccountStatus | null;
  lastOnlineAt?: string | null;
  now?: number;
  evidence?: IdentityEvidence | null;
  /** Read-only evidence from the currently loaded consumer homepage. */
  homepage?: HomepageLoginVerdict | null;
}

export interface DetectionResult {
  status: AccountStatus;
  message: string;
  sessionCookiesPresent: boolean;
  probeStatus?: number | null;
  sessionExpiresAt?: string | null;
  /** Main-process only: the response did not confirm authentication; do not persist status or times. */
  unconfirmed?: true;
  evidenceKey?: string;
  source?: "homepage";
  /** Main-process media input only; never persisted as an account profile field. */
  avatarUrl?: string;
}

const LOGGED_OUT_BODY_PATTERNS: Record<PlatformId, RegExp[]> = {
  douyin: [/"status_code"\s*:\s*(?:8|2190004|2190008|2190015)\b/, /"status_msg"\s*:\s*"[^"]*(?:登录|login)/i],
  kuaishou: [/"result"\s*:\s*(?:109|401|100110000)\b/, /"error_msg"\s*:\s*"[^"]*(?:登录|login)/i],
  xiaohongshu: [/"code"\s*:\s*-100\b/, /"msg"\s*:\s*"[^"]*(?:登录|login)/i],
  bilibili: [/"code"\s*:\s*-101\b/, /"isLogin"\s*:\s*false/],
  baijiahao: [/"errno"\s*:\s*(?:10000|110|10001)\b/, /"errmsg"\s*:\s*"[^"]*(?:登录|login)/i],
  weixin_channels: [/"errCode"\s*:\s*3003(?:30|33|34)\b/],
};

const GENERIC_LOGGED_OUT =
  /"(?:msg|message|errMsg|errmsg|status_msg)"\s*:\s*"[^"]*(?:未登录|请登录|登录失效|登录过期|not\s*logged|login\s*required)/i;

export function hasSessionCookies(platformId: PlatformId, cookies: readonly Cookie[]): boolean {
  const { sessionCookies, cookieDomains } = getPlatform(platformId).login;
  const relevant = cookies.filter((cookie) => {
    const domain = (cookie.domain ?? "").replace(/^\./, "");
    return cookieDomains.some((d) => hostMatches(domain, d)) && cookie.value;
  });
  const names = new Set(relevant.map((cookie) => cookie.name));
  const required = sessionCookies.required.every((name) => names.has(name));
  const anyOf =
    !sessionCookies.anyOf ||
    sessionCookies.anyOf.length === 0 ||
    sessionCookies.anyOf.some((n) => names.has(n));
  if (sessionCookies.required.length === 0) return anyOf && relevant.length > 0;
  return required && anyOf;
}

export function bodyLooksLoggedOut(platformId: PlatformId, body: string): boolean {
  const sample = body.slice(0, 20_000);
  return (
    LOGGED_OUT_BODY_PATTERNS[platformId].some((pattern) => pattern.test(sample)) ||
    GENERIC_LOGGED_OUT.test(sample)
  );
}

type ProbeVerdict =
  | { kind: "online"; status: number }
  | { kind: "offline"; status: number; message: string }
  | { kind: "unconfirmed"; status: number | null }
  | { kind: "network_error" };

/** Only the configured Bilibili probe origin may confirm this platform's authenticated API result. */
function bilibiliProbeVerdict(response: ProbeResponse): ProbeVerdict {
  const unconfirmed: ProbeVerdict = { kind: "unconfirmed", status: response.status };
  try {
    if (
      typeof response.url !== "string" ||
      !response.url ||
      response.url.includes("\\") ||
      [...response.url].some(
        (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
      )
    )
      return unconfirmed;
    const final = new URL(response.url);
    const expected = new URL(getPlatform("bilibili").login.probe.url);
    if (final.protocol !== "https:" || final.origin !== expected.origin || final.username || final.password)
      return unconfirmed;
  } catch {
    return unconfirmed;
  }
  if (response.status === 401)
    return { kind: "offline", status: 401, message: "平台接口返回 401,登录态失效" };
  if (response.status >= 200 && response.status < 300) {
    try {
      const body: unknown = JSON.parse(response.text);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const value = body as Record<string, unknown>;
        const data =
          value.data && typeof value.data === "object" && !Array.isArray(value.data)
            ? (value.data as Record<string, unknown>)
            : null;
        if (value.code === -101 || data?.isLogin === false)
          return { kind: "offline", status: response.status, message: "平台接口提示未登录" };
        if (value.code === 0 && data?.isLogin === true) return { kind: "online", status: response.status };
      }
    } catch {
      // HTML challenges, empty bodies and malformed JSON cannot extend a login conclusion.
    }
  }
  return unconfirmed;
}

/** Compatibility envelopes already used by the platform collectors, not an API schema audit. */
function hasRecognisedSuccessEnvelope(
  platformId: Exclude<PlatformId, "bilibili">,
  value: Record<string, unknown>,
): boolean {
  switch (platformId) {
    case "douyin":
      return value.status_code === 0;
    case "kuaishou":
      return value.result === 1 && Boolean(value.data);
    case "xiaohongshu":
      return (value.code === 0 || value.code === "0" || value.success === true) && Boolean(value.data);
    case "baijiahao":
      return (value.errno === 0 || value.errno === "0") && Boolean(value.data);
    case "weixin_channels":
      return value.errCode === 0;
  }
}

async function runProbe(input: DetectionInput, platformProbeFromMain: boolean): Promise<ProbeVerdict> {
  const noObservation: ProbeVerdict = {
    kind: "unconfirmed",
    status: null,
  };
  if (input.skipProbe) return noObservation;
  if (!input.probe && !platformProbeFromMain) return noObservation;
  let response: ProbeResponse | null;
  try {
    response = input.probe ? await input.probe() : await mainProcessProbe(input);
  } catch (error) {
    if (isNetworkDormantError(error)) throw error;
    return { kind: "network_error" };
  }
  if (!response) return noObservation;
  if (response.status === 0) return { kind: "network_error" };
  if (input.platformId === "bilibili") return bilibiliProbeVerdict(response);
  if (input.platformId === "kuaishou" || input.platformId === "weixin_channels") {
    const verdict = parseIdentityResponse(
      input.platformId,
      response.url ?? "",
      response.status,
      response.text,
    );
    if (verdict.kind === "online") return { kind: "online", status: response.status };
    if (verdict.kind === "offline")
      return { kind: "offline", status: response.status, message: verdict.reason };
    return { kind: "unconfirmed", status: response.status };
  }
  if (response.status === 401)
    return { kind: "offline", status: 401, message: "平台接口返回 401,登录态失效" };
  if (response.status >= 200 && response.status < 300) {
    try {
      const body: unknown = JSON.parse(response.text);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        if (bodyLooksLoggedOut(input.platformId, response.text))
          return { kind: "offline", status: response.status, message: "平台接口提示未登录" };
        if (hasRecognisedSuccessEnvelope(input.platformId, body as Record<string, unknown>))
          return { kind: "online", status: response.status };
      }
    } catch {
      // Empty responses, HTML challenges and malformed JSON do not establish authentication.
    }
  }
  return { kind: "unconfirmed", status: response.status };
}

/**
 * Confirm authentication from the current homepage or recognised probe responses. Missing or
 * inconclusive observations preserve the last conclusion without refreshing
 * verification times. Cookies and ordinary page URLs cannot replace a probe.
 * Verification pages remain an independent local risk signal. Main-process
 * probes are limited to platforms marked `probeFromMain`; page probes may
 * confirm a login even when our expected cookie names have changed.
 */
export async function detectLoginState(input: DetectionInput): Promise<DetectionResult> {
  const now = input.now ?? Date.now();
  const platform = getPlatform(input.platformId);
  const url = input.currentUrl ?? "";

  if (input.lastError) {
    return { status: "network_error", message: "账号页面加载失败，等待网络恢复后复核；上次登录结论保留", sessionCookiesPresent: false };
  }

  // Consumer and creator sessions may expire independently. A homepage's own
  // authenticated UI is authoritative here; a creator API must not veto it.
  // This also deliberately avoids TTL estimates and cookie-name heuristics.
  if (isHomepageContext(input.platformId, url)) {
    const homepage = input.loading ? null : input.homepage;
    if (homepage?.source === "homepage" && (homepage.kind === "online" || homepage.kind === "offline")) {
      return {
        status: homepage.kind,
        message: homepage.reason,
        sessionCookiesPresent: false,
        source: "homepage",
        ...(homepage.kind === "online" && typeof homepage.avatarUrl === "string"
          ? { avatarUrl: homepage.avatarUrl } : {}),
      };
    }
    return {
      status: input.previousStatus ?? "unknown",
      message: homepage?.reason || "等待主页加载并确认登录状态，上次登录结论保留",
      sessionCookiesPresent: false,
      unconfirmed: true,
      source: "homepage",
    };
  }

  let cookies: Cookie[];
  try {
    cookies = await input.session.cookies.get({});
  } catch {
    return { status: "network_error", message: "无法读取会话 Cookie", sessionCookiesPresent: false };
  }
  const present = hasSessionCookies(input.platformId, cookies);

  if (url && isVerificationUrl(input.platformId, url)) {
    return { status: "needs_verification", message: "平台要求完成安全验证", sessionCookiesPresent: present };
  }
  const identityPlatform = input.platformId === "kuaishou" || input.platformId === "weixin_channels";
  if (identityPlatform && input.loading) {
    return { status: input.previousStatus ?? "unknown", message: "账号页面正在加载，等待身份确认", sessionCookiesPresent: present, unconfirmed: true };
  }
  let confirmedLoginPage = false;
  try {
    const page = new URL(url);
    confirmedLoginPage =
      page.protocol === "https:" &&
      isPlatformHost(input.platformId, page.hostname) &&
      isLoginUrl(input.platformId, page.origin + page.pathname);
  } catch {
    /* A partial URL is not a login redirect. */
  }
  if (identityPlatform && !input.loading && confirmedLoginPage) {
    return { status: "offline", message: "账号页面已跳转至登录页", sessionCookiesPresent: present };
  }
  if (
    identityPlatform &&
    input.evidence &&
    now >= input.evidence.observedAt &&
    now - input.evidence.observedAt < 30000
  ) {
    return {
      status:
        input.evidence.kind === "unconfirmed" ? (input.previousStatus ?? "unknown") : input.evidence.kind,
      message: input.evidence.reason,
      sessionCookiesPresent: present,
      evidenceKey: input.evidence.key,
      ...(input.evidence.kind === "unconfirmed" ? { unconfirmed: true as const } : {}),
    };
  }

  const verdict =
    input.platformId === "weixin_channels"
      ? { kind: "unconfirmed" as const, status: null }
      : await runProbe(input, platform.login.probeFromMain);
  if (verdict.kind === "unconfirmed") {
    return {
      status: input.previousStatus ?? "unknown",
      message:
        input.platformId === "weixin_channels"
          ? "等待平台网页确认身份，可打开账号管理首页复核"
          : "平台回应暂不能确认登录状态，可打开账号管理首页复核",
      sessionCookiesPresent: present,
      probeStatus: verdict.status,
      unconfirmed: true,
    };
  }
  if (verdict.kind === "network_error") {
    return {
      status: "network_error",
      message: "网络不可用,无法验证登录态",
      sessionCookiesPresent: present,
      probeStatus: null,
    };
  }
  if (verdict.kind === "offline") {
    return {
      status: "offline",
      message: verdict.message,
      sessionCookiesPresent: present,
      probeStatus: verdict.status,
    };
  }
  const probeStatus = verdict.status;

  // Only the in-page probe may vouch for a login we cannot see in cookies; a
  // main-process 2xx with no session cookies is not evidence of anything.
  const provenOnline = verdict.kind === "online" && (present || Boolean(input.probe));
  if (!provenOnline) {
    if (input.platformId !== "bilibili") {
      return {
        status: input.previousStatus ?? "unknown",
        message: "后台未能确认登录态,打开账号页面后自动复核",
        sessionCookiesPresent: false,
        probeStatus,
        unconfirmed: true,
      };
    }
    // Preserve Bilibili's existing main-probe/cookie fallback; its strict
    // authenticated response parser is independent of the compatibility envelopes.
    const wasHealthy = input.previousStatus === "online" || input.previousStatus === "expiring";
    if (wasHealthy) {
      return {
        status: input.previousStatus as AccountStatus,
        message: "后台未能确认登录态,打开账号页面后自动复核",
        sessionCookiesPresent: false,
        probeStatus,
      };
    }
    return {
      status: "offline",
      message: "未检测到登录态,请扫码登录",
      sessionCookiesPresent: false,
      probeStatus,
    };
  }

  const base = input.lastOnlineAt ? Date.parse(input.lastOnlineAt) : now;
  const expiresAt = (Number.isFinite(base) ? base : now) + platform.login.sessionTtlHours * 3600_000;
  const warnAt = expiresAt - platform.login.expiryWarningHours * 3600_000;
  const status: AccountStatus = now >= warnAt ? "expiring" : "online";
  return {
    status,
    message: status === "expiring" ? "登录态即将过期,建议尽快打开账号页面续期" : "登录正常",
    sessionCookiesPresent: present,
    probeStatus,
    sessionExpiresAt: new Date(expiresAt).toISOString(),
  };
}

async function mainProcessProbe(input: DetectionInput): Promise<ProbeResponse> {
  const platform = getPlatform(input.platformId);
  if (input.platformId === "bilibili") {
    return gatedSessionProbe(input.accountId, input.session, platform.login.probe.url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
      },
    });
  }
  // No manual Referer: Chromium rejects a cross-site Referer on a main-process
  // fetch with ERR_BLOCKED_BY_CLIENT (api.bilibili.com vs member.bilibili.com).
  return gatedSessionFetch(input.accountId, input.session, platform.login.probe.url, {
    method: platform.login.probe.method ?? "GET",
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      ...(platform.login.probe.method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(platform.login.probe.method === "POST" ? { body: "{}" } : {}),
  });
}

/**
 * Script evaluated inside the account's page. It uses the page's own fetch,
 * so cookies, Referer/Origin and any interceptors the platform installed all
 * apply — exactly what happens when the operator opens the data tab.
 */
export function buildInPageProbeScript(platformId: PlatformId): string {
  const { probe } = getPlatform(platformId).login;
  const readBody =
    platformId === "bilibili"
      ? `let text = "";
        if (response.body) {
          const reader = response.body.getReader();
          const bytes = new Uint8Array(20000);
          let size = 0;
          let exceeded = false;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (chunk.value.byteLength > bytes.byteLength - size) {
                exceeded = true;
                break;
              }
              bytes.set(chunk.value, size);
              size += chunk.value.byteLength;
            }
            if (!exceeded) text = new TextDecoder().decode(bytes.subarray(0, size));
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        }`
      : `const text = await response.text();`;
  return `
    (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(${JSON.stringify(probe.url)}, {
          method: ${JSON.stringify(probe.method ?? "GET")},
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          headers: { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest"${probe.method === "POST" ? ', "content-type": "application/json"' : ""} },
          ${probe.method === "POST" ? 'body: "{}",' : ""}
        });
        ${readBody}
        return { status: response.status, text: ${platformId === "bilibili" ? "text" : "text.slice(0, 20000)"}, url: response.url };
      } catch (error) {
        return { status: 0, text: String(error && error.message || error), url: "" };
      } finally { clearTimeout(timeout); }
    })()
  `;
}
