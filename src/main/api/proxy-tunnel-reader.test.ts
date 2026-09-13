import { createHash } from "node:crypto";
import { ClientRequest, createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClashReadResult } from "@main/network/clash-reader";
import type { WindowsControllerOwnerSnapshot } from "@main/network/windows-controller-owner";
import type { WindowsTcpSocketScope, WindowsTcpSocketSnapshot } from "@main/network/windows-tcp-sockets";
import type { ProxyTunnelContext } from "./proxy-transport";
import { verifyProxyTunnelEvidence, type AnonymousProxyTunnelContext } from "./proxy-tunnel-evidence";
import {
  ProxyTunnelReader,
  type ProxyTunnelReaderDependencies,
  type ProxyTunnelReaderOptions,
} from "./proxy-tunnel-reader";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = () => ({ startedAtMono: performance.now(), completedAtMono: performance.now() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const disposals: (() => Promise<void>)[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) await dispose().catch(() => undefined);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function context(): ProxyTunnelContext {
  return {
    id: "current-context",
    platformId: "youtube",
    target: { host: "oauth2.googleapis.com", port: 443 },
    proxy: { host: "127.0.0.1", port: 10090 },
    socket: { localAddress: "127.0.0.1", localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 10090 },
    connectedAtMono: performance.now(),
  };
}
function owner(port: number): WindowsControllerOwnerSnapshot {
  return {
    available: true,
    basis: "windows-controller-listener",
    ...stamp(),
    scopeHash: hash(JSON.stringify({ address: "127.0.0.1", port })),
    owner: { pid: 1234, createdAtTicks: "134332323232323232", executablePathIdentity: hash("kernel-path") },
    kernelEpoch: hash(`owner-${port}`),
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port, coverage: "exact" }],
  };
}
function config(): ClashReadResult {
  return {
    mode: "rule",
    tun: true,
    mixedPort: 10090,
    version: "test",
    fingerprint: hash("current-config"),
    rules: [],
    ...stamp(),
  };
}
function rawConnections() {
  return {
    connections: [
      {
        id: "owned-id",
        chains: ["node", "group"],
        upload: 999,
        metadata: {
          sourceIP: "127.0.0.1",
          sourcePort: "50000",
          inboundIP: "127.0.0.1",
          inboundPort: "10090",
          host: "oauth2.googleapis.com",
          destinationPort: "443",
          network: "tcp",
          type: "HTTPS",
          processPath: process.execPath,
        },
      },
      {
        id: "unrelated-secret-row",
        chains: ["unrelated-node"],
        metadata: {
          sourceIP: "127.0.0.1",
          sourcePort: "60000",
          host: "private.example",
          inboundIP: "127.0.0.1",
          inboundPort: "10090",
          destinationPort: "443",
          network: "tcp",
          type: "HTTPS",
          processPath: "private-path",
        },
      },
    ],
  };
}
function rawProxies() {
  return {
    proxies: {
      node: { type: "Shadowsocks", id: "node-id", udp: true, history: [{ delay: 5 }] },
      group: { type: "Selector", now: "node", all: ["node"] },
      "unrelated-node": { type: "Shadowsocks", id: "unrelated-secret-policy" },
    },
  };
}
function fixture(
  overrides: Partial<ProxyTunnelReaderOptions> = {},
  dependencyOverrides: Partial<ProxyTunnelReaderDependencies> = {},
) {
  let version: { generation: number; revision: string } | null = { generation: 1, revision: "revision-1" };
  const readVersion = vi.fn(() => version);
  const controller = { read: vi.fn(async () => config()), whenIdle: vi.fn(async () => undefined) };
  const makeOwner = (port: number) => ({
    read: vi.fn(async () => owner(port)),
    whenIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
  });
  const controllerOwner = makeOwner(9790),
    proxyOwner = makeOwner(10090);
  const json = {
    read: vi.fn(async (endpoint: "/connections" | "/proxies", _signal: AbortSignal) => ({
      ...stamp(),
      value: endpoint === "/connections" ? rawConnections() : rawProxies(),
    })),
    whenIdle: vi.fn(async () => undefined),
  };
  const reader = new ProxyTunnelReader(
    {
      controllerUrl: "http://127.0.0.1:9790",
      proxy: { host: "127.0.0.1", port: 10090 },
      getSecret: () => null,
      readVersion,
      ...overrides,
    },
    { controller, controllerOwner, proxyOwner, json, ...dependencyOverrides },
  );
  disposals.push(() => reader.dispose());
  return {
    reader,
    controller,
    controllerOwner,
    proxyOwner,
    json,
    readVersion,
    setVersion: (value: typeof version) => {
      version = value;
    },
  };
}
const run = (reader: ProxyTunnelReader, input = context()) =>
  reader.readTunnel(input, new AbortController().signal);

function acceptedSnapshot(scope: WindowsTcpSocketScope): WindowsTcpSocketSnapshot {
  const identity = owner(9790);
  if (!identity.available) throw new Error("fixture owner unavailable");
  return {
    available: true,
    ...stamp(),
    scopeHash: hash(JSON.stringify(scope)),
    owners: [identity.owner],
    sockets: [
      {
        ownerPid: identity.owner.pid,
        sourceAddress: "127.0.0.1",
        sourcePort: 10090,
        remoteAddress: scope.remotes[0].address,
        remotePort: scope.remotes[0].port,
        state: "Established",
      },
    ],
  };
}

describe("accepted proxy socket ownership", () => {
  it("reads an approved website only in the explicit website scope", async () => {
    const input = context();
    Object.assign(input.target, { host: "studio.youtube.com" });
    const api = fixture();
    expect(await run(api.reader, input)).toBeNull();
    expect(api.controller.read).not.toHaveBeenCalled();
    const web = fixture({ targetScope: "website" });
    web.json.read.mockImplementation(async (endpoint) => {
      const value = endpoint === "/connections" ? rawConnections() : rawProxies();
      if ("connections" in value) value.connections[0].metadata.host = "studio.youtube.com";
      return { ...stamp(), value };
    });
    expect(await run(web.reader, input)).toMatchObject({ contextId: input.id });
    await web.reader.whenIdle();
  });
  it("queries only the controller PID and actual client tuple, then feeds accepted facts to the shared verifier", async () => {
    const createAcceptedSocketReader = vi.fn((scope: WindowsTcpSocketScope) => ({
      read: vi.fn(async () => acceptedSnapshot(scope)),
    }));
    const f = fixture({}, { proxyOwner: undefined, createAcceptedSocketReader }),
      input = context();
    const readStartedAtMono = performance.now();
    const evidence = await run(f.reader, input);
    await f.reader.whenIdle();
    expect(createAcceptedSocketReader).toHaveBeenCalledWith({
      ownerPids: [1234],
      remotes: [{ address: input.socket.localAddress, port: input.socket.localPort }],
    });
    expect(f.proxyOwner.read).not.toHaveBeenCalled();
    expect(evidence?.proxyOwner).toMatchObject({
      available: true,
      basis: "windows-proxy-accepted",
      socketSnapshot: {
        available: true,
        sockets: [{ sourcePort: 10090, remotePort: input.socket.localPort, state: "Established" }],
      },
    });
    expect(evidence?.proxyOwner).not.toHaveProperty("listeners");
    expect(
      verifyProxyTunnelEvidence({
        context: input,
        evidence: evidence!,
        controller: { host: "127.0.0.1", port: 9790 },
        proxy: input.proxy,
        generation: 1,
        revision: "revision-1",
        nowMono: performance.now(),
        readStartedAtMono,
      }),
    ).not.toBeNull();
  });

  it("does not query an accepted socket without a verified controller owner", async () => {
    const createAcceptedSocketReader = vi.fn((scope: WindowsTcpSocketScope) => ({
      read: vi.fn(async () => acceptedSnapshot(scope)),
    }));
    const f = fixture({}, { proxyOwner: undefined, createAcceptedSocketReader });
    f.controllerOwner.read.mockResolvedValue({ available: false, ...stamp(), reason: "READ_UNAVAILABLE" });
    expect(await run(f.reader)).toBeNull();
    expect(createAcceptedSocketReader).not.toHaveBeenCalled();
  });

  it("does not use a dual-stack wildcard listener in place of an actual accepted IPv4 connection", async () => {
    const f = fixture(
      {},
      {
        proxyOwner: undefined,
        createAcceptedSocketReader: (scope) => ({
          read: async () => {
            const value = acceptedSnapshot(scope);
            if (!value.available) return value;
            return {
              ...value,
              sockets: [
                {
                  ...value.sockets[0],
                  sourceAddress: "::",
                  remoteAddress: "::",
                  remotePort: 0,
                  state: "Listen",
                },
              ],
            };
          },
        }),
      },
    );
    expect(await run(f.reader)).toBeNull();
  });

  it("keeps the uncancellable native TCP read in whenIdle after public abort", async () => {
    const held = deferred<WindowsTcpSocketSnapshot>();
    let capturedScope: WindowsTcpSocketScope | null = null;
    const f = fixture(
      {},
      {
        proxyOwner: undefined,
        createAcceptedSocketReader: (scope) => {
          capturedScope = scope;
          return { read: () => held.promise };
        },
      },
    );
    const abort = new AbortController(),
      pending = f.reader.readTunnel(context(), abort.signal);
    await flush();
    expect(capturedScope).not.toBeNull();
    abort.abort();
    expect(await pending).toBeNull();
    let drained = false;
    const idle = f.reader.whenIdle().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    expect(await run(f.reader)).toBeNull();
    held.resolve(acceptedSnapshot(capturedScope!));
    await idle;
    expect(drained).toBe(true);
  });
});

describe("ProxyTunnelReader scoped facts", () => {
  it("feeds real reader output into the shared fixed anonymous verifier", async () => {
    const f = fixture();
    const input: AnonymousProxyTunnelContext = {
      ...context(),
      platformId: "anonymous-egress",
      target: { host: "www.cloudflare.com", port: 443 },
    };
    f.json.read.mockImplementation(async (endpoint) => {
      const connections = rawConnections();
      connections.connections[0].metadata.host = "www.cloudflare.com";
      return { ...stamp(), value: endpoint === "/connections" ? connections : rawProxies() };
    });
    const readStartedAtMono = performance.now();
    const evidence = await f.reader.readAnonymousTunnel(input, new AbortController().signal);
    await f.reader.whenIdle();
    expect(evidence).not.toBeNull();
    const verified = verifyProxyTunnelEvidence({
      context: input,
      evidence: evidence!,
      controller: { host: "127.0.0.1", port: 9790 },
      proxy: input.proxy,
      generation: 1,
      revision: "revision-1",
      readStartedAtMono,
      nowMono: performance.now(),
    });
    expect(verified).toMatchObject({
      contextId: input.id,
      target: input.target,
      controllerFingerprint: hash("current-config"),
    });
    expect(verified!.evidenceExpiresAtMono).toBeLessThanOrEqual(evidence!.startedAtMono + 15000);
    expect(JSON.stringify(evidence)).not.toContain("unrelated-secret");
  });

  it.each(["anonymous-through-business", "business-through-anonymous", "other-anonymous-host"])(
    "keeps reader entry points separate: %s",
    async (kind) => {
      const f = fixture();
      const input = {
        ...context(),
        platformId: "anonymous-egress",
        target: { host: "www.cloudflare.com", port: 443 },
      } as AnonymousProxyTunnelContext;
      let result;
      if (kind === "anonymous-through-business") {
        result = await f.reader.readTunnel(
          input as unknown as ProxyTunnelContext,
          new AbortController().signal,
        );
      } else {
        if (kind === "business-through-anonymous")
          Object.assign(input, {
            platformId: "youtube",
            target: { host: "oauth2.googleapis.com", port: 443 },
          });
        if (kind === "other-anonymous-host") Object.assign(input.target, { host: "api6.ipify.org" });
        result = await f.reader.readAnonymousTunnel(input, new AbortController().signal);
      }
      await f.reader.whenIdle();
      expect(result).toBeNull();
      expect(f.controller.read).not.toHaveBeenCalled();
      expect(f.json.read).not.toHaveBeenCalled();
    },
  );

  it("returns current before/after facts and original chain policy, dropping unrelated connections and policies", async () => {
    const f = fixture(),
      input = context();
    const result = await run(f.reader, input);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ contextId: input.id, generation: 1, revision: "revision-1" });
    expect(result!.connections.value).toEqual({
      connections: [
        {
          id: "owned-id",
          chains: ["node", "group"],
          start: undefined,
          metadata: rawConnections().connections[0].metadata,
        },
      ],
    });
    expect(result!.proxies.value).toEqual({
      proxies: { node: rawProxies().proxies.node, group: rawProxies().proxies.group },
    });
    expect(JSON.stringify(result)).not.toMatch(/unrelated|eligible|country|grant|upload/);
    expect(result!.connections.startedAtMono).toBeGreaterThanOrEqual(
      result!.controllerBefore.completedAtMono,
    );
    expect(result!.controllerAfter.startedAtMono).toBeGreaterThanOrEqual(result!.proxies.completedAtMono);
    await f.reader.whenIdle();
    expect(f.controller.read).toHaveBeenCalledTimes(2);
  });
  it("snapshots caller context before asynchronous callbacks can mutate it", async () => {
    const f = fixture(),
      input = context();
    const pending = run(f.reader, input);
    Object.assign(input.target, { host: "attacker.example" });
    Object.assign(input.socket, { localPort: 60000 });
    expect((await pending)?.connections.value).toMatchObject({ connections: [{ id: "owned-id" }] });
  });
  it("does not hide a conflicting same-source tuple by filtering its host or inbound endpoint", async () => {
    const f = fixture(),
      raw = rawConnections();
    raw.connections.push({
      ...raw.connections[0],
      id: "conflicting-id",
      metadata: { ...raw.connections[0].metadata, host: "attacker.example", inboundPort: "9999" },
    });
    f.json.read.mockImplementation(async (endpoint) => ({
      ...stamp(),
      value: endpoint === "/connections" ? raw : rawProxies(),
    }));
    const result = await run(f.reader);
    expect(result!.connections.value).toMatchObject({
      connections: [
        { id: "owned-id" },
        { id: "conflicting-id", metadata: { host: "attacker.example", inboundPort: "9999" } },
      ],
    });
  });
  it.each([
    "https://127.0.0.1:9790",
    "http://localhost:9790",
    "http://127.1:9790",
    "http://user@127.0.0.1:9790",
    "http://127.0.0.1:9790/configs",
    "http://127.0.0.1:9790?secret=x",
    "http://127.0.0.1:65536",
  ])("rejects unsafe controller endpoint %s without reads", (controllerUrl) => {
    expect(() => fixture({ controllerUrl })).toThrow("INVALID_TUNNEL_READER_OPTIONS");
  });
  it.each(["localhost", "192.168.1.1", "127.1"])("rejects nonliteral proxy %s", (host) => {
    expect(() => fixture({ proxy: { host, port: 10090 } })).toThrow("INVALID_TUNNEL_READER_OPTIONS");
  });
  it.each([
    { target: { host: "bilibili.com", port: 443 } },
    { target: { host: "oauth2.googleapis.com", port: 444 } },
    { proxy: { host: "127.0.0.1", port: 7890 } },
    { socket: { localAddress: "127.0.0.1", localPort: 0, remoteAddress: "127.0.0.1", remotePort: 10090 } },
    {
      socket: { localAddress: "127.0.0.1", localPort: 50000, remoteAddress: "192.0.2.1", remotePort: 10090 },
    },
    { connectedAtMono: Number.POSITIVE_INFINITY },
  ])("rejects invalid or out-of-scope context before I/O %j", async (changes) => {
    const f = fixture();
    expect(await run(f.reader, { ...context(), ...changes } as ProxyTunnelContext)).toBeNull();
    expect(f.controller.read).not.toHaveBeenCalled();
  });
  it.each(["fingerprint", "mode", "mixedPort"] as const)("rejects controller %s changes", async (field) => {
    const f = fixture();
    f.controller.read
      .mockImplementationOnce(async () => config())
      .mockImplementationOnce(async () => ({
        ...config(),
        [field]: field === "fingerprint" ? hash("changed") : field === "mode" ? "direct" : 7890,
      }));
    expect(await run(f.reader)).toBeNull();
  });
  it.each(["pid", "createdAtTicks", "executablePathIdentity", "scopeHash", "listener", "time"])(
    "rejects mismatched kernel owner %s",
    async (field) => {
      const f = fixture();
      f.proxyOwner.read.mockImplementation(async () => {
        const result = owner(10090);
        if (!result.available) throw new Error("fixture");
        if (field === "pid") result.owner.pid++;
        if (field === "createdAtTicks") result.owner.createdAtTicks = "134332323232323233";
        if (field === "executablePathIdentity") result.owner.executablePathIdentity = null;
        if (field === "scopeHash") result.scopeHash = hash("wrong-endpoint");
        if (field === "listener") result.listeners = [];
        if (field === "time") result.startedAtMono = -1;
        return result;
      });
      expect(await run(f.reader)).toBeNull();
    },
  );
  it.each(["missing-source", "too-many-owned", "missing-policy", "oversize-policy", "bad-window"])(
    "rejects incomplete or unbounded facts %s",
    async (kind) => {
      const f = fixture();
      f.json.read.mockImplementation(async (endpoint) => {
        const rows = rawConnections(),
          policies = rawProxies();
        if (kind === "missing-source") rows.connections.splice(0, 1);
        if (kind === "too-many-owned")
          rows.connections = Array.from({ length: 9 }, () => rows.connections[0]);
        if (kind === "missing-policy") Reflect.deleteProperty(policies.proxies, "node");
        if (kind === "oversize-policy") policies.proxies.node.id = "x".repeat(65_537);
        return {
          ...stamp(),
          ...(kind === "bad-window" ? { startedAtMono: -1 } : {}),
          value: endpoint === "/connections" ? rows : policies,
        };
      });
      expect(await run(f.reader)).toBeNull();
    },
  );
});

describe("ProxyTunnelReader cancellation and real work ownership", () => {
  function delayedDomestic() {
    const f = fixture({ targetScope: "domestic" });
    const input = context();
    input.platformId = "weixin_channels";
    input.target = { host: "channels.weixin.qq.com", port: 443 };
    let visible = false;
    f.json.read.mockImplementation(async (endpoint) => {
      const rows = rawConnections();
      rows.connections[0].metadata.host = input.target.host;
      if (!visible) rows.connections.splice(0, 1);
      return { ...stamp(), value: endpoint === "/connections" ? rows : rawProxies() };
    });
    return { ...f, input, publish: () => { visible = true; } };
  }
  it("waits for a domestic CONNECT row published after socket acknowledgement, retaining real sample times", async () => {
    const f = delayedDomestic();
    const pending = run(f.reader, f.input);
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.publish();
    const result = await pending;
    expect(result?.connections.value).toMatchObject({ connections: [{ metadata: { host: f.input.target.host } }] });
    expect(f.json.read.mock.calls.filter(([path]) => path === "/connections").length).toBeGreaterThanOrEqual(2);
    expect(result!.controllerBefore.completedAtMono).toBeLessThanOrEqual(result!.connections.startedAtMono);
    expect(result!.controllerAfter.startedAtMono).toBeGreaterThanOrEqual(result!.connections.completedAtMono);
  });
  it.each(["abort", "configuration", "timeout"])("stops waiting for a missing domestic row on %s", async (kind) => {
    const f = delayedDomestic();
    const abort = new AbortController();
    const pending = f.reader.readTunnel(f.input, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (kind === "abort") abort.abort();
    if (kind === "configuration") f.setVersion({ generation: 2, revision: "changed" });
    expect(await pending).toBeNull();
    await f.reader.whenIdle();
    const calls = f.json.read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(f.json.read).toHaveBeenCalledTimes(calls);
    expect(f.json.read.mock.calls.filter(([path]) => path === "/connections").length).toBeLessThanOrEqual(11);
  });
  it("does not retry a malformed domestic connection list", async () => {
    const f = delayedDomestic();
    f.json.read.mockResolvedValue({ ...stamp(), value: { connections: null } } as never);
    expect(await run(f.reader, f.input)).toBeNull();
    expect(f.json.read.mock.calls.filter(([path]) => path === "/connections")).toHaveLength(1);
  });
  it("keeps a cancelled public read busy until both real work and dependency drain finish", async () => {
    const f = fixture(),
      work = deferred<ClashReadResult>(),
      drain = deferred<void>(),
      entered = deferred<void>();
    f.controller.read.mockImplementationOnce(() => {
      entered.resolve();
      return work.promise;
    });
    f.controller.whenIdle.mockImplementationOnce(() => drain.promise);
    const abort = new AbortController(),
      pending = f.reader.readTunnel(context(), abort.signal);
    await entered.promise;
    abort.abort();
    expect(await pending).toBeNull();
    let idle = false;
    const waiting = f.reader.whenIdle().then(() => {
      idle = true;
    });
    expect(await run(f.reader)).toBeNull();
    await flush();
    expect(idle).toBe(false);
    work.resolve(config());
    await flush();
    expect(idle).toBe(false);
    expect(f.json.read).not.toHaveBeenCalled();
    drain.resolve();
    await waiting;
    expect(await run(f.reader)).not.toBeNull();
  });
  it("reserves the slot before reentrant version providers and refuses their invalidation", async () => {
    const f = fixture();
    let nested: Promise<unknown> | undefined;
    f.readVersion.mockImplementationOnce(() => {
      nested = run(f.reader);
      f.reader.invalidate();
      return { generation: 1, revision: "revision-1" };
    });
    expect(await run(f.reader)).toBeNull();
    expect(await nested).toBeNull();
    expect(f.controller.read).not.toHaveBeenCalled();
  });
  it.each([null, { generation: 2, revision: "revision-1" }, { generation: 1, revision: "revision-2" }])(
    "does not return late evidence after revision becomes %j",
    async (version) => {
      const f = fixture();
      f.json.read.mockImplementation(async (endpoint) => {
        f.setVersion(version);
        return { ...stamp(), value: endpoint === "/connections" ? rawConnections() : rawProxies() };
      });
      expect(await run(f.reader)).toBeNull();
    },
  );
  it("times out without freeing an unresolved actual read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture({ timeoutMs: 30 }),
      work = deferred<ClashReadResult>(),
      entered = deferred<void>();
    f.controller.read.mockImplementationOnce(() => {
      entered.resolve();
      return work.promise;
    });
    const pending = run(f.reader);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toBeNull();
    expect(await run(f.reader)).toBeNull();
    work.resolve(config());
    await f.reader.whenIdle();
    expect(f.controller.read).toHaveBeenCalledTimes(1);
  });
  it("disposal cancels observers and waits for actual work before releasing the instance", async () => {
    const f = fixture(),
      work = deferred<ClashReadResult>(),
      entered = deferred<void>();
    f.controller.read.mockImplementationOnce(() => {
      entered.resolve();
      return work.promise;
    });
    const pending = run(f.reader);
    await entered.promise;
    let disposed = false;
    const disposal = f.reader.dispose().then(() => {
      disposed = true;
    });
    expect(await pending).toBeNull();
    await flush();
    expect(disposed).toBe(false);
    work.resolve(config());
    await disposal;
    expect(f.controllerOwner.dispose).toHaveBeenCalled();
    expect(f.proxyOwner.dispose).toHaveBeenCalled();
    expect(await run(f.reader)).toBeNull();
  });
  it("a synchronous cleanup error cannot release an uncompleted sibling drain or reopen this reader", async () => {
    const f = fixture(),
      drain = deferred<void>();
    f.controller.whenIdle.mockImplementation(() => {
      throw new Error("SECRET-DRAIN-ERROR");
    });
    f.json.whenIdle.mockImplementation(() => drain.promise);
    expect(await run(f.reader)).not.toBeNull();
    let settled = false;
    const waiting = f.reader.whenIdle().catch((error: Error) => {
      settled = true;
      return error.message;
    });
    await flush();
    expect(settled).toBe(false);
    expect(await run(f.reader)).toBeNull();
    drain.resolve();
    expect(await waiting).toBe("TUNNEL_READER_CLEANUP_FAILED");
    await expect(f.reader.dispose()).rejects.toThrow("TUNNEL_READER_CLEANUP_FAILED");
    expect(await run(f.reader)).toBeNull();
  });
  it("waits for started siblings when a provider throws synchronously", async () => {
    const f = fixture(),
      held = deferred<WindowsControllerOwnerSnapshot>(),
      entered = deferred<void>();
    f.controllerOwner.read.mockImplementationOnce(() => {
      entered.resolve();
      return held.promise;
    });
    f.proxyOwner.read.mockImplementationOnce(() => {
      throw new Error("PRIVATE-PROVIDER-ERROR");
    });
    const pending = run(f.reader);
    await entered.promise;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    held.resolve(owner(9790));
    expect(await pending).toBeNull();
  });
});

async function httpFixture(handler?: (path: string, response: ServerResponse) => boolean) {
  const calls: {
    path: string;
    authorization: string | undefined;
    cookie: string | undefined;
    method: string | undefined;
  }[] = [];
  const responses: Record<string, unknown> = {
    "/configs": {
      mode: "rule",
      "mixed-port": 10090,
      tun: { enable: true },
      secret: "never-return-config-secret",
    },
    "/version": { version: "synthetic-kernel" },
    "/rules": { rules: [{ type: "Match", payload: "", proxy: "group" }] },
    "/proxies/DIRECT": { type: "Direct", interface: "", "dialer-proxy": "" },
    "/connections": rawConnections(),
    "/proxies": rawProxies(),
  };
  const server = createServer((req, res) => {
    calls.push({
      path: req.url!,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      method: req.method,
    });
    if (handler?.(req.url!, res)) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responses[req.url!]));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const makeOwner = (p: number) => ({
    read: vi.fn(async () => owner(p)),
    whenIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
  });
  const dependencies: ProxyTunnelReaderDependencies = {
    controllerOwner: makeOwner(port),
    proxyOwner: makeOwner(10090),
  };
  const options: ProxyTunnelReaderOptions = {
    controllerUrl: `http://127.0.0.1:${port}`,
    proxy: { host: "127.0.0.1", port: 10090 },
    getSecret: () => "local-test-secret",
    readVersion: () => ({ generation: 1, revision: "revision-1" }),
  };
  return { calls, options, dependencies, server };
}
describe("ProxyTunnelReader default loopback HTTP", () => {
  it("uses the real ClashReader and fixed raw GET endpoints with main-only controller authentication", async () => {
    const f = await httpFixture();
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:1");
    const reader = new ProxyTunnelReader(f.options, f.dependencies);
    disposals.push(() => reader.dispose());
    const result = await run(reader);
    expect(result).not.toBeNull();
    await reader.whenIdle();
    expect(f.calls).toHaveLength(10);
    expect(f.calls.filter((call) => call.path === "/connections")).toHaveLength(1);
    expect(f.calls.filter((call) => call.path === "/proxies")).toHaveLength(1);
    expect(
      f.calls.every(
        (call) =>
          call.method === "GET" &&
          call.authorization === "Bearer local-test-secret" &&
          call.cookie === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/local-test-secret|never-return-config-secret/);
  });
  it.each(["redirect", "unauthorized", "oversize", "encoding", "malformed-json", "invalid-utf8"])(
    "refuses raw %s response without following or returning its contents",
    async (kind) => {
      const f = await httpFixture((path, res) => {
        if (path !== "/connections") return false;
        if (kind === "redirect") res.writeHead(302, { location: "http://127.0.0.1:1/SECRET" }).end();
        if (kind === "unauthorized") res.writeHead(401).end("PRIVATE-RESPONSE");
        if (kind === "oversize") res.end("x".repeat(2049));
        if (kind === "encoding") res.writeHead(200, { "content-encoding": "gzip" }).end("PRIVATE");
        if (kind === "malformed-json") res.end("PRIVATE-INVALID-JSON");
        if (kind === "invalid-utf8") res.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
        return true;
      });
      const reader = new ProxyTunnelReader({ ...f.options, maxResponseBytes: 2048 }, f.dependencies);
      disposals.push(() => reader.dispose());
      expect(await run(reader)).toBeNull();
      await reader.whenIdle();
      expect(f.calls).toHaveLength(6);
      expect(f.calls.some((call) => call.path.includes("SECRET"))).toBe(false);
    },
  );
  it("waits for the raw GET native close after public evidence returns", async () => {
    const f = await httpFixture(),
      held: (() => void)[] = [],
      received = deferred<void>(),
      emit = ClientRequest.prototype.emit;
    const spy = vi.spyOn(ClientRequest.prototype, "emit").mockImplementation(function (
      this: ClientRequest,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "close" && ["/connections", "/proxies"].includes(this.path)) {
        held.push(() => emit.call(this, event, ...args));
        if (held.length === 2) received.resolve();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const reader = new ProxyTunnelReader(f.options, f.dependencies);
    disposals.push(() => reader.dispose());
    try {
      expect(await run(reader)).not.toBeNull();
      await received.promise;
      let idle = false;
      const waiting = reader.whenIdle().then(() => {
        idle = true;
      });
      await flush();
      expect(idle).toBe(false);
      expect(await run(reader)).toBeNull();
      held.splice(0).forEach((release) => release());
      await waiting;
    } finally {
      spy.mockRestore();
      held.splice(0).forEach((release) => release());
    }
  });
  it("reentrant secret invalidation prevents the raw reader from constructing an HTTP request", async () => {
    const f = await httpFixture();
    let count = 0;
    const reader = new ProxyTunnelReader(
      {
        ...f.options,
        getSecret: () => {
          if (++count === 2) reader.invalidate();
          return "PRIVATE";
        },
      },
      f.dependencies,
    );
    disposals.push(() => reader.dispose());
    expect(await run(reader)).toBeNull();
    await reader.whenIdle();
    expect(f.calls).toHaveLength(4);
    expect(f.calls.some((call) => call.path === "/connections" || call.path === "/proxies")).toBe(false);
  });
});
