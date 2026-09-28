import type { Cookie, Session } from "electron";
import { getPlatform, hostMatches, type PlatformId } from "@shared/platforms";

const PERSIST_DAYS = 30;
const guards = new Set<CookieGuard>();
const sessionCookieRevisions = new WeakMap<Session, number>();
export interface CookieDiagnostic {
  phase: "restore" | "persist" | "flush";
  outcome: "success" | "failed" | "timeout";
  pending: number;
  cookies?: Array<Pick<Cookie, "name" | "domain" | "path" | "hostOnly" | "secure" | "httpOnly" | "sameSite" | "session" | "expirationDate">>;
}
export interface CookieGuardOptions {
  onSessionCookiesChanged?: () => void;
  onDiagnostic?: (diagnostic: CookieDiagnostic) => void;
}
/** A host-only cookie must never acquire Domain. */
export function persistentCookie(cookie: Cookie): Electron.CookiesSetDetails {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
    name: cookie.name, value: cookie.value,
    ...(!cookie.hostOnly && cookie.domain ? { domain: cookie.domain } : {}),
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    expirationDate: Math.floor(Date.now() / 1000) + PERSIST_DAYS * 86400,
  };
}
/** Native writes cannot be cancelled: reset drains them before clearing storage. */
export async function flushCookieGuards(session?: Session, timeoutMs = 5_000): Promise<boolean> {
  const results = await Promise.all([...guards].filter((g) => !session || g.session === session).map((g) => g.flush(timeoutMs, true)));
  return results.every(Boolean);
}
export class CookieGuard {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private readonly failedWrites = new Map<string, number>();
  private readonly domains: readonly string[];
  constructor(readonly session: Session, private readonly platformId: PlatformId, private readonly options: CookieGuardOptions = {}) {
    this.domains = getPlatform(platformId).login.cookieDomains;
    guards.add(this);
    session.cookies.on("changed", this.onChanged);
  }
  private key(cookie: Cookie): string { return `${cookie.domain ?? ""}\n${cookie.path ?? "/"}\n${cookie.name}`; }
  private diagnostic(phase: CookieDiagnostic["phase"], outcome: CookieDiagnostic["outcome"], cookies?: Cookie[]): void {
    try {
      this.options.onDiagnostic?.({ phase, outcome, pending: this.pending.size,
        ...(cookies ? { cookies: cookies.filter((c) => this.relevant(c)).map((c) => ({
          name: c.name, domain: c.domain, path: c.path, hostOnly: c.hostOnly,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          session: c.session, expirationDate: c.expirationDate,
        })) } : {}),
      });
    } catch { /* Diagnostics must not prevent persistence. */ }
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.finally(() => {
      this.pending.delete(work);
      this.releaseIfSettled();
    }).catch(() => undefined);
    return work;
  }
  private releaseIfSettled(): void {
    if (this.disposed && !this.pending.size && !this.failedWrites.size) guards.delete(this);
  }
  private sessionPending(): Promise<unknown>[] {
    return [...guards].filter((guard) => guard.session === this.session).flatMap((guard) => [...guard.pending]);
  }
  private relevant(cookie: Cookie): boolean {
    return this.domains.some((d) => hostMatches((cookie.domain ?? "").replace(/^\./, ""), d));
  }
  private readonly onChanged = (_event: unknown, cookie: Cookie, _cause: string, removed: boolean) => {
    if (this.disposed || !this.relevant(cookie)) return;
    sessionCookieRevisions.set(this.session, (sessionCookieRevisions.get(this.session) ?? 0) + 1);
    const key = this.key(cookie);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    // A removal or replacement supersedes the failed value. A failed write of
    // this new revision will be tracked separately, without retaining secrets.
    this.failedWrites.delete(key);
    if (!removed && cookie.session) void this.persist(cookie);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, 2_000);
    const login = getPlatform(this.platformId).login.sessionCookies;
    if ([...login.required, ...(login.anyOf ?? [])].includes(cookie.name) && this.options.onSessionCookiesChanged) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = undefined;
        if (!this.disposed) this.options.onSessionCookiesChanged?.();
      }, 1_500);
    }
  };
  private persist(cookie: Cookie): Promise<void> {
    if (this.disposed || !cookie.domain) return Promise.resolve();
    const key = this.key(cookie);
    const revision = this.revisions.get(key) ?? 0;
    return this.track((async () => {
      try {
        await this.session.cookies.set(persistentCookie(cookie));
        if ((this.revisions.get(key) ?? 0) === revision) this.failedWrites.delete(key);
      } catch {
        // A late failure for an old value must not poison a newer cookie.
        if ((this.revisions.get(key) ?? 0) === revision) this.failedWrites.set(key, revision);
        this.diagnostic("persist", "failed", [cookie]);
      }
    })());
  }
  async flush(timeoutMs = 5_000, captureMetadata = false): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const save = async (): Promise<{ outcome: CookieDiagnostic["outcome"]; cookies?: Cookie[] }> => {
      for (;;) {
        if (timedOut) return { outcome: "timeout" };
        // A replacement view may own the same Session while this disposed guard
        // still has a native write or an unresolved failure. Drain both owners.
        let pending = this.sessionPending();
        while (pending.length) {
          await Promise.allSettled(pending);
          if (timedOut) return { outcome: "timeout" };
          pending = this.sessionPending();
        }
        const sessionRevision = sessionCookieRevisions.get(this.session) ?? 0;
        await this.session.cookies.flushStore();
        const failures = new Map(this.failedWrites);
        const cookies = captureMetadata || failures.size ? await this.session.cookies.get({}) : undefined;
        // Never let an old jar snapshot clear a failure from a newer rotation,
        // including changes observed by the replacement guard after disposal.
        if (this.sessionPending().length || (sessionCookieRevisions.get(this.session) ?? 0) !== sessionRevision) continue;
        if (cookies && failures.size) {
          const current = new Map(cookies.map((cookie) => [this.key(cookie), cookie]));
          for (const [key, revision] of failures) {
            if (this.failedWrites.get(key) === revision && !current.get(key)?.session)
              this.failedWrites.delete(key);
          }
        }
        this.releaseIfSettled();
        return { outcome: this.failedWrites.size ? "failed" : "success", ...(captureMetadata ? { cookies } : {}) };
      }
    };
    try {
      const result = await Promise.race([save(), new Promise<{ outcome: "timeout" }>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve({ outcome: "timeout" }); }, timeoutMs);
      })]);
      this.diagnostic("flush", result.outcome, "cookies" in result ? result.cookies : undefined);
      return result.outcome === "success";
    } catch { this.diagnostic("flush", "failed"); return false; }
    finally { if (timer) clearTimeout(timer); }
  }
  async persistExisting(): Promise<void> {
    const revisions = new Map(this.revisions);
    await this.track((async () => {
      try {
        const cookies = await this.session.cookies.get({});
        if (this.disposed) return;
        this.diagnostic("restore", "success", cookies);
        for (const cookie of cookies) {
          if (this.disposed) return;
          if (cookie.session && this.relevant(cookie) && this.revisions.get(this.key(cookie)) === revisions.get(this.key(cookie)))
            await this.persist(cookie);
        }
      } catch { this.diagnostic("restore", "failed"); }
    })());
    if (!this.disposed) await this.flush();
  }
  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.session.cookies.removeListener("changed", this.onChanged);
    this.releaseIfSettled();
  }
}
