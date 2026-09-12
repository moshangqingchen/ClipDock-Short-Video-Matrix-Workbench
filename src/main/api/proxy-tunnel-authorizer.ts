import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { WindowsControllerProcessIdentity } from "@main/network/windows-controller-owner";
import type { ProxyTransportLease, ProxyTunnelContext } from "./proxy-transport";
import { isOfficialProxyHost } from "./proxy-target-policy";
import { isDomesticWebHost } from "@main/network/domestic-web-target-policy";
import { isGlobalWebHost } from "@main/network/global-web-target-policy";
import {
  verifyProxyTunnelEvidence,
  verifyDomesticTunnelEvidence,
  verifyWebProxyTunnelEvidence,
  type ProxyTunnelReadResult,
  type VerifiedProxyTunnelEvidence,
} from "./proxy-tunnel-evidence";
export { proxyTunnelChainFingerprint, type ProxyTunnelReadResult } from "./proxy-tunnel-evidence";

type Endpoint = Readonly<{ host: string; port: number }>;
/** Main-only runtime input. Its producer must retain actual sample times and revoke on loss/change.
 * This is deliberately not PublicEgress/renderer state: a healthy mixed port is not a chain proof.
 */
export interface ProxyTunnelAuthorityState {
  readonly generation: number;
  readonly revision: string;
  readonly proxy: Endpoint;
  readonly controller: Endpoint;
  readonly controllerFingerprint: string;
  readonly kernelOwner: WindowsControllerProcessIdentity;
  readonly proxyState: "on" | "off" | "unknown";
  readonly checkedAtMono: number;
  readonly expiresAtMono: number;
  readonly egress: null | Readonly<{
    sampleId: string;
    generation: number;
    revision: string;
    countryCode: string;
    allowedCountries: readonly string[];
    /** Exact ordered name/type chain digest from the anonymous health/egress sample's own connection. */
    chainFingerprint: string;
    observedAtMono: number;
    expiresAtMono: number;
  }>;
}
export interface ProxyTunnelAuthorizerOptions {
  /** Main-owned scope. Existing API callers default to API-only target validation. */
  targetScope?: "api" | "website" | "domestic";
  readState(): ProxyTunnelAuthorityState | null;
  subscribeState(listener: () => void): () => void;
  /** Exact context, unchanged controller and real listener ownership; absent data is a refusal. */
  readTunnel(context: ProxyTunnelContext, signal: AbortSignal): Promise<ProxyTunnelReadResult | null>;
  /** Real underlying reader drain, including work whose public cancellation result already settled.
   * Must drain those readers only; recursively awaiting this authorizer would deadlock.
   */
  whenIdle(): Promise<void>;
  now?: () => number;
  leaseTtlMs?: number;
  evidenceTtlMs?: number;
  timeoutMs?: number;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const integer = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
function ip(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  // Windows can expose IPv4-mapped addresses while the kernel reports plain IPv4.
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i.exec(canonical);
  if (!mapped) return canonical;
  const bits = Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16);
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".");
}
function port(value: unknown): number | null {
  const number = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : value;
  return typeof number === "number" && integer(number, 1, 65535) ? number : null;
}
function sameOwner(a: WindowsControllerProcessIdentity, b: WindowsControllerProcessIdentity): boolean {
  return (
    integer(a.pid, 1, 0xffffffff) &&
    /^[1-9]\d{15,18}$/.test(a.createdAtTicks) &&
    hash(a.executablePathIdentity) &&
    a.pid === b.pid &&
    a.createdAtTicks === b.createdAtTicks &&
    a.executablePathIdentity === b.executablePathIdentity
  );
}
function localEndpoint(endpoint: Endpoint): boolean {
  const address = ip(endpoint.host);
  return !!address && (address === "::1" || address.startsWith("127.")) && port(endpoint.port) !== null;
}
interface Entry {
  context: ProxyTunnelContext;
  state: ProxyTunnelAuthorityState;
  binding: string;
  epoch: number;
  abort: AbortController;
  deadline: number;
  expiresAtMono: number;
  timer?: ReturnType<typeof setTimeout>;
  releaseListener: () => void;
  released: boolean;
  connectionId?: string;
  parent?: Entry;
}

/** Pure authorization orchestration: no default source, controller writes, browser, credentials or retries.
 * GlobalProxyRuntime supplies the production state and scoped tunnel readers. CONNECT 200 alone precedes route tracking;
 * if this kernel requires SNI to expose a final chain, the pre-TLS v1 transport remains refused.
 * The isolated 2026-09-08 run global-proxy-context.20260908T055121301Z.results.json observed
 * oauth2.googleapis.com's exact HTTPS/TCP flow before TLS on kernel 424c2ef (mixed port 10090), with the same ID after
 * default-verified TLS and zero application HTTP. It does not qualify every official target.
 */
export class ProxyTunnelAuthorizer {
  private readonly allowHost: typeof isOfficialProxyHost;
  private readonly verifyEvidence: typeof verifyProxyTunnelEvidence;
  private readonly now: () => number;
  private readonly leaseTtlMs: number;
  private readonly evidenceTtlMs: number;
  private readonly timeoutMs: number;
  private readonly entries = new Set<Entry>();
  private readonly issued = new WeakMap<ProxyTransportLease, Entry>();
  private readonly renewing = new Set<Entry>();
  private readonly work = new Set<Promise<void>>();
  private readonly preparations = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private epoch = 0;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  constructor(private readonly options: ProxyTunnelAuthorizerOptions) {
    if (
      options.targetScope !== undefined &&
      options.targetScope !== "api" &&
      options.targetScope !== "website" &&
      options.targetScope !== "domestic"
    )
      throw new Error("INVALID_TUNNEL_AUTHORIZER_OPTIONS");
    this.allowHost =
      options.targetScope === "domestic"
        ? isDomesticWebHost
        : options.targetScope === "website"
          ? isGlobalWebHost
          : isOfficialProxyHost;
    this.verifyEvidence =
      options.targetScope === "domestic"
        ? verifyDomesticTunnelEvidence
        : options.targetScope === "website"
          ? verifyWebProxyTunnelEvidence
          : verifyProxyTunnelEvidence;
    this.now = options.now ?? (() => performance.now());
    this.leaseTtlMs = options.leaseTtlMs ?? 5_000;
    this.evidenceTtlMs = options.evidenceTtlMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if ([this.leaseTtlMs, this.evidenceTtlMs, this.timeoutMs].some((value) => !integer(value, 1, 15_000)))
      throw new Error("INVALID_TUNNEL_AUTHORIZER_OPTIONS");
  }

  readonly authorizeTunnel = async (
    context: ProxyTunnelContext,
    signal: AbortSignal,
  ): Promise<ProxyTransportLease | null> => {
    if (this.disposed || signal.aborted) return null;
    let complete!: () => void;
    const preparation = new Promise<void>((resolve) => {
      complete = resolve;
    });
    // Reserve before any external readState/subscribe callback can reenter whenIdle or dispose.
    this.preparations.add(preparation);
    try {
      return await this.authorizeOnce(context, signal);
    } finally {
      this.preparations.delete(preparation);
      complete();
    }
  };

  /** Re-read the same still-live connection. An expired, foreign or already-replaced lease cannot renew. */
  readonly renewTunnel = async (
    context: ProxyTunnelContext,
    previous: ProxyTransportLease,
    signal: AbortSignal,
  ): Promise<ProxyTransportLease | null> => {
    const entry = previous && this.issued.get(previous);
    if (!entry || !entry.connectionId || this.renewing.has(entry) || signal.aborted || !this.current(entry))
      return null;
    let same = false;
    try {
      same = JSON.stringify(context) === JSON.stringify(entry.context);
    } catch {
      /* Refuse altered context. */
    }
    if (!same) return null;
    let complete!: () => void;
    const preparation = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.preparations.add(preparation);
    this.renewing.add(entry);
    try {
      const next = await this.authorizeOnce(context, signal, entry);
      if (!next) this.release(entry);
      return next;
    } finally {
      this.renewing.delete(entry);
      this.preparations.delete(preparation);
      complete();
    }
  };

  private async authorizeOnce(
    context: ProxyTunnelContext,
    signal: AbortSignal,
    previous?: Entry,
  ): Promise<ProxyTransportLease | null> {
    const epoch = this.epoch;
    let state: ProxyTunnelAuthorityState | null, input: ProxyTunnelContext;
    try {
      state = this.currentState();
      input = structuredClone(context);
    } catch {
      return null;
    }
    if (
      this.disposed ||
      epoch !== this.epoch ||
      signal.aborted ||
      !state ||
      !this.validContext(input, state, Boolean(previous)) ||
      (previous && !this.current(previous)) ||
      this.entries.size >= 8 ||
      this.work.size >= 8 ||
      [...this.entries].some((entry) => entry.context.id === input.id && entry !== previous)
    )
      return null;
    const entry: Entry = {
      context: input,
      state,
      binding: this.binding(state),
      epoch,
      abort: new AbortController(),
      deadline: Math.min(
        this.now() + this.timeoutMs,
        state.expiresAtMono,
        state.egress!.expiresAtMono,
        previous?.expiresAtMono ?? Infinity,
      ),
      expiresAtMono: 0,
      releaseListener: () => undefined,
      released: false,
      parent: previous,
    };
    const cancel = () => this.release(entry);
    signal.addEventListener("abort", cancel, { once: true });
    entry.releaseListener = () => signal.removeEventListener("abort", cancel);
    this.entries.add(entry);
    entry.timer = setTimeout(cancel, Math.max(1, entry.deadline - this.now()));
    entry.timer.unref?.();
    try {
      if (!this.unsubscribe) {
        const unsubscribe = this.options.subscribeState(() => this.reconcile());
        if (typeof unsubscribe !== "function") throw new Error();
        this.unsubscribe = unsubscribe;
      }
      if (!this.current(entry)) {
        this.release(entry);
        return null;
      }
      // Reserve before providers run. Abort may return early, but whenIdle retains the actual source drain.
      let readStartedAtMono = this.now();
      const reader = Promise.resolve().then(() => {
        readStartedAtMono = this.now();
        return this.current(entry)
          ? this.options.readTunnel(structuredClone(input), entry.abort.signal)
          : null;
      });
      const drain = reader
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => this.options.whenIdle())
        .catch(() => {
          this.invalidate();
        });
      this.work.add(drain);
      void drain.finally(() => this.work.delete(drain));
      const evidence = await new Promise<ProxyTunnelReadResult | null>((resolve) => {
        const cancelled = () => resolve(null);
        entry.abort.signal.addEventListener("abort", cancelled, { once: true });
        void reader
          .then(async (value) => {
            const snapshot = value ? structuredClone(value) : null;
            await drain;
            resolve(snapshot);
          })
          .catch(() => resolve(null))
          .finally(() => entry.abort.signal.removeEventListener("abort", cancelled));
        if (entry.abort.signal.aborted) cancelled();
      });
      if (!evidence || !this.current(entry)) {
        this.release(entry);
        return null;
      }
      // The independent egress probe may finish during the actual tunnel read.
      // A NEW grant can use that fresh, identically bound source. Existing leases
      // and the preparation deadline remain fixed; no expired entry is revived.
      const issuanceState = this.currentState();
      if (!issuanceState || this.binding(issuanceState) !== entry.binding || !this.current(entry)) {
        this.release(entry);
        return null;
      }
      const verified = this.verify(
        input,
        issuanceState,
        evidence,
        this.now(),
        readStartedAtMono,
        previous?.connectionId,
      );
      if (verified === null || !this.current(entry)) {
        this.release(entry);
        return null;
      }
      entry.expiresAtMono = Math.min(
        verified.evidenceExpiresAtMono,
        this.now() + this.leaseTtlMs,
        issuanceState.expiresAtMono,
        issuanceState.egress!.expiresAtMono,
      );
      if (entry.expiresAtMono <= Math.max(this.now(), previous?.expiresAtMono ?? 0) || !this.current(entry)) {
        this.release(entry);
        return null;
      }
      clearTimeout(entry.timer);
      entry.timer = setTimeout(cancel, Math.max(1, entry.expiresAtMono - this.now()));
      entry.timer.unref?.();
      entry.connectionId = verified.connectionId;
      entry.parent = undefined;
      const lease = Object.freeze({
        generation: state.generation,
        expiresAtMono: entry.expiresAtMono,
        signal: entry.abort.signal,
        isCurrent: () => this.current(entry),
        release: cancel,
      });
      this.issued.set(lease, entry);
      return lease;
    } catch {
      this.release(entry);
      return null;
    }
  }

  invalidate(): void {
    this.epoch++;
    for (const entry of [...this.entries]) this.release(entry);
  }
  async whenIdle(): Promise<void> {
    while (this.work.size || this.preparations.size)
      await Promise.allSettled([...this.work, ...this.preparations]);
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let complete!: () => void;
    this.disposal = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.disposed = true;
    this.invalidate();
    void this.whenIdle().then(complete);
    return this.disposal;
  }
  private release(entry: Entry): void {
    if (!entry.released) {
      entry.released = true;
      this.entries.delete(entry);
      clearTimeout(entry.timer);
      entry.releaseListener();
      entry.abort.abort();
      for (const child of [...this.entries]) if (child.parent === entry) this.release(child);
    }
    if (!this.entries.size && this.unsubscribe) {
      const off = this.unsubscribe;
      this.unsubscribe = null;
      try {
        off();
      } catch {
        /* permission already revoked */
      }
    }
  }
  private reconcile(): void {
    for (const entry of [...this.entries]) if (!this.current(entry)) this.release(entry);
  }
  private current(entry: Entry): boolean {
    if (entry.released || this.disposed || entry.epoch !== this.epoch || entry.abort.signal.aborted)
      return false;
    if (entry.parent && !this.current(entry.parent)) {
      this.release(entry);
      return false;
    }
    let state: ProxyTunnelAuthorityState | null = null;
    try {
      state = this.currentState();
    } catch {
      /* unknown is closed */
    }
    const deadline = entry.expiresAtMono || entry.deadline;
    const valid =
      !!state &&
      !entry.released &&
      !this.disposed &&
      entry.epoch === this.epoch &&
      !entry.abort.signal.aborted &&
      this.binding(state) === entry.binding &&
      deadline <= state.expiresAtMono &&
      deadline <= state.egress!.expiresAtMono &&
      this.now() < deadline &&
      !entry.released &&
      entry.epoch === this.epoch &&
      !this.disposed;
    if (!valid) this.release(entry);
    return valid;
  }
  private currentState(): ProxyTunnelAuthorityState | null {
    const raw = this.options.readState();
    if (!raw) return null;
    const state = structuredClone(raw),
      now = this.now(),
      egress = state.egress;
    if (
      !integer(state.generation, 0, Number.MAX_SAFE_INTEGER) ||
      !token(state.revision) ||
      !hash(state.controllerFingerprint) ||
      !localEndpoint(state.proxy) ||
      !localEndpoint(state.controller) ||
      !sameOwner(state.kernelOwner, state.kernelOwner) ||
      state.proxyState !== "on" ||
      !this.fresh(state.checkedAtMono, state.expiresAtMono, now) ||
      !egress ||
      !token(egress.sampleId) ||
      egress.generation !== state.generation ||
      egress.revision !== state.revision ||
      !hash(egress.chainFingerprint) ||
      !/^[A-Z]{2}$/.test(egress.countryCode) ||
      !Array.isArray(egress.allowedCountries) ||
      !egress.allowedCountries.length ||
      egress.allowedCountries.length > 250 ||
      egress.allowedCountries.some((value) => !/^[A-Z]{2}$/.test(value)) ||
      !egress.allowedCountries.includes(egress.countryCode) ||
      (this.options.targetScope === "domestic" && egress.countryCode !== "CN") ||
      !this.fresh(egress.observedAtMono, egress.expiresAtMono, now)
    )
      return null;
    return state;
  }
  private binding(state: ProxyTunnelAuthorityState): string {
    return digest(
      JSON.stringify([
        state.generation,
        state.revision,
        state.proxy,
        state.controller,
        state.controllerFingerprint,
        state.kernelOwner,
        state.proxyState,
        state.egress?.chainFingerprint,
        state.egress?.countryCode,
        state.egress?.allowedCountries,
      ]),
    );
  }
  private fresh(start: number, expiry: number, now: number): boolean {
    return (
      Number.isFinite(start) &&
      Number.isFinite(expiry) &&
      start >= 0 &&
      start <= now &&
      now < expiry &&
      expiry <= start + this.evidenceTtlMs
    );
  }
  private validContext(
    input: ProxyTunnelContext,
    state: ProxyTunnelAuthorityState,
    continued = false,
  ): boolean {
    return (
      token(input.id) &&
      input.target.port === 443 &&
      this.allowHost(input.platformId, input.target.host) &&
      input.proxy.host === state.proxy.host &&
      input.proxy.port === state.proxy.port &&
      ip(input.socket.remoteAddress) === ip(state.proxy.host) &&
      input.socket.remotePort === state.proxy.port &&
      port(input.socket.localPort) !== null &&
      ip(input.socket.localAddress) !== null &&
      Number.isFinite(input.connectedAtMono) &&
      input.connectedAtMono >= 0 &&
      input.connectedAtMono <= this.now() &&
      (continued || this.now() - input.connectedAtMono < this.evidenceTtlMs)
    );
  }
  private verify(
    input: ProxyTunnelContext,
    state: ProxyTunnelAuthorityState,
    value: ProxyTunnelReadResult,
    now: number,
    readStartedAtMono: number,
    expectedConnectionId?: string,
  ): VerifiedProxyTunnelEvidence | null {
    const verified = this.verifyEvidence({
      context: input,
      evidence: value,
      controller: state.controller,
      proxy: state.proxy,
      generation: state.generation,
      revision: state.revision,
      nowMono: now,
      readStartedAtMono,
      evidenceTtlMs: this.evidenceTtlMs,
      expectedConnectionId,
    });
    return verified &&
      verified.controllerFingerprint === state.controllerFingerprint &&
      sameOwner(verified.kernelOwner, state.kernelOwner) &&
      verified.chainFingerprint === state.egress!.chainFingerprint
      ? verified
      : null;
  }
}
