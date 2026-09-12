import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExclusiveAccessSnapshot } from "@shared/network";
import { CN_PLATFORM_IDS, PLATFORMS } from "@shared/platforms";
import type { ProxyTunnelContext } from "@main/api/proxy-transport";
import type { ProxyTunnelReadResult } from "@main/api/proxy-tunnel-evidence";
import type { GlobalWebTunnel, GlobalWebTunnelInput, GlobalWebTunnelOptions } from "./global-web-tunnel";
import { DomesticRuleTransport, type DomesticRuleTransportOptions } from "./domestic-rule-transport";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const kernel = { pid: 1234, createdAtTicks: "134332323232323232", executablePathIdentity: hash("kernel") };
const fingerprint = hash("controller");
type Resources = ReturnType<NonNullable<DomesticRuleTransportOptions["createResources"]>>;
type Observation = NonNullable<Awaited<ReturnType<Resources["observe"]>>>;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function owner(port: number) {
  const now = performance.now();
  return {
    available: true as const,
    basis: "windows-controller-listener" as const,
    startedAtMono: now,
    completedAtMono: now,
    scopeHash: hash({ address: "127.0.0.1", port }),
    owner: { ...kernel },
    kernelEpoch: hash(`kernel-${port}`),
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4" as const, port, coverage: "exact" as const }],
  };
}
function observation(): Observation {
  const now = performance.now();
  const config = {
    mode: "rule",
    tun: true,
    mixedPort: 10090,
    version: "test",
    rules: [],
    fingerprint,
    startedAtMono: now,
    completedAtMono: now,
  };
  return {
    startedAtMono: now,
    completedAtMono: now,
    before: { ...config },
    after: { ...config },
    owner: owner(9790),
  };
}
function context(id = "domestic-own-socket"): ProxyTunnelContext {
  return {
    id,
    platformId: "xiaohongshu",
    target: { host: "fe-static.xhscdn.com", port: 443 },
    proxy: { host: "127.0.0.1", port: 10090 },
    socket: { localAddress: "127.0.0.1", localPort: 55000, remoteAddress: "127.0.0.1", remotePort: 10090 },
    connectedAtMono: performance.now(),
  };
}
function evidence(
  input: ProxyTunnelContext,
  version: { generation: number; revision: string },
): ProxyTunnelReadResult {
  const now = performance.now();
  const config = { fingerprint, mixedPort: 10090, mode: "rule", startedAtMono: now, completedAtMono: now };
  return {
    contextId: input.id,
    ...version,
    startedAtMono: now,
    completedAtMono: now,
    controllerBefore: { ...config },
    controllerAfter: { ...config },
    controllerOwner: owner(9790),
    proxyOwner: owner(10090),
    connections: {
      startedAtMono: now,
      completedAtMono: now,
      value: {
        connections: [
          {
            id: `flow-${input.id}`,
            chains: ["DIRECT"],
            metadata: {
              host: input.target.host,
              sniffHost: "",
              sourceIP: input.socket.localAddress,
              sourcePort: String(input.socket.localPort),
              inboundIP: input.proxy.host,
              inboundPort: String(input.proxy.port),
              destinationPort: "443",
              type: "HTTPS",
              network: "tcp",
              remoteDestination: "110.43.50.20",
              processPath: process.execPath,
            },
          },
        ],
      },
    },
    proxies: {
      startedAtMono: now,
      completedAtMono: now,
      value: {
        proxies: { DIRECT: { type: "Direct", name: "DIRECT", "dialer-proxy": "" } },
      },
    },
  };
}
function fixture(open?: (input: GlobalWebTunnelInput) => Promise<GlobalWebTunnel>) {
  const raw: ExclusiveAccessSnapshot = {
    state: "overseas",
    proxy: "on",
    reason: "PROXY_ENABLED",
    generation: 1,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15000).toISOString(),
  };
  const network = { available: true, hash: hash("network") };
  const config = {
    controllerUrl: "http://127.0.0.1:9790",
    proxyPort: 10090,
    credentialRevision: hash("credential"),
  };
  let resourceContext!: Parameters<NonNullable<DomesticRuleTransportOptions["createResources"]>>[0];
  const transports: {
    options: GlobalWebTunnelOptions;
    transport: { open: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  }[] = [];
  const resources = {
    observe: vi.fn<Resources["observe"]>(async () => observation()),
    readTunnel: vi.fn<Resources["readTunnel"]>(async (input) =>
      evidence(input, resourceContext.readVersion()!),
    ),
    whenReaderIdle: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const createResources = vi.fn((input: typeof resourceContext) => {
    resourceContext = input;
    return resources;
  });
  const source = new DomesticRuleTransport({
    configuration: () => config,
    readSwitch: () => raw,
    readNetwork: () => network,
    getSecret: () => null,
    createResources,
    createTransport: (input) => {
      const transport = {
        open: vi.fn(
          open ??
            (async () => {
              throw Error("test transport");
            }),
        ),
        dispose: vi.fn(async () => {}),
      };
      transports.push({ options: input, transport });
      return transport;
    },
  });
  cleanup.push(() => source.dispose());
  const xhsPool = () => transports[CN_PLATFORM_IDS.indexOf("xiaohongshu")]!;
  return {
    source,
    raw,
    network,
    config,
    resources,
    createResources,
    transports,
    get transport() {
      return xhsPool().transport;
    },
    proof: () => xhsPool().options,
    ready: () => source.acquireEligibility("xiaohongshu", new AbortController().signal),
  };
}

describe("domestic rule transport", () => {
  it("records display route only after a successful account CONNECT, without reusing diagnostic or failed opens", async () => {
    const tunnel: GlobalWebTunnel = { stream: new PassThrough(), closed: Promise.resolve(), close: vi.fn() };
    let complete!: (tunnel: GlobalWebTunnel) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await f.ready();
    const input: GlobalWebTunnelInput = {
      platformId: "xiaohongshu",
      host: "fe-static.xhscdn.com",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    const diagnostic = f.source.openWebTunnel(input);
    await settle();
    complete(tunnel);
    await diagnostic;
    expect(f.source.readAccountRoute("account-a")).toBeNull();
    const opening = f.source.openAccountTunnel("account-a", input);
    await settle();
    expect(f.source.readAccountRoute("account-a")).toBeNull();
    await vi.advanceTimersByTimeAsync(123);
    complete(tunnel);
    await expect(opening).resolves.toBe(tunnel);
    const expected = { generation: f.source.readAdmission().generation, checkedAtMono: 123 };
    const observed = f.source.readAccountRoute("account-a")!;
    expect(observed).toEqual(expected);
    observed.checkedAtMono = -1;
    expect(f.source.readAccountRoute("account-a")).toEqual(expected);
    expect(f.source.readAccountRoute("other-account")).toBeNull();
    f.transports[6].transport.open.mockRejectedValue(Error("open failed"));
    await vi.advanceTimersByTimeAsync(100);
    await expect(f.source.openAccountTunnel("account-a", input)).rejects.toThrow("open failed");
    expect(f.source.readAccountRoute("account-a")).toEqual(expected);
    await expect(
      f.source.openAccountTunnel("account-a", {
        ...input,
        platformId: "douyin",
        host: "www.douyin.com",
      }),
    ).rejects.toThrow("DOMESTIC_RULE_UNAVAILABLE");
    expect(f.source.readAccountRoute("account-a")).toEqual(expected);
  });

  it("clears account route association on release, replacement and network generation changes", async () => {
    const tunnel: GlobalWebTunnel = { stream: new PassThrough(), closed: Promise.resolve(), close: vi.fn() };
    const f = fixture(async () => tunnel);
    await f.ready();
    const input: GlobalWebTunnelInput = {
      platformId: "xiaohongshu",
      host: "fe-static.xhscdn.com",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    await f.source.openAccountTunnel("account-a", input);
    const firstGeneration = f.source.readAccountRoute("account-a")!.generation;
    f.source.releaseAccount("account-a");
    expect(f.source.readAccountRoute("account-a")).toBeNull();
    await f.source.whenIdle();
    await f.source.openAccountTunnel("account-a", input);
    expect(f.source.readAccountRoute("account-a")?.generation).toBe(firstGeneration);
    f.raw.generation++;
    expect(f.source.readAccountRoute("account-a")).toBeNull();
    f.source.sync();
    await f.source.whenIdle();
    await f.ready();
    expect(f.source.readAccountRoute("account-a")).toBeNull();
    await f.source.openAccountTunnel("account-a", input);
    expect(f.source.readAccountRoute("account-a")!.generation).toBeGreaterThan(firstGeneration);
    f.source.invalidate();
    expect(f.source.readAccountRoute("account-a")).toBeNull();
  });

  it.each(["release", "cancel", "invalidate"] as const)(
    "does not record a late open after %s",
    async (change) => {
      const tunnel: GlobalWebTunnel = {
        stream: new PassThrough(),
        closed: Promise.resolve(),
        close: vi.fn(),
      };
      let complete!: (tunnel: GlobalWebTunnel) => void;
      const f = fixture(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      await f.ready();
      const abort = new AbortController();
      const opening = f.source.openAccountTunnel("account-a", {
        platformId: "xiaohongshu",
        host: "fe-static.xhscdn.com",
        signal: abort.signal,
        assertCurrent: () => {},
      });
      await settle();
      if (change === "release") f.source.releaseAccount("account-a");
      else if (change === "cancel") abort.abort();
      else f.source.invalidate();
      complete(tunnel);
      await opening;
      expect(f.source.readAccountRoute("account-a")).toBeNull();
    },
  );

  it("does not wait for another account's readers when CONNECT closes before authorization", async () => {
    const f = fixture();
    await f.ready();
    await f.proof().whenAuthorizerIdle(undefined);
    expect(f.resources.whenReaderIdle).not.toHaveBeenCalled();
    const input = context();
    let release!: () => void;
    f.resources.whenReaderIdle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let completed = false;
    const waiting = f
      .proof()
      .whenAuthorizerIdle(input)
      .then(() => {
        completed = true;
      });
    await settle();
    expect(f.resources.whenReaderIdle).toHaveBeenCalledWith(input);
    expect(completed).toBe(false);
    release();
    await waiting;
    expect(completed).toBe(true);
  });
  it("isolates same-platform account pools and releases one without revoking another or the monitor", async () => {
    const f = fixture(),
      eligibility = (await f.ready())!;
    const input = {
      platformId: "xiaohongshu" as const,
      host: "fe-static.xhscdn.com",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    await expect(f.source.openAccountTunnel("account-a", input)).rejects.toThrow("test transport");
    await expect(f.source.openAccountTunnel("account-b", input)).rejects.toThrow("test transport");
    expect(f.source.readAccountRoute("account-a")).toBeNull();
    expect(f.source.readAccountRoute("account-b")).toBeNull();
    expect(f.transports).toHaveLength(8);
    const [a, b] = f.transports.slice(6);
    expect(a.transport).not.toBe(b.transport);
    expect(a.options.concurrency).toBe(32);
    expect(b.options.concurrency).toBe(32);
    const connection = context(),
      signal = new AbortController().signal;
    const leaseA = (await a.options.authorize(connection, signal))!;
    const leaseB = (await b.options.authorize(context("another-socket"), new AbortController().signal))!;
    expect(await b.options.renew!(connection, leaseA, signal)).toBeNull();
    const generation = f.source.readAdmission().generation;
    f.source.releaseAccount("account-a");
    expect(leaseA.signal.aborted).toBe(true);
    expect(leaseB.isCurrent()).toBe(true);
    expect(eligibility.isCurrent()).toBe(true);
    expect(f.source.readAdmission().generation).toBe(generation);
    await f.source.whenIdle();
    expect(a.transport.dispose).toHaveBeenCalledTimes(1);
    expect(b.transport.dispose).not.toHaveBeenCalled();
    expect(f.resources.dispose).not.toHaveBeenCalled();
    expect(f.transports.slice(0, 6).every((pool) => pool.transport.open.mock.calls.length === 0)).toBe(true);
  });

  it("drains each account's old pool before replacement and bounds live plus retiring pools to 64", async () => {
    const f = fixture();
    await f.ready();
    const input = {
      platformId: "xiaohongshu" as const,
      host: "fe-static.xhscdn.com",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    for (let i = 0; i < 64; i++)
      await expect(f.source.openAccountTunnel(`account-${i}`, input)).rejects.toThrow("test transport");
    expect(f.transports).toHaveLength(70);
    await expect(f.source.openAccountTunnel("overflow", input)).rejects.toThrow("DOMESTIC_RULE_UNAVAILABLE");
    await expect(
      f.source.openAccountTunnel("account-0", { ...input, platformId: "douyin", host: "www.douyin.com" }),
    ).rejects.toThrow("DOMESTIC_RULE_UNAVAILABLE");
    let drained!: () => void;
    f.transports[6].transport.dispose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drained = resolve;
        }),
    );
    f.source.releaseAccount("account-0");
    const replacement = f.source.openAccountTunnel("account-0", input);
    await settle();
    expect(f.transports).toHaveLength(70);
    await expect(f.source.openAccountTunnel("overflow", input)).rejects.toThrow("DOMESTIC_RULE_UNAVAILABLE");
    drained();
    await expect(replacement).rejects.toThrow("test transport");
    for (let i = 0; i < 10; i++) {
      f.source.releaseAccount("account-0");
      await f.source.whenIdle();
      await expect(f.source.openAccountTunnel("account-0", input)).rejects.toThrow("test transport");
      expect(f.transports.filter((pool) => pool.transport.dispose.mock.calls.length === 0)).toHaveLength(70);
    }
    f.source.invalidate();
    await f.source.whenIdle();
    expect(f.transports.every((pool) => pool.transport.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("admits from fresh rule/controller/kernel/OS observations without inventing a country claim", async () => {
    const f = fixture();
    expect(f.source.readAdmission()).toEqual({
      ready: false,
      generation: 1,
      checkedAtMono: null,
      expiresAtMono: null,
    });
    const eligibility = await f.ready();
    expect(eligibility?.isCurrent()).toBe(true);
    expect(f.source.readAdmission()).toEqual({
      ready: true,
      generation: 1,
      checkedAtMono: 0,
      expiresAtMono: 15000,
    });
    expect(f.source).not.toHaveProperty("readAuthority");
    expect(await f.source.acquireEligibility("youtube", new AbortController().signal)).toBeNull();
    expect(f.resources.readTunnel).not.toHaveBeenCalled();
  });

  it("keeps the same verified TCP connection beyond 60 seconds using actual monitor renewals", async () => {
    const f = fixture(),
      eligibility = (await f.ready())!;
    const input = context(),
      signal = new AbortController().signal;
    let lease = (await f.proof().authorize(input, signal))!;
    expect(lease?.isCurrent()).toBe(true);
    const generation = lease.generation;
    for (let i = 1; i <= 13; i++) {
      f.raw.checkedAt = new Date(Date.now() + i * 5000).toISOString();
      f.raw.expiresAt = new Date(Date.now() + i * 5000 + 15000).toISOString();
      await vi.advanceTimersByTimeAsync(5000);
      const next = (await f.proof().renew!(input, lease, signal))!;
      expect(next?.expiresAtMono).toBe(i * 5000 + 15000);
      expect(next?.generation).toBe(generation);
      lease.release();
      lease = next;
      expect(lease.isCurrent()).toBe(true);
      expect(eligibility.isCurrent()).toBe(true);
    }
    expect(f.resources.readTunnel).toHaveBeenCalledTimes(1);
    expect(f.resources.observe).toHaveBeenCalledTimes(14);
    expect(f.createResources).toHaveBeenCalledTimes(1);
    expect(f.transport.dispose).not.toHaveBeenCalled();
  });

  it("does not transfer verified permission to another connection or cancellation lifetime", async () => {
    const f = fixture();
    await f.ready();
    const input = context(),
      signal = new AbortController().signal;
    const lease = (await f.proof().authorize(input, signal))!;
    expect(lease).not.toBeNull();
    expect(await f.proof().renew!(structuredClone(input), lease, signal)).toBeNull();
    expect(await f.proof().renew!(input, lease, new AbortController().signal)).toBeNull();
    const forged = { ...lease };
    expect(await f.proof().renew!(input, forged, signal)).toBeNull();
    input.socket.localPort++;
    expect(lease.isCurrent()).toBe(false);
    expect(await f.proof().renew!(input, lease, signal)).toBeNull();
  });

  it("reserves a separate bounded 32-connection pool for every domestic platform", async () => {
    const f = fixture();
    await f.ready();
    expect(f.transports).toHaveLength(6);
    expect(f.transports.every((item) => item.options.concurrency === 32)).toBe(true);
    for (const platformId of CN_PLATFORM_IDS) {
      const host = new URL(PLATFORMS[platformId].routes.site ?? PLATFORMS[platformId].routes.home).hostname;
      const pools = f.transports.filter((item) => item.options.allowTarget(platformId, host));
      expect(pools).toHaveLength(1);
      await expect(
        f.source.openWebTunnel({
          platformId,
          host,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("test transport");
      expect(pools[0].transport.open).toHaveBeenCalledTimes(1);
    }
    expect(f.transports.every((item) => item.transport.open.mock.calls.length === 1)).toBe(true);
    f.source.invalidate();
    await settle();
    expect(f.transports.every((item) => item.transport.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("still verifies every new CONNECT and rejects a proxied resource despite prior DIRECT success", async () => {
    const f = fixture();
    await f.ready();
    expect(await f.proof().authorize(context(), new AbortController().signal)).not.toBeNull();
    const first = f.resources.readTunnel.getMockImplementation()!;
    f.resources.readTunnel.mockImplementation(async (...args) => {
      const sample = (await first(...args))!;
      (sample.connections.value as { connections: { chains: string[] }[] }).connections[0].chains = ["proxy"];
      return sample;
    });
    expect(await f.proof().authorize(context("second-socket"), new AbortController().signal)).toBeNull();
    expect(f.resources.readTunnel).toHaveBeenCalledTimes(2);
  });

  it.each(["wrong-tuple", "missing-owner", "wrong-owner", "foreign-fingerprint", "fake-ip", "wrong-port"])(
    "preserves the existing exact DIRECT evidence boundary: %s",
    async (change) => {
      const f = fixture();
      await f.ready();
      const first = f.resources.readTunnel.getMockImplementation()!;
      f.resources.readTunnel.mockImplementation(async (...args) => {
        const sample = (await first(...args))!;
        const row = (sample.connections.value as { connections: { metadata: Record<string, string> }[] })
          .connections[0];
        if (change === "wrong-tuple") row.metadata.sourcePort = "55001";
        if (change === "missing-owner") Object.assign(sample, { controllerOwner: { available: false } });
        if (change === "wrong-owner") {
          if (sample.controllerOwner.available && sample.proxyOwner.available) {
            sample.controllerOwner.owner.pid++;
            sample.proxyOwner.owner.pid++;
          }
        }
        if (change === "foreign-fingerprint")
          sample.controllerBefore.fingerprint = sample.controllerAfter.fingerprint = hash("other-config");
        if (change === "fake-ip") row.metadata.remoteDestination = "198.18.1.1";
        if (change === "wrong-port") row.metadata.destinationPort = "80";
        return sample;
      });
      expect(await f.proof().authorize(context(), new AbortController().signal)).toBeNull();
    },
  );

  it.each([
    "global-mode",
    "mixed-port",
    "stale",
    "missing-owner",
    "unreadable-path",
    "wrong-listener",
    "changed-during-read",
  ])("refuses invalid route admission: %s", async (change) => {
    const f = fixture();
    f.resources.observe.mockImplementation(async () => {
      const value = observation();
      if (change === "global-mode") value.before.mode = value.after.mode = "global";
      if (change === "mixed-port") value.after.mixedPort = 10091;
      if (change === "stale") value.before.startedAtMono = -1;
      if (change === "missing-owner") Object.assign(value, { owner: { available: false } });
      if (change === "unreadable-path" && value.owner.available)
        value.owner.owner.executablePathIdentity = null;
      if (change === "wrong-listener" && value.owner.available)
        Object.assign(value.owner, { scopeHash: hash("wrong-scope") });
      if (change === "changed-during-read") value.after.fingerprint = hash("other-config");
      return value;
    });
    expect(await f.ready()).toBeNull();
    expect(f.source.readAdmission().ready).toBe(false);
  });

  it.each(["network", "switch", "credential", "port", "controller-event"])(
    "immediately revokes admission and open connection leases on %s change",
    async (change) => {
      const f = fixture(),
        eligibility = (await f.ready())!;
      const lease = (await f.proof().authorize(context(), new AbortController().signal))!;
      if (change === "network") f.network.hash = hash("other-network");
      if (change === "switch") f.raw.proxy = "off";
      if (change === "credential") f.config.credentialRevision = hash("other-credential");
      if (change === "port") f.config.proxyPort++;
      if (change === "controller-event") f.source.observeController(hash("new-rules"));
      f.source.sync();
      expect(eligibility.signal.aborted).toBe(true);
      expect(lease.signal.aborted).toBe(true);
      expect(lease.isCurrent()).toBe(false);
      expect(f.source.readAdmission().ready).toBe(false);
    },
  );

  it("revokes when the same controller port is taken by a new kernel process", async () => {
    const f = fixture(),
      eligibility = (await f.ready())!;
    f.resources.observe.mockImplementation(async () => {
      const value = observation();
      if (value.owner.available) value.owner.owner.createdAtTicks = "134332323232323233";
      return value;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(eligibility.signal.aborted).toBe(true);
    expect(f.source.readAdmission().ready).toBe(false);
  });

  it("expires at the original 15-second deadline while a later observation is stalled", async () => {
    const f = fixture(),
      eligibility = (await f.ready())!;
    let finish!: (value: null) => void;
    f.resources.observe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(eligibility.signal.aborted).toBe(true);
    expect(f.source.readAdmission().ready).toBe(false);
    finish(null);
    await settle();
  });

  it("cannot extend a live lease by restamping a cached monitor observation", async () => {
    const f = fixture();
    await f.ready();
    const cached = observation(),
      input = context(),
      signal = new AbortController().signal;
    const lease = (await f.proof().authorize(input, signal))!;
    f.resources.observe.mockImplementation(async () => cached);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.signal.aborted).toBe(true);
    expect(await f.proof().renew!(input, lease, signal)).toBeNull();
  });

  it("waits for an actual new observation if renewal runs before the next scheduled poll", async () => {
    const f = fixture();
    await f.ready();
    const input = context(),
      signal = new AbortController().signal;
    const lease = (await f.proof().authorize(input, signal))!;
    await vi.advanceTimersByTimeAsync(1000);
    const next = (await f.proof().renew!(input, lease, signal))!;
    expect(next.expiresAtMono).toBe(16000);
    expect(f.resources.observe).toHaveBeenCalledTimes(2);
    expect(f.resources.readTunnel).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight evidence and refuses stale results after invalidation", async () => {
    const f = fixture();
    await f.ready();
    const first = f.resources.readTunnel.getMockImplementation()!;
    let finish!: (sample: ProxyTunnelReadResult | null) => void,
      sample: ProxyTunnelReadResult | null = null;
    let evidenceSignal!: AbortSignal;
    f.resources.readTunnel.mockImplementation(async (...args) => {
      evidenceSignal = args[1];
      sample = await first(...args);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const work = f.proof().authorize(context(), new AbortController().signal);
    await settle();
    f.source.invalidate();
    expect(evidenceSignal.aborted).toBe(true);
    finish(sample);
    expect(await work).toBeNull();
  });

  it("continues cleanup after a synchronous disposal failure and permanently fails closed", async () => {
    const f = fixture();
    await f.ready();
    f.transport.dispose.mockImplementation(() => {
      throw Error("cleanup-failed");
    });
    f.source.invalidate();
    await expect(f.source.whenIdle()).rejects.toThrow("DOMESTIC_RULE_UNAVAILABLE");
    expect(f.resources.dispose).toHaveBeenCalledTimes(1);
    expect(await f.ready()).toBeNull();
    cleanup.pop();
    await expect(f.source.dispose()).rejects.toThrow("DOMESTIC_RULE_UNAVAILABLE");
  });
});
