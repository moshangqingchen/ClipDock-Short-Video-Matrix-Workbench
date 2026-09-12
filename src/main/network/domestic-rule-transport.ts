import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { CN_PLATFORM_IDS, isCnPlatformId, type CnPlatformId, type GlobalPlatformId } from "@shared/platforms";
import type { GlobalOAuthEligibility } from "@main/api/global-oauth-service";
import type { GlobalProxyRuntimeOptions } from "@main/api/global-proxy-runtime";
import type { ProxyTransportLease, ProxyTunnelContext } from "@main/api/proxy-transport";
import { ProxyTunnelReader } from "@main/api/proxy-tunnel-reader";
import { verifyDomesticTunnelEvidence, type ProxyTunnelReadResult } from "@main/api/proxy-tunnel-evidence";
import { ClashReader, type ClashReadResult } from "./clash-reader";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";
import { WindowsTunnelOwnership } from "./windows-tunnel-ownership";
import { isDomesticWebHost } from "./domestic-web-target-policy";
import {
  GlobalWebTunnelTransport,
  GlobalWebTunnelError,
  type GlobalWebTunnelOptions,
  type GlobalWebTunnelInput,
  type GlobalWebTunnel,
} from "./global-web-tunnel";

const TTL = 15_000;
const POLL = 5_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = () => new Error("DOMESTIC_RULE_UNAVAILABLE");
type Endpoint = { host: string; port: number };
type Transport = Pick<GlobalWebTunnelTransport, "open" | "dispose">;
interface AccountPool {
  platformId: CnPlatformId;
  epoch: AbortController;
  transport: Transport;
  route: { generation: number; checkedAtMono: number } | null;
}

/** Route admission only. This deliberately makes no geographical egress claim. */
export interface DomesticRuleAdmission {
  ready: boolean;
  generation: number;
  checkedAtMono: number | null;
  expiresAtMono: number | null;
}
interface Observation {
  startedAtMono: number;
  completedAtMono: number;
  before: ClashReadResult;
  after: ClashReadResult;
  owner: WindowsControllerOwnerSnapshot;
}
interface ResourceContext {
  controllerUrl: string;
  proxy: Endpoint;
  getSecret(): string | null;
  readVersion(): { generation: number; revision: string } | null;
}
interface Resources {
  observe(signal: AbortSignal): Promise<Observation | null>;
  readTunnel(context: ProxyTunnelContext, signal: AbortSignal): Promise<ProxyTunnelReadResult | null>;
  whenReaderIdle(context: ProxyTunnelContext): Promise<void>;
  dispose(): Promise<void>;
}
export interface DomesticRuleTransportOptions extends Pick<
  GlobalProxyRuntimeOptions,
  "configuration" | "readSwitch" | "readNetwork" | "getSecret" | "now"
> {
  /** Controlled test adapters only. Production always uses fresh real controller/Windows readers. */
  createResources?(context: ResourceContext): Resources;
  createTransport?(options: GlobalWebTunnelOptions): Pick<GlobalWebTunnelTransport, "open" | "dispose">;
}
interface Input {
  binding: string;
  controllerUrl: string;
  controller: Endpoint;
  proxy: Endpoint;
}
interface Admitted {
  key: string;
  checkedAtMono: number;
  expiresAtMono: number;
  fingerprint: string;
  owner: Extract<WindowsControllerOwnerSnapshot, { available: true }>;
}
interface Bundle extends Input {
  generation: number;
  revision: string;
  epoch: AbortController;
  resources: Resources;
  transports: Map<CnPlatformId, Transport>;
  accounts: Map<string, AccountPool>;
  admitted: Admitted | null;
}
interface Connection {
  context: ProxyTunnelContext;
  contextKey: string;
  signal: AbortSignal;
  scope: AbortSignal;
  bundle: Bundle;
  admissionKey: string;
  connectionId: string;
}

/** Local rule-mode relay. A new CONNECT must prove its exact kernel-owned DIRECT
 * socket before any browser bytes pass. A live TCP connection keeps that route;
 * renewal uses genuinely refreshed controller/OS/kernel observations, never a
 * fabricated country sample or a new deadline stamped onto old evidence. */
export class DomesticRuleTransport {
  private readonly now: () => number;
  private generation = 1;
  private bundle: Bundle | null = null;
  private flight: Promise<void> | null = null;
  private readonly retiring = new Set<Promise<void>>();
  private readonly retiringAccounts = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly connections = new WeakMap<ProxyTransportLease, Connection>();
  private poll?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private cleanupFailed = false;
  private controllerFingerprint: string | null | undefined;

  constructor(private readonly options: DomesticRuleTransportOptions) {
    this.now = options.now ?? (() => performance.now());
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* UI observations cannot authorize traffic. */
      }
    }
  }
  private input(): Input | null {
    try {
      const mode = this.options.readSwitch(),
        network = this.options.readNetwork();
      const config = this.options.configuration();
      if (
        mode.proxy !== "on" ||
        !Number.isSafeInteger(mode.generation) ||
        mode.generation < 0 ||
        !network.available ||
        !isHash(network.hash) ||
        !isHash(config.credentialRevision) ||
        !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(config.controllerUrl) ||
        !Number.isSafeInteger(config.proxyPort) ||
        config.proxyPort < 1 ||
        config.proxyPort > 65535
      )
        return null;
      const url = new URL(config.controllerUrl),
        host = url.hostname === "[::1]" ? "::1" : url.hostname;
      return {
        binding: digest({
          mode: { proxy: mode.proxy, generation: mode.generation },
          network: network.hash,
          config,
        }),
        controllerUrl: config.controllerUrl,
        controller: { host, port: Number(url.port || 80) },
        proxy: { host, port: config.proxyPort },
      };
    } catch {
      return null;
    }
  }
  private current(bundle: Bundle): boolean {
    return (
      !this.disposed &&
      !this.cleanupFailed &&
      !bundle.epoch.signal.aborted &&
      this.bundle === bundle &&
      this.generation === bundle.generation &&
      this.input()?.binding === bundle.binding
    );
  }
  sync(): void {
    const bundle = this.bundle;
    if (bundle && (!this.current(bundle) || (bundle.admitted && this.now() >= bundle.admitted.expiresAtMono)))
      this.invalidate();
  }
  observeController(fingerprint: string | null): void {
    if (this.disposed) return;
    const next = isHash(fingerprint) ? fingerprint : null;
    this.controllerFingerprint = next;
    if (this.bundle && (next === null || (this.bundle.admitted && next !== this.bundle.admitted.fingerprint)))
      this.invalidate();
  }
  readAdmission(): DomesticRuleAdmission {
    this.sync();
    const sample = this.bundle?.admitted;
    return {
      ready: !!sample,
      generation: this.generation,
      checkedAtMono: sample?.checkedAtMono ?? null,
      expiresAtMono: sample?.expiresAtMono ?? null,
    };
  }
  invalidate(): void {
    this.generation++;
    clearTimeout(this.poll);
    clearTimeout(this.expiry);
    this.poll = this.expiry = undefined;
    const old = this.bundle;
    this.bundle = null;
    if (old) {
      old.epoch.abort();
      for (const [accountId, pool] of old.accounts) this.retireAccount(accountId, pool);
      old.accounts.clear();
      const work = Promise.allSettled([
        ...[...old.transports.values()].map((transport) => Promise.resolve().then(() => transport.dispose())),
        Promise.resolve().then(() => old.resources.dispose()),
      ]).then((results) => {
        if (results.some((result) => result.status === "rejected")) this.cleanupFailed = true;
      });
      this.retiring.add(work);
      void work.finally(() => this.retiring.delete(work));
    }
    this.publish();
  }
  private validateObservation(value: Observation | null, input: Input, start: number): Admitted | null {
    if (!value) return null;
    const now = this.now(),
      { before, after, owner } = value;
    const timed = (sample: { startedAtMono?: number; completedAtMono?: number }) =>
      Number.isFinite(sample?.startedAtMono) &&
      Number.isFinite(sample?.completedAtMono) &&
      sample.startedAtMono! >= start &&
      sample.completedAtMono! >= sample.startedAtMono! &&
      sample.completedAtMono! <= now &&
      now < sample.startedAtMono! + TTL;
    if (
      !timed(value) ||
      !timed(before) ||
      !timed(after) ||
      !timed(owner) ||
      before.completedAtMono! > after.startedAtMono! ||
      owner.completedAtMono > after.startedAtMono! ||
      value.startedAtMono > Math.min(before.startedAtMono!, owner.startedAtMono) ||
      value.completedAtMono < after.completedAtMono! ||
      !isHash(before.fingerprint) ||
      before.fingerprint !== after.fingerprint ||
      before.mode !== "rule" ||
      after.mode !== "rule" ||
      before.mixedPort !== input.proxy.port ||
      after.mixedPort !== input.proxy.port ||
      (typeof this.controllerFingerprint === "string" && this.controllerFingerprint !== after.fingerprint) ||
      !owner.available ||
      owner.basis !== "windows-controller-listener" ||
      !isHash(owner.kernelEpoch) ||
      owner.scopeHash !== digest({ address: input.controller.host, port: input.controller.port }) ||
      !Number.isSafeInteger(owner.owner.pid) ||
      owner.owner.pid < 1 ||
      owner.owner.pid > 0xffff_ffff ||
      !/^[1-9]\d{15,18}$/.test(owner.owner.createdAtTicks) ||
      !isHash(owner.owner.executablePathIdentity) ||
      !owner.listeners.some(
        (listener) =>
          listener.port === input.controller.port &&
          ((listener.coverage === "exact" && listener.address === input.controller.host) ||
            (listener.coverage === "same-family-wildcard" &&
              listener.address === (isIP(input.controller.host) === 4 ? "0.0.0.0" : "::"))),
      )
    )
      return null;
    return {
      key: digest({ fingerprint: after.fingerprint, owner: owner.owner, kernelEpoch: owner.kernelEpoch }),
      checkedAtMono: value.startedAtMono,
      expiresAtMono: value.startedAtMono + TTL,
      fingerprint: after.fingerprint,
      owner,
    };
  }
  private refresh(): Promise<void> {
    if (this.flight) return this.flight;
    const generation = this.generation;
    const work = Promise.resolve()
      .then(async () => {
        await Promise.all([...this.retiring]);
        if (this.disposed || this.cleanupFailed || generation !== this.generation) return;
        const input = this.input();
        if (!input) {
          if (this.bundle) this.invalidate();
          return;
        }
        if (this.bundle && !this.current(this.bundle)) {
          this.invalidate();
          return;
        }
        const bundle = this.bundle ?? this.createBundle(input);
        const started = this.now();
        let raw: Observation | null = null;
        try {
          raw = await bundle.resources.observe(bundle.epoch.signal);
        } catch {
          /* unavailable */
        }
        if (!this.current(bundle)) return;
        const sample = this.validateObservation(raw, input, started);
        if (!sample || (bundle.admitted && bundle.admitted.key !== sample.key)) {
          this.invalidate();
          return;
        }
        bundle.admitted = sample;
        clearTimeout(this.expiry);
        clearTimeout(this.poll);
        const expire = () => {
          if (!this.current(bundle) || bundle.admitted !== sample) return;
          this.sync();
          if (this.bundle === bundle && this.now() < sample.expiresAtMono) {
            this.expiry = setTimeout(expire, Math.max(1, Math.ceil(sample.expiresAtMono - this.now())));
            this.expiry.unref?.();
          }
        };
        this.expiry = setTimeout(expire, Math.max(1, Math.ceil(sample.expiresAtMono - this.now())));
        this.poll = setTimeout(
          () => {
            void this.refresh();
          },
          Math.max(1, started + POLL - this.now()),
        );
        this.expiry.unref?.();
        this.poll.unref?.();
        this.publish();
      })
      .catch(() => {
        if (generation === this.generation) this.invalidate();
      })
      .finally(() => {
        if (this.flight === work) this.flight = null;
      });
    this.flight = work;
    return work;
  }
  private createBundle(input: Input): Bundle {
    const generation = this.generation,
      revision = randomUUID(),
      epoch = new AbortController();
    const resourceContext: ResourceContext = {
      controllerUrl: input.controllerUrl,
      proxy: input.proxy,
      getSecret: this.options.getSecret,
      readVersion: () =>
        this.bundle?.generation === generation && this.current(this.bundle) ? { generation, revision } : null,
    };
    const resources = this.options.createResources?.(resourceContext) ?? createResources(resourceContext);
    const bundle: Bundle = {
      ...input,
      generation,
      revision,
      epoch,
      resources,
      transports: new Map(),
      accounts: new Map(),
      admitted: null,
    };
    this.bundle = bundle;
    // One site's long-lived HTTP/2 sockets cannot exhaust the other five sites.
    // The registry bounds this to six pools, each with the existing 32-socket cap.
    for (const platformId of CN_PLATFORM_IDS) {
      bundle.transports.set(platformId, this.createTransport(bundle, platformId, epoch.signal));
    }
    return bundle;
  }
  private createTransport(bundle: Bundle, platformId: CnPlatformId, scope: AbortSignal): Transport {
    const transportOptions: GlobalWebTunnelOptions = {
      proxy: bundle.proxy,
      allowTarget: (platform, host) =>
        !scope.aborted && platform === platformId && isDomesticWebHost(platform, host),
      concurrency: 32,
      connectTimeoutMs: 15_000,
      authorize: (context, signal) =>
        context.platformId === platformId && !scope.aborted
          ? this.authorize(bundle, context, signal, scope)
          : Promise.resolve(null),
      renew: (context, previous, signal) =>
        context.platformId === platformId && !scope.aborted
          ? this.renew(bundle, context, previous, signal, scope)
          : Promise.resolve(null),
      // No context means CONNECT never reached authorization; no reader belongs to it.
      whenAuthorizerIdle: (context) =>
        context ? bundle.resources.whenReaderIdle(context) : Promise.resolve(),
    };
    return this.options.createTransport?.(transportOptions) ?? new GlobalWebTunnelTransport(transportOptions);
  }
  /** Account IDs originate from registered main-process Sessions, never a renderer route choice. */
  async openAccountTunnel(accountId: string, input: GlobalWebTunnelInput): Promise<GlobalWebTunnel> {
    if (typeof accountId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(accountId)) throw fail();
    const bundle = this.bundle;
    if (
      !bundle ||
      !this.readAdmission().ready ||
      !isCnPlatformId(input.platformId) ||
      !isDomesticWebHost(input.platformId, input.host) ||
      input.signal.aborted
    )
      throw fail();
    // A reconfigured Session cannot create another pool until its previous sockets have drained.
    await this.retiringAccounts.get(accountId);
    if (!this.current(bundle) || !this.readAdmission().ready || input.signal.aborted) throw fail();
    let pool = bundle.accounts.get(accountId);
    if (pool && pool.platformId !== input.platformId) throw fail();
    if (!pool) {
      if (bundle.accounts.size + this.retiringAccounts.size >= 64) throw fail();
      const epoch = new AbortController();
      pool = {
        platformId: input.platformId,
        epoch,
        transport: this.createTransport(bundle, input.platformId, epoch.signal),
        route: null,
      };
      bundle.accounts.set(accountId, pool);
    }
    const tunnel = await this.openPool(bundle, pool.transport, input, pool.epoch.signal);
    if (
      this.current(bundle) &&
      bundle.admitted &&
      this.now() < bundle.admitted.expiresAtMono &&
      bundle.accounts.get(accountId) === pool &&
      pool.platformId === input.platformId &&
      !pool.epoch.signal.aborted &&
      !input.signal.aborted
    )
      pool.route = { generation: bundle.generation, checkedAtMono: this.now() };
    return tunnel;
  }
  /** Display-only association with a successful account CONNECT; never an authorization grant. */
  readAccountRoute(accountId: string): { generation: number; checkedAtMono: number } | null {
    const bundle = this.bundle,
      pool = bundle?.accounts.get(accountId);
    if (
      !bundle ||
      !this.current(bundle) ||
      !bundle.admitted ||
      this.now() >= bundle.admitted.expiresAtMono ||
      !pool ||
      pool.epoch.signal.aborted ||
      !pool.route ||
      pool.route.generation !== bundle.generation
    )
      return null;
    return { ...pool.route };
  }
  releaseAccount(accountId: string): void {
    const pool = this.bundle?.accounts.get(accountId);
    if (!pool) return;
    this.bundle!.accounts.delete(accountId);
    this.retireAccount(accountId, pool);
  }
  private retireAccount(accountId: string, pool: AccountPool): void {
    pool.epoch.abort();
    const work = Promise.resolve()
      .then(() => pool.transport.dispose())
      .catch(() => {
        this.cleanupFailed = true;
        this.invalidate();
      })
      .finally(() => {
        if (this.retiringAccounts.get(accountId) === work) this.retiringAccounts.delete(accountId);
      });
    this.retiringAccounts.set(accountId, work);
  }
  async acquireEligibility(
    platformId: CnPlatformId | GlobalPlatformId,
    signal: AbortSignal,
  ): Promise<GlobalOAuthEligibility | null> {
    if (!isCnPlatformId(platformId) || signal.aborted || this.disposed) return null;
    if (!this.readAdmission().ready) await this.refresh();
    const bundle = this.bundle;
    if (!bundle || !this.readAdmission().ready || signal.aborted) return null;
    let released = false;
    const combined = AbortSignal.any([signal, bundle.epoch.signal]);
    return {
      generation: bundle.generation,
      signal: combined,
      isCurrent: () => !released && !combined.aborted && this.current(bundle) && this.readAdmission().ready,
      release: () => {
        released = true;
      },
    };
  }
  async openWebTunnel(input: GlobalWebTunnelInput): Promise<GlobalWebTunnel> {
    const bundle = this.bundle;
    if (
      !bundle ||
      !this.readAdmission().ready ||
      !isCnPlatformId(input.platformId) ||
      !isDomesticWebHost(input.platformId, input.host)
    )
      throw fail();
    const transport = bundle.transports.get(input.platformId);
    if (!transport) throw fail();
    return this.openPool(bundle, transport, input, bundle.epoch.signal);
  }
  private async openPool(
    bundle: Bundle,
    transport: Transport,
    input: GlobalWebTunnelInput,
    scope: AbortSignal,
  ): Promise<GlobalWebTunnel> {
    const deadline = this.now() + 4_000;
    for (;;) {
      if (!this.current(bundle) || !this.readAdmission().ready || input.signal.aborted || scope.aborted)
        throw fail();
      try {
        return await transport.open({
          ...input,
          signal: AbortSignal.any([input.signal, bundle.epoch.signal, scope]),
          assertCurrent: () => {
            input.assertCurrent();
            if (!this.current(bundle) || !this.readAdmission().ready || scope.aborted) throw fail();
          },
        });
      } catch (error) {
        if (!(error instanceof GlobalWebTunnelError) || error.code !== "BUSY" || this.now() >= deadline)
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  private async authorize(
    bundle: Bundle,
    context: ProxyTunnelContext,
    signal: AbortSignal,
    scope: AbortSignal,
  ): Promise<ProxyTransportLease | null> {
    if (!this.current(bundle) || !this.readAdmission().ready || signal.aborted) return null;
    const contextKey = digest(context),
      started = this.now();
    const evidence = await bundle.resources.readTunnel(
      context,
      AbortSignal.any([signal, bundle.epoch.signal, scope]),
    );
    if (
      !evidence ||
      signal.aborted ||
      scope.aborted ||
      !this.current(bundle) ||
      !this.readAdmission().ready ||
      digest(context) !== contextKey
    )
      return null;
    const verified = verifyDomesticTunnelEvidence({
      context,
      evidence,
      controller: bundle.controller,
      proxy: bundle.proxy,
      generation: bundle.generation,
      revision: bundle.revision,
      nowMono: this.now(),
      readStartedAtMono: started,
    });
    const admitted = bundle.admitted!;
    if (
      !verified ||
      verified.controllerFingerprint !== admitted.fingerprint ||
      digest(verified.kernelOwner) !== digest(admitted.owner.owner)
    )
      return null;
    return this.lease(
      {
        context,
        contextKey,
        signal,
        scope,
        bundle,
        admissionKey: admitted.key,
        connectionId: verified.connectionId,
      },
      Math.min(admitted.expiresAtMono, verified.evidenceExpiresAtMono),
    );
  }
  private async renew(
    bundle: Bundle,
    context: ProxyTunnelContext,
    previous: ProxyTransportLease,
    signal: AbortSignal,
    scope: AbortSignal,
  ): Promise<ProxyTransportLease | null> {
    const connection = this.connections.get(previous);
    if (
      !connection ||
      connection.bundle !== bundle ||
      connection.context !== context ||
      connection.signal !== signal ||
      connection.scope !== scope ||
      digest(context) !== connection.contextKey ||
      signal.aborted ||
      !previous.isCurrent()
    )
      return null;
    // The transport owns this exact still-open TCP socket and its cancellation signal.
    // If no later monitor observation exists, obtain one instead of extending old timestamps.
    if (bundle.admitted!.expiresAtMono <= previous.expiresAtMono) await this.refresh();
    if (
      !previous.isCurrent() ||
      !this.current(bundle) ||
      !bundle.admitted ||
      bundle.admitted.key !== connection.admissionKey ||
      bundle.admitted.expiresAtMono <= previous.expiresAtMono
    )
      return null;
    return this.lease(connection, bundle.admitted.expiresAtMono);
  }
  private lease(connection: Connection, expiresAtMono: number): ProxyTransportLease | null {
    const { bundle, signal } = connection;
    if (expiresAtMono <= this.now()) return null;
    let released = false;
    const combined = AbortSignal.any([signal, bundle.epoch.signal, connection.scope]);
    const lease: ProxyTransportLease = Object.freeze({
      generation: bundle.generation,
      signal: combined,
      expiresAtMono,
      isCurrent: () =>
        !released &&
        !combined.aborted &&
        this.now() < expiresAtMono &&
        this.current(bundle) &&
        this.readAdmission().ready &&
        bundle.admitted?.key === connection.admissionKey &&
        digest(connection.context) === connection.contextKey,
      release: () => {
        released = true;
      },
    });
    this.connections.set(lease, connection);
    return lease;
  }
  async whenIdle(): Promise<void> {
    await this.flight;
    while (this.retiring.size || this.retiringAccounts.size)
      await Promise.all([...this.retiring, ...this.retiringAccounts.values()]);
    if (this.cleanupFailed) throw fail();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
    this.listeners.clear();
  }
}

function createResources(context: ResourceContext): Resources {
  // Monitor ownership has its own worker, so page bursts cannot starve route renewal.
  const monitorOwnership = new WindowsTunnelOwnership(1),
    tunnelOwnership = new WindowsTunnelOwnership(4);
  const controller = new ClashReader({ controllerUrl: context.controllerUrl, getSecret: context.getSecret });
  const owner = monitorOwnership.controller(context.controllerUrl);
  const work = new Map<string, Promise<unknown>>();
  let stopped = false;
  return {
    observe: async (signal) => {
      if (stopped || signal.aborted) return null;
      const startedAtMono = performance.now();
      const [before, observedOwner] = await Promise.all([controller.read(), owner.read(signal)]);
      if (stopped || signal.aborted) return null;
      const after = await controller.read();
      return stopped || signal.aborted
        ? null
        : { startedAtMono, completedAtMono: performance.now(), before, after, owner: observedOwner };
    },
    readTunnel: (input, signal) => {
      if (stopped || signal.aborted || work.has(input.id)) return Promise.resolve(null);
      const reader = new ProxyTunnelReader(
        { ...context, targetScope: "domestic" },
        {
          controllerOwner: tunnelOwnership.controller(context.controllerUrl),
          createAcceptedSocketReader: (scope) => tunnelOwnership.accepted(scope),
        },
      );
      const pending = reader.readTunnel(input, signal).finally(async () => {
        try {
          await reader.dispose();
        } finally {
          work.delete(input.id);
        }
      });
      work.set(input.id, pending);
      return pending;
    },
    whenReaderIdle: async (input) => {
      await work.get(input.id);
    },
    dispose: async () => {
      stopped = true;
      const reads = await Promise.allSettled([controller.whenIdle(), owner.whenIdle(), ...work.values()]);
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => owner.dispose()),
        monitorOwnership.dispose(),
        tunnelOwnership.dispose(),
      ]);
      if ([...reads, ...cleanup].some((result) => result.status === "rejected")) throw fail();
    },
  };
}
