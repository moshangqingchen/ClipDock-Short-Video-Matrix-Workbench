import { createHash } from "node:crypto";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { ClashReader, type ClashReadResult } from "@main/network/clash-reader";
import {
  WindowsControllerOwnerReader,
  type WindowsControllerOwnerSnapshot,
} from "@main/network/windows-controller-owner";
import { WindowsTcpSocketReader, type WindowsTcpSocketScope } from "@main/network/windows-tcp-sockets";
import { proxyAcceptedOwnerMatches } from "./proxy-tunnel-evidence";
import type { ProxyTunnelContext } from "./proxy-transport";
import { isOfficialProxyHost } from "./proxy-target-policy";
import { isDomesticWebHost } from "@main/network/domestic-web-target-policy";
import { isGlobalWebHost } from "@main/network/global-web-target-policy";
import type {
  AnonymousProxyTunnelContext,
  VerifiableProxyTunnelContext,
  ProxyTunnelReadResult,
  WindowsProxyAcceptedSnapshot,
} from "./proxy-tunnel-evidence";

type Timed = Readonly<{ startedAtMono: number; completedAtMono: number }>;
type RawResponse = Timed & { readonly value: unknown };
type Endpoint = Readonly<{ host: string; port: number }>;
type Version = Readonly<{ generation: number; revision: string }>;
type OwnerReader = Pick<WindowsControllerOwnerReader, "read" | "whenIdle" | "dispose">;
export interface ProxyTunnelReaderOptions {
  /** Explicit website readers do not change the default API target policy. */
  readonly targetScope?: "api" | "website" | "domestic";
  readonly controllerUrl: string;
  readonly proxy: Endpoint;
  readonly getSecret: () => string | null;
  /** Synchronous main-process settings/network epoch; this is not an eligibility grant. */
  readonly readVersion: () => Version | null;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
/** Explicit tests only. The default dependencies cannot choose arbitrary URLs or another transport. */
export interface ProxyTunnelReaderDependencies {
  readonly controller?: Pick<ClashReader, "read" | "whenIdle">;
  readonly controllerOwner?: OwnerReader;
  /** Legacy fixture seam only. Default production ownership uses the accepted reverse socket. */
  readonly proxyOwner?: OwnerReader;
  readonly createAcceptedSocketReader?: (
    scope: WindowsTcpSocketScope,
  ) => Pick<WindowsTcpSocketReader, "read">;
  readonly json?: {
    read(endpoint: "/connections" | "/proxies", signal: AbortSignal): Promise<RawResponse>;
    whenIdle(): Promise<void>;
  };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function fail(): never {
  throw new Error("TUNNEL_READ_UNAVAILABLE");
}
function ip(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i.exec(canonical);
  if (!mapped) return canonical;
  const bits = Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16);
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".");
}
function port(value: unknown): number | null {
  const result = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : value;
  return integer(result, 1, 65_535) ? result : null;
}
function endpointUrl(endpoint: Endpoint): string {
  return `http://${endpoint.host === "::1" ? "[::1]" : endpoint.host}:${endpoint.port}`;
}
function timed(value: Timed, start: number, end: number): boolean {
  return (
    Number.isFinite(value?.startedAtMono) &&
    Number.isFinite(value.completedAtMono) &&
    value.startedAtMono >= start &&
    value.completedAtMono >= value.startedAtMono &&
    value.completedAtMono <= end
  );
}
function ownerAt(
  value: WindowsControllerOwnerSnapshot,
  endpoint: Endpoint,
  start: number,
  end: number,
): boolean {
  if (
    !value.available ||
    !timed(value, start, end) ||
    value.basis !== "windows-controller-listener" ||
    value.scopeHash !== hash(JSON.stringify({ address: endpoint.host, port: endpoint.port })) ||
    !isHash(value.kernelEpoch) ||
    !integer(value.owner.pid, 1, 0xffffffff) ||
    !/^[1-9]\d{15,18}$/.test(value.owner.createdAtTicks) ||
    !isHash(value.owner.executablePathIdentity)
  )
    return false;
  return value.listeners.some(
    (listener) =>
      listener.port === endpoint.port &&
      ((listener.coverage === "exact" && ip(listener.address) === endpoint.host) ||
        (listener.coverage === "same-family-wildcard" &&
          listener.address === (endpoint.host === "::1" ? "::" : "0.0.0.0"))),
  );
}

/** Raw controller objects stay main-only; retain all this source tuple's candidates, including conflicts. */
function sourceConnections(
  value: unknown,
  context: VerifiableProxyTunnelContext,
): unknown[] {
  const rows = record(value)?.connections;
  if (!Array.isArray(rows) || rows.length > 20_000) fail();
  return rows.filter((row) => {
    const meta = record(record(row)?.metadata);
    return meta && ip(meta.sourceIP) === ip(context.socket.localAddress) &&
      port(meta.sourcePort) === context.socket.localPort;
  });
}
function scopeConnections(
  value: unknown,
  context: VerifiableProxyTunnelContext,
): { value: unknown; chains: Set<string> } {
  const owned = sourceConnections(value, context);
  if (!owned.length || owned.length > 8) fail();
  const chains = new Set<string>();
  const connections = owned.map((row) => {
    const item = record(row)!,
      meta = record(item.metadata)!;
    if (!Array.isArray(item.chains) || !item.chains.length || item.chains.length > 32) fail();
    for (const name of item.chains) {
      if (typeof name !== "string" || !name || name.length > 1024 || /[\r\n\0]/.test(name)) fail();
      chains.add(name);
    }
    return {
      id: item.id,
      chains: item.chains,
      start: item.start,
      metadata: Object.fromEntries(
        [
          "host",
          "sniffHost",
          "sourceIP",
          "sourcePort",
          "inboundIP",
          "inboundPort",
          "destinationPort",
          "destinationIP",
          "remoteDestination",
          "network",
          "type",
          "processPath",
        ]
          .filter((key) => Object.hasOwn(meta, key))
          .map((key) => [key, meta[key]]),
      ),
    };
  });
  if (chains.size > 32) fail();
  return { value: { connections }, chains };
}
function scopeProxies(value: unknown, chains: Set<string>): unknown {
  const proxies = record(record(value)?.proxies);
  if (!proxies || Object.keys(proxies).length > 10_000) fail();
  return {
    proxies: Object.fromEntries(
      [...chains].map((name) => {
        if (
          !Object.hasOwn(proxies, name) ||
          !record(proxies[name]) ||
          JSON.stringify(proxies[name]).length > 65_536
        )
          fail();
        return [name, proxies[name]];
      }),
    ),
  };
}

/** Literal loopback, two immutable GET paths, identity encoding, no redirect/pool/environment proxy. */
class ControllerJsonReader {
  private readonly drains = new Set<Promise<void>>();
  constructor(
    private readonly endpoint: Endpoint,
    private readonly secret: () => string | null,
    private readonly maxBytes: number,
    private readonly timeoutMs: number,
  ) {}
  read(endpoint: "/connections" | "/proxies", external: AbortSignal): Promise<RawResponse> {
    let finish!: () => void;
    const drain = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.drains.add(drain);
    const controller = new AbortController();
    let req: ClientRequest | undefined, response: IncomingMessage | undefined;
    let requestClosed = false,
      responseClosed = false,
      sockets = 0,
      settled = false;
    const complete = () => {
      if (!requestClosed || (response && !responseClosed) || sockets) return;
      this.drains.delete(drain);
      finish();
    };
    const startedAtMono = performance.now();
    let rejectResult!: (error: Error) => void;
    const stop = () => {
      controller.abort();
      req?.destroy();
      response?.destroy();
    };
    const error = () => {
      if (!settled) {
        settled = true;
        rejectResult(new Error("TUNNEL_CONTROLLER_UNAVAILABLE"));
      }
      stop();
    };
    const result = new Promise<RawResponse>((resolve, reject) => {
      rejectResult = reject;
      try {
        if (external.aborted || !["/connections", "/proxies"].includes(endpoint)) fail();
        const secret = this.secret();
        if (
          external.aborted ||
          (secret !== null &&
            (typeof secret !== "string" || secret.length > 65_536 || /[\r\n\0]/.test(secret)))
        )
          fail();
        req = request(
          {
            hostname: this.endpoint.host,
            port: this.endpoint.port,
            family: this.endpoint.host === "::1" ? 6 : 4,
            path: endpoint,
            method: "GET",
            agent: false,
            signal: controller.signal,
            maxHeaderSize: 16_384,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              ...(secret ? { authorization: `Bearer ${secret}` } : {}),
            },
          },
          (incoming) => {
            response = incoming;
            incoming.once("close", () => {
              responseClosed = true;
              if (!settled) error();
              complete();
            });
            incoming.once("error", error);
            incoming.once("aborted", error);
            const length = incoming.headers["content-length"],
              encoding = incoming.headers["content-encoding"];
            if (
              settled ||
              external.aborted ||
              incoming.statusCode !== 200 ||
              (encoding && encoding !== "identity") ||
              (length !== undefined && (!/^\d+$/.test(length) || Number(length) > this.maxBytes))
            ) {
              error();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            incoming.on("data", (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > this.maxBytes) error();
              else chunks.push(chunk);
            });
            incoming.once("end", () => {
              if (settled) return;
              try {
                if (external.aborted || performance.now() >= startedAtMono + this.timeoutMs) fail();
                const value: unknown = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
                );
                settled = true;
                resolve({ value, startedAtMono, completedAtMono: performance.now() });
                req?.destroy();
              } catch {
                error();
              }
            });
          },
        );
        req.once("socket", (socket) => {
          sockets++;
          socket.once("close", () => {
            sockets--;
            complete();
          });
        });
        req.once("close", () => {
          requestClosed = true;
          if (!settled) error();
          complete();
        });
        req.once("error", error);
        req.once("upgrade", (incoming, socket) => {
          incoming.destroy();
          socket.destroy();
          error();
        });
        req.end();
      } catch {
        error();
        if (!req) {
          requestClosed = true;
          complete();
        }
      }
    });
    const timer = setTimeout(error, this.timeoutMs);
    external.addEventListener("abort", error, { once: true });
    if (external.aborted) error();
    return result.finally(() => {
      clearTimeout(timer);
      external.removeEventListener("abort", error);
      stop();
    });
  }
  async whenIdle(): Promise<void> {
    while (this.drains.size) await Promise.allSettled([...this.drains]);
  }
}

interface Job {
  controller: AbortController;
  epoch: number;
  guard: () => void;
  drained: Promise<void>;
}
/** Reads facts only. No egress/eligibility grant, CONNECT, TLS, account Session or controller write. */
export class ProxyTunnelReader {
  private readonly controllerEndpoint: Endpoint;
  private readonly proxy: Endpoint;
  private readonly controller: Pick<ClashReader, "read" | "whenIdle">;
  private readonly controllerOwner: OwnerReader;
  private readonly proxyOwner: OwnerReader | null;
  private readonly createAcceptedSocketReader: NonNullable<
    ProxyTunnelReaderDependencies["createAcceptedSocketReader"]
  >;
  private readonly json: NonNullable<ProxyTunnelReaderDependencies["json"]>;
  private readonly timeoutMs: number;
  private readonly options: ProxyTunnelReaderOptions;
  private active: Job | null = null;
  private epoch = 0;
  private disposed = false;
  private cleanupFailed = false;

  constructor(options: ProxyTunnelReaderOptions, dependencies: ProxyTunnelReaderDependencies = {}) {
    try {
      if (
        !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(options.controllerUrl) ||
        !["127.0.0.1", "::1"].includes(options.proxy?.host) ||
        !port(options.proxy.port) ||
        typeof options.getSecret !== "function" ||
        typeof options.readVersion !== "function" ||
        (options.targetScope !== undefined &&
          options.targetScope !== "api" &&
          options.targetScope !== "website" &&
          options.targetScope !== "domestic")
      )
        fail();
      const url = new URL(options.controllerUrl);
      this.controllerEndpoint = Object.freeze({
        host: url.hostname === "[::1]" ? "::1" : url.hostname,
        port: Number(url.port || 80),
      });
      if (!port(this.controllerEndpoint.port)) fail();
      this.proxy = Object.freeze({ host: options.proxy.host, port: options.proxy.port });
      this.timeoutMs = options.timeoutMs ?? 10_000;
      const maxBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
      if (!integer(this.timeoutMs, 1, 15_000) || !integer(maxBytes, 1, 8 * 1024 * 1024)) fail();
      this.options = Object.freeze({ ...options, proxy: this.proxy });
      const secret = () => {
        if (!this.active) fail();
        this.active.guard();
        const result = this.options.getSecret();
        this.active?.guard();
        if (!this.active || this.disposed) fail();
        return result;
      };
      this.controller =
        dependencies.controller ??
        new ClashReader({ controllerUrl: endpointUrl(this.controllerEndpoint), getSecret: secret });
      this.controllerOwner =
        dependencies.controllerOwner ??
        new WindowsControllerOwnerReader({ controllerUrl: endpointUrl(this.controllerEndpoint) });
      this.proxyOwner = dependencies.proxyOwner ?? null;
      this.createAcceptedSocketReader =
        dependencies.createAcceptedSocketReader ?? ((scope) => new WindowsTcpSocketReader(scope));
      this.json =
        dependencies.json ??
        new ControllerJsonReader(this.controllerEndpoint, secret, maxBytes, Math.min(this.timeoutMs, 3000));
    } catch {
      throw new Error("INVALID_TUNNEL_READER_OPTIONS");
    }
  }

  readonly readTunnel = (
    context: ProxyTunnelContext,
    signal: AbortSignal,
  ): Promise<ProxyTunnelReadResult | null> => this.read(context, signal, false);

  /** The diagnostic path is separate from the business allowlist and cannot carry a business platform. */
  readonly readAnonymousTunnel = (
    context: AnonymousProxyTunnelContext,
    signal: AbortSignal,
  ): Promise<ProxyTunnelReadResult | null> => this.read(context, signal, true);

  private read(
    context: VerifiableProxyTunnelContext,
    signal: AbortSignal,
    anonymous: boolean,
  ): Promise<ProxyTunnelReadResult | null> {
    if (this.disposed || this.cleanupFailed || signal.aborted || this.active) return Promise.resolve(null);
    let finished!: () => void;
    const job: Job = {
      controller: new AbortController(),
      epoch: this.epoch,
      guard: fail,
      drained: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    this.active = job; // Reserve before any injected callback or asynchronous operation.
    let snapshot: VerifiableProxyTunnelContext | null = null;
    try {
      snapshot = structuredClone(context);
    } catch {
      job.controller.abort();
    }
    const cancel = () => job.controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(cancel, this.timeoutMs);
    const work = Promise.resolve()
      .then(() => {
        if (!snapshot || job.controller.signal.aborted) fail();
        return this.collect(snapshot, job, anonymous);
      })
      .catch(() => null);
    const cancelled = new Promise<null>((resolve) => {
      job.controller.signal.addEventListener("abort", () => resolve(null), { once: true });
      if (job.controller.signal.aborted) resolve(null);
    });
    const result = Promise.race([work, cancelled]);
    void Promise.allSettled([work, result]).then(async () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      job.controller.abort();
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => this.controller.whenIdle()),
        Promise.resolve().then(() => this.controllerOwner.whenIdle()),
        Promise.resolve().then(() => this.proxyOwner?.whenIdle()),
        Promise.resolve().then(() => this.json.whenIdle()),
      ]);
      if (outcomes.some((item) => item.status === "rejected")) this.cleanupFailed = true;
      if (this.active === job) this.active = null;
      finished();
    });
    return result;
  }

  invalidate(): void {
    this.epoch++;
    this.active?.controller.abort();
  }
  async whenIdle(): Promise<void> {
    while (this.active) await this.active.drained;
    if (this.cleanupFailed) throw new Error("TUNNEL_READER_CLEANUP_FAILED");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    for (const owner of [this.controllerOwner, this.proxyOwner]) {
      try {
        owner?.dispose();
      } catch {
        this.cleanupFailed = true;
      }
    }
    await this.whenIdle();
  }
  private version(): Version {
    const value = this.options.readVersion();
    if (
      !value ||
      !integer(value.generation, 0, Number.MAX_SAFE_INTEGER) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.revision)
    )
      fail();
    return Object.freeze({ generation: value.generation, revision: value.revision });
  }
  private async collect(
    input: VerifiableProxyTunnelContext,
    job: Job,
    anonymous: boolean,
  ): Promise<ProxyTunnelReadResult> {
    const startedAtMono = performance.now(),
      context = structuredClone(input),
      version = this.version();
    job.guard = () => {
      if (
        this.disposed ||
        this.active !== job ||
        job.epoch !== this.epoch ||
        job.controller.signal.aborted ||
        performance.now() >= startedAtMono + this.timeoutMs
      )
        fail();
      const current = this.version();
      if (
        current.generation !== version.generation ||
        current.revision !== version.revision ||
        this.disposed ||
        this.active !== job ||
        job.epoch !== this.epoch ||
        job.controller.signal.aborted
      )
        fail();
    };
    job.guard();
    if (
      !context ||
      typeof context.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(context.id) ||
      (anonymous
        ? context.platformId !== "anonymous-egress" ||
          context.target?.host !==
            (this.options.targetScope === "domestic" ? "myip.ipip.net" : "www.cloudflare.com")
        : context.platformId === "anonymous-egress" ||
          !(
            this.options.targetScope === "domestic"
              ? isDomesticWebHost
              : this.options.targetScope === "website"
                ? isGlobalWebHost
                : isOfficialProxyHost
          )(context.platformId, context.target?.host)) ||
      context.target.port !== 443 ||
      context.proxy?.host !== this.proxy.host ||
      context.proxy.port !== this.proxy.port ||
      ip(context.socket?.remoteAddress) !== this.proxy.host ||
      context.socket.remotePort !== this.proxy.port ||
      !ip(context.socket.localAddress) ||
      !port(context.socket.localPort) ||
      !Number.isFinite(context.connectedAtMono) ||
      context.connectedAtMono < 0 ||
      context.connectedAtMono > startedAtMono
    )
      fail();
    const before = await this.controller.read();
    job.guard();
    this.config(before, startedAtMono);
    const controllerOwnerWork = Promise.resolve().then(() => {
      job.guard();
      return this.controllerOwner.read(job.controller.signal);
    });
    const proxyOwnerWork = this.proxyOwner
      ? Promise.resolve().then(() => {
          job.guard();
          return this.proxyOwner!.read(job.controller.signal);
        })
      : controllerOwnerWork.then(async (owner): Promise<WindowsProxyAcceptedSnapshot> => {
          job.guard();
          if (!ownerAt(owner, this.controllerEndpoint, startedAtMono, performance.now()) || !owner.available)
            fail();
          const reader = this.createAcceptedSocketReader({
            ownerPids: [owner.owner.pid],
            remotes: [{ address: context.socket.localAddress, port: context.socket.localPort }],
          });
          job.guard();
          // The native fixed query has no Abort API. Its original promise stays in this job's
          // allSettled barrier even when the public cancellation result has already returned.
          const socketSnapshot = await reader.read();
          job.guard();
          if (!socketSnapshot.available) fail();
          const actualOwner = socketSnapshot.owners.find((identity) => identity.pid === owner.owner.pid);
          if (!actualOwner) fail();
          const accepted: WindowsProxyAcceptedSnapshot = {
            available: true,
            basis: "windows-proxy-accepted",
            startedAtMono: socketSnapshot.startedAtMono,
            completedAtMono: socketSnapshot.completedAtMono,
            scopeHash: socketSnapshot.scopeHash,
            owner: actualOwner,
            socketSnapshot,
          };
          if (!proxyAcceptedOwnerMatches(context, owner.owner, accepted, startedAtMono, performance.now()))
            fail();
          return accepted;
        });
    const samples = await Promise.allSettled([
      controllerOwnerWork,
      proxyOwnerWork,
      (this.options.targetScope === "domestic" ? proxyOwnerWork : Promise.resolve()).then(() => {
        job.guard();
        return this.readConnections(context, job);
      }),
      Promise.resolve().then(() => {
        job.guard();
        return this.json.read("/proxies", job.controller.signal);
      }),
    ] as const);
    job.guard();
    const [owner, proxyOwner, connections, proxies] = samples.map((sample) => {
      if (sample.status !== "fulfilled") fail();
      return sample.value;
    }) as [WindowsControllerOwnerSnapshot, ProxyTunnelReadResult["proxyOwner"], RawResponse, RawResponse];
    const after = await this.controller.read();
    job.guard();
    this.config(after, startedAtMono);
    const completedAtMono = performance.now();
    if (
      before.fingerprint !== after.fingerprint ||
      before.mode !== after.mode ||
      !ownerAt(owner, this.controllerEndpoint, startedAtMono, completedAtMono) ||
      (proxyOwner.available && proxyOwner.basis === "windows-proxy-accepted"
        ? !owner.available ||
          !proxyAcceptedOwnerMatches(context, owner.owner, proxyOwner, startedAtMono, completedAtMono)
        : !ownerAt(proxyOwner, this.proxy, startedAtMono, completedAtMono)) ||
      !owner.available ||
      !proxyOwner.available ||
      owner.owner.pid !== proxyOwner.owner.pid ||
      owner.owner.createdAtTicks !== proxyOwner.owner.createdAtTicks ||
      owner.owner.executablePathIdentity !== proxyOwner.owner.executablePathIdentity ||
      !timed(connections, before.completedAtMono!, after.startedAtMono!) ||
      !timed(proxies, before.completedAtMono!, after.startedAtMono!)
    )
      fail();
    const scoped = scopeConnections(connections.value, context);
    const projectConfig = (value: ClashReadResult) => ({
      fingerprint: value.fingerprint,
      mode: value.mode,
      mixedPort: value.mixedPort,
      startedAtMono: value.startedAtMono!,
      completedAtMono: value.completedAtMono!,
    });
    const result = structuredClone({
      contextId: context.id,
      ...version,
      startedAtMono,
      completedAtMono,
      controllerBefore: projectConfig(before),
      controllerAfter: projectConfig(after),
      controllerOwner: owner,
      proxyOwner,
      connections: { ...connections, value: scoped.value },
      proxies: { ...proxies, value: scopeProxies(proxies.value, scoped.chains) },
    });
    job.guard();
    return result;
  }
  private config(value: ClashReadResult, startedAtMono: number): void {
    if (
      !isHash(value.fingerprint) ||
      value.mixedPort !== this.proxy.port ||
      !["rule", "global"].includes(value.mode) ||
      !timed(value as Timed, startedAtMono, performance.now())
    )
      fail();
  }

  private async readConnections(context: VerifiableProxyTunnelContext, job: Job): Promise<RawResponse> {
    // The kernel can acknowledge CONNECT before publishing its connection row.
    // Only absence is transient; malformed or conflicting evidence still fails verification.
    const deadline = performance.now() + 1000;
    for (let attempt = 0; ; attempt++) {
      job.guard();
      const sample = await this.json.read("/connections", job.controller.signal);
      job.guard();
      if (this.options.targetScope !== "domestic" ||
          sourceConnections(sample.value, context).length || attempt >= 10 || performance.now() >= deadline) return sample;
      await wait(Math.min(100, Math.max(1, deadline - performance.now())), undefined,
        { signal: job.controller.signal });
    }
  }
}
