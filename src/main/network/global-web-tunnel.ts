import { randomUUID } from "node:crypto";
import http from "node:http";
import { isIP, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { isCnPlatformId, type GlobalPlatformId, type CnPlatformId } from "@shared/platforms";
import type { ProxyTransportLease, ProxyTunnelContext } from "@main/api/proxy-transport";

type Code =
  "INVALID_INPUT" | "BUSY" | "CANCELLED" | "CONNECT_FAILED" | "UNVERIFIED" | "REVOKED" | "CLEANUP_FAILED";
export class GlobalWebTunnelError extends Error {
  constructor(readonly code: Code) {
    super(`GLOBAL_WEB_${code}`);
  }
}
export interface GlobalWebTunnelInput {
  platformId: GlobalPlatformId | CnPlatformId;
  host: string;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface GlobalWebTunnelOptions {
  proxy: Readonly<{ host: string; port: number }>;
  /** A separately reviewed web policy. There is deliberately no permissive default. */
  allowTarget(platform: GlobalPlatformId | CnPlatformId, host: string): boolean;
  authorize(context: ProxyTunnelContext, signal: AbortSignal): Promise<ProxyTransportLease | null>;
  renew?(
    context: ProxyTunnelContext,
    previous: ProxyTransportLease,
    signal: AbortSignal,
  ): Promise<ProxyTransportLease | null>;
  whenAuthorizerIdle(context?: ProxyTunnelContext): Promise<void>;
  concurrency?: number;
  connectTimeoutMs?: number;
}
export interface GlobalWebTunnel {
  /** Opaque end-to-end bytes. This layer never decrypts browser TLS or reads cookies. */
  stream: Duplex;
  closed: Promise<void>;
  close(): void;
}
interface Job {
  finished: boolean;
  finish(code: Code): void;
  done: Promise<void>;
}
const failure = (code: Code) => new GlobalWebTunnelError(code);
const positive = (n: number, max: number) => Number.isSafeInteger(n) && n >= 1 && n <= max;

/** Main-only CONNECT transport for independent website profiles. No listener, browser or default route.
 * Every read/write is guarded, including after a proof callback; retirement waits for actual socket closure.
 */
export class GlobalWebTunnelTransport {
  private readonly jobs = new Set<Job>();
  private readonly proxy: Readonly<{ host: string; port: number }>;
  private readonly concurrency: number;
  private readonly connectTimeoutMs: number;
  private readonly options: Readonly<GlobalWebTunnelOptions>;
  private disposed = false;
  private faulted = false;
  constructor(options: GlobalWebTunnelOptions) {
    const { host, port } = options.proxy;
    this.concurrency = options.concurrency ?? 8;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (
      !((isIP(host) === 4 && host.startsWith("127.")) || host === "::1") ||
      !positive(port, 65535) ||
      !positive(this.concurrency, 32) ||
      !positive(this.connectTimeoutMs, 15_000) ||
      typeof options.allowTarget !== "function" ||
      typeof options.authorize !== "function" ||
      typeof options.whenAuthorizerIdle !== "function" ||
      (options.renew !== undefined && typeof options.renew !== "function")
    )
      throw failure("INVALID_INPUT");
    this.proxy = Object.freeze({ host, port });
    this.options = Object.freeze({ ...options, proxy: this.proxy });
  }
  async open(raw: GlobalWebTunnelInput): Promise<GlobalWebTunnel> {
    if (this.disposed || this.faulted) throw failure("CANCELLED");
    if (this.jobs.size >= this.concurrency) throw failure("BUSY");
    const input = { ...raw };
    if (
      (!isCnPlatformId(input.platformId) && !["youtube", "tiktok", "x"].includes(input.platformId)) ||
      typeof input.host !== "string" ||
      input.host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.host) ||
      isIP(input.host) ||
      !(input.signal instanceof AbortSignal) ||
      typeof input.assertCurrent !== "function"
    )
      throw failure("INVALID_INPUT");
    if (input.signal.aborted) throw failure("CANCELLED");

    const abort = new AbortController(),
      sockets = new Set<Socket>();
    const socketCloses = new Set<Promise<void>>(),
      sources = new Set<Promise<void>>();
    const released = new WeakSet<object>();
    let request: http.ClientRequest | undefined,
      requestClosed = Promise.resolve();
    let tunnel: Socket | null = null,
      context: ProxyTunnelContext | null = null;
    let lease: ProxyTransportLease | null = null,
      leaseSignal: AbortSignal | null = null;
    let expiresAt = 0,
      generation = 0,
      renewing = false,
      verificationDuration = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined,
      renewTimer: ReturnType<typeof setTimeout> | undefined;
    let finishDone!: () => void,
      readyResolve!: (value: GlobalWebTunnel) => void,
      readyReject!: (error: Error) => void;
    const ready = new Promise<GlobalWebTunnel>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const done = new Promise<void>((resolve) => {
      finishDone = resolve;
    });
    // Rejections always have an observer, including a reentrant revocation before open returns.
    void ready.catch(() => undefined);
    const job: Job = { finished: false, finish: (code) => finish(code), done };
    const tripCleanup = () => {
      this.faulted = true;
      for (const active of this.jobs) active.finish("CLEANUP_FAILED");
    };
    const release = (candidate: ProxyTransportLease | null) => {
      if (!candidate || typeof candidate !== "object" || released.has(candidate)) return;
      released.add(candidate);
      try {
        candidate.release();
      } catch {
        tripCleanup();
      }
    };
    const current = (requireLease = true) => {
      if (job.finished || this.disposed || this.faulted || abort.signal.aborted || input.signal.aborted)
        throw failure("CANCELLED");
      input.assertCurrent();
      if (this.options.allowTarget(input.platformId, input.host) !== true) throw failure("UNVERIFIED");
      if (requireLease) {
        if (!lease || lease.isCurrent() !== true) throw failure("REVOKED");
        if (
          lease.signal !== leaseSignal ||
          lease.expiresAtMono !== expiresAt ||
          lease.generation !== generation ||
          leaseSignal?.aborted ||
          performance.now() >= expiresAt
        )
          throw failure("REVOKED");
      }
      if (job.finished || this.disposed || this.faulted || abort.signal.aborted || input.signal.aborted)
        throw failure("CANCELLED");
    };
    const stream = new Duplex({
      readableHighWaterMark: 65_536,
      writableHighWaterMark: 65_536,
      read: () => {
        try {
          current();
          tunnel?.resume();
        } catch {
          finish("REVOKED");
        }
      },
      write: (chunk: Buffer, encoding, callback) => {
        try {
          current();
          if (!tunnel) throw failure("UNVERIFIED");
          tunnel.write(chunk, encoding, (error) => {
            if (error) finish("CONNECT_FAILED");
            callback(error ? failure("CONNECT_FAILED") : undefined);
          });
        } catch {
          callback(failure("REVOKED"));
          finish("REVOKED");
        }
      },
      final: (callback) => {
        try {
          current();
          tunnel!.end(callback);
        } catch {
          callback(failure("REVOKED"));
          finish("REVOKED");
        }
      },
      destroy: (_error, callback) => {
        finish("CANCELLED");
        callback();
      },
    });
    stream.on("error", () => undefined);
    const revoked = () => finish("REVOKED");
    const externalCancel = () => finish("CANCELLED");
    const finish = (code: Code) => {
      if (job.finished) return;
      job.finished = true;
      abort.abort();
      clearTimeout(connectTimer);
      clearTimeout(expiryTimer);
      clearTimeout(renewTimer);
      input.signal.removeEventListener("abort", externalCancel);
      leaseSignal?.removeEventListener("abort", revoked);
      release(lease);
      readyReject(failure(code));
      request?.destroy();
      for (const socket of sockets) socket.destroy();
      stream.destroy();
      void (async () => {
        try {
          await requestClosed;
          while (sources.size || socketCloses.size) await Promise.all([...sources, ...socketCloses]);
          await this.options.whenAuthorizerIdle(context ?? undefined);
        } catch {
          tripCleanup();
        } finally {
          this.jobs.delete(job);
          finishDone();
        }
      })();
    };
    const connectTimer = setTimeout(() => finish("CONNECT_FAILED"), this.connectTimeoutMs);
    connectTimer.unref?.();
    this.jobs.add(job);
    input.signal.addEventListener("abort", externalCancel, { once: true });
    const own = (socket: Socket) => {
      if (sockets.has(socket)) return;
      sockets.add(socket);
      const closed = socket.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => socket.once("close", resolve));
      socketCloses.add(closed);
      void closed.then(() => {
        socketCloses.delete(closed);
        sockets.delete(socket);
      });
      socket.on("error", () => finish("CONNECT_FAILED"));
      socket.once("close", () => finish("CONNECT_FAILED"));
      if (job.finished) socket.destroy();
    };
    const track = (work: Promise<ProxyTransportLease | null>) => {
      const drain = work.then(
        (candidate) => {
          if (job.finished) release(candidate);
        },
        () => undefined,
      );
      sources.add(drain);
      void drain.then(() => sources.delete(drain));
      return work;
    };
    const adopt = (candidate: ProxyTransportLease | null) => {
      try {
        current(!!lease);
        const nextSignal = candidate?.signal,
          nextExpiry = candidate?.expiresAtMono,
          nextGeneration = candidate?.generation;
        if (
          !candidate ||
          candidate === lease ||
          typeof candidate.isCurrent !== "function" ||
          typeof candidate.release !== "function" ||
          !(nextSignal instanceof AbortSignal) ||
          nextGeneration === undefined ||
          !positive(nextGeneration, Number.MAX_SAFE_INTEGER) ||
          nextExpiry === undefined ||
          !Number.isFinite(nextExpiry) ||
          nextExpiry <= performance.now() ||
          nextExpiry > performance.now() + 15_000 ||
          nextSignal.aborted ||
          candidate.isCurrent() !== true ||
          (lease && (nextGeneration !== generation || nextExpiry <= expiresAt))
        )
          throw failure("UNVERIFIED");
        current(!!lease);
        // Callbacks may revoke or mutate a returned lease. Validate the captured grant again
        // before adopting it; a callback cannot extend its own lifetime or replace its signal.
        if (
          candidate.signal !== nextSignal ||
          candidate.expiresAtMono !== nextExpiry ||
          candidate.generation !== nextGeneration ||
          nextSignal.aborted ||
          performance.now() >= nextExpiry
        )
          throw failure("UNVERIFIED");
        const previous = lease;
        leaseSignal?.removeEventListener("abort", revoked);
        clearTimeout(expiryTimer);
        clearTimeout(renewTimer);
        lease = candidate;
        leaseSignal = nextSignal;
        expiresAt = nextExpiry;
        generation = nextGeneration;
        leaseSignal.addEventListener("abort", revoked, { once: true });
        current();
        expiryTimer = setTimeout(revoked, Math.max(1, expiresAt - performance.now()));
        expiryTimer.unref?.();
        if (this.options.renew) {
          renewTimer = setTimeout(
            () => {
              if (renewing || job.finished || !context) return;
              renewing = true;
              const original = lease!;
              const verificationStarted = performance.now();
              void track(
                Promise.resolve().then(() => {
                  current();
                  return this.options.renew!(context!, original, abort.signal);
                }),
              )
                .then((next) => {
                  if (job.finished) {
                    release(next);
                    return;
                  }
                  if (lease !== original) {
                    release(next);
                    finish("REVOKED");
                    return;
                  }
                  renewing = false;
                  verificationDuration = performance.now() - verificationStarted;
                  adopt(next);
                })
                .catch(() => finish("REVOKED"));
            },
            Math.max(
              1,
              Math.min(
                (expiresAt - performance.now()) / 2,
                expiresAt -
                  performance.now() -
                  verificationDuration -
                  Math.min(250, (expiresAt - performance.now()) / 4),
              ),
            ),
          );
          renewTimer.unref?.();
        }
        release(previous);
        current();
      } catch {
        release(candidate);
        finish("UNVERIFIED");
        throw failure("UNVERIFIED");
      }
    };
    try {
      current(false);
      request = http.request({
        hostname: this.proxy.host,
        port: this.proxy.port,
        method: "CONNECT",
        path: `${input.host}:443`,
        headers: { Host: `${input.host}:443` },
        agent: false,
        maxHeaderSize: 16_384,
      });
      requestClosed = new Promise<void>((resolve) => request!.once("close", resolve));
      request.on("socket", own);
      request.once("error", () => finish("CONNECT_FAILED"));
      request.once("response", (response) => {
        response.destroy();
        finish("CONNECT_FAILED");
      });
      request.once("connect", (response, socket, head) => {
        own(socket);
        socket.pause();
        if (
          job.finished ||
          response.statusCode !== 200 ||
          head.length ||
          !socket.localAddress ||
          !socket.localPort ||
          !socket.remoteAddress ||
          !socket.remotePort
        ) {
          finish("CONNECT_FAILED");
          return;
        }
        tunnel = socket;
        context = Object.freeze({
          id: randomUUID(),
          platformId: input.platformId,
          target: Object.freeze({ host: input.host, port: 443 as const }),
          proxy: this.proxy,
          socket: Object.freeze({
            localAddress: socket.localAddress,
            localPort: socket.localPort,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
          }),
          connectedAtMono: performance.now(),
        });
        socket.on("data", (chunk: Buffer) => {
          try {
            current();
            if (!stream.push(chunk)) socket.pause();
          } catch {
            finish("REVOKED");
          }
        });
        socket.once("end", () => stream.push(null));
        const verificationStarted = performance.now();
        void track(
          Promise.resolve().then(() => {
            current(false);
            return this.options.authorize(context!, abort.signal);
          }),
        )
          .then((candidate) => {
            if (job.finished) {
              release(candidate);
              return;
            }
            verificationDuration = performance.now() - verificationStarted;
            adopt(candidate);
            clearTimeout(connectTimer);
            current();
            readyResolve(Object.freeze({ stream, closed: done, close: externalCancel }));
          })
          .catch(() => finish("UNVERIFIED"));
      });
      current(false);
      request.end();
    } catch {
      finish("UNVERIFIED");
    }
    return ready;
  }
  async whenIdle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs].map((job) => job.done));
    if (this.faulted) throw failure("CLEANUP_FAILED");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.jobs) job.finish("CANCELLED");
    await this.whenIdle();
  }
}
