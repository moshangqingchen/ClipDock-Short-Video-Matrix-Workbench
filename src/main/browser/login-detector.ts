import type { Cookie, Session } from "electron";
import { getPlatform, hostMatches, isLoginUrl, isVerificationUrl, type PlatformId } from "@shared/platforms";
import type { AccountStatus } from "@shared/types";

export interface ProbeResponse {
  status: number;
  text: string;
  /** Final URL after redirects, when known. */
  url?: string;
}

export interface DetectionInput {
  platformId: PlatformId;
  session: Pick<Session, "cookies" | "fetch">;
  /** Current top-level URL of the account view, if one exists. */
  currentUrl?: string | null;
  loading?: boolean;
  /** Skip the network probe (cookie + URL heuristics only). */
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
}

export interface DetectionResult {
  status: AccountStatus;
  message: string;
  sessionCookiesPresent: boolean;
  probeStatus?: number | null;
  sessionExpiresAt?: string | null;
}

const LOGGED_OUT_BODY_PATTERNS: Record<PlatformId, RegExp[]> = {
  douyin: [/"status_code"\s*:\s*(?:8|2190004|2190008|2190015)\b/, /"status_msg"\s*:\s*"[^"]*(?:登录|login)/i],
  kuaishou: [/"result"\s*:\s*(?:109|401|100110000)\b/, /"error_msg"\s*:\s*"[^"]*(?:登录|login)/i],
  xiaohongshu: [/"code"\s*:\s*-100\b/, /"msg"\s*:\s*"[^"]*(?:登录|login)/i],
  bilibili: [/"code"\s*:\s*-101\b/, /"isLogin"\s*:\s*false/],
  baijiahao: [/"errno"\s*:\s*(?:10000|110|10001)\b/, /"errmsg"\s*:\s*"[^"]*(?:登录|login)/i],
  weixin_channels: [/"errCode"\s*:\s*3003(?:30|33|34)\b/, /"errMsg"\s*:\s*"[^"]*(?:登录|login|session)/i],
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
  | { kind: "inconclusive"; status: number | null }
  | { kind: "network_error" };

async function runProbe(input: DetectionInput, platformProbeFromMain: boolean): Promise<ProbeVerdict> {
  if (input.skipProbe) return { kind: "inconclusive", status: null };
  if (!input.probe && !platformProbeFromMain) return { kind: "inconclusive", status: null };
  let response: ProbeResponse | null;
  try {
    response = input.probe ? await input.probe() : await mainProcessProbe(input);
  } catch {
    return { kind: "network_error" };
  }
  if (!response) return { kind: "inconclusive", status: null };
  if (response.status === 401)
    return { kind: "offline", status: 401, message: "平台接口返回 401,登录态失效" };
  if (response.status >= 200 && response.status < 300) {
    if (bodyLooksLoggedOut(input.platformId, response.text)) {
      return { kind: "offline", status: response.status, message: "平台接口提示未登录" };
    }
    // An HTML answer to a JSON endpoint that landed on a login URL means the
    // platform redirected the request to its passport page.
    if (
      /^\s*<(?:!doctype|html)/i.test(response.text) &&
      response.url &&
      isLoginUrl(input.platformId, response.url)
    ) {
      return { kind: "offline", status: response.status, message: "平台接口跳转到登录页,登录态失效" };
    }
    return { kind: "online", status: response.status };
  }
  return { kind: "inconclusive", status: response.status };
}

/**
 * Decide an account's status from three signals, strongest first:
 *
 * 1. A probe issued *inside the account's page* (the platform's own answer to
 *    "am I logged in", with all page-side headers/signatures). Conclusive
 *    either way, regardless of which cookie names we expected.
 * 2. Cookies on the platform's login domains. Absence means offline unless a
 *    live page proved otherwise; presence alone is only "probably online".
 * 3. The URL the view shows. Login/passport URLs are a weak signal because
 *    consoles bounce through them during redirects; they decide only when the
 *    probe was skipped or inconclusive.
 *
 * Without a live page, a main-process probe is used only on platforms whose
 * endpoints answer it faithfully (`probeFromMain`), and an account that was
 * online is not downgraded on cookie heuristics alone — the next time its
 * page is opened the in-page probe re-checks.
 */
export async function detectLoginState(input: DetectionInput): Promise<DetectionResult> {
  const now = input.now ?? Date.now();
  const platform = getPlatform(input.platformId);
  const url = input.currentUrl ?? "";

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

  const verdict = await runProbe(input, platform.login.probeFromMain);
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
    if (!present) {
      const wasHealthy = input.previousStatus === "online" || input.previousStatus === "expiring";
      if (wasHealthy && !input.probe) {
        // Background check with no page to ask: cookie names alone are not
        // enough evidence to log the account out. Keep the last verdict.
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
    // A view sitting on a login route is only a weak signal (redirect chains).
    const settledOnLoginPage =
      Boolean(url) &&
      !input.loading &&
      isLoginUrl(input.platformId, url) &&
      !isHomeLike(input.platformId, url);
    if (settledOnLoginPage) {
      return {
        status: "offline",
        message: "平台已跳转到登录页,登录态失效",
        sessionCookiesPresent: true,
        probeStatus,
      };
    }
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
  // No manual Referer: Chromium rejects a cross-site Referer on a main-process
  // fetch with ERR_BLOCKED_BY_CLIENT (api.bilibili.com vs member.bilibili.com).
  const response = await input.session.fetch(platform.login.probe.url, {
    method: platform.login.probe.method ?? "GET",
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    },
    ...(platform.login.probe.method === "POST" ? { body: "{}" } : {}),
  });
  const text = response.ok ? await response.text().catch(() => "") : "";
  return { status: response.status, text, url: response.url };
}

/**
 * Script evaluated inside the account's page. It uses the page's own fetch,
 * so cookies, Referer/Origin and any interceptors the platform installed all
 * apply — exactly what happens when the operator opens the data tab.
 */
export function buildInPageProbeScript(platformId: PlatformId): string {
  const { probe } = getPlatform(platformId).login;
  return `
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(probe.url)}, {
          method: ${JSON.stringify(probe.method ?? "GET")},
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest"${probe.method === "POST" ? ', "content-type": "application/json"' : ""} },
          ${probe.method === "POST" ? 'body: "{}",' : ""}
        });
        const text = await response.text();
        return { status: response.status, text: text.slice(0, 20000), url: response.url };
      } catch (error) {
        return { status: 0, text: String(error && error.message || error), url: "" };
      }
    })()
  `;
}

/** `creator.douyin.com/` is both the login shell and the console root. */
function isHomeLike(platformId: PlatformId, url: string): boolean {
  const routes = getPlatform(platformId).routes;
  const normalized = url.replace(/[?#].*$/, "").replace(/\/$/, "");
  return [routes.home, routes.upload, routes.analytics, routes.works, routes.comments]
    .filter(Boolean)
    .some((route) => normalized.startsWith((route as string).replace(/[?#].*$/, "").replace(/\/$/, "")));
}
