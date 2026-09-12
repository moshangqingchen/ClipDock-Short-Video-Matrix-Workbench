import { session, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { PublicEgress } from "@shared/network";
import { ensureDirectSession } from "./direct-session";

export interface DiagnosticResults {
  direct: PublicEgress;
  proxy: PublicEgress;
}
const GEO_CACHE_MS = 24 * 3600_000;
const TIMEOUT_MS = 8_000;

function failed(): PublicEgress {
  return {
    state: "unavailable",
    country: null,
    asn: null,
    maskedIp: null,
    checkedAt: new Date().toISOString(),
    routeVerified: false,
  };
}

function maskedIp(ip: string): string {
  return isIP(ip) === 4
    ? `${ip.split(".").slice(0, 2).join(".")}.*.*`
    : `${ip.split(":").slice(0, 2).join(":")}:…`;
}

/** Disposable anonymous Chromium sessions; never obtain or copy an account session. */
export class AnonymousDiagnostics {
  private direct: Session | null = null;
  private proxy: Session | null = null;
  private proxyPort: number | null = null;
  private readonly requests = new Set<AbortController>();
  private readonly geo = new Map<string, { country: string; asn: number | null; expiresAt: number }>();
  private revision = 0;
  private paused = false;
  private cleanupFailed = false;
  private work: Promise<DiagnosticResults> | null = null;
  private draining: Promise<void> | null = null;
  private readonly owned = new Set<Session>();

  private guard(revision: number): void {
    if (this.paused || this.cleanupFailed || revision !== this.revision)
      throw new Error("DIAGNOSTICS_REVOKED");
  }

  private async clean(sessions: readonly Session[]): Promise<void> {
    const settled = await Promise.allSettled(
      sessions.map(async (ses) => {
        // Only this module's disposable anonymous partitions. Always try closing even if cookies
        // could not be cleared; a failed native cleanup must not be healed by a replacement Session.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => ses.clearStorageData({ storages: ["cookies"] })),
          Promise.resolve().then(() => ses.closeAllConnections()),
        ]);
        if (results.some((value) => value.status === "rejected"))
          throw new Error("DIAGNOSTICS_CLEANUP_FAILED");
      }),
    );
    if (settled.some((value) => value.status === "rejected")) {
      this.cleanupFailed = true;
      throw new Error("DIAGNOSTICS_CLEANUP_FAILED");
    }
  }

  private async text(ses: Session, url: string, revision: number): Promise<string> {
    this.guard(revision);
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await ses.fetch(url, {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("诊断响应为空");
      let cancellation: Promise<void> | null = null;
      const cancel = () => {
        // Already errored streams reject cancel too. The original read/fetch is still awaited;
        // cancellation settling is not our idle proof: verified Session cleanup follows the run.
        cancellation ??= Promise.resolve()
          .then(() => reader.cancel())
          .catch(() => undefined);
        return cancellation;
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) void cancel();
      const decoder = new TextDecoder();
      let size = 0;
      let text = "";
      try {
        this.guard(revision);
        if (!response.ok) throw new Error("诊断端点不可用");
        while (true) {
          const chunk = await reader.read();
          this.guard(revision);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 32_768) {
            controller.abort();
            throw new Error("诊断响应过大");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        await cancel();
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.requests.delete(controller);
    }
  }

  private async sessions(port: number, revision: number): Promise<{ direct: Session; proxy: Session }> {
    this.guard(revision);
    if (!this.direct) {
      this.direct = session.fromPartition(`sv-diagnostic-direct-${randomUUID()}`, { cache: false });
      this.owned.add(this.direct);
    }
    await ensureDirectSession(this.direct);
    this.guard(revision);
    if (!this.proxy || this.proxyPort !== port) {
      if (this.proxy) {
        await this.clean([this.proxy]);
        this.owned.delete(this.proxy);
      }
      this.guard(revision);
      this.proxy = session.fromPartition(`sv-diagnostic-proxy-${randomUUID()}`, { cache: false });
      this.owned.add(this.proxy);
      await this.proxy.setProxy({
        mode: "fixed_servers",
        proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
        proxyBypassRules: "<-loopback>",
      });
      await this.proxy.closeAllConnections();
      this.guard(revision);
      this.proxyPort = port;
    }
    return { direct: this.direct, proxy: this.proxy };
  }

  private async lookup(
    ses: Session,
    ip: string,
    revision: number,
  ): Promise<{ country: string; asn: number | null }> {
    this.guard(revision);
    const cached = this.geo.get(ip);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const raw: unknown = JSON.parse(
      await this.text(ses, `https://ipwho.is/${encodeURIComponent(ip)}`, revision),
    );
    const value = raw as {
      success?: boolean;
      ip?: string;
      country_code?: string;
      connection?: { asn?: number };
    };
    if (!value.success || value.ip !== ip || !/^[A-Z]{2}$/.test(value.country_code ?? ""))
      throw new Error("出口归属不可验证");
    const result = {
      country: value.country_code!,
      asn: Number.isInteger(value.connection?.asn) ? value.connection!.asn! : null,
      expiresAt: Date.now() + GEO_CACHE_MS,
    };
    this.guard(revision);
    if (this.geo.size >= 32) this.geo.clear();
    this.geo.set(ip, result);
    return result;
  }

  private async sample(ses: Session, kind: "direct" | "proxy", revision: number): Promise<PublicEgress> {
    try {
      const body = await this.text(
        ses,
        kind === "direct" ? "https://myip.ipip.net/" : "https://www.cloudflare.com/cdn-cgi/trace",
        revision,
      );
      const ip =
        kind === "direct"
          ? body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
          : body.match(/^ip=(.+)$/m)?.[1]?.trim();
      if (!ip || !isIP(ip)) throw new Error("没有出口证据");
      const geo = await this.lookup(ses, ip, revision);
      this.guard(revision);
      return {
        state: "reachable",
        country: geo.country,
        asn: geo.asn,
        maskedIp: maskedIp(ip),
        checkedAt: new Date().toISOString(),
        routeVerified: false,
      };
    } catch {
      return failed();
    }
  }

  run(proxyPort: number): Promise<DiagnosticResults> {
    if (this.paused || this.cleanupFailed || this.work || this.draining)
      return Promise.resolve({ direct: failed(), proxy: failed() });
    const revision = this.revision;
    const work = Promise.resolve()
      .then(async () => {
        let result: DiagnosticResults = { direct: failed(), proxy: failed() };
        try {
          const sessions = await this.sessions(proxyPort, revision);
          this.guard(revision);
          const [direct, proxy] = await Promise.all([
            this.sample(sessions.direct, "direct", revision),
            this.sample(sessions.proxy, "proxy", revision),
          ]);
          result = { direct, proxy };
        } catch {
          /* Unavailable; real initialization/request cleanup still belongs to this slot. */
        } finally {
          await this.clean([...this.owned]).catch(() => undefined);
        }
        return revision === this.revision && !this.paused && !this.cleanupFailed
          ? result
          : { direct: failed(), proxy: failed() };
      })
      .finally(() => {
        if (this.work === work) this.work = null;
      });
    this.work = work;
    return work;
  }

  stop(): void {
    this.revision++;
    for (const controller of this.requests) controller.abort();
    const interrupted = [...this.owned].map((ses) => Promise.resolve().then(() => ses.closeAllConnections()));
    const previous = this.draining,
      active = this.work;
    const draining = Promise.allSettled([previous, active, ...interrupted])
      .then(async (results) => {
        if (results.some((value) => value.status === "rejected")) this.cleanupFailed = true;
        // Initialization can complete after stop's first close. Clean again after that original
        // work is drained so it cannot refill the connection pool behind a successful pause.
        await this.clean([...this.owned]).catch(() => undefined);
      })
      .finally(() => {
        if (this.draining === draining) this.draining = null;
      });
    this.draining = draining;
  }

  pause(): Promise<void> {
    this.paused = true;
    this.stop();
    return this.whenIdle();
  }
  resume(): void {
    if (!this.cleanupFailed) this.paused = false;
  }
  async whenIdle(): Promise<void> {
    while (this.work || this.draining) await Promise.allSettled([this.work, this.draining]);
    if (this.cleanupFailed) throw new Error("DIAGNOSTICS_CLEANUP_FAILED");
  }
}
