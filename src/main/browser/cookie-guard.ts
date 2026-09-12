import type { Cookie, Session } from "electron";
import { getPlatform, hostMatches, type PlatformId } from "@shared/platforms";

const PERSIST_DAYS = 30;
const FLUSH_DEBOUNCE_MS = 2_000;

export interface CookieGuardOptions {
  /** Called (debounced) whenever a cookie relevant to login changes. */
  onSessionCookiesChanged?: () => void;
}

/**
 * Keeps an account logged in across restarts.
 *
 * Chromium discards "session" cookies (no expiration) when the process exits.
 * Several platforms (WeChat Channels, Kuaishou, parts of Douyin/Baijiahao)
 * issue their login cookie without an expiration, which is why the previous
 * build dropped logins on every restart. The guard rewrites such cookies with
 * a 30-day expiry *on the platform's own login domains only*. The server-side
 * session is untouched: if the platform really expires it, requests fail and
 * LoginDetector flips the account offline. It also flushes the cookie store to
 * disk shortly after changes so a crash cannot lose a fresh login.
 */
export class CookieGuard {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly domains: readonly string[];

  constructor(
    private readonly session: Session,
    private readonly platformId: PlatformId,
    private readonly options: CookieGuardOptions = {},
  ) {
    this.domains = getPlatform(platformId).login.cookieDomains;
    this.session.cookies.on("changed", this.onChanged);
  }

  private readonly onChanged = (_event: unknown, cookie: Cookie, _cause: string, removed: boolean) => {
    if (this.disposed) return;
    if (!removed && cookie.session && this.isLoginDomain(cookie.domain ?? "")) {
      void this.persist(cookie);
    }
    this.scheduleFlush();
    const login = getPlatform(this.platformId).login.sessionCookies;
    if (this.isLoginDomain(cookie.domain ?? "") &&
        [...login.required, ...(login.anyOf ?? [])].includes(cookie.name)) this.scheduleNotify();
  };

  private isLoginDomain(domain: string): boolean {
    const bare = domain.replace(/^\./, "");
    return this.domains.some((d) => hostMatches(bare, d));
  }

  private async persist(cookie: Cookie): Promise<void> {
    const domain = cookie.domain ?? "";
    const host = domain.replace(/^\./, "");
    if (!host) return;
    const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
    const expirationDate = Math.floor(Date.now() / 1000) + PERSIST_DAYS * 24 * 3600;
    try {
      await this.session.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate,
      });
    } catch {
      // Some cookies (e.g. __Host- prefixed with conflicting attributes) cannot
      // be re-set; they were going to be session-only regardless.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private scheduleNotify(): void {
    if (!this.options.onSessionCookiesChanged) return;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.options.onSessionCookiesChanged?.();
    }, 1_500);
  }

  async flush(): Promise<void> {
    try {
      await this.session.cookies.flushStore();
    } catch {
      // best-effort
    }
  }

  /** Convert all existing session cookies on login domains right now. */
  async persistExisting(): Promise<void> {
    let cookies: Cookie[];
    try {
      cookies = await this.session.cookies.get({});
    } catch {
      return;
    }
    for (const cookie of cookies) {
      if (cookie.session && this.isLoginDomain(cookie.domain ?? "")) await this.persist(cookie);
    }
    await this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    try {
      this.session.cookies.removeListener("changed", this.onChanged);
    } catch {
      // ignore
    }
  }
}
