import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExclusiveNetworkSwitch, type ProxySwitchObservation } from "./exclusive-switch";
import type { PublicEgress } from "@shared/network";

const resources: ExclusiveNetworkSwitch[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.dispose();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function domestic(): PublicEgress {
  return {
    state: "reachable",
    country: "CN",
    asn: 4837,
    maskedIp: "1.2.*.*",
    checkedAt: new Date().toISOString(),
    routeVerified: false,
  };
}
function fixture() {
  let proxy: ProxySwitchObservation["state"] = "inactive";
  let network = { available: true, hash: "network-a" };
  const readProxy = vi.fn(async () => ({
    state: proxy,
    startedAtMono: performance.now(),
    completedAtMono: performance.now(),
  }));
  const probeDomestic = vi.fn(async (_signal: AbortSignal) => domestic());
  const monitor = new ExclusiveNetworkSwitch({
    readProxy,
    probeDomestic,
    readNetwork: () => network,
    timing: { pollMs: 1_000_000 },
  });
  resources.push(monitor);
  return {
    monitor,
    readProxy,
    probeDomestic,
    setProxy: (value: typeof proxy) => {
      proxy = value;
    },
    setNetwork: (value: typeof network) => {
      network = value;
    },
    async start() {
      monitor.start();
      await monitor.refresh();
    },
    async allow() {
      monitor.start();
      await monitor.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
      await monitor.refresh();
      expect(monitor.read().state).toBe("domestic");
    },
  };
}

describe("exclusive domestic / proxy network switch", () => {
  it("rechecks OS recovery immediately, coalescing changes after cancelled work drains", async () => {
    const oldRead = deferred<ProxySwitchObservation>();
    const drain = deferred<void>();
    const readProxy = vi
      .fn(async (_signal: AbortSignal): Promise<ProxySwitchObservation> => ({
        state: "inactive",
        startedAtMono: performance.now(),
        completedAtMono: performance.now(),
      }))
      .mockImplementationOnce(() => oldRead.promise);
    const monitor = new ExclusiveNetworkSwitch({
      readProxy,
      readNetwork: () => ({ available: true, hash: "network" }),
      whenIdle: () => drain.promise,
    });
    resources.push(monitor);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    const oldSignal = readProxy.mock.calls[0][0];
    monitor.networkChanged();
    monitor.networkChanged();
    expect(oldSignal.aborted).toBe(true);
    expect(monitor.acquire()).toBeNull();
    oldRead.resolve({ state: "inactive", startedAtMono: 0, completedAtMono: performance.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(readProxy).toHaveBeenCalledTimes(1);
    expect(monitor.acquire()).toBeNull();
    drain.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(readProxy).toHaveBeenCalledTimes(2);
    expect(monitor.read().state).toBe("domestic");
    const lease = monitor.acquire()!;
    monitor.networkChanged();
    expect(lease.signal.aborted).toBe(true);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(readProxy).toHaveBeenCalledTimes(2);
    expect(monitor.acquire()).toBeNull();
  });

  it("does not supersede a newer positive TUN decision with a queued recovery read", async () => {
    const f = fixture();
    await f.start();
    f.monitor.networkChanged();
    f.monitor.observeProxyEnabled(0);
    const calls = f.readProxy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.readProxy).toHaveBeenCalledTimes(calls);
    expect(f.monitor.read().state).toBe("overseas");
    expect(f.monitor.acquire()).toBeNull();
  });

  it("normal startup enables domestic immediately and switches both account sides without geo probes", async () => {
    let proxy: ProxySwitchObservation["state"] = "inactive";
    const monitor = new ExclusiveNetworkSwitch({
      readNetwork: () => ({ available: true, hash: "same-network" }),
      readProxy: async () => ({
        state: proxy,
        startedAtMono: performance.now(),
        completedAtMono: performance.now(),
      }),
    });
    resources.push(monitor);
    monitor.start();
    await monitor.refresh();
    expect(monitor.read()).toMatchObject({ state: "domestic", proxy: "off", reason: "READY" });
    const domestic = monitor.acquire()!;
    expect(domestic.isCurrent()).toBe(true);
    expect(monitor.acquire("overseas")).toBeNull();
    // Multiple unchanged polls do not rebuild views or revoke account sessions.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(domestic.isCurrent()).toBe(true);
    proxy = "active";
    await monitor.refresh();
    expect(domestic.signal.aborted).toBe(true);
    expect(monitor.acquire()).toBeNull();
    const overseas = monitor.acquire("overseas")!;
    expect(overseas.isCurrent()).toBe(true);
    proxy = "inactive";
    await monitor.refresh();
    expect(overseas.signal.aborted).toBe(true);
    expect(monitor.read().state).toBe("domestic");
    expect(monitor.acquire()!.isCurrent()).toBe(true);
  });

  it("unknown proxy state pauses both sides and recovers on the next valid read", async () => {
    let proxy: ProxySwitchObservation["state"] = "active";
    const monitor = new ExclusiveNetworkSwitch({
      readNetwork: () => ({ available: true, hash: "same-network" }),
      readProxy: async () => ({
        state: proxy,
        startedAtMono: performance.now(),
        completedAtMono: performance.now(),
      }),
    });
    resources.push(monitor);
    monitor.start();
    await monitor.refresh();
    const overseas = monitor.acquire("overseas")!;
    proxy = "unknown";
    await monitor.refresh();
    expect(overseas.signal.aborted).toBe(true);
    expect(monitor.acquire()).toBeNull();
    expect(monitor.acquire("overseas")).toBeNull();
    proxy = "inactive";
    await monitor.refresh();
    expect(monitor.acquire()!.isCurrent()).toBe(true);
  });

  it("starts closed and requires two separate CN samples after the warmup gap", async () => {
    const f = fixture();
    expect(f.monitor.read()).toMatchObject({ state: "checking", proxy: "unknown" });
    expect(f.monitor.acquire()).toBeNull();
    await f.start();
    expect(f.monitor.read()).toMatchObject({ state: "checking", proxy: "off" });
    expect(f.probeDomestic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    await f.monitor.refresh();
    expect(f.probeDomestic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await f.monitor.refresh();
    expect(f.probeDomestic).toHaveBeenCalledTimes(2);
    expect(f.monitor.read()).toMatchObject({ state: "domestic", proxy: "off", reason: "READY" });
    expect(f.monitor.acquire()?.isCurrent()).toBe(true);
  });

  it.each(["active", "unknown"] as const)(
    "%s proxy closes immediately and does not probe a domestic site",
    async (state) => {
      const f = fixture();
      f.setProxy(state);
      await f.start();
      expect(f.monitor.read().state).toBe(state === "active" ? "overseas" : "checking");
      expect(f.monitor.acquire()).toBeNull();
      expect(f.probeDomestic).not.toHaveBeenCalled();
    },
  );

  it("revokes a live lease when proxy turns on, even if its exit would be CN", async () => {
    const f = fixture();
    await f.allow();
    const lease = f.monitor.acquire()!;
    const previous = f.monitor.read().generation;
    f.setProxy("active");
    await f.monitor.refresh();
    expect(lease.signal.aborted).toBe(true);
    expect(lease.isCurrent()).toBe(false);
    expect(f.monitor.read()).toMatchObject({ proxy: "on", reason: "PROXY_ENABLED" });
    expect(f.monitor.read().generation).toBeGreaterThan(previous);
    expect(f.probeDomestic).toHaveBeenCalledTimes(2);
  });

  it("closing the proxy starts a new warmup rather than resurrecting an old permit", async () => {
    const f = fixture();
    await f.allow();
    f.setProxy("active");
    await f.monitor.refresh();
    f.setProxy("inactive");
    await f.monitor.refresh();
    expect(f.monitor.read().state).toBe("checking");
    expect(f.monitor.acquire()).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    await f.monitor.refresh();
    expect(f.monitor.read().state).toBe("domestic");
    expect(f.probeDomestic).toHaveBeenCalledTimes(4);
  });

  it("positive TUN evidence aborts pending probes and discards their late CN result", async () => {
    const f = fixture(),
      response = deferred<PublicEgress>();
    f.probeDomestic.mockImplementationOnce(() => response.promise);
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.probeDomestic.mock.calls[0]?.[0] as AbortSignal | undefined;
    f.monitor.observeProxyEnabled(0);
    expect(f.monitor.read()).toMatchObject({ proxy: "on", state: "overseas" });
    if (signal) expect(signal.aborted).toBe(true);
    response.resolve(domestic());
    await f.monitor.refresh();
    expect(f.monitor.read().proxy).toBe("on");
    expect(f.monitor.acquire()).toBeNull();
  });

  it("rechecks proxy after a CN response before opening", async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(10_000);
    f.probeDomestic.mockImplementationOnce(async () => {
      f.setProxy("active");
      return domestic();
    });
    await f.monitor.refresh();
    expect(f.monitor.read().proxy).toBe("on");
    expect(f.monitor.acquire()).toBeNull();
  });

  it.each(["US", null])("a %s country result does not authorize normal domestic work", async (country) => {
    const f = fixture();
    f.probeDomestic.mockResolvedValue({ ...domestic(), country });
    await f.start();
    expect(f.monitor.read().state).toBe("unavailable");
    expect(f.monitor.acquire()).toBeNull();
  });

  it("fresh off samples renew without repeating geo requests or tearing down a valid lease", async () => {
    const f = fixture();
    await f.allow();
    const lease = f.monitor.acquire()!,
      generation = f.monitor.read().generation;
    await vi.advanceTimersByTimeAsync(5_000);
    await f.monitor.refresh();
    expect(f.probeDomestic).toHaveBeenCalledTimes(2);
    expect(f.monitor.read().generation).toBe(generation);
    expect(lease.isCurrent()).toBe(true);
  });

  it("expiry fails closed even without another OS read", async () => {
    const f = fixture();
    await f.allow();
    const lease = f.monitor.acquire()!;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.monitor.read()).toMatchObject({ state: "checking", reason: "PROOF_EXPIRED" });
    expect(lease.signal.aborted).toBe(true);
    expect(f.monitor.acquire()).toBeNull();
  });

  it("network identity changes invalidate warmup and active leases", async () => {
    const f = fixture();
    await f.allow();
    const lease = f.monitor.acquire()!;
    f.setNetwork({ available: true, hash: "network-b" });
    await f.monitor.refresh();
    expect(f.monitor.read().reason).toBe("NETWORK_CHANGED");
    expect(lease.signal.aborted).toBe(true);
    await f.monitor.refresh();
    expect(f.monitor.read().state).toBe("checking");
  });

  it("unavailable OS fingerprint prevents a domestic probe without hiding a positive proxy", async () => {
    const f = fixture();
    f.setNetwork({ available: false, hash: "" });
    await f.start();
    expect(f.probeDomestic).not.toHaveBeenCalled();
    f.setProxy("active");
    await f.monitor.refresh();
    expect(f.monitor.read().proxy).toBe("on");
  });

  it("rejects stale/future proxy reads and never re-labels their observation time", async () => {
    const f = fixture();
    f.readProxy.mockResolvedValue({ state: "inactive", startedAtMono: 1, completedAtMono: 2 });
    await f.start();
    expect(f.monitor.read().reason).toBe("PROXY_STATE_UNKNOWN");
    expect(f.probeDomestic).not.toHaveBeenCalled();
  });

  it("one real read owns the busy slot and shutdown waits for it", async () => {
    const f = fixture(),
      result = deferred<ProxySwitchObservation>();
    f.readProxy.mockImplementationOnce(() => result.promise);
    f.monitor.start();
    const pending = f.monitor.refresh();
    expect(f.monitor.refresh()).toBe(pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.readProxy).toHaveBeenCalledOnce();
    f.monitor.stop();
    let idle = false;
    const drained = f.monitor.whenIdle().then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);
    result.resolve({
      state: "inactive",
      startedAtMono: performance.now(),
      completedAtMono: performance.now(),
    });
    await drained;
    expect(f.probeDomestic).not.toHaveBeenCalled();
    expect(f.monitor.acquire()).toBeNull();
  });

  it("reserves the flight before a synchronous provider reenters refresh", async () => {
    const readProxy = vi.fn(async () => ({
      state: "active" as const,
      startedAtMono: performance.now(),
      completedAtMono: performance.now(),
    }));
    let reentered = false;
    const monitor = new ExclusiveNetworkSwitch({
      readProxy,
      probeDomestic: async () => domestic(),
      readNetwork: () => {
        if (!reentered) {
          reentered = true;
          void monitor.refresh();
        }
        return { available: true, hash: "network" };
      },
      timing: { pollMs: 1_000_000 },
    });
    resources.push(monitor);
    monitor.start();
    await monitor.refresh();
    expect(readProxy).toHaveBeenCalledTimes(1);
  });

  it("a repeated positive TUN observation cancels an off check even while the UI already says on", async () => {
    const f = fixture(),
      result = deferred<PublicEgress>();
    f.setProxy("active");
    await f.start();
    f.setProxy("inactive");
    f.probeDomestic.mockImplementationOnce(() => result.promise);
    const pending = f.monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.probeDomestic.mock.calls.at(-1)![0];
    expect(f.monitor.read().proxy).toBe("on");
    f.monitor.observeProxyEnabled(0);
    expect(signal.aborted).toBe(true);
    result.resolve(domestic());
    await pending;
    expect(f.monitor.read().proxy).toBe("on");
    expect(f.monitor.acquire()).toBeNull();
  });

  it("postflight proxy reads cannot make an older egress sample younger", async () => {
    let reads = 0;
    const monitor = new ExclusiveNetworkSwitch({
      readNetwork: () => ({ available: true, hash: "network" }),
      probeDomestic: async () => domestic(),
      readProxy: async () => {
        const start = performance.now();
        if (++reads === 2) await vi.advanceTimersByTimeAsync(50);
        return { state: "inactive", startedAtMono: start, completedAtMono: performance.now() };
      },
      timing: { pollMs: 1_000_000, egressTtlMs: 100 },
    });
    resources.push(monitor);
    monitor.start();
    await monitor.refresh();
    expect(monitor.domesticEgress()?.country).toBe("CN");
    await vi.advanceTimersByTimeAsync(50);
    expect(monitor.domesticEgress()).toBeNull();
  });
});
