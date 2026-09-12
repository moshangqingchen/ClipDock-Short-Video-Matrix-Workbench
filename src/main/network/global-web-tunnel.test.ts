import http from "node:http";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalWebRelay } from "./global-web-relay";
import type { ProxyTransportLease, ProxyTunnelContext } from "@main/api/proxy-transport";
import {
  GlobalWebTunnelTransport,
  type GlobalWebTunnelInput,
  type GlobalWebTunnelOptions,
} from "./global-web-tunnel";

// Synthetic identity, trusted by this test client only. No system trust or real platform traffic.
const identity = {
  key: readFileSync(new URL("../api/test-fixtures/youtube-upload-key.pem", import.meta.url)),
  cert: readFileSync(new URL("../api/test-fixtures/youtube-upload-cert.pem", import.meta.url)),
};
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function grant(ttl = 5_000, generation = 1) {
  const abort = new AbortController();
  const lease: ProxyTransportLease = {
    generation,
    expiresAtMono: performance.now() + ttl,
    signal: abort.signal,
    isCurrent: vi.fn(() => !abort.signal.aborted),
    release: vi.fn(),
  };
  return { lease, abort };
}
function input(overrides: Partial<GlobalWebTunnelInput> = {}): GlobalWebTunnelInput {
  return {
    platformId: "youtube",
    host: "www.googleapis.com",
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    ...overrides,
  };
}
async function fixture(
  options: { status?: number; earlyHead?: string; hold?: boolean; targetPort?: number } = {},
) {
  const server = http.createServer();
  const sockets = new Set<Socket>();
  const requests: { target?: string; headers: http.IncomingHttpHeaders; sourcePort?: number }[] = [];
  const bytes: Buffer[] = [];
  const arrived = deferred<Socket>(),
    closed = deferred<void>();
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => {
      sockets.delete(socket);
      closed.resolve();
    });
  };
  server.on("connection", own);
  server.on("connect", (request, client) => {
    const socket = client as Socket;
    // Node hands the CONNECT handler a half-open socket. The fixture proxy must
    // close its writable half after observing the client's FIN.
    socket.once("end", () => socket.end());
    requests.push({ target: request.url, headers: request.headers, sourcePort: socket.remotePort });
    socket.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
    arrived.resolve(socket);
    if (options.hold) return;
    socket.write(`HTTP/1.1 ${options.status ?? 200} Test\r\n\r\n${options.earlyHead ?? ""}`);
    if (options.targetPort) {
      const target = net.connect({ host: "127.0.0.1", port: options.targetPort });
      own(target);
      socket.pipe(target).pipe(socket);
      socket.once("close", () => target.destroy());
      target.once("close", () => socket.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    proxy: { host: "127.0.0.1", port },
    requests,
    bytes,
    arrived: arrived.promise,
    closed: closed.promise,
    sockets,
    received: () => Buffer.concat(bytes),
  };
}
function transport(proxy: { host: string; port: number }, options: Partial<GlobalWebTunnelOptions> = {}) {
  const instance = new GlobalWebTunnelTransport({
    proxy,
    allowTarget: (platform, host) => platform === "youtube" && host === "www.googleapis.com",
    authorize: async () => grant().lease,
    whenAuthorizerIdle: async () => undefined,
    ...options,
  });
  cleanups.push(() => instance.dispose().catch(() => undefined));
  return instance;
}
const write = (stream: NodeJS.WritableStream, value: string | Buffer) =>
  new Promise<void>((resolve, reject) =>
    stream.write(value, (error?: Error | null) => (error ? reject(error) : resolve())),
  );

describe("opaque website CONNECT transport", () => {
  it.each(["localhost", "192.0.2.1", "0.0.0.0", "proxy.example", "127.0.0.1:7890"])(
    "refuses a noncanonical or non-loopback proxy: %s",
    (host) => {
      expect(() => transport({ host, port: 7890 })).toThrow("GLOBAL_WEB_INVALID_INPUT");
    },
  );
  it.each([
    "youtube.com.attacker.test",
    "www.googleapis.com.",
    "WWW.GOOGLEAPIS.COM",
    "127.0.0.1",
    "user@www.googleapis.com",
    "www.googleapis.com:443",
    "www.googleapis.com\r\nCookie: synthetic",
  ])("refuses unapproved or malformed targets before CONNECT: %s", async (host) => {
    const f = await fixture();
    await expect(transport(f.proxy).open(input({ host }))).rejects.toThrow(/^GLOBAL_WEB_/);
    expect(f.requests).toEqual([]);
  });
  it("holds all browser bytes until the actual CONNECT socket is authorized", async () => {
    const f = await fixture(),
      pending = deferred<ProxyTransportLease | null>(),
      called = deferred<ProxyTunnelContext>();
    const lease = grant().lease;
    const t = transport(f.proxy, {
      authorize: async (context) => {
        called.resolve(context);
        return pending.promise;
      },
    });
    cleanups.push(() => pending.resolve(null));
    const opening = t.open(input());
    const context = await called.promise;
    expect(context.socket.localPort).toBe(f.requests[0].sourcePort);
    expect(context.socket.remotePort).toBe(f.proxy.port);
    expect(context.target).toEqual({ host: "www.googleapis.com", port: 443 });
    expect(Object.isFrozen(context.socket)).toBe(true);
    expect(f.received().length).toBe(0);
    expect(f.requests[0].headers).toEqual({ host: "www.googleapis.com:443", connection: "close" });
    pending.resolve(lease);
    const tunnel = await opening;
    await write(tunnel.stream, "synthetic encrypted browser bytes");
    await vi.waitFor(() => expect(f.received().toString()).toBe("synthetic encrypted browser bytes"));
    tunnel.close();
    await tunnel.closed;
    await f.closed;
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
  it("denied proof sends no TLS or credential bytes to the receiver", async () => {
    const f = await fixture();
    const t = transport(f.proxy, { authorize: async () => null });
    await expect(t.open(input())).rejects.toThrow("GLOBAL_WEB_UNVERIFIED");
    await t.whenIdle();
    await f.closed;
    expect(f.received().length).toBe(0);
  });
  it.each([{ status: 407 }, { status: 302 }, { earlyHead: "unsolicited bytes" }])(
    "refuses non-200 or early proxy data without authorization: %j",
    async (options) => {
      const f = await fixture(options),
        authorize = vi.fn(async () => grant().lease);
      const t = transport(f.proxy, { authorize });
      await expect(t.open(input())).rejects.toThrow("GLOBAL_WEB_CONNECT_FAILED");
      await t.whenIdle();
      expect(authorize).not.toHaveBeenCalled();
      expect(f.received().length).toBe(0);
    },
  );
  it("times out an unanswered CONNECT and closes its actual socket", async () => {
    const f = await fixture({ hold: true });
    const t = transport(f.proxy, { connectTimeoutMs: 250 });
    await expect(t.open(input())).rejects.toThrow("GLOBAL_WEB_CONNECT_FAILED");
    await t.whenIdle();
    await f.closed;
    expect(f.received().length).toBe(0);
  });
  it("cancels a pending proof, retaining its slot until late work and socket closure finish", async () => {
    const f = await fixture(),
      pending = deferred<ProxyTransportLease | null>(),
      called = deferred<void>();
    const abort = new AbortController(),
      late = grant().lease;
    const t = transport(f.proxy, {
      concurrency: 1,
      authorize: async () => {
        called.resolve();
        return pending.promise;
      },
    });
    cleanups.push(() => pending.resolve(late));
    const opening = t.open(input({ signal: abort.signal }));
    const rejected = expect(opening).rejects.toThrow("GLOBAL_WEB_CANCELLED");
    await called.promise;
    abort.abort();
    await rejected;
    await f.closed;
    await expect(t.open(input())).rejects.toThrow("GLOBAL_WEB_BUSY");
    let drained = false;
    const drain = t.whenIdle().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve(late);
    await drain;
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(f.received().length).toBe(0);
  });
  it("cancels before CONNECT without making a socket", async () => {
    const f = await fixture(),
      abort = new AbortController();
    abort.abort();
    await expect(transport(f.proxy).open(input({ signal: abort.signal }))).rejects.toThrow(
      "GLOBAL_WEB_CANCELLED",
    );
    expect(f.requests).toEqual([]);
  });
  it.each(["transport", "relay"])("keeps TLS and synthetic cookies end to end through %s", async (mode) => {
    const requests: string[] = [],
      targetSockets = new Set<Socket>();
    const target = tls.createServer(identity, (socket) => {
      socket.on("data", (data) => {
        requests.push(data.toString());
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
      });
    });
    target.on("connection", (socket) => {
      targetSockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      for (const socket of targetSockets) socket.destroy();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    });
    const f = await fixture({ targetPort: (target.address() as net.AddressInfo).port });
    const t = transport(f.proxy);
    let stream;
    if (mode === "transport") stream = (await t.open(input())).stream;
    else {
      const relay = new GlobalWebRelay({
        platformId: "youtube",
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
        allowTarget: (_platform, host) => host === "www.googleapis.com",
        openTunnel: (value) => t.open(value),
      });
      cleanups.push(() => relay.dispose());
      const endpoint = await relay.start();
      stream = await new Promise<Socket>((resolve, reject) => {
        const request = http.request({
          hostname: endpoint.host,
          port: endpoint.port,
          method: "CONNECT",
          path: "www.googleapis.com:443",
          headers: { Host: "www.googleapis.com:443" },
          agent: false,
        });
        request.on("error", reject);
        request.once("connect", (response, socket, head) => {
          if (response.statusCode !== 200 || head.length) {
            socket.destroy();
            reject(new Error("relay denied"));
          } else resolve(socket);
        });
        request.end();
      });
    }
    const client = tls.connect({
      socket: stream,
      servername: "www.googleapis.com",
      ca: identity.cert,
    });
    cleanups.push(() => {
      client.destroy();
    });
    const response = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on("error", reject);
      client.on("data", (chunk: Buffer) => chunks.push(chunk));
      client.on("end", () => resolve(Buffer.concat(chunks).toString()));
      client.once("secureConnect", () => {
        expect(client.authorized).toBe(true);
        client.write(
          "GET /controlled-test HTTP/1.1\r\nHost: www.googleapis.com\r\nCookie: synthetic=only-local\r\n\r\n",
        );
      });
    });
    expect(response).toContain("200 OK");
    expect(requests.join("")).toContain("Cookie: synthetic=only-local");
    expect(f.received().includes(Buffer.from("synthetic=only-local"))).toBe(false);
    await t.whenIdle();
  });
  it.each(["parent", "lease", "dispose"])(
    "closes a live idle connection after %s revocation",
    async (kind) => {
      const f = await fixture(),
        parent = new AbortController(),
        allowed = grant();
      const t = transport(f.proxy, { authorize: async () => allowed.lease });
      const tunnel = await t.open(input({ signal: parent.signal }));
      if (kind === "parent") parent.abort();
      else if (kind === "lease") allowed.abort.abort();
      else void t.dispose();
      await tunnel.closed;
      await f.closed;
      await expect(write(tunnel.stream, "must never arrive")).rejects.toThrow();
      expect(f.received().length).toBe(0);
      expect(allowed.lease.release).toHaveBeenCalledTimes(1);
    },
  );
  it("expires an idle lease even with no subsequent read or write", async () => {
    const f = await fixture();
    const t = transport(f.proxy, { authorize: async () => grant(250).lease });
    const tunnel = await t.open(input());
    await tunnel.closed;
    await f.closed;
    expect(f.received().length).toBe(0);
  });
  it.each(["signal", "expiresAtMono", "generation"] as const)(
    "rejects a candidate mutated by its own isCurrent callback: %s",
    async (key) => {
      const f = await fixture(),
        candidate = grant().lease;
      candidate.isCurrent = () => {
        Object.assign(candidate, { [key]: key === "signal" ? new AbortController().signal : 1_000_000_000 });
        return true;
      };
      const t = transport(f.proxy, { authorize: async () => candidate });
      await expect(t.open(input())).rejects.toThrow("GLOBAL_WEB_UNVERIFIED");
      await t.whenIdle();
      expect(f.received().length).toBe(0);
      expect(candidate.release).toHaveBeenCalledTimes(1);
    },
  );
  it("rechecks revocation after a callback, before writing already supplied bytes", async () => {
    const f = await fixture(),
      allowed = grant();
    let revokeOnCheck = false;
    allowed.lease.isCurrent = () => {
      if (revokeOnCheck) allowed.abort.abort();
      return true;
    };
    const t = transport(f.proxy, { authorize: async () => allowed.lease });
    const tunnel = await t.open(input());
    revokeOnCheck = true;
    await expect(write(tunnel.stream, "blocked after callback")).rejects.toThrow();
    await tunnel.closed;
    await f.closed;
    expect(f.received().length).toBe(0);
  });
  it("renews the same connection without reconnecting or reusing the previous lease", async () => {
    const f = await fixture(),
      renewed = deferred<void>(),
      first = grant(600).lease;
    let firstContext: ProxyTunnelContext | undefined;
    const next: ProxyTransportLease[] = [];
    const t = transport(f.proxy, {
      authorize: async (context) => {
        firstContext = context;
        return first;
      },
      renew: async (context, previous) => {
        expect(context).toBe(firstContext);
        expect(previous).toBe(next.at(-1) ?? first);
        const lease = grant(600).lease;
        next.push(lease);
        renewed.resolve();
        return lease;
      },
    });
    const tunnel = await t.open(input());
    await renewed.promise;
    await vi.waitFor(() => expect(first.release).toHaveBeenCalledTimes(1));
    await write(tunnel.stream, "after renewal");
    await vi.waitFor(() => expect(f.received().toString()).toBe("after renewal"));
    expect(f.requests).toHaveLength(1);
    tunnel.close();
    await tunnel.closed;
    for (const lease of next) expect(lease.release).toHaveBeenCalledTimes(1);
  });
  it("starts renewal early enough for the measured proof-read duration without extending the old lease", async () => {
    const f = await fixture(), renewed = deferred<void>();
    let first!: ProxyTransportLease;
    const t = transport(f.proxy, {
      authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        first = grant(400).lease;
        return first;
      },
      renew: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const next = grant(400).lease;
        renewed.resolve();
        return next;
      },
    });
    const tunnel = await t.open(input()), originalDeadline = first.expiresAtMono;
    await renewed.promise;
    await vi.waitFor(() => expect(first.release).toHaveBeenCalledOnce());
    expect(first.expiresAtMono).toBe(originalDeadline);
    await write(tunnel.stream, "after slow proof renewal");
    await vi.waitFor(() => expect(f.received().toString()).toBe("after slow proof renewal"));
    expect(f.requests).toHaveLength(1);
    tunnel.close(); await tunnel.closed;
  });
  it("does not revive a connection when renewal completes after the old deadline", async () => {
    const f = await fixture(),
      renewing = deferred<void>(),
      pending = deferred<ProxyTransportLease | null>();
    const t = transport(f.proxy, {
      authorize: async () => grant(350).lease,
      renew: async () => {
        renewing.resolve();
        return pending.promise;
      },
    });
    cleanups.push(() => pending.resolve(null));
    const tunnel = await t.open(input());
    await renewing.promise;
    await f.closed;
    const late = grant().lease;
    pending.resolve(late);
    await tunnel.closed;
    await expect(write(tunnel.stream, "cannot revive")).rejects.toThrow();
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(1);
    expect(f.received().length).toBe(0);
  });
  it("faults closed after an authorizer cleanup error", async () => {
    const f = await fixture();
    const t = transport(f.proxy, {
      whenAuthorizerIdle: async () => {
        throw new Error("private source error");
      },
    });
    const tunnel = await t.open(input());
    tunnel.close();
    await tunnel.closed;
    await expect(t.whenIdle()).rejects.toThrow("GLOBAL_WEB_CLEANUP_FAILED");
    await expect(t.open(input())).rejects.toThrow("GLOBAL_WEB_CANCELLED");
    expect(f.received().length).toBe(0);
  });
});
