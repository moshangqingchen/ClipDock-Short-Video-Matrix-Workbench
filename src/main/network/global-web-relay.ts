import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isCnPlatformId, type GlobalPlatformId, type CnPlatformId } from "@shared/platforms";
import type { GlobalWebTunnel, GlobalWebTunnelInput } from "./global-web-tunnel";

export interface GlobalWebRelayOptions {
  readonly platformId: GlobalPlatformId | CnPlatformId;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  allowTarget(platformId: GlobalPlatformId | CnPlatformId, host: string): boolean;
  openTunnel(input: GlobalWebTunnelInput): Promise<GlobalWebTunnel>;
  readonly maxConnections?: number;
  readonly requestTimeoutMs?: number;
}
const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const fail = () => new Error("GLOBAL_WEB_RELAY_UNAVAILABLE");

/** One main-process, loopback-only CONNECT listener per independent website environment.
 * It accepts no ordinary HTTP, renderer commands, credentials, DNS or arbitrary destinations.
 * The supplied transport owns route proof and guards the opaque stream throughout its life.
 */
export class GlobalWebRelay {
  private readonly options: Readonly<GlobalWebRelayOptions>;
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly closes = new Set<Promise<void>>();
  private readonly work = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly timeoutMs: number;
  private readonly maxConnections: number;
  private starting: Promise<Readonly<{ host: "127.0.0.1"; port: number }>> | null = null;
  private disposal: Promise<void> | null = null;
  private stopped = false;
  private faulted = false;

  constructor(options: GlobalWebRelayOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxConnections = options.maxConnections ?? 32;
    if (
      !options ||
      (!isCnPlatformId(options.platformId) && !["youtube", "tiktok", "x"].includes(options.platformId)) ||
      !(options.signal instanceof AbortSignal) ||
      typeof options.assertCurrent !== "function" ||
      typeof options.allowTarget !== "function" ||
      typeof options.openTunnel !== "function" ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 15_000 ||
      !Number.isSafeInteger(this.maxConnections) ||
      this.maxConnections < 1 ||
      this.maxConnections > 64
    )
      throw fail();
    this.options = Object.freeze({ ...options });
    this.server = http.createServer({
      maxHeaderSize: 8192,
      headersTimeout: this.timeoutMs,
      requestTimeout: this.timeoutMs,
      keepAliveTimeout: 1,
    });
    this.server.on("connection", (socket) => {
      const accepted =
        !this.stopped &&
        !this.faulted &&
        this.sockets.size < this.maxConnections &&
        socket.remoteAddress === "127.0.0.1";
      this.sockets.add(socket);
      const close = new Promise<void>((resolve) => socket.once("close", resolve));
      this.closes.add(close);
      void close.then(() => {
        this.closes.delete(close);
        this.sockets.delete(socket);
      });
      socket.on("error", () => undefined);
      if (!accepted) {
        socket.destroy();
        return;
      }
      // Includes clients that never finish their request headers.
      socket.setTimeout(this.timeoutMs, () => socket.destroy());
    });
    this.server.on("request", (_request, response) => {
      response.writeHead(403, { Connection: "close", "Content-Length": "0" });
      response.end();
    });
    this.server.on("checkContinue", (_request, response) => {
      response.writeHead(403, { Connection: "close", "Content-Length": "0" });
      response.end();
    });
    this.server.on("upgrade", (_request, socket) => socket.destroy());
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connect", (request, socket, head) => this.connect(request, socket as Socket, head));
    this.server.on("error", () => {
      this.faulted = true;
      this.stop();
    });
    options.signal.addEventListener("abort", this.stop, { once: true });
    if (options.signal.aborted) this.stop();
  }

  private current(): void {
    if (this.stopped || this.faulted || this.options.signal.aborted) throw fail();
    this.options.assertCurrent();
    if (this.stopped || this.faulted || this.options.signal.aborted) throw fail();
  }

  start(): Promise<Readonly<{ host: "127.0.0.1"; port: number }>> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const error = () => reject(fail());
      this.server.once("error", error);
      this.server.once("close", error);
      try {
        this.current();
        this.server.listen(0, "127.0.0.1", () => {
          this.server.removeListener("error", error);
          this.server.removeListener("close", error);
          try {
            this.current();
            const address = this.server.address() as AddressInfo | null;
            if (address?.address !== "127.0.0.1" || !address.port) throw fail();
            resolve(Object.freeze({ host: "127.0.0.1", port: address.port }));
          } catch {
            this.stop();
            reject(fail());
          }
        });
      } catch {
        this.server.removeListener("error", error);
        this.server.removeListener("close", error);
        reject(fail());
      }
    });
    // Cancellation may occur before the caller attaches its own handler.
    void this.starting.catch(() => undefined);
    return this.starting;
  }

  private connect(request: http.IncomingMessage, socket: Socket, head: Buffer): void {
    socket.pause();
    const abort = new AbortController();
    this.controllers.add(abort);
    let tunnel: GlobalWebTunnel | null = null;
    let handedOff = false;
    const cancel = () => {
      abort.abort();
      tunnel?.close();
      socket.destroy();
    };
    socket.once("close", cancel);
    socket.once("error", cancel);
    socket.once("end", cancel);
    const timer = setTimeout(cancel, this.timeoutMs);
    timer.unref?.();
    const guard = () => {
      this.current();
      if (abort.signal.aborted || socket.destroyed) throw fail();
    };
    const work = Promise.resolve().then(async () => {
      try {
        guard();
        const authority = request.url ?? "";
        const host = authority.endsWith(":443") ? authority.slice(0, -4) : "";
        if (
          host.length > 253 ||
          !hostPattern.test(host) ||
          request.headers.host !== authority ||
          head.length ||
          request.headers["content-length"] !== undefined ||
          request.headers["transfer-encoding"] !== undefined ||
          request.headers.cookie !== undefined ||
          request.headers.authorization !== undefined ||
          request.headers["proxy-authorization"] !== undefined ||
          this.options.allowTarget(this.options.platformId, host) !== true
        )
          throw fail();
        guard();
        tunnel = await this.options.openTunnel({
          platformId: this.options.platformId,
          host,
          signal: abort.signal,
          assertCurrent: guard,
        });
        guard();
        if (this.options.allowTarget(this.options.platformId, host) !== true) throw fail();
        guard();
        // No CONNECT 200 (and therefore no browser TLS handshake) before actual tunnel proof.
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        handedOff = true;
        clearTimeout(timer);
        socket.setTimeout(0);
        tunnel.stream.once("error", cancel);
        tunnel.stream.once("close", cancel);
        socket.pipe(tunnel.stream).pipe(socket);
        socket.resume();
        await tunnel.closed;
      } catch {
        // Fixed response only; neither source errors nor target URLs are projected.
        if (!handedOff && !socket.destroyed) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
      } finally {
        clearTimeout(timer);
        abort.abort();
        tunnel?.close();
        if (tunnel) await tunnel.closed;
        // Permit a bounded rejection response to flush, but never retain a writable browser socket.
        if (!socket.destroyed && !handedOff) socket.destroySoon();
        else socket.destroy();
        this.controllers.delete(abort);
      }
    });
    this.work.add(work);
    void work
      .catch(() => {
        this.faulted = true;
        this.stop();
      })
      .finally(() => this.work.delete(work));
  }

  private readonly stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.options.signal.removeEventListener("abort", this.stop);
    for (const controller of this.controllers) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  };

  async whenIdle(): Promise<void> {
    while (this.work.size || this.closes.size) await Promise.allSettled([...this.work, ...this.closes]);
    if (this.faulted) throw fail();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stop();
    this.disposal = (async () => {
      await this.starting?.catch(() => undefined);
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      await this.whenIdle();
    })();
    return this.disposal;
  }
}
