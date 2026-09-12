import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import tls from "node:tls";
import type { GlobalPlatformId } from "@shared/platforms";
import { OFFICIAL_API_HOSTS, assertTikTokUploadTarget, type TikTokUploadTarget } from "./proxy-target-policy";
import { assertYouTubeUploadTarget, type YouTubeUploadTarget } from "./youtube-upload-target";
export { OFFICIAL_API_HOSTS } from "./proxy-target-policy";

export interface ProxyTunnelContext {
  readonly id: string;
  readonly platformId: GlobalPlatformId | import("@shared/platforms").CnPlatformId;
  readonly target: Readonly<{ host: string; port: 443 }>;
  readonly proxy: Readonly<{ host: string; port: number }>;
  readonly socket: Readonly<{
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
  }>;
  readonly connectedAtMono: number;
}
export interface ProxyTransportLease {
  readonly generation: number;
  readonly expiresAtMono: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}
export interface ProxyTransportOptions {
  proxy: { host: string; port: number; username?: string; password?: string };
  /** Required to send anything. CONNECT success alone does not establish a proxy route.
   * V1 authorizes before TLS: a real authorizer must establish the route without SNI sniffing.
   * If the kernel cannot do so, refuse; this module does not assume the mixed port proves it.
   */
  authorizeTunnel?: (context: ProxyTunnelContext, signal: AbortSignal) => Promise<ProxyTransportLease | null>;
  /** Optional continuous verification on this same socket, never a retry/reconnect or longer cached proof. */
  renewTunnel?: (
    context: ProxyTunnelContext,
    previous: ProxyTransportLease,
    signal: AbortSignal,
  ) => Promise<ProxyTransportLease | null>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  concurrency?: number;
}
export interface ProxyTransportRequest {
  platformId: GlobalPlatformId;
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /** Main-only opaque capability for a verified signed TikTok FILE_UPLOAD destination. */
  uploadTarget?: TikTokUploadTarget | YouTubeUploadTarget;
  /** Bounded per-request duration; tunnel and source evidence keep their own short deadlines. */
  timeoutMs?: number;
}
/** Main-process response only: body and headers can contain OAuth or signed-upload data. Never log. */
export interface ProxyTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}
export type ProxyTransportErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_REQUEST"
  | "TARGET_NOT_ALLOWED"
  | "AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_DENIED"
  | "LEASE_REVOKED"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "PROXY_CONNECT_FAILED"
  | "TLS_FAILED"
  | "REQUEST_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_REJECTED"
  | "TRANSPORT_DISPOSED"
  | "TRANSPORT_BUSY";
export class ProxyTransportError extends Error {
  constructor(readonly code: ProxyTransportErrorCode) {
    super(code);
    this.name = "ProxyTransportError";
  }
}
interface Job {
  abort: AbortController;
  drained: Promise<void>;
  authorizations: Promise<unknown>[];
}
const forbiddenHeaders = new Set([
  "host",
  "cookie",
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "expect",
]);
function fail(code: ProxyTransportErrorCode): never {
  throw new ProxyTransportError(code);
}
const abortError = (signal: AbortSignal) =>
  signal.reason instanceof ProxyTransportError ? signal.reason : new ProxyTransportError("REQUEST_ABORTED");
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Node only. One anonymous CONNECT, one verified TLS connection, one application request.
 * https.Agent cannot create another socket: its sole connection is the already authorized tunnel.
 * Node APIs: https://nodejs.org/api/http.html#event-connect_1
 * https://nodejs.org/api/tls.html#tlsconnectoptions-callback (explicit SNI + default CA/hostname checks).
 */
export class ProxyTransport {
  private readonly options: ProxyTransportOptions;
  private readonly limits;
  private readonly jobs = new Set<Job>();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  constructor(options: ProxyTransportOptions) {
    const proxy = options?.proxy;
    if (
      !proxy ||
      typeof proxy.host !== "string" ||
      proxy.host.length > 253 ||
      !(
        isIP(proxy.host) ||
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(proxy.host)
      ) ||
      !integer(proxy.port, 1, 65535) ||
      [proxy.username, proxy.password].some(
        (value) =>
          value !== undefined && (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)),
      ) ||
      proxy.username?.includes(":") ||
      (proxy.password !== undefined && proxy.username === undefined)
    )
      fail("INVALID_CONFIG");
    this.limits = {
      timeoutMs: options.timeoutMs ?? 15_000,
      maxResponseBytes: options.maxResponseBytes ?? 2 * 1024 * 1024,
      maxRequestBytes: options.maxRequestBytes ?? 16 * 1024 * 1024,
      concurrency: options.concurrency ?? 2,
    };
    if (
      !integer(this.limits.timeoutMs, 1, 120_000) ||
      !integer(this.limits.maxResponseBytes, 1, 16 * 1024 * 1024) ||
      !integer(this.limits.maxRequestBytes, 1, 64 * 1024 * 1024) ||
      !integer(this.limits.concurrency, 1, 8)
    )
      fail("INVALID_CONFIG");
    this.options = Object.freeze({ ...options, proxy: Object.freeze({ ...proxy }) });
  }

  request(input: ProxyTransportRequest): Promise<ProxyTransportResponse> {
    try {
      if (this.disposed) fail("TRANSPORT_DISPOSED");
      if (!this.options.authorizeTunnel) fail("AUTHORIZATION_REQUIRED");
      if (this.jobs.size >= this.limits.concurrency) fail("TRANSPORT_BUSY");
      if (input.signal?.aborted) fail("REQUEST_ABORTED");
      if (typeof input.url !== "string" || input.url.length > 16_384 || /[\s\\]/.test(input.url))
        fail("INVALID_REQUEST");
      const url = new URL(input.url);
      const uploadTarget = input.uploadTarget;
      let uploadExpiresAtMono: number | undefined;
      if (uploadTarget) {
        if (input.method !== "PUT") fail("TARGET_NOT_ALLOWED");
        try {
          if (uploadTarget.kind === "tiktok-upload" && input.platformId === "tiktok")
            uploadExpiresAtMono = assertTikTokUploadTarget(uploadTarget, input.url);
          else if (uploadTarget.kind === "youtube-upload" && input.platformId === "youtube")
            uploadExpiresAtMono = assertYouTubeUploadTarget(uploadTarget, input.url);
          else fail("TARGET_NOT_ALLOWED");
        } catch {
          fail("TARGET_NOT_ALLOWED");
        }
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== "443") ||
        (!uploadTarget && !OFFICIAL_API_HOSTS[input.platformId]?.includes(url.hostname))
      )
        fail("TARGET_NOT_ALLOWED");
      const method = input.method ?? "GET";
      if (
        !uploadTarget &&
        input.platformId === "youtube" &&
        method === "PUT" &&
        url.pathname === "/upload/youtube/v3/videos"
      )
        fail("TARGET_NOT_ALLOWED");
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) fail("INVALID_REQUEST");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers ?? {})) {
        const normalized = name.toLowerCase();
        if (forbiddenHeaders.has(normalized) || normalized in headers || typeof value !== "string")
          fail("INVALID_REQUEST");
        http.validateHeaderName(name);
        http.validateHeaderValue(name, value);
        headers[normalized] = value;
      }
      if (
        uploadTarget &&
        Object.keys(headers).some(
          (name) =>
            !(
              uploadTarget.kind === "youtube-upload"
                ? ["content-type", "content-range", "authorization"]
                : ["content-type", "content-range"]
            ).includes(name),
        )
      )
        fail("INVALID_REQUEST");
      const timeoutMs = input.timeoutMs ?? this.limits.timeoutMs;
      if (!integer(timeoutMs, 1, 120_000)) fail("INVALID_REQUEST");
      if (input.body !== undefined && typeof input.body !== "string" && !(input.body instanceof Uint8Array))
        fail("INVALID_REQUEST");
      const body = input.body === undefined ? undefined : Buffer.from(input.body);
      if (body && body.byteLength > this.limits.maxRequestBytes) fail("INVALID_REQUEST");
      const job: Job = { abort: new AbortController(), drained: Promise.resolve(), authorizations: [] };
      const platformId = input.platformId,
        callerSignal = input.signal;
      this.jobs.add(job);
      // Snapshot application data before any authorizer callback/await can mutate a caller buffer.
      const pending = Promise.resolve().then(() =>
        this.execute(job, {
          platformId,
          url,
          method,
          headers,
          body,
          signal: callerSignal,
          uploadTarget,
          uploadExpiresAtMono,
          timeoutMs,
        }),
      );
      job.drained = pending
        .then(
          () => undefined,
          () => undefined,
        )
        .then(async () => {
          await Promise.allSettled(job.authorizations);
        })
        .finally(() => this.jobs.delete(job));
      return pending;
    } catch (error) {
      return Promise.reject(
        error instanceof ProxyTransportError ? error : new ProxyTransportError("INVALID_REQUEST"),
      );
    }
  }
  async whenIdle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs].map((job) => job.drained));
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let complete!: () => void;
    this.disposal = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.disposed = true;
    for (const job of this.jobs) job.abort.abort(new ProxyTransportError("TRANSPORT_DISPOSED"));
    void this.whenIdle().then(complete);
    return this.disposal;
  }

  private async execute(
    job: Job,
    input: {
      platformId: GlobalPlatformId;
      url: URL;
      method: string;
      headers: Record<string, string>;
      body?: Buffer;
      signal?: AbortSignal;
      uploadTarget?: TikTokUploadTarget | YouTubeUploadTarget;
      uploadExpiresAtMono?: number;
      timeoutMs: number;
    },
  ): Promise<ProxyTransportResponse> {
    const signal = job.abort.signal,
      deadline = Math.min(performance.now() + input.timeoutMs, input.uploadExpiresAtMono ?? Infinity);
    const sockets = new Set<Socket>(),
      closes: Promise<void>[] = [];
    let connectRequest: http.ClientRequest | undefined, application: http.ClientRequest | undefined;
    let agent: https.Agent | undefined, response: http.IncomingMessage | undefined;
    let lease: ProxyTransportLease | null = null,
      leaseExpiry = 0,
      leaseGeneration = -1;
    let leaseSignal: AbortSignal | undefined, leaseTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalPending = false,
      verificationDuration = 0;
    let context: ProxyTunnelContext | undefined;
    let finished = false;
    const released = new WeakSet<object>();
    const release = (candidate: ProxyTransportLease | null) => {
      if (!candidate || typeof candidate !== "object" || released.has(candidate)) return;
      released.add(candidate);
      try {
        candidate.release();
      } catch {
        /* Already locally revoked; never expose authority errors. */
      }
    };
    const close = () => {
      connectRequest?.destroy();
      application?.destroy();
      response?.destroy();
      agent?.destroy();
      for (const socket of sockets) socket.destroy();
    };
    const own = (socket: Socket) => {
      if (sockets.has(socket)) return;
      sockets.add(socket);
      closes.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
      socket.on("error", () => undefined);
      if (signal.aborted || finished) socket.destroy();
    };
    const abort = () => job.abort.abort(new ProxyTransportError("REQUEST_ABORTED"));
    const revoked = () => job.abort.abort(new ProxyTransportError("LEASE_REVOKED"));
    const timer = setTimeout(
      () => job.abort.abort(new ProxyTransportError("REQUEST_TIMEOUT")),
      Math.max(1, deadline - performance.now()),
    );
    timer.unref?.();
    signal.addEventListener("abort", close, { once: true });
    input.signal?.addEventListener("abort", abort, { once: true });
    const guard = (authorized = false) => {
      if (input.uploadTarget) {
        try {
          if (input.uploadTarget.kind === "youtube-upload")
            assertYouTubeUploadTarget(input.uploadTarget, input.url.href);
          else assertTikTokUploadTarget(input.uploadTarget, input.url.href);
        } catch {
          revoked();
        }
      }
      if (this.disposed) fail("TRANSPORT_DISPOSED");
      if (input.signal?.aborted) abort();
      if (performance.now() >= deadline) job.abort.abort(new ProxyTransportError("REQUEST_TIMEOUT"));
      if (signal.aborted) throw abortError(signal);
      if (authorized) {
        let current = false;
        try {
          current = lease?.isCurrent() === true;
        } catch {
          /* Unknown is closed. */
        }
        if (
          !current ||
          !lease ||
          lease.signal !== leaseSignal ||
          lease.generation !== leaseGeneration ||
          lease.expiresAtMono !== leaseExpiry ||
          leaseSignal?.aborted ||
          performance.now() >= leaseExpiry ||
          signal.aborted ||
          this.disposed
        )
          fail("LEASE_REVOKED");
      }
    };
    const scheduleRenewal = () => {
      clearTimeout(renewalTimer);
      if (!this.options.renewTunnel || !lease || !context || finished || signal.aborted || renewalPending)
        return;
      const remaining = leaseExpiry - performance.now();
      const delay = Math.max(
        1,
        Math.min(5000, remaining / 2, remaining - verificationDuration - Math.min(250, remaining / 4)),
      );
      renewalTimer = setTimeout(() => {
        if (finished || signal.aborted || !lease || !context || renewalPending) return;
        const previous = lease,
          savedContext = context,
          started = performance.now();
        renewalPending = true;
        const pending = Promise.resolve()
          .then(() => {
            guard(true);
            return this.options.renewTunnel!(savedContext, previous, signal);
          })
          .then(
            (candidate) => {
              if (finished || signal.aborted) {
                release(candidate);
                return;
              }
              try {
                guard(true);
                if (lease !== previous) fail("LEASE_REVOKED");
                verificationDuration = performance.now() - started;
                adopt(candidate);
              } catch {
                release(candidate);
                revoked();
              }
            },
            () => {
              if (!finished && !signal.aborted) revoked();
            },
          )
          .finally(() => {
            renewalPending = false;
            scheduleRenewal();
          });
        job.authorizations.push(pending);
      }, delay);
      renewalTimer.unref?.();
    };
    const adopt = (candidate: ProxyTransportLease | null) => {
      if (
        !candidate ||
        !integer(candidate.generation, 0, Number.MAX_SAFE_INTEGER) ||
        !Number.isFinite(candidate.expiresAtMono) ||
        !(candidate.signal instanceof AbortSignal) ||
        typeof candidate.isCurrent !== "function" ||
        typeof candidate.release !== "function"
      )
        fail("AUTHORIZATION_DENIED");
      const old = lease;
      const nextExpiry = candidate.expiresAtMono,
        nextGeneration = candidate.generation,
        nextSignal = candidate.signal;
      if (old) {
        guard(true);
        if (
          candidate === old ||
          nextSignal === leaseSignal ||
          nextGeneration !== leaseGeneration ||
          nextExpiry <= leaseExpiry
        )
          fail("LEASE_REVOKED");
        if (!candidate.isCurrent()) fail("LEASE_REVOKED");
        guard(true); // The old proof must remain live throughout the handoff, including provider callbacks.
      }
      leaseSignal?.removeEventListener("abort", revoked);
      clearTimeout(leaseTimer);
      lease = candidate;
      leaseExpiry = nextExpiry;
      leaseGeneration = nextGeneration;
      leaseSignal = nextSignal;
      leaseSignal.addEventListener("abort", revoked, { once: true });
      guard(true);
      leaseTimer = setTimeout(revoked, Math.max(1, Math.min(leaseExpiry, deadline) - performance.now()));
      leaseTimer.unref?.();
      scheduleRenewal();
      release(old);
    };
    try {
      guard();
      const proxy = this.options.proxy;
      const tunnel = await interrupted(
        new Promise<Socket>((resolve, reject) => {
          const headers: Record<string, string> = { Host: `${input.url.hostname}:443` };
          if (proxy.username !== undefined)
            headers["Proxy-Authorization"] =
              "Basic " + Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
          connectRequest = http.request({
            hostname: proxy.host,
            port: proxy.port,
            method: "CONNECT",
            path: `${input.url.hostname}:443`,
            headers,
            agent: false,
            maxHeaderSize: 16_384,
          });
          connectRequest.on("socket", own);
          connectRequest.once("error", () => reject(new ProxyTransportError("PROXY_CONNECT_FAILED")));
          connectRequest.once("response", (value) => {
            value.destroy();
            reject(new ProxyTransportError("PROXY_CONNECT_FAILED"));
          });
          connectRequest.once("connect", (value, socket, head) => {
            if (
              value.statusCode !== 200 ||
              head.length ||
              !socket.localAddress ||
              !socket.remoteAddress ||
              !socket.localPort ||
              !socket.remotePort
            ) {
              socket.destroy();
              reject(new ProxyTransportError("PROXY_CONNECT_FAILED"));
              return;
            }
            own(socket);
            socket.pause();
            resolve(socket);
          });
          connectRequest.end();
        }),
        signal,
      );
      guard();
      const connectedContext: ProxyTunnelContext = Object.freeze({
        id: randomUUID(),
        platformId: input.platformId,
        target: Object.freeze({ host: input.url.hostname, port: 443 as const }),
        proxy: Object.freeze({ host: proxy.host, port: proxy.port }),
        socket: Object.freeze({
          localAddress: tunnel.localAddress!,
          localPort: tunnel.localPort!,
          remoteAddress: tunnel.remoteAddress!,
          remotePort: tunnel.remotePort!,
        }),
        connectedAtMono: performance.now(),
      });
      context = connectedContext;
      const verificationStarted = performance.now();
      const authorization = Promise.resolve().then(() => {
        guard();
        return this.options.authorizeTunnel!(connectedContext, signal);
      });
      job.authorizations.push(
        authorization.then(
          (candidate) => {
            if (finished || signal.aborted) release(candidate);
          },
          () => undefined,
        ),
      );
      try {
        const candidate = await interrupted(authorization, signal);
        verificationDuration = performance.now() - verificationStarted;
        try {
          adopt(candidate);
        } catch (error) {
          release(candidate);
          throw error;
        }
      } catch {
        guard();
        fail("AUTHORIZATION_DENIED");
      }
      guard(true);
      const secured = await interrupted(
        new Promise<tls.TLSSocket>((resolve, reject) => {
          // No client certificate, CA override, DNS lookup, TLS session reuse or certificate bypass.
          const socket = tls.connect({
            socket: tunnel,
            servername: input.url.hostname,
            rejectUnauthorized: true,
            ALPNProtocols: ["http/1.1"],
          });
          own(socket);
          socket.once("error", () => reject(new ProxyTransportError("TLS_FAILED")));
          socket.once("secureConnect", () =>
            socket.authorized ? resolve(socket) : reject(new ProxyTransportError("TLS_FAILED")),
          );
        }),
        signal,
      );
      guard(true);
      agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
      let supplied = false;
      agent.createConnection = () => {
        guard(true);
        if (supplied) fail("REQUEST_FAILED");
        supplied = true;
        return secured;
      };
      return await interrupted(
        new Promise<ProxyTransportResponse>((resolve, reject) => {
          const headers = {
            ...input.headers,
            host: input.url.hostname,
            connection: "close",
            "accept-encoding": "identity",
            ...(input.body === undefined ? {} : { "content-length": String(input.body.byteLength) }),
          };
          guard(true);
          application = https.request(
            {
              hostname: input.url.hostname,
              port: 443,
              path: input.url.pathname + input.url.search,
              method: input.method,
              headers,
              agent,
              maxHeaderSize: 16_384,
            },
            (value) => {
              response = value;
              const chunks: Buffer[] = [];
              let size = 0;
              const failed = (error: unknown) => {
                reject(
                  error instanceof ProxyTransportError ? error : new ProxyTransportError("REQUEST_FAILED"),
                );
                value.destroy();
              };
              // 308 is protocol progress only for an owned YouTube resumable PUT, never a redirect.
              const resumable =
                value.statusCode === 308 &&
                input.uploadTarget?.kind === "youtube-upload" &&
                value.headers.location === undefined;
              if ((value.statusCode ?? 0) >= 300 && (value.statusCode ?? 0) < 400 && !resumable) {
                failed(new ProxyTransportError("REDIRECT_REJECTED"));
                return;
              }
              value.on("data", (chunk: Buffer) => {
                try {
                  guard(true);
                  size += chunk.byteLength;
                  if (size > this.limits.maxResponseBytes) fail("RESPONSE_TOO_LARGE");
                  chunks.push(Buffer.from(chunk));
                } catch (error) {
                  failed(error);
                }
              });
              value.once("error", failed);
              value.once("aborted", () => failed(new ProxyTransportError("REQUEST_FAILED")));
              value.once("end", () => {
                try {
                  guard(true);
                  if (!value.complete) fail("REQUEST_FAILED");
                  resolve({
                    status: value.statusCode ?? 0,
                    headers: Object.freeze({ ...value.headers }),
                    body: Buffer.concat(chunks, size),
                  });
                } catch (error) {
                  failed(error);
                }
              });
            },
          );
          application.once("error", () => reject(new ProxyTransportError("REQUEST_FAILED")));
          application.once("upgrade", (_response, socket) => {
            socket.destroy();
            reject(new ProxyTransportError("REQUEST_FAILED"));
          });
          guard(true);
          application.end(input.body);
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw error instanceof ProxyTransportError ? error : new ProxyTransportError("REQUEST_FAILED");
    } finally {
      finished = true;
      clearTimeout(timer);
      clearTimeout(leaseTimer);
      clearTimeout(renewalTimer);
      input.signal?.removeEventListener("abort", abort);
      leaseSignal?.removeEventListener("abort", revoked);
      release(lease);
      close();
      await Promise.allSettled(closes);
      signal.removeEventListener("abort", close);
    }
  }
}
