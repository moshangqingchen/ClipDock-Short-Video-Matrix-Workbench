import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyTransportLease, ProxyTunnelContext } from "@main/api/proxy-transport";
import { GlobalWebProxyPool, type GlobalWebProxyPoolOptions } from "./global-web-proxy-pool";

type Source = ReturnType<NonNullable<GlobalWebProxyPoolOptions["createProofSession"]>>;
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
async function fixture(factory?: () => Source) {
  const sockets = new Set<Socket>(),
    server = http.createServer(),
    contexts: ProxyTunnelContext[] = [];
  const sources: {
    source: Source;
    invalidate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (_request, client) => {
    client.once("end", () => client.end());
    client.write("HTTP/1.1 200 OK\r\n\r\n");
    client.on("data", (chunk: Buffer) => client.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const make = () => {
    const abort = new AbortController();
    const lease = (signal: AbortSignal): ProxyTransportLease => ({
      generation: 1,
      expiresAtMono: performance.now() + 5_000,
      signal: abort.signal,
      isCurrent: () => !signal.aborted && !abort.signal.aborted,
      release: vi.fn(),
    });
    const invalidate = vi.fn(() => abort.abort()),
      dispose = vi.fn(async () => abort.abort());
    const source: Source = factory?.() ?? {
      authorize: async (context, signal) => {
        contexts.push(context);
        return lease(signal);
      },
      renew: async (_context, _previous, signal) => lease(signal),
      invalidate,
      dispose,
      whenIdle: async () => undefined,
    };
    sources.push({ source, invalidate, dispose });
    return source;
  };
  const pool = new GlobalWebProxyPool({
    proxy: { host: "127.0.0.1", port: (server.address() as AddressInfo).port },
    controllerUrl: "http://127.0.0.1:9790",
    getSecret: () => {
      throw new Error("real secret forbidden in test");
    },
    readVersion: () => null,
    readAuthority: () => null,
    subscribe: () => () => undefined,
    createProofSession: make,
  });
  cleanups.push(() => pool.dispose().catch(() => undefined));
  const open = (host = "studio.youtube.com", signal = new AbortController().signal) =>
    pool.open({ platformId: "youtube", host, signal, assertCurrent: () => undefined });
  return { pool, open, contexts, sources, sockets };
}

describe("website proof sessions", () => {
  it("releases a closed connection without waiting for an unrelated proof reader", async () => {
    const busy = deferred<void>();
    let number = 0;
    const f = await fixture(() => {
      const index = number++,
        abort = new AbortController();
      return {
        authorize: async () => ({
          generation: 1,
          signal: abort.signal,
          expiresAtMono: performance.now() + 5000,
          isCurrent: () => !abort.signal.aborted,
          release: vi.fn(),
        }),
        renew: async () => null,
        invalidate: () => abort.abort(),
        dispose: async () => {},
        whenIdle: () => (index === 0 ? Promise.resolve() : busy.promise),
      };
    });
    const a = await f.open(),
      b = await f.open("i.ytimg.com");
    try {
      let closed = false;
      void a.closed.then(() => {
        closed = true;
      });
      a.close();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500 });
    } finally {
      busy.resolve();
      b.close();
      await Promise.all([a.closed, b.closed]);
    }
  });
  it("assigns separate proof sessions to actual page connections and drains them on close", async () => {
    const f = await fixture();
    const [page, resource] = await Promise.all([f.open(), f.open("i.ytimg.com")]);
    expect(f.sources).toHaveLength(2);
    expect(new Set(f.contexts.map((context) => context.id)).size).toBe(2);
    expect(new Set(f.contexts.map((context) => context.socket.localPort)).size).toBe(2);
    expect(f.contexts.map((context) => context.target.host).sort()).toEqual([
      "i.ytimg.com",
      "studio.youtube.com",
    ]);
    page.close();
    resource.close();
    await Promise.all([page.closed, resource.closed]);
    expect(
      f.sources.every(
        ({ invalidate, dispose }) => invalidate.mock.calls.length === 1 && dispose.mock.calls.length === 1,
      ),
    ).toBe(true);
  });
  it("does not cancel a different website connection when one caller leaves", async () => {
    const f = await fixture(),
      parent = new AbortController();
    const first = await f.open("studio.youtube.com", parent.signal),
      second = await f.open("i.ytimg.com");
    parent.abort();
    await first.closed;
    expect(second.stream.destroyed).toBe(false);
    const echoed = new Promise<string>((resolve) =>
      second.stream.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    second.stream.write("still permitted");
    expect(await echoed).toBe("still permitted");
    second.close();
    await second.closed;
  });
  it("invalidates every live website connection with the source bundle", async () => {
    const f = await fixture(),
      first = await f.open(),
      second = await f.open("i.ytimg.com");
    f.pool.invalidate();
    expect(first.stream.destroyed).toBe(true);
    expect(second.stream.destroyed).toBe(true);
    await f.pool.dispose();
    await expect(f.open()).rejects.toThrow("GLOBAL_WEB_PROOF_UNAVAILABLE");
  });
  it("waits for a pending proof and releases a late lease after cancellation", async () => {
    const pending = deferred<ProxyTransportLease | null>(),
      started = deferred<void>();
    const released = vi.fn(),
      parent = new AbortController();
    const f = await fixture(() => ({
      authorize: async () => {
        started.resolve();
        return pending.promise;
      },
      renew: async () => null,
      invalidate() {},
      whenIdle: async () => undefined,
      dispose: async () => undefined,
    }));
    cleanups.push(() => pending.resolve(null));
    const opening = f.open("studio.youtube.com", parent.signal);
    const denied = expect(opening).rejects.toThrow("GLOBAL_WEB_CANCELLED");
    await started.promise;
    parent.abort();
    await denied;
    let drained = false;
    const drain = f.pool.dispose().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve({
      generation: 1,
      expiresAtMono: performance.now() + 5000,
      signal: new AbortController().signal,
      isCurrent: () => true,
      release: released,
    });
    await drain;
    expect(released).toHaveBeenCalledTimes(1);
  });
  it("refuses domestic and unreviewed targets before creating a proof session", async () => {
    const f = await fixture();
    await expect(f.open("creator.douyin.com")).rejects.toThrow();
    await expect(f.open("unreviewed.example")).rejects.toThrow();
    expect(f.sources).toHaveLength(0);
  });
});
