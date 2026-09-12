import net from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalWebRelay, type GlobalWebRelayOptions } from "./global-web-relay";
import type { GlobalWebTunnel } from "./global-web-tunnel";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function echoTunnel(): GlobalWebTunnel {
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      this.push(chunk);
      done();
    },
  });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  return { stream, closed, close: vi.fn(() => stream.destroy()) };
}
async function fixture(options: Partial<GlobalWebRelayOptions> = {}) {
  const abort = new AbortController();
  const open = vi.fn(async () => echoTunnel());
  const relay = new GlobalWebRelay({
    platformId: "youtube",
    signal: abort.signal,
    assertCurrent: () => undefined,
    allowTarget: (_platform, host) => host === "www.youtube.com",
    openTunnel: open,
    ...options,
  });
  cleanups.push(() => relay.dispose());
  const endpoint = await relay.start();
  async function client(request?: string) {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    const chunks: Buffer[] = [];
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    cleanups.push(() => {
      socket.destroy();
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    if (request) socket.write(request);
    return { socket, closed, text: () => Buffer.concat(chunks).toString() };
  }
  return { abort, relay, open, endpoint, client };
}
const connect = "CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n";

describe("independent website loopback relay", () => {
  it("binds only loopback and returns CONNECT 200 only after proof", async () => {
    const pending = deferred<GlobalWebTunnel>(),
      called = deferred<void>();
    const f = await fixture({
      openTunnel: async () => {
        called.resolve();
        return pending.promise;
      },
    });
    const tunnel = echoTunnel();
    cleanups.push(() => pending.resolve(tunnel));
    expect(f.endpoint.host).toBe("127.0.0.1");
    const client = await f.client(connect);
    await called.promise;
    expect(client.text()).toBe("");
    pending.resolve(tunnel);
    await vi.waitFor(() => expect(client.text()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n"));
    client.socket.write("opaque browser test bytes");
    await vi.waitFor(() => expect(client.text()).toContain("opaque browser test bytes"));
    client.socket.destroy();
    await client.closed;
    await f.relay.whenIdle();
    expect(tunnel.close).toHaveBeenCalled();
  });
  it.each([
    "GET http://www.youtube.com/ HTTP/1.1\r\nHost: www.youtube.com\r\n\r\n",
    "GET /local-rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
    "POST http://www.youtube.com/ HTTP/1.1\r\nHost: www.youtube.com\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n",
  ])("rejects ordinary HTTP and never interprets it as local RPC: %s", async (request) => {
    const f = await fixture(),
      client = await f.client(request);
    await client.closed;
    expect(client.text()).toContain("403 Forbidden");
    expect(f.open).not.toHaveBeenCalled();
  });
  it.each([
    connect.replaceAll("www.youtube.com", "127.0.0.1"),
    connect.replaceAll(":443", ":80"),
    connect.replaceAll("www.youtube.com", "www.youtube.com.attacker.test"),
    connect.replace("Host: www.youtube.com:443", "Host: different.example:443"),
    connect.replace("\r\n\r\n", "\r\nCookie: synthetic=blocked\r\n\r\n"),
    connect.replace("\r\n\r\n", "\r\nProxy-Authorization: synthetic\r\n\r\n"),
    connect.replace("\r\n\r\n", "\r\nContent-Length: 5\r\n\r\n"),
    connect + "early TLS bytes",
  ])("rejects a disallowed CONNECT before opening an upstream: %s", async (request) => {
    const f = await fixture(),
      client = await f.client(request);
    await client.closed;
    expect(client.text()).not.toContain("200 Connection");
    expect(f.open).not.toHaveBeenCalled();
  });
  it("closes pending and active browser connections on revocation, draining late opens", async () => {
    const pending = deferred<GlobalWebTunnel>(),
      called = deferred<void>();
    let signal: AbortSignal | undefined;
    const f = await fixture({
      openTunnel: async (input) => {
        signal = input.signal;
        called.resolve();
        return pending.promise;
      },
    });
    const late = echoTunnel();
    cleanups.push(() => pending.resolve(late));
    const client = await f.client(connect);
    await called.promise;
    f.abort.abort();
    await client.closed;
    expect(signal?.aborted).toBe(true);
    expect(client.text()).toBe("");
    let drained = false;
    const drain = f.relay.dispose().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve(late);
    await drain;
    expect(late.close).toHaveBeenCalled();
    expect(late.stream.destroyed).toBe(true);
  });
  it("destroys an established stream on parent revocation", async () => {
    const f = await fixture(),
      client = await f.client(connect);
    await vi.waitFor(() => expect(client.text()).toContain("200 Connection"));
    const tunnel = await f.open.mock.results[0].value;
    f.abort.abort();
    await client.closed;
    await f.relay.dispose();
    expect(tunnel.stream.destroyed).toBe(true);
  });
  it("rechecks authority after a late source callback before sending 200", async () => {
    let current = true;
    const tunnel = echoTunnel();
    const f = await fixture({
      assertCurrent: () => {
        if (!current) throw new Error("private");
      },
      openTunnel: async () => {
        current = false;
        return tunnel;
      },
    });
    const client = await f.client(connect);
    await client.closed;
    expect(client.text()).not.toContain("200 Connection");
    expect(client.text()).not.toContain("private");
    expect(tunnel.stream.destroyed).toBe(true);
  });
  it("bounds idle clients and times out incomplete headers", async () => {
    const f = await fixture({ maxConnections: 1, requestTimeoutMs: 250 });
    const first = await f.client("CONNECT ");
    const excess = net.connect({ host: f.endpoint.host, port: f.endpoint.port });
    excess.on("error", () => undefined);
    cleanups.push(() => {
      excess.destroy();
    });
    await new Promise<void>((resolve) => excess.once("close", resolve));
    await first.closed;
    expect(f.open).not.toHaveBeenCalled();
  });
  it("rejects oversized headers without upstream work", async () => {
    const f = await fixture();
    const client = await f.client(connect.replace("\r\n\r\n", `\r\nX-Test: ${"a".repeat(9000)}\r\n\r\n`));
    await client.closed;
    expect(f.open).not.toHaveBeenCalled();
  });
  it("closes its listener during startup cancellation without an unresolved start", async () => {
    const abort = new AbortController();
    const relay = new GlobalWebRelay({
      platformId: "x",
      signal: abort.signal,
      assertCurrent() {},
      allowTarget: () => false,
      openTunnel: async () => {
        throw new Error();
      },
    });
    const opening = relay.start();
    const rejected = expect(opening).rejects.toThrow("GLOBAL_WEB_RELAY_UNAVAILABLE");
    abort.abort();
    await rejected;
    await relay.dispose();
  });
});
