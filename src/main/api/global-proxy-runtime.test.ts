import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GlobalProxyRuntime,
  type GlobalProxyClients,
  type GlobalProxyRuntimeOptions,
} from "./global-proxy-runtime";
import type { ProxyEgressSample } from "./proxy-egress-probe";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";
import type { GlobalWebTunnel, GlobalWebTunnelInput } from "@main/network/global-web-tunnel";

type Context = Parameters<NonNullable<GlobalProxyRuntimeOptions["createClients"]>>[0];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const response: ProxyTransportResponse = {
  status: 200,
  headers: {},
  body: Buffer.from("controlled-response"),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const disposals: (() => Promise<void>)[] = [];
const unblock: (() => void)[] = [];
afterEach(async () => {
  unblock.splice(0).forEach((done) => done());
  for (const dispose of disposals.splice(0)) await dispose().catch(() => undefined);
  vi.useRealTimers();
});
function fixture(domesticDirect = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let clockOffset = 1000 - performance.now();
  const now = () => clockOffset + performance.now();
  let sampleNumber = 0;
  const network = { available: true, hash: hash("network") };
  const switching: ReturnType<GlobalProxyRuntimeOptions["readSwitch"]> = { proxy: "on", generation: 1 };
  const configuration = {
    controllerUrl: "http://127.0.0.1:9790",
    proxyPort: 10090,
    credentialRevision: hash("credential-row"),
  };
  const sampleFor = (context: Context, changes: Partial<ProxyEgressSample> = {}): ProxyEgressSample => ({
    sampleId: `sample-${++sampleNumber}`,
    ip: "203.0.113.10",
    countryCode: "JP",
    generation: context.generation,
    revision: context.revision,
    observedAtMono: now(),
    expiresAtMono: now() + 15000,
    chainFingerprint: hash("verified-chain"),
    controllerFingerprint: hash("current-controller"),
    kernelOwner: {
      pid: 1234,
      createdAtTicks: "134332323232323232",
      executablePathIdentity: hash("kernel-path"),
    },
    ...changes,
  });
  const sample = vi.fn<(context: Context, signal: AbortSignal) => Promise<ProxyEgressSample | null>>(
    async (context) => sampleFor(context),
  );
  const request = vi.fn<(input: ProxyTransportRequest) => Promise<ProxyTransportResponse>>(
    async () => response,
  );
  const entries: {
    context: Context;
    clients: GlobalProxyClients;
    invalidate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const createClients = vi.fn((context: Context): GlobalProxyClients => {
    const invalidate = vi.fn(),
      dispose = vi.fn(async () => undefined);
    const clients = {
      sample: (signal: AbortSignal) => sample(context, signal),
      request,
      invalidate,
      dispose,
    };
    entries.push({ context, clients, invalidate, dispose });
    return clients;
  });
  const runtime = new GlobalProxyRuntime({
    domesticDirect,
    configuration: () => configuration,
    readSwitch: () => switching,
    readNetwork: () => network,
    getSecret: () => {
      throw new Error("test factory must never access a real credential");
    },
    createClients,
    now,
  });
  disposals.push(() => runtime.dispose());
  return {
    runtime,
    entries,
    createClients,
    sample,
    sampleFor,
    request,
    network,
    switching,
    configuration,
    get now() {
      return now();
    },
    set now(value: number) {
      clockOffset = value - performance.now();
    },
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
    acquire: (signal = new AbortController().signal) => runtime.acquireEligibility("youtube", signal),
    send: (signal?: AbortSignal) =>
      runtime.request({
        platformId: "youtube",
        url: "https://oauth2.googleapis.com/token",
        method: "POST",
        body: "controlled-body",
        signal,
      }),
  };
}

describe("GlobalProxyRuntime on-demand composition", () => {
  it("keeps mainland DIRECT eligibility and overseas proxy eligibility separate", async () => {
    const domestic = fixture(true);
    domestic.sample.mockImplementation(async (context) => domestic.sampleFor(context, { countryCode: "CN" }));
    const lease = await domestic.runtime.acquireEligibility("bilibili", new AbortController().signal);
    expect(lease?.isCurrent()).toBe(true);
    await expect(domestic.send()).rejects.toThrow();
    const overseas = fixture();
    overseas.sample.mockImplementation(async (context) => overseas.sampleFor(context, { countryCode: "CN" }));
    expect(await overseas.acquire()).toBeNull();
    lease?.release();
  });
  const webInput = (): GlobalWebTunnelInput => ({
    platformId: "youtube",
    host: "studio.youtube.com",
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
  });
  const webTunnel = (): GlobalWebTunnel => {
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    return { stream, closed, close: vi.fn(() => stream.destroy()) };
  };
  it("requires network eligibility for websites without requiring OAuth or an app configuration", async () => {
    const f = fixture();
    await expect(f.runtime.openWebTunnel(webInput())).rejects.toThrow();
    expect(f.createClients).not.toHaveBeenCalled();
    const eligibility = await f.acquire();
    const tunnel = webTunnel(),
      opening = vi.fn(async () => tunnel);
    f.entries[0].clients.openWebTunnel = opening;
    expect(await f.runtime.openWebTunnel(webInput())).toBe(tunnel);
    expect(opening).toHaveBeenCalledTimes(1);
    // An active website is not an indefinitely running API request.
    await f.runtime.whenIdle();
    await expect(f.send()).resolves.toBe(response);
    expect(tunnel.stream.destroyed).toBe(false);
    tunnel.close();
    await tunnel.closed;
    eligibility?.release();
  });
  it("refuses and closes a late website open after source invalidation", async () => {
    const f = fixture();
    await f.acquire();
    const held = deferred<GlobalWebTunnel>();
    f.entries[0].clients.openWebTunnel = vi.fn(() => held.promise);
    const opening = f.runtime.openWebTunnel(webInput());
    const rejected = expect(opening).rejects.toThrow();
    await flush();
    f.runtime.invalidate();
    const tunnel = webTunnel();
    held.resolve(tunnel);
    await rejected;
    expect(tunnel.stream.destroyed).toBe(true);
    await f.runtime.whenIdle();
  });
  it("guards the handed-off stream against caller cancellation and changed authority", async () => {
    const f = fixture();
    await f.acquire();
    let guard: (() => void) | undefined;
    const tunnel = webTunnel();
    f.entries[0].clients.openWebTunnel = vi.fn(async (input) => {
      guard = input.assertCurrent;
      return tunnel;
    });
    const input = webInput(),
      abort = new AbortController();
    input.signal = abort.signal;
    await f.runtime.openWebTunnel(input);
    expect(() => guard!()).not.toThrow();
    abort.abort();
    expect(() => guard!()).toThrow();
    tunnel.close();
    await tunnel.closed;
  });
  it("ignores refreshed display timestamps in the real full switch snapshot within the same generation", async () => {
    const f = fixture();
    Object.assign(f.switching, {
      state: "overseas",
      reason: "PROXY_ENABLED",
      checkedAt: "2026-09-08T07:00:00Z",
      expiresAt: "2026-09-08T07:00:15Z",
    });
    const lease = await f.acquire();
    expect(lease?.isCurrent()).toBe(true);
    Object.assign(f.switching, { checkedAt: "2026-09-08T07:00:05Z", expiresAt: "2026-09-08T07:00:20Z" });
    f.runtime.sync();
    expect(lease?.isCurrent()).toBe(true);
    expect(f.entries[0].invalidate).not.toHaveBeenCalled();
    lease?.release();
  });

  it("constructs and syncs without sampling when no OAuth or API operation requests eligibility", async () => {
    const f = fixture();
    f.runtime.sync();
    await f.advance(60000);
    expect(f.createClients).not.toHaveBeenCalled();
    expect(f.sample).not.toHaveBeenCalled();
    await expect(f.send()).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it.each(["off", "unknown"] as const)("does not create a probe when proxy is %s", async (proxy) => {
    const f = fixture();
    f.switching.proxy = proxy;
    expect(await f.acquire()).toBeNull();
    expect(f.createClients).not.toHaveBeenCalled();
    expect(f.sample).not.toHaveBeenCalled();
  });

  it("coalesces concurrent eligibility starts and keeps authority main-only without the raw exit IP", async () => {
    const f = fixture(),
      first = f.acquire(),
      second = f.runtime.acquireEligibility("x", new AbortController().signal);
    const [a, b] = await Promise.all([first, second]);
    expect(a?.isCurrent()).toBe(true);
    expect(b?.isCurrent()).toBe(true);
    expect(a?.generation).toBe(b?.generation);
    expect(f.sample).toHaveBeenCalledTimes(1);
    expect(f.createClients).toHaveBeenCalledTimes(1);
    const authority = f.entries[0].context.readAuthority();
    expect(authority).toMatchObject({ proxyState: "on", egress: { countryCode: "JP" } });
    expect(JSON.stringify(authority)).not.toContain("203.0.113.10");
    await expect(f.send()).resolves.toEqual(response);
    a?.release();
    b?.release();
  });

  it("refuses mainland/unknown and already-expired samples without installing an authority", async () => {
    for (const changes of [{ countryCode: "CN" }, { countryCode: "XX" }, { expiresAtMono: 1000 }]) {
      const f = fixture();
      f.sample.mockImplementation(async (context) => f.sampleFor(context, changes));
      expect(await f.acquire()).toBeNull();
      expect(f.entries[0].context.readAuthority()).toBeNull();
      expect(f.entries[0].invalidate).toHaveBeenCalledTimes(1);
      await f.runtime.dispose();
    }
  });

  it("renews a held eligibility with a fresh sample in the same generation and stops renewal after release", async () => {
    const f = fixture(),
      lease = await f.acquire();
    const original = f.entries[0].context.readAuthority()!;
    await f.advance(5000);
    const renewed = f.entries[0].context.readAuthority()!;
    expect(renewed.generation).toBe(original.generation);
    expect(renewed.egress!.sampleId).not.toBe(original.egress!.sampleId);
    expect(renewed.checkedAtMono).toBe(6000);
    expect(renewed.expiresAtMono).toBe(21000);
    expect(lease?.isCurrent()).toBe(true);
    lease?.release();
    await f.advance(5000);
    expect(f.sample).toHaveBeenCalledTimes(2);
  });

  it("starts renewal early enough for real six-second sampling while keeping each original fifteen-second deadline", async () => {
    const f = fixture();
    const starts: number[] = [];
    let active = 0,
      maximumActive = 0;
    f.sample.mockImplementation(async (context) => {
      const startedAt = f.now;
      starts.push(startedAt);
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise<void>((resolve) => setTimeout(resolve, 6000));
      active--;
      return f.sampleFor(context, { expiresAtMono: startedAt + 15_000 });
    });
    const pending = f.acquire();
    await flush();
    await f.advance(6000);
    const lease = await pending;
    expect(lease?.isCurrent()).toBe(true);
    expect(f.entries[0].context.readAuthority()?.expiresAtMono).toBe(16000);
    await f.advance(3000);
    expect(starts).toHaveLength(2);
    await f.advance(6000);
    expect(lease?.signal.aborted).toBe(false);
    expect(lease?.isCurrent()).toBe(true);
    expect(f.entries[0].context.readAuthority()?.expiresAtMono).toBe(starts[1] + 15_000);
    expect(maximumActive).toBe(1);
    lease?.release();
  });

  it("keeps a DIRECT eligibility across multiple deadlines with slow independent renewal and no rebinding", async () => {
    const f = fixture(true);
    const starts: number[] = [];
    f.sample.mockImplementation(async (context) => {
      const startedAt = f.now;
      starts.push(startedAt);
      await new Promise<void>((resolve) => setTimeout(resolve, 6000));
      return f.sampleFor(context, { countryCode: "CN", expiresAtMono: startedAt + 15_000 });
    });
    const pending = f.runtime.acquireEligibility("douyin", new AbortController().signal);
    await flush();
    await f.advance(6000);
    const lease = await pending;
    const generation = lease?.generation;
    expect(lease?.isCurrent()).toBe(true);
    await f.advance(45_000);
    expect(starts.length).toBeGreaterThanOrEqual(7);
    expect(lease?.isCurrent()).toBe(true);
    expect(lease?.generation).toBe(generation);
    expect(lease?.signal.aborted).toBe(false);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0].invalidate).not.toHaveBeenCalled();
    const current = f.runtime.readAuthority()!;
    expect(current.expiresAtMono).toBeGreaterThan(f.now);
    expect(starts).toContain(current.expiresAtMono - 15_000);
    // Drain the pending controlled sample after releasing renewal ownership.
    lease?.release();
    await f.advance(6000);
  });

  it.each([null, "changed"])(
    "revokes a first sample on a fresh controller %s observation and refuses its late result",
    async (change) => {
      const f = fixture(),
        held = deferred<ProxyEgressSample | null>();
      unblock.push(() => held.resolve(null));
      f.runtime.observeController(hash("current-controller"));
      f.sample.mockImplementation(() => held.promise);
      const pending = f.acquire();
      await flush();
      const entry = f.entries[0];
      f.runtime.observeController(change === null ? null : hash("changed-controller"));
      expect(f.sample.mock.calls[0][1].aborted).toBe(true);
      held.resolve(f.sampleFor(entry.context));
      expect(await pending).toBeNull();
      expect(entry.context.readAuthority()).toBeNull();
      await f.runtime.whenIdle();
      f.sample.mockImplementation(async (context) => f.sampleFor(context));
      const next = await f.acquire();
      expect(next?.isCurrent()).toBe(true);
      expect(next?.generation).not.toBe(entry.context.generation);
      next?.release();
    },
  );

  it.each([undefined, null, "old"])(
    "can supersede a controller observation from before this sample: %s",
    async (previous) => {
      const f = fixture();
      if (previous !== undefined)
        f.runtime.observeController(previous === null ? null : hash("old-controller"));
      const lease = await f.acquire();
      expect(lease?.isCurrent()).toBe(true);
      f.runtime.observeController(hash("current-controller"));
      expect(lease?.isCurrent()).toBe(true);
      lease?.release();
    },
  );

  it.each([undefined, null, "same"])(
    "accepts a matching first or refreshed controller report during initial sampling: %s",
    async (previous) => {
      const f = fixture(),
        held = deferred<ProxyEgressSample | null>();
      unblock.push(() => held.resolve(null));
      if (previous !== undefined)
        f.runtime.observeController(previous === null ? null : hash("current-controller"));
      f.sample.mockImplementation(() => held.promise);
      const pending = f.acquire();
      await flush();
      f.runtime.observeController(hash("current-controller"));
      f.runtime.observeController(hash("current-controller"));
      expect(f.sample.mock.calls[0][1].aborted).toBe(false);
      held.resolve(f.sampleFor(f.entries[0].context));
      const lease = await pending;
      expect(lease?.isCurrent()).toBe(true);
      lease?.release();
    },
  );

  it("rejects a conflicting first controller report before committing a late initial result", async () => {
    const f = fixture(),
      held = deferred<ProxyEgressSample | null>();
    unblock.push(() => held.resolve(null));
    f.sample.mockImplementation(() => held.promise);
    const pending = f.acquire();
    await flush();
    f.runtime.observeController(hash("different-controller"));
    held.resolve(f.sampleFor(f.entries[0].context));
    expect(await pending).toBeNull();
    expect(f.entries[0].context.readAuthority()).toBeNull();
  });

  it("treats a repeated unavailable report during a new recovery sample as a fresh loss", async () => {
    const f = fixture(),
      held = deferred<ProxyEgressSample | null>();
    unblock.push(() => held.resolve(null));
    f.runtime.observeController(null);
    f.sample.mockImplementation(() => held.promise);
    const pending = f.acquire();
    await flush();
    f.runtime.observeController(null);
    expect(f.sample.mock.calls[0][1].aborted).toBe(true);
    held.resolve(f.sampleFor(f.entries[0].context));
    expect(await pending).toBeNull();
  });

  it("does not turn repeated cached sample data into a later evidence expiry", async () => {
    const f = fixture();
    let cached: ProxyEgressSample | null = null;
    f.sample.mockImplementation(async (context) => (cached ??= f.sampleFor(context)));
    const lease = await f.acquire();
    await f.advance(5000);
    expect(f.entries[0].context.readAuthority()).toMatchObject({ checkedAtMono: 1000, expiresAtMono: 16000 });
    f.now = 16000;
    f.runtime.sync();
    expect(lease?.signal.aborted).toBe(true);
    expect(lease?.isCurrent()).toBe(false);
    expect(f.entries[0].context.readAuthority()).toBeNull();
  });

  it("does not poll repeatedly when renewal returns the same original deadline", async () => {
    const f = fixture();
    let cached: ProxyEgressSample | null = null;
    f.sample.mockImplementation(async (context) => (cached ??= f.sampleFor(context)));
    const lease = await f.acquire();
    await f.advance(14_000);
    expect(f.sample).toHaveBeenCalledTimes(2);
    expect(lease?.isCurrent()).toBe(true);
    await f.advance(1000);
    expect(lease?.signal.aborted).toBe(true);
    expect(f.sample).toHaveBeenCalledTimes(2);
  });

  it("starts immediately when the prior sample cost exceeds remaining time, then closes at the original deadline", async () => {
    const f = fixture(),
      held = deferred<ProxyEgressSample | null>();
    unblock.push(() => held.resolve(null));
    f.sample.mockImplementationOnce(async (context) => {
      const startedAt = f.now;
      await new Promise<void>((resolve) => setTimeout(resolve, 8000));
      return f.sampleFor(context, { expiresAtMono: startedAt + 15_000 });
    });
    f.sample.mockImplementationOnce(() => held.promise);
    const pending = f.acquire();
    await flush();
    await f.advance(8000);
    const lease = await pending;
    expect(lease?.isCurrent()).toBe(true);
    await f.advance(1);
    expect(f.sample).toHaveBeenCalledTimes(2);
    await f.advance(6999);
    expect(f.sample.mock.calls[1][1].aborted).toBe(true);
    expect(lease?.signal.aborted).toBe(true);
    held.resolve(f.sampleFor(f.entries[0].context));
    await f.runtime.whenIdle();
    expect(f.entries[0].context.readAuthority()).toBeNull();
    expect(f.sample).toHaveBeenCalledTimes(2);
  });

  it("expiry revokes an active eligibility even while a renewal dependency ignores abort", async () => {
    const f = fixture(),
      lease = await f.acquire(),
      pending = deferred<ProxyEgressSample | null>();
    unblock.push(() => pending.resolve(null));
    f.sample.mockImplementation(() => pending.promise);
    await f.advance(5000);
    const signal = f.sample.mock.calls[1][1];
    await f.advance(10000);
    expect(signal.aborted).toBe(true);
    expect(lease?.signal.aborted).toBe(true);
    expect(f.entries[0].context.readAuthority()).toBeNull();
    pending.resolve(f.sampleFor(f.entries[0].context));
    await f.runtime.whenIdle();
    expect(lease?.isCurrent()).toBe(false);
  });

  it("a changed chain or failed renewal revokes rather than rebinding existing consent", async () => {
    for (const change of ["changed", "failed"]) {
      const f = fixture(),
        lease = await f.acquire();
      f.sample.mockImplementation(async (context) =>
        change === "failed" ? null : f.sampleFor(context, { chainFingerprint: hash("different-chain") }),
      );
      await f.advance(5000);
      expect(lease?.signal.aborted).toBe(true);
      expect(lease?.isCurrent()).toBe(false);
      expect(f.entries[0].context.readAuthority()).toBeNull();
      await f.runtime.dispose();
    }
  });

  it("settings, OS identity and switch changes synchronously revoke authority and publish withdrawal", async () => {
    for (const change of ["settings", "os", "switch"]) {
      const f = fixture(),
        lease = await f.acquire(),
        observed: unknown[] = [];
      const context = f.entries[0].context;
      context.subscribe(() => observed.push(context.readAuthority()));
      if (change === "settings") f.configuration.credentialRevision = hash("new-secret-row");
      if (change === "os") f.network.hash = hash("new-network");
      if (change === "switch") f.switching.proxy = "off";
      f.runtime.sync();
      expect(lease?.signal.aborted).toBe(true);
      expect(observed).toEqual([null]);
      expect(context.readVersion()).toBeNull();
      await f.runtime.dispose();
    }
  });

  it("does not install a late initial sample after proxy-off revocation", async () => {
    const f = fixture(),
      pending = deferred<ProxyEgressSample | null>();
    unblock.push(() => pending.resolve(null));
    f.sample.mockImplementation(() => pending.promise);
    const start = f.acquire();
    await flush();
    f.switching.proxy = "off";
    f.runtime.sync();
    expect(f.sample.mock.calls[0][1].aborted).toBe(true);
    pending.resolve(f.sampleFor(f.entries[0].context));
    expect(await start).toBeNull();
    expect(f.entries[0].context.readAuthority()).toBeNull();
  });

  it("renews independently while business requests remain serialized", async () => {
    const f = fixture(),
      lease = await f.acquire(),
      held = deferred<ProxyTransportResponse>();
    unblock.push(() => held.resolve(response));
    const order: string[] = [];
    f.request.mockImplementationOnce(async () => {
      order.push("first");
      return held.promise;
    });
    f.request.mockImplementationOnce(async () => {
      order.push("second");
      return response;
    });
    f.sample.mockImplementation(async (context) => {
      order.push("renew");
      return f.sampleFor(context);
    });
    const a = f.send();
    await flush();
    await f.advance(5000);
    const b = f.send();
    await flush();
    expect(order).toEqual(["first", "renew"]);
    held.resolve(response);
    await Promise.all([a, b]);
    expect(order).toEqual(["first", "renew", "second"]);
    expect(lease?.isCurrent()).toBe(true);
  });

  it("a long business response does not starve source renewal across multiple original deadlines", async () => {
    const f = fixture(),
      lease = await f.acquire(),
      held = deferred<ProxyTransportResponse>();
    unblock.push(() => held.resolve(response));
    f.request.mockReturnValueOnce(held.promise);
    const active = f.send();
    await flush();
    await f.advance(45000);
    expect(f.sample.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(lease?.isCurrent()).toBe(true);
    expect(f.entries[0].context.readAuthority()!.expiresAtMono).toBeGreaterThan(46000);
    held.resolve(response);
    await expect(active).resolves.toEqual(response);
  });

  it("reserves evidence capacity when the bounded business queue is full", async () => {
    const f = fixture(),
      lease = await f.acquire(),
      held = deferred<ProxyTransportResponse>();
    unblock.push(() => held.resolve(response));
    f.request.mockReturnValueOnce(held.promise);
    const queued = Array.from({ length: 7 }, () => f.send());
    await flush();
    await expect(f.send()).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.advance(5000);
    expect(f.sample).toHaveBeenCalledTimes(2);
    expect(lease?.isCurrent()).toBe(true);
    held.resolve(response);
    await Promise.all(queued);
    expect(f.request).toHaveBeenCalledTimes(7);
  });

  it("source failure during a long response immediately invalidates the active client and rejects its late result", async () => {
    const f = fixture(),
      lease = await f.acquire(),
      held = deferred<ProxyTransportResponse>();
    unblock.push(() => held.resolve(response));
    f.request.mockReturnValueOnce(held.promise);
    const active = f.send(),
      rejected = expect(active).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    await flush();
    f.sample.mockResolvedValue(null);
    await f.advance(5000);
    expect(lease?.signal.aborted).toBe(true);
    expect(f.entries[0].invalidate).toHaveBeenCalledOnce();
    held.resolve(response);
    await rejected;
  });

  it("cancels a queued request before transport and snapshots another queued request's body/headers", async () => {
    const f = fixture();
    await f.acquire();
    const held = deferred<ProxyTransportResponse>();
    unblock.push(() => held.resolve(response));
    f.request.mockImplementationOnce(() => held.promise);
    const first = f.send();
    await flush();
    const abort = new AbortController(),
      cancelled = f.send(abort.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    abort.abort();
    const body = new Uint8Array([1, 2]),
      headers = { Authorization: "synthetic-original" };
    const next = f.runtime.request({ platformId: "x", url: "https://api.x.com/2/users/me", headers, body });
    headers.Authorization = "mutated";
    body[0] = 9;
    held.resolve(response);
    await first;
    await rejected;
    await next;
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1][0]).toMatchObject({
      headers: { Authorization: "synthetic-original" },
      body: new Uint8Array([1, 2]),
    });
  });

  it("refuses a late business response after network invalidation even if its dependency ignores cancellation", async () => {
    const f = fixture();
    await f.acquire();
    const held = deferred<ProxyTransportResponse>();
    unblock.push(() => held.resolve(response));
    f.request.mockImplementation(() => held.promise);
    const pending = f.send();
    await flush();
    f.runtime.invalidate();
    held.resolve(response);
    await expect(pending).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it("dispose waits for actual outstanding sampling and client cleanup, with no new clients during shutdown", async () => {
    const f = fixture(),
      sampling = deferred<ProxyEgressSample | null>(),
      cleanup = deferred<void>();
    unblock.push(() => {
      sampling.resolve(null);
      cleanup.resolve();
    });
    f.sample.mockImplementation(() => sampling.promise);
    const start = f.acquire();
    await flush();
    f.entries[0].dispose.mockImplementation(() => cleanup.promise);
    let drained = false;
    const stop = f.runtime.dispose().then(() => {
      drained = true;
    });
    await flush();
    expect(f.sample.mock.calls[0][1].aborted).toBe(true);
    expect(drained).toBe(false);
    sampling.resolve(null);
    await start;
    await flush();
    expect(drained).toBe(false);
    expect(await f.acquire()).toBeNull();
    expect(f.createClients).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await stop;
    expect(drained).toBe(true);
  });

  it("a new demand waits for the retired client to drain before creating a replacement", async () => {
    const f = fixture();
    await f.acquire();
    const cleanup = deferred<void>();
    unblock.push(() => cleanup.resolve());
    f.entries[0].dispose.mockImplementation(() => cleanup.promise);
    f.runtime.invalidate();
    const pending = f.acquire();
    await flush();
    expect(f.createClients).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    const lease = await pending;
    expect(f.createClients).toHaveBeenCalledTimes(2);
    expect(lease?.isCurrent()).toBe(true);
  });

  it("cleanup failure stays closed and cannot be cleared by new demand", async () => {
    const f = fixture();
    await f.acquire();
    f.entries[0].dispose.mockRejectedValue(new Error("controlled-cleanup-failure"));
    f.runtime.invalidate();
    await expect(f.runtime.whenIdle()).rejects.toThrow("GLOBAL_PROXY_CLEANUP_FAILED");
    expect(await f.acquire()).toBeNull();
    expect(f.createClients).toHaveBeenCalledTimes(1);
    await expect(f.send()).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });
});
