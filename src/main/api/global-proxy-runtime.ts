import { createHash, randomUUID } from "node:crypto";
import type { GlobalPlatformId, CnPlatformId } from "@shared/platforms";
import type { ExclusiveAccessSnapshot } from "@shared/network";
import type { GlobalOAuthEligibility } from "./global-oauth-service";
import { GlobalWebProxyPool } from "@main/network/global-web-proxy-pool";
import { WindowsTunnelOwnership } from "@main/network/windows-tunnel-ownership";
import type { GlobalWebTunnel, GlobalWebTunnelInput } from "@main/network/global-web-tunnel";
import { ProxyEgressProbe, type ProxyEgressSample } from "./proxy-egress-probe";
import { ProxyTunnelReader } from "./proxy-tunnel-reader";
import { ProxyTunnelAuthorizer, type ProxyTunnelAuthorityState } from "./proxy-tunnel-authorizer";
import {
  ProxyTransport,
  ProxyTransportError,
  type ProxyTransportRequest,
  type ProxyTransportResponse,
} from "./proxy-transport";

// Route geography only. API access, application review and regional platform availability
// remain separate checks. Unknown/anonymous region codes and mainland CN are not eligible.
export const GLOBAL_EGRESS_COUNTRIES = Object.freeze(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

interface Configuration {
  controllerUrl: string;
  proxyPort: number;
  /** Main-only digest of the saved controller credential row; never the secret itself. */
  credentialRevision: string;
}
interface Context {
  generation: number;
  revision: string;
  proxy: { host: string; port: number };
  controller: { host: string; port: number };
  readVersion(): { generation: number; revision: string } | null;
  readAuthority(): ProxyTunnelAuthorityState | null;
  subscribe(listener: () => void): () => void;
}
export interface GlobalProxyClients {
  sample(signal: AbortSignal): Promise<ProxyEgressSample | null>;
  request(input: ProxyTransportRequest): Promise<ProxyTransportResponse>;
  openWebTunnel?(input: GlobalWebTunnelInput): Promise<GlobalWebTunnel>;
  invalidate(): void;
  dispose(): Promise<void>;
}
export interface GlobalProxyRuntimeOptions {
  /** Main-only DIRECT website transport; never used by overseas API clients. */
  domesticDirect?: boolean;
  configuration(): Configuration;
  readSwitch(): Pick<ExclusiveAccessSnapshot, "proxy" | "generation">;
  readNetwork(): { available: boolean; hash: string | null };
  getSecret(): string | null;
  /** Explicit controlled tests only; production uses the real reader/probe/authorizer/transport. */
  createClients?(context: Context): GlobalProxyClients;
  now?: () => number;
}
interface Bundle {
  generation: number;
  revision: string;
  binding: string;
  clients: GlobalProxyClients;
  controller: { host: string; port: number };
  proxy: { host: string; port: number };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = () => new ProxyTransportError("AUTHORIZATION_DENIED");

/** On-demand international source. No account session, renderer authority or persisted lease.
 * Business requests remain serialized; anonymous renewal has its own reader and execution lane
 * so a long response cannot block its own proof. Failed/expired renewal revokes all transports.
 */
export class GlobalProxyRuntime {
  private readonly now: () => number;
  private generation = 1;
  private revision = randomUUID();
  private bundle: Bundle | null = null;
  private authority: ProxyTunnelAuthorityState | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly leases = new Set<AbortController>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly webOpenings = new Set<Promise<unknown>>();
  private readonly retiring = new Set<Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private proofTail: Promise<unknown> = Promise.resolve();
  private flight: Promise<void> | null = null;
  private sampling: AbortController | null = null;
  private controllerFingerprint: string | null | undefined;
  private controllerEpoch = 0;
  private sampleDurationMs = 0;
  private renewal: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private cleanupFailed = false;

  constructor(private readonly options: GlobalProxyRuntimeOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Synchronous invalidation is wired to OS, switch, settings, credential and suspension changes. */
  invalidate(): void {
    this.generation++;
    this.revision = randomUUID();
    this.authority = null;
    this.sampleDurationMs = 0;
    clearTimeout(this.renewal);
    clearTimeout(this.expiry);
    this.renewal = this.expiry = undefined;
    this.sampling?.abort();
    for (const lease of this.leases) lease.abort();
    this.leases.clear();
    const old = this.bundle;
    this.bundle = null;
    if (old) {
      // Publish the real retirement barrier before invoking any foreign cleanup callback.
      let finish!: () => void;
      const drain = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.retiring.add(drain);
      try {
        old.clients.invalidate();
      } catch {
        this.cleanupFailed = true;
      }
      void Promise.resolve()
        .then(() => old.clients.dispose())
        .catch(() => {
          this.cleanupFailed = true;
        })
        .finally(() => {
          this.retiring.delete(drain);
          finish();
        });
    }
    this.publish();
  }

  sync(): void {
    if (this.bundle && !this.current(this.bundle)) this.invalidate();
    else if (this.authority && this.now() >= this.authority.expiresAtMono) this.invalidate();
  }

  observeController(fingerprint: string | null): void {
    if (this.disposed) return;
    const next = fingerprint && /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
    const previous = this.controllerFingerprint;
    this.controllerFingerprint = next;
    if (previous !== next || next === null) this.controllerEpoch++;
    if (
      this.bundle &&
      (next === null ||
        (typeof previous === "string" && previous !== next) ||
        (this.authority && next !== this.authority.controllerFingerprint))
    )
      this.invalidate();
  }

  async acquireEligibility(
    _platformId: GlobalPlatformId | CnPlatformId,
    signal: AbortSignal,
  ): Promise<GlobalOAuthEligibility | null> {
    if (signal.aborted || this.disposed) return null;
    await this.ensureReady();
    const bundle = this.bundle;
    if (signal.aborted || !bundle || !this.readAuthority()) return null;
    const abort = new AbortController();
    this.leases.add(abort);
    let released = false;
    const cancel = () => {
      abort.abort();
      release();
    };
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", cancel);
      abort.signal.removeEventListener("abort", release);
      this.leases.delete(abort);
      if (!this.leases.size) {
        clearTimeout(this.renewal);
        this.renewal = undefined;
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    abort.signal.addEventListener("abort", release, { once: true });
    if (signal.aborted) cancel();
    if (released) return null;
    this.scheduleRenewal();
    return {
      generation: bundle.generation,
      signal: abort.signal,
      isCurrent: () => !released && !abort.signal.aborted && this.bundle === bundle && !!this.readAuthority(),
      release,
    };
  }

  request(input: ProxyTransportRequest): Promise<ProxyTransportResponse> {
    if (this.options.domesticDirect) return Promise.reject(fail());
    // Snapshot before another queued operation can change caller-owned headers/body.
    const snapshot = {
      ...input,
      headers: input.headers ? { ...input.headers } : undefined,
      body: input.body instanceof Uint8Array ? new Uint8Array(input.body) : input.body,
    };
    const bundle = this.bundle;
    if (!bundle || !this.readAuthority() || input.signal?.aborted) return Promise.reject(fail());
    return this.enqueue(async () => {
      if (this.bundle !== bundle || !this.readAuthority() || snapshot.signal?.aborted) throw fail();
      const response = await bundle.clients.request(snapshot);
      if (this.bundle !== bundle || !this.readAuthority() || snapshot.signal?.aborted) throw fail();
      return response;
    });
  }

  async whenIdle(): Promise<void> {
    while (this.work.size || this.retiring.size || this.webOpenings.size)
      await Promise.allSettled([...this.work, ...this.retiring, ...this.webOpenings]);
    if (this.cleanupFailed) throw new Error("GLOBAL_PROXY_CLEANUP_FAILED");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
    this.listeners.clear();
  }

  /** Caller holds a network eligibility lease for the browser lifetime, without OAuth.
   * Only pending opens join whenIdle; a live browser stream must not block API queues.
   * The bundle owns live streams and closes all of them on invalidation/disposal.
   */
  openWebTunnel(input: GlobalWebTunnelInput): Promise<GlobalWebTunnel> {
    const snapshot = { ...input },
      bundle = this.bundle;
    if (
      this.webOpenings.size >= (this.options.domesticDirect ? 64 : 16) ||
      !bundle?.clients.openWebTunnel ||
      !this.readAuthority() ||
      snapshot.signal.aborted
    )
      return Promise.reject(fail());
    const guard = () => {
      if (this.bundle !== bundle || !this.readAuthority() || snapshot.signal.aborted) throw fail();
      snapshot.assertCurrent();
      if (this.bundle !== bundle || !this.readAuthority() || snapshot.signal.aborted) throw fail();
    };
    const work = Promise.resolve().then(async () => {
      guard();
      const tunnel = await bundle.clients.openWebTunnel!({ ...snapshot, assertCurrent: guard });
      try {
        guard();
        return tunnel;
      } catch {
        tunnel.close();
        await tunnel.closed;
        throw fail();
      }
    });
    this.webOpenings.add(work);
    void work.catch(() => undefined).finally(() => this.webOpenings.delete(work));
    return work;
  }

  private input(): {
    binding: string;
    controller: { host: string; port: number };
    proxy: { host: string; port: number };
  } | null {
    try {
      const mode = this.options.readSwitch(),
        network = this.options.readNetwork(),
        config = this.options.configuration();
      if (
        mode.proxy !== "on" ||
        !Number.isSafeInteger(mode.generation) ||
        mode.generation < 0 ||
        !network.available ||
        !network.hash ||
        !/^[a-f0-9]{64}$/.test(network.hash) ||
        !/^[a-f0-9]{64}$/.test(config.credentialRevision) ||
        !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(config.controllerUrl) ||
        !Number.isSafeInteger(config.proxyPort) ||
        config.proxyPort < 1 ||
        config.proxyPort > 65535
      )
        return null;
      const url = new URL(config.controllerUrl),
        host = url.hostname === "[::1]" ? "::1" : url.hostname;
      const controller = { host, port: Number(url.port || 80) },
        proxy = { host, port: config.proxyPort };
      if (controller.port > 65535) return null;
      return {
        binding: hash({
          mode: { proxy: mode.proxy, generation: mode.generation },
          network: network.hash,
          config,
        }),
        controller,
        proxy,
      };
    } catch {
      return null;
    }
  }
  private current(bundle: Bundle): boolean {
    const generation = this.generation;
    const input = this.input();
    return (
      !this.disposed &&
      !this.cleanupFailed &&
      this.bundle === bundle &&
      generation === this.generation &&
      bundle.generation === this.generation &&
      input?.binding === bundle.binding
    );
  }
  readAuthority(): ProxyTunnelAuthorityState | null {
    this.sync();
    if (!this.bundle || !this.authority || !this.current(this.bundle)) return null;
    return structuredClone(this.authority);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private get allowedCountries(): readonly string[] {
    return this.options.domesticDirect ? ["CN"] : GLOBAL_EGRESS_COUNTRIES;
  }
  private publish(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* A projection cannot grant permission. */
      }
    }
  }
  private enqueue<T>(run: () => Promise<T>, proof = false): Promise<T> {
    // Keep one of the eight work slots for evidence even when business callers fill the queue.
    if (this.disposed || this.cleanupFailed || this.work.size >= (proof ? 8 : 7))
      return Promise.reject(fail());
    const pending = (proof ? this.proofTail : this.tail).then(run);
    if (proof) this.proofTail = pending.catch(() => undefined);
    else this.tail = pending.catch(() => undefined);
    this.work.add(pending);
    void pending.then(
      () => this.work.delete(pending),
      () => this.work.delete(pending),
    );
    return pending;
  }
  private ensureReady(): Promise<void> {
    if (this.readAuthority()) return Promise.resolve();
    return this.refresh();
  }
  private refresh(): Promise<void> {
    if (this.flight) return this.flight;
    const generation = this.generation;
    const pending = this.enqueue(async () => {
      if (generation !== this.generation || this.disposed) return;
      await Promise.allSettled([...this.retiring]);
      if (generation !== this.generation || this.disposed || this.cleanupFailed) return;
      const input = this.input();
      if (!input) {
        this.invalidate();
        return;
      }
      if (this.bundle && !this.current(this.bundle)) {
        this.invalidate();
        return;
      }
      if (!this.bundle) {
        const context: Context = {
          generation,
          revision: this.revision,
          controller: input.controller,
          proxy: input.proxy,
          readVersion: () =>
            this.bundle && this.current(this.bundle)
              ? { generation: this.bundle.generation, revision: this.bundle.revision }
              : null,
          readAuthority: () => this.readAuthority(),
          subscribe: (listener) => {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
          },
        };
        const clients = (this.options.createClients ?? ((ctx) => this.createClients(ctx)))(context);
        if (generation !== this.generation || this.disposed) {
          clients.invalidate();
          await clients.dispose();
          return;
        }
        this.bundle = { ...input, generation, revision: this.revision, clients };
      }
      const bundle = this.bundle,
        abort = new AbortController(),
        controllerEpoch = this.controllerEpoch,
        sampleStartedAt = this.now();
      this.sampling = abort;
      try {
        const sample = await bundle.clients.sample(abort.signal);
        if (abort.signal.aborted || !this.current(bundle)) return;
        const now = this.now();
        if (
          !sample ||
          !Number.isFinite(sampleStartedAt) ||
          !Number.isFinite(now) ||
          now < sampleStartedAt ||
          (controllerEpoch !== this.controllerEpoch &&
            this.controllerFingerprint !== sample.controllerFingerprint) ||
          sample.generation !== bundle.generation ||
          sample.revision !== bundle.revision ||
          !this.allowedCountries.includes(sample.countryCode) ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(sample.sampleId) ||
          !/^[a-f0-9]{64}$/.test(sample.chainFingerprint) ||
          !/^[a-f0-9]{64}$/.test(sample.controllerFingerprint) ||
          !sample.kernelOwner ||
          !Number.isSafeInteger(sample.kernelOwner.pid) ||
          sample.kernelOwner.pid < 1 ||
          !/^[1-9]\d{15,18}$/.test(sample.kernelOwner.createdAtTicks) ||
          typeof sample.kernelOwner.executablePathIdentity !== "string" ||
          !/^[a-f0-9]{64}$/.test(sample.kernelOwner.executablePathIdentity) ||
          !Number.isFinite(sample.observedAtMono) ||
          sample.observedAtMono < 0 ||
          sample.observedAtMono > now ||
          !Number.isFinite(sample.expiresAtMono) ||
          now >= sample.expiresAtMono ||
          sample.expiresAtMono > sample.observedAtMono + 15_000
        ) {
          this.invalidate();
          return;
        }
        const old = this.authority;
        if (
          old &&
          (old.controllerFingerprint !== sample.controllerFingerprint ||
            hash(old.kernelOwner) !== hash(sample.kernelOwner) ||
            old.egress?.chainFingerprint !== sample.chainFingerprint ||
            old.egress.countryCode !== sample.countryCode)
        ) {
          this.invalidate();
          return;
        }
        if (abort.signal.aborted || !this.current(bundle)) return;
        // A fresh source read may supersede an observation from before this round. A new
        // observation during the round must agree; loss/known changes already abort above.
        this.controllerFingerprint = sample.controllerFingerprint;
        this.controllerEpoch++;
        this.sampleDurationMs = now - sampleStartedAt;
        this.authority = {
          generation: bundle.generation,
          revision: bundle.revision,
          proxy: bundle.proxy,
          controller: bundle.controller,
          kernelOwner: sample.kernelOwner,
          controllerFingerprint: sample.controllerFingerprint,
          proxyState: "on",
          checkedAtMono: sample.observedAtMono,
          expiresAtMono: sample.expiresAtMono,
          egress: {
            sampleId: sample.sampleId,
            generation: bundle.generation,
            revision: bundle.revision,
            countryCode: sample.countryCode,
            allowedCountries: this.allowedCountries,
            chainFingerprint: sample.chainFingerprint,
            observedAtMono: sample.observedAtMono,
            expiresAtMono: sample.expiresAtMono,
          },
        };
        clearTimeout(this.expiry);
        this.expiry = setTimeout(() => this.sync(), Math.max(1, sample.expiresAtMono - this.now()));
        this.expiry.unref?.();
        this.publish();
        // A repeated/cached deadline cannot trigger progressively faster automatic retries.
        // Keep its original expiry and let it close if no genuinely newer evidence arrives.
        if (!old || sample.expiresAtMono > old.expiresAtMono) this.scheduleRenewal();
      } finally {
        if (this.sampling === abort) this.sampling = null;
      }
    }, true).catch(() => {
      if (generation === this.generation) this.invalidate();
    });
    this.flight = pending;
    void pending.finally(() => {
      if (this.flight === pending) this.flight = null;
    });
    return pending;
  }
  private scheduleRenewal(): void {
    clearTimeout(this.renewal);
    if (!this.leases.size || !this.authority || this.disposed) return;
    const remaining = this.authority.expiresAtMono - this.now();
    this.renewal = setTimeout(
      () => {
        void this.refresh();
      },
      // Windows ownership reads can take several seconds under page-load contention.
      // Start the DIRECT renewal early; keep the original expiry and all fail-closed checks.
      this.options.domesticDirect
        ? Math.max(1, Math.min(5_000, remaining / 2, remaining - 2 * this.sampleDurationMs - 1_000))
        : Math.max(1, Math.min(5_000, remaining / 2, remaining - this.sampleDurationMs - 250)),
    );
    this.renewal.unref?.();
  }
  private createClients(context: Context): GlobalProxyClients {
    const ownership = this.options.domesticDirect ? new WindowsTunnelOwnership(4) : undefined;
    // Anonymous renewal has its own native lane as well as its own HTTP reader.
    // A resource-heavy page must never queue ahead of the exit-country renewal.
    const egressOwnership = this.options.domesticDirect ? new WindowsTunnelOwnership() : undefined;
    const controllerUrl = `http://${context.controller.host === "::1" ? "[::1]" : context.controller.host}:${context.controller.port}`;
    const readerOptions = {
      controllerUrl,
      proxy: context.proxy,
      getSecret: this.options.getSecret,
      readVersion: context.readVersion,
    };
    const reader = new ProxyTunnelReader(readerOptions);
    const egressReader = new ProxyTunnelReader(
      { ...readerOptions, targetScope: this.options.domesticDirect ? "domestic" : "api" },
      egressOwnership
        ? {
            controllerOwner: egressOwnership.controller(controllerUrl),
            createAcceptedSocketReader: (scope) => egressOwnership.accepted(scope),
          }
        : undefined,
    );
    const probe = new ProxyEgressProbe({
      domesticDirect: this.options.domesticDirect,
      proxy: context.proxy,
      controller: context.controller,
      reader: egressReader,
      readVersion: context.readVersion,
      allowedCountries: this.allowedCountries,
    });
    const authorizer = new ProxyTunnelAuthorizer({
      readState: context.readAuthority,
      subscribeState: context.subscribe,
      readTunnel: reader.readTunnel,
      whenIdle: () => reader.whenIdle(),
    });
    const transport = new ProxyTransport({
      proxy: context.proxy,
      authorizeTunnel: authorizer.authorizeTunnel,
      renewTunnel: authorizer.renewTunnel,
      concurrency: 1,
    });
    const web = new GlobalWebProxyPool({
      domesticDirect: this.options.domesticDirect,
      ownership,
      ...readerOptions,
      readAuthority: context.readAuthority,
      subscribe: context.subscribe,
    });
    return {
      sample: (signal) => probe.probe(signal),
      request: async (input) => {
        try {
          return await transport.request(input);
        } finally {
          await transport.whenIdle();
          await authorizer.whenIdle();
        }
      },
      openWebTunnel: (input) => web.open(input),
      invalidate: () => {
        web.invalidate();
        probe.invalidate();
        reader.invalidate();
        egressReader.invalidate();
        authorizer.invalidate();
        void transport.dispose();
      },
      dispose: async () => {
        const outcomes = await Promise.allSettled([
          web.dispose(),
          transport.dispose(),
          probe.dispose(),
          authorizer.dispose(),
          reader.dispose(),
          egressReader.dispose(),
        ]);
        await Promise.all([ownership?.dispose(), egressOwnership?.dispose()]);
        if (outcomes.some((result) => result.status === "rejected"))
          throw new Error("GLOBAL_PROXY_CLEANUP_FAILED");
      },
    };
  }
}
