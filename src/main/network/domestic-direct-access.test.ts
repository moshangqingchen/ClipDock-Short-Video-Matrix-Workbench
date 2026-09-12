import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomesticDirectAccess } from "./domestic-direct-access";
import { NetworkRuntime, type NetworkSession } from "./runtime";
import type { ExclusiveAccessSnapshot } from "@shared/network";
import type { ProxyTunnelAuthorityState } from "@main/api/proxy-tunnel-authorizer";
import { parseDomesticEgress } from "@main/api/proxy-egress-probe";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function fixture() {
  let raw: ExclusiveAccessSnapshot = {
    state: "overseas",
    proxy: "on",
    reason: "PROXY_ENABLED",
    generation: 1,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15000).toISOString(),
  };
  let mode = "rule",
    available = true;
  const abort = new AbortController();
  const source = {
    acquireEligibility: vi.fn(async () =>
      available
        ? {
            generation: 1,
            signal: abort.signal,
            isCurrent: () => available && !abort.signal.aborted,
            release: vi.fn(),
          }
        : null,
    ),
    readAuthority: () =>
      available
        ? ({
            checkedAtMono: performance.now(),
            expiresAtMono: performance.now() + 15000,
            egress: { countryCode: "CN" },
          } as ProxyTunnelAuthorityState)
        : null,
    openWebTunnel: vi.fn(async () => {
      throw Error("no live public requests in this fixture");
    }),
    sync: vi.fn(),
    invalidate: vi.fn(() => {
      available = false;
      abort.abort();
    }),
    subscribe: () => () => {},
    dispose: vi.fn(async () => {}),
  };
  const off = {
    signal: new AbortController().signal,
    isCurrent: () => raw.proxy === "off",
    release: vi.fn(),
  };
  const access = new DomesticDirectAccess({
    source,
    readSwitch: () => raw,
    acquireOff: () => off,
    readController: () => ({ readable: mode !== "lost", mode }),
  });
  cleanup.push(() => access.dispose());
  return {
    access,
    source,
    setMode: (value: string) => {
      mode = value;
      access.sync();
    },
    setRaw: (value: Partial<ExclusiveAccessSnapshot>) => {
      raw = { ...raw, ...value };
      access.sync();
    },
    revoke: () => {
      available = false;
      abort.abort();
      access.sync();
    },
  };
}
class FakeSession extends EventEmitter {
  setProxy = vi.fn<NetworkSession["setProxy"]>().mockResolvedValue();
  closeAllConnections = vi.fn(async () => {});
  clearHostResolverCache = vi.fn(async () => {});
  clearStorageData = vi.fn(async () => {});
}

describe("domestic rule-mode production wiring", () => {
  it("cancels a pending listener when an account is released before start completes", async () => {
    const f = fixture(),
      releaseAccount = vi.fn();
    Object.assign(f.source, { releaseAccount });
    f.access.start();
    await settle();
    const session = new FakeSession();
    const pending = f.access.configureSession({
      session,
      accountId: "pending-account",
      platformId: "xiaohongshu",
      contextId: "old",
    });
    f.access.releaseSession("pending-account");
    await pending;
    expect(session.setProxy).not.toHaveBeenCalled();
    expect(session.closeAllConnections).not.toHaveBeenCalled();
    expect(session.clearHostResolverCache).not.toHaveBeenCalled();
    expect(releaseAccount).toHaveBeenCalledTimes(2);
  });

  it("does not let a cancelled configuration retire its newer replacement", async () => {
    const f = fixture(),
      releaseAccount = vi.fn();
    Object.assign(f.source, { releaseAccount });
    f.access.start();
    await settle();
    const old = new FakeSession(),
      next = new FakeSession();
    const previous = f.access.configureSession({
      session: old,
      accountId: "same-account",
      platformId: "xiaohongshu",
      contextId: "old",
    });
    const replacement = f.access.configureSession({
      session: next,
      accountId: "same-account",
      platformId: "xiaohongshu",
      contextId: "new",
    });
    await Promise.all([previous, replacement]);
    expect(old.setProxy).not.toHaveBeenCalled();
    expect(old.closeAllConnections).not.toHaveBeenCalled();
    expect(next.setProxy).toHaveBeenCalledTimes(1);
    expect(next.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(releaseAccount).toHaveBeenCalledTimes(2);
    const rules = next.setProxy.mock.calls[0][0].proxyRules!;
    const port = Number(/http=127\.0\.0\.1:(\d+)/.exec(rules)![1]);
    const client = net.connect({ host: "127.0.0.1", port });
    const connected = new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => client.once("close", resolve));
    await connected;
    client.destroy();
    await closed;
    f.access.releaseSession("same-account");
    expect(releaseAccount).toHaveBeenCalledTimes(3);
  });
  it("routes registered relays to their account pool and releases old pools on reconfiguration", async () => {
    const f = fixture();
    const openAccountTunnel = vi.fn(async () => {
      throw Error("no external requests in this test");
    });
    const releaseAccount = vi.fn();
    Object.assign(f.source, { openAccountTunnel, releaseAccount });
    f.access.start();
    await settle();
    const session = new FakeSession();
    const entry = { session, accountId: "cn-one", platformId: "xiaohongshu" as const, contextId: "fresh" };
    for (let i = 0; i < 3; i++) {
      await f.access.configureSession(entry);
      const rules = session.setProxy.mock.calls.at(-1)![0].proxyRules!;
      const port = Number(/http=127\.0\.0\.1:(\d+)/.exec(rules)![1]);
      const client = net.connect({ host: "127.0.0.1", port });
      client.on("error", () => undefined);
      const closed = new Promise<void>((resolve) => client.once("close", resolve));
      client.resume();
      client.once("connect", () =>
        client.write(
          "CONNECT creator.xiaohongshu.com:443 HTTP/1.1\r\nHost: creator.xiaohongshu.com:443\r\n\r\n",
        ),
      );
      await closed;
      expect(openAccountTunnel.mock.calls.at(-1)?.[0]).toBe("cn-one");
      expect(releaseAccount).toHaveBeenCalledTimes(i + 1);
    }
    expect(f.source.openWebTunnel).not.toHaveBeenCalled();
    f.access.releaseSession("cn-one");
    expect(releaseAccount).toHaveBeenCalledTimes(4);
    expect(f.access.read().state).toBe("dual");
  });
  it("uses measured route admission without requiring or fabricating a CN egress result", async () => {
    const f = fixture();
    let ready = true;
    const checkedAtMono = performance.now();
    const readAuthority = vi.fn(() => {
      throw Error("route source must not read country authority");
    });
    Object.assign(f.source, {
      readAuthority,
      readAdmission: () => ({ ready, generation: 1, checkedAtMono, expiresAtMono: checkedAtMono + 15000 }),
    });
    f.access.start();
    await settle();
    expect(f.access.read().state).toBe("dual");
    const lease = f.access.acquire()!;
    const generation = f.access.read().generation;
    for (let i = 0; i < 10; i++) f.access.sync();
    expect(f.access.read().generation).toBe(generation);
    expect(lease.isCurrent()).toBe(true);
    expect(readAuthority).not.toHaveBeenCalled();
    ready = false;
    f.access.sync();
    expect(lease.signal.aborted).toBe(true);
    expect(f.access.acquire()).toBeNull();
    expect(f.access.read().state).toBe("overseas");
  });
  it("does not expose the proxy-off path before start or after stop, and revokes its own off leases", async () => {
    const f = fixture();
    f.setRaw({ proxy: "off", state: "domestic", reason: "READY", generation: 2 });
    expect(f.access.read().state).toBe("checking");
    expect(f.access.acquire()).toBeNull();
    f.access.start();
    await settle();
    expect(f.access.read().state).toBe("domestic");
    const lease = f.access.acquire()!;
    expect(lease.isCurrent()).toBe(true);
    f.access.stop();
    expect(lease.signal.aborted).toBe(true);
    expect(lease.isCurrent()).toBe(false);
    expect(f.access.read().state).toBe("checking");
    expect(f.access.acquire()).toBeNull();
  });

  it("binds proxy-off leases to adapter invalidation even while the raw switch stays domestic", async () => {
    const f = fixture();
    f.setRaw({ proxy: "off", state: "domestic", reason: "READY", generation: 2 });
    f.access.start();
    await settle();
    const lease = f.access.acquire()!;
    f.access.invalidate();
    expect(lease.signal.aborted).toBe(true);
    expect(lease.isCurrent()).toBe(false);
    expect(f.access.read().state).toBe("domestic");
    expect(f.access.acquire()?.isCurrent()).toBe(true);
  });
  it("admits domestic sessions through distinct local relays, revokes them on controller loss and keeps storage", async () => {
    const f = fixture();
    f.access.start();
    await settle();
    expect(f.access.read().state).toBe("dual");
    const runtime = new NetworkRuntime({
      enforcement: "strict",
      networkReadiness: () => true,
      exclusiveAccess: f.access,
      ruleSplitTransport: {
        configureSession: (e) => f.access.configureSession(e),
        allowUrl: (p, u) => f.access.allowUrl(p, u),
      },
    });
    cleanup.push(() => runtime.dispose());
    f.access.on("state", () => runtime.syncExclusiveAccess());
    const a = new FakeSession(),
      b = new FakeSession();
    await runtime.registerSession(a, "cn-one", "xiaohongshu").ready;
    await runtime.registerSession(b, "cn-two", "bilibili").ready;
    expect(runtime.checkSessionRequest(a, "https://creator.xiaohongshu.com/").allowed).toBe(true);
    expect(runtime.checkSessionRequest(a, "https://studio.youtube.com/").allowed).toBe(false);
    expect(runtime.checkSessionRequest(a, "http://creator.xiaohongshu.com/").allowed).toBe(false);
    expect(a.setProxy.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "fixed_servers",
      proxyBypassRules: "<-loopback>",
    });
    expect(a.setProxy.mock.calls.at(-1)?.[0].proxyRules).not.toBe(
      b.setProxy.mock.calls.at(-1)?.[0].proxyRules,
    );
    const lease = runtime.acquire("cn-one")!;
    expect(lease.isCurrent()).toBe(true);
    const generation = f.access.read().generation;
    const configurations = a.setProxy.mock.calls.length;
    // Fresh authority timestamps in the same binding must not rebuild every account relay.
    for (let i = 0; i < 20; i++) f.access.sync();
    await settle();
    expect(f.access.read().generation).toBe(generation);
    expect(a.setProxy).toHaveBeenCalledTimes(configurations);
    expect(lease.isCurrent()).toBe(true);
    f.setMode("lost");
    expect(lease.signal.aborted).toBe(true);
    expect(runtime.check("cn-one").allowed).toBe(false);
    await settle();
    expect(
      a.clearStorageData.mock.calls.every(
        (call) => JSON.stringify(call) === JSON.stringify([{ storages: ["serviceworkers"] }]),
      ),
    ).toBe(true);
    f.setMode("rule");
    await settle();
    await runtime.registerSession(a, "cn-one", "xiaohongshu").ready;
    expect(runtime.check("cn-one").allowed).toBe(true);
    expect(f.source.openWebTunnel).not.toHaveBeenCalled();
  });
  it("does not sample global mode and does not grant access without an eligible sample", async () => {
    const f = fixture();
    f.setMode("global");
    f.access.start();
    await settle();
    expect(f.source.acquireEligibility).not.toHaveBeenCalled();
    expect(f.access.read()).toMatchObject({ state: "overseas", reason: "GLOBAL_MODE" });
    f.setMode("rule");
    await settle();
    expect(f.access.acquire()).not.toBeNull();
    const lease = f.access.acquire()!;
    f.revoke();
    expect(lease.signal.aborted).toBe(true);
    expect(f.access.acquire()).toBeNull();
  });
  it("restores the original proxy-off direct path", async () => {
    const f = fixture();
    f.access.start();
    await settle();
    const lease = f.access.acquire()!;
    f.setRaw({ proxy: "off", state: "domestic", reason: "READY", generation: 2 });
    expect(lease.isCurrent()).toBe(false);
    const session = new FakeSession();
    await f.access.configureSession({
      session,
      accountId: "cn-off",
      platformId: "douyin",
      contextId: "fresh",
    });
    expect(session.setProxy).toHaveBeenLastCalledWith({ mode: "direct" });
    expect(f.access.acquire()?.isCurrent()).toBe(true);
  });
  it("only accepts a mainland IPv4 IPIP response", () => {
    expect(parseDomesticEgress(Buffer.from("当前 IP： 110.43.50.20  来自于： 中国 北京 电信\n"))).toEqual({
      ip: "110.43.50.20",
      countryCode: "CN",
    });
    for (const response of [
      "当前 IP： 110.43.50.20 来自于： 中国 香港",
      "当前 IP： 110.43.50.20 来自于： 美国",
      "当前 IP： 127.0.0.1 来自于： 中国 北京",
      "<html>中国</html>",
      "当前 IP： ::1 来自于： 中国 北京",
    ])
      expect(() => parseDomesticEgress(Buffer.from(response))).toThrow();
  });
});
