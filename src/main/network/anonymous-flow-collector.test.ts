import { afterEach, describe, expect, it, vi } from "vitest";
import { AnonymousFlowCollector, type AnonymousFlowCollectorOptions } from "./anonymous-flow-collector";
import { type AnonymousTlsObserverContext } from "./anonymous-proof-probe";
import { validateResolverFlowMapping } from "./resolver-flow-mapping";
import type { ClashReadResult } from "./clash-reader";
import type { ProofScopeVersion } from "./proof-issuer";
import { fixture, mutable, socketNetLog, V } from "./fixtures/resolver-flow";

vi.mock("electron", () => ({ app: {}, session: {} }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function later<T>(input: T, offset: number): T {
  return JSON.parse(JSON.stringify(input), (key, value) =>
    typeof value === "number" && key.endsWith("AtMono") ? value + offset : value,
  ) as T;
}
function setup() {
  const facts = fixture();
  let now = 100;
  let version: ProofScopeVersion | null = { generation: 1, rulesVersion: V };
  let quiet = true;
  const signal = new AbortController();
  const postflight = later(facts.inputs, 2000);
  mutable(postflight).sampleId = "actual-postflight-round";
  const controller: ClashReadResult = {
    mode: "rule",
    tun: true,
    mixedPort: 10090,
    version: "synthetic-kernel",
    fingerprint: V,
    rules: [{ type: "Domain", payload: facts.target.host, proxy: "DIRECT" }],
    directPolicy: facts.inputs.configurationBefore.currentDirectPolicy,
    startedAtMono: 100,
    completedAtMono: 101,
  };
  const capture = {
    start: vi.fn(async () => undefined),
    finish: vi.fn(async () => socketNetLog()),
    dispose: vi.fn(async () => undefined),
    whenIdle: vi.fn(async () => undefined),
  };
  const context: AnonymousTlsObserverContext = Object.freeze({
    factoryId: "clipdock-anonymous-tls-v1",
    origin: facts.target,
    transportContextId: facts.transportContextId,
    signal: signal.signal,
    trace: { netLog: {} as AnonymousTlsObserverContext["trace"]["netLog"] },
  });
  const observation = {
    factoryId: "clipdock-anonymous-tls-v1" as const,
    origin: facts.target,
    transportContextId: facts.transportContextId,
    startedAtMono: 132,
    completedAtMono: 160,
    statusCode: 200,
    responseFromCache: false,
    certificateValidation: "chromium-default" as const,
    credentials: "omit" as const,
  };
  const tcp = vi.fn(async () => {
    now = 180;
    return facts.appTcp;
  });
  const probe: NonNullable<AnonymousFlowCollectorOptions["probe"]> = {
    probeTls: vi.fn(async (_origin, _signal, observer) => {
      try {
        await observer!.beforeSend!(context);
        now = 160;
        await observer!.headers!(context, {
          requestId: 1,
          sentAtMono: 140,
          sentAtWall: 1000,
          headersAtMono: 160,
          headersAtWall: 1020,
          statusCode: 200,
          responseFromCache: false,
        });
        return { available: true, observation };
      } finally {
        await observer!.cleanup!(context);
      }
    }),
    whenIdle: vi.fn(async () => undefined),
  };
  let inputsRead = 0,
    connectionRead = 0;
  const options: AnonymousFlowCollectorOptions = {
    readController: vi.fn(async () => {
      now = 101;
      return controller;
    }),
    inputs: {
      read: vi.fn(async () => {
        const result = inputsRead++ === 0 ? facts.inputs : postflight;
        now = result.completedAtMono + 1;
        return result;
      }),
      whenIdle: vi.fn(async () => undefined),
    },
    dns: {
      read: vi.fn(async () => {
        now = 139;
        return facts.kernelDns;
      }),
    },
    readConnections: vi.fn(async () => {
      const result = connectionRead++ === 0 ? facts.incomingBefore : facts.incomingAfter;
      now = Math.max(now, result.completedAtMono);
      return result;
    }),
    readVersion: () => version,
    isQuiescent: () => quiet,
    readersWhenIdle: vi.fn(async () => undefined),
    probe,
    createCapture: () => capture,
    createTcpReader: vi.fn(() => ({ read: tcp })),
    readNetworkServicePids: () => [facts.appOwner.pid],
    now: () => now,
  };
  const collector = new AnonymousFlowCollector(options);
  return {
    collector,
    options,
    facts,
    postflight,
    capture,
    controller,
    signal,
    observation,
    tcp,
    probe,
    setVersion: (v: ProofScopeVersion | null) => {
      version = v;
    },
    setQuiet: (v: boolean) => {
      quiet = v;
    },
    setNow: (v: number) => {
      now = v;
    },
    collect: () => collector.collect(facts.target, facts.loader, facts.transportProfileId, signal.signal),
  };
}

afterEach(() => vi.useRealTimers());

describe("AnonymousFlowCollector", () => {
  it("retains the actual original branded mapping, with fresh postflight inputs and no qualification", async () => {
    const s = setup();
    const result = await s.collect();
    expect(result.available).toBe(true);
    if (!result.available) return;
    const o = result.observation;
    expect(o.qualificationGranted).toBe(false);
    expect(o.tls.completedAtMono).toBe(160);
    expect(o.inputs.expiresAtMono).toBe(1100);
    expect(o.postflightInputs.startedAtMono).toBe(2100);
    expect(o.completedAtMono).toBe(2131);
    expect(
      validateResolverFlowMapping(o.mapping, o.inputs, o.loader, o.configuration, o.completedAtMono),
    ).toBe(true);
    expect(
      validateResolverFlowMapping(
        structuredClone(o.mapping),
        o.inputs,
        o.loader,
        o.configuration,
        o.completedAtMono,
      ),
    ).toBe(false);
    expect(s.options.createTcpReader).toHaveBeenCalledWith({
      ownerPids: [902],
      remotes: [{ address: "198.18.0.2", port: 443 }],
    });
    expect(s.capture.dispose).toHaveBeenCalled();
  });

  it("constructor and a nonquiet window perform no observation", async () => {
    const s = setup();
    expect(s.options.readController).not.toHaveBeenCalled();
    s.setQuiet(false);
    expect(await s.collect()).toEqual({ available: false, reason: "QUIET_WINDOW_REQUIRED" });
    expect(s.options.readController).not.toHaveBeenCalled();
    expect(s.probe.probeTls).not.toHaveBeenCalled();
  });
  it.each(["global", "direct", "unknown"])("does not probe under %s kernel mode", async (mode) => {
    const s = setup();
    s.controller.mode = mode;
    expect((await s.collect()).available).toBe(false);
    expect(s.probe.probeTls).not.toHaveBeenCalled();
  });
  it("does not guess past an unresolved process rule", async () => {
    const s = setup();
    s.controller.rules.unshift({ type: "ProcessName", payload: "other.exe", proxy: "PROXY" });
    expect((await s.collect()).available).toBe(false);
    expect(s.probe.probeTls).not.toHaveBeenCalled();
  });
  it.each(["generation", "rules"])("rejects a %s change after reading controller", async (kind) => {
    const s = setup();
    vi.mocked(s.options.readController).mockImplementation(async () => {
      s.setVersion({
        generation: kind === "generation" ? 2 : 1,
        rulesVersion: kind === "rules" ? "c".repeat(64) : V,
      });
      return s.controller;
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.probe.probeTls).not.toHaveBeenCalled();
  });
  it("losing the quiet window during capture prevents request dispatch", async () => {
    const s = setup();
    s.capture.start.mockImplementation(async () => {
      s.setQuiet(false);
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.dns.read).not.toHaveBeenCalled();
    expect(s.capture.finish).not.toHaveBeenCalled();
    expect(s.capture.dispose).toHaveBeenCalled();
  });
  it("requires an actual Network Service socket owner", async () => {
    const s = setup();
    mutable(s.facts.appTcp).owners = [];
    expect((await s.collect()).available).toBe(false);
  });
  it("rejects a different source port even with the same DIRECT host", async () => {
    const s = setup();
    mutable(s.facts.incomingAfter).connections[0].sourcePort++;
    expect((await s.collect()).available).toBe(false);
  });
  it("rejects a preexisting flow instead of crediting a historical DIRECT connection", async () => {
    const s = setup();
    mutable(s.facts.incomingBefore).connections = structuredClone(s.facts.incomingAfter.connections);
    expect((await s.collect()).available).toBe(false);
  });
  it("requires the response connection to remain held through native socket inspection", async () => {
    const s = setup();
    vi.mocked(s.options.readConnections)
      .mockResolvedValueOnce(s.facts.incomingBefore)
      .mockResolvedValueOnce(s.facts.incomingAfter)
      .mockResolvedValueOnce({ startedAtMono: 181, completedAtMono: 182, connections: [] });
    expect((await s.collect()).available).toBe(false);
  });
  it("a different transport context cannot supply the TLS result", async () => {
    const s = setup();
    s.observation.transportContextId = "another-anonymous-session";
    expect((await s.collect()).available).toBe(false);
  });
  it.each(["network", "hosts", "source", "owner"])("rejects changed %s in postflight", async (kind) => {
    const s = setup();
    const p = mutable(s.postflight);
    if (kind === "network") p.networkAfter.hash = "d".repeat(64);
    if (kind === "hosts") p.systemHostsAfter!.fileHash = "d".repeat(64);
    if (kind === "source") p.configurationAfter.fileFingerprint = "d".repeat(64);
    if (kind === "owner") p.ownerAfter.kernelEpoch = "d".repeat(64);
    expect((await s.collect()).available).toBe(false);
  });
  it("does not publish until nested cleanup drains, and refuses overlapping collection", async () => {
    const s = setup();
    const drain = deferred();
    vi.mocked(s.options.readersWhenIdle).mockImplementation(() => drain.promise);
    let settled = false;
    const work = s.collect().then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(s.options.readersWhenIdle).toHaveBeenCalled());
    expect(settled).toBe(false);
    expect(await s.collect()).toEqual({ available: false, reason: "BUSY" });
    drain.resolve();
    expect((await work).available).toBe(true);
  });
  it("revocation during cleanup discards a completed mapping and waits for the actual provider", async () => {
    const s = setup();
    const drain = deferred();
    vi.mocked(s.options.readersWhenIdle).mockImplementation(() => drain.promise);
    const work = s.collect();
    await vi.waitFor(() => expect(s.options.readersWhenIdle).toHaveBeenCalled());
    s.collector.invalidate();
    let idle = false;
    const wait = s.collector.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    drain.resolve();
    expect(await work).toEqual({ available: false, reason: "CANCELLED" });
    await wait;
    expect(idle).toBe(true);
  });
  it("cleanup failure permanently prevents another observation", async () => {
    const s = setup();
    vi.mocked(s.options.readersWhenIdle).mockRejectedValue(new Error("synthetic cleanup failure"));
    expect((await s.collect()).available).toBe(false);
    expect(await s.collect()).toEqual({ available: false, reason: "CANCELLED" });
    expect(s.probe.probeTls).toHaveBeenCalledTimes(1);
  });
  it("an external abort before entry performs no reads", async () => {
    const s = setup();
    s.signal.abort();
    expect(await s.collect()).toEqual({ available: false, reason: "CANCELLED" });
    expect(s.options.readController).not.toHaveBeenCalled();
  });
  it("a synchronous setup revocation stops before any source read", async () => {
    const s = setup();
    s.options.readVersion = () => {
      s.collector.invalidate();
      return { generation: 1, rulesVersion: V };
    };
    expect((await s.collect()).available).toBe(false);
    expect(s.options.readController).not.toHaveBeenCalled();
  });
  it("a provider cannot reenter before the active collection slot is installed", async () => {
    const s = setup();
    let reentered: ReturnType<typeof s.collect> | undefined;
    vi.mocked(s.options.readController).mockImplementation(async () => {
      reentered = s.collect();
      return s.controller;
    });
    await s.collect();
    expect(await reentered).toEqual({ available: false, reason: "BUSY" });
    expect(s.options.readController).toHaveBeenCalledTimes(1);
  });
  it("a reentrant initial version getter cannot start another collection", async () => {
    const s = setup();
    let nested: ReturnType<typeof s.collect> | undefined;
    s.options.readVersion = () => {
      nested ??= s.collect();
      return { generation: 1, rulesVersion: V };
    };
    expect((await s.collect()).available).toBe(true);
    expect(await nested).toEqual({ available: false, reason: "BUSY" });
    expect(s.options.readController).toHaveBeenCalledTimes(1);
  });
  it("the monotonic deadline is enforced even when the timer has not run", async () => {
    const s = setup();
    vi.mocked(s.options.readersWhenIdle).mockImplementation(async () => {
      s.setNow(16_000);
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.inputs.read).toHaveBeenCalledTimes(2);
    expect(s.capture.finish).toHaveBeenCalledTimes(1);
  });
  it.each(["factory", "headers-time", "status"])(
    "rejects a %s mismatch between hook and TLS result",
    async (kind) => {
      const s = setup();
      if (kind === "factory") Object.assign(s.observation, { factoryId: "different-factory" });
      if (kind === "headers-time") s.observation.completedAtMono++;
      if (kind === "status") s.observation.statusCode = 204;
      expect((await s.collect()).available).toBe(false);
    },
  );
  it("a cloned valid preflight is not a new postflight observation", async () => {
    const s = setup();
    vi.mocked(s.options.inputs.read)
      .mockResolvedValueOnce(s.facts.inputs)
      .mockResolvedValueOnce(s.facts.inputs);
    expect((await s.collect()).available).toBe(false);
  });
  it("a postflight read already underway before the request cannot attest the later environment", async () => {
    const s = setup();
    mutable(s.postflight).startedAtMono = 100;
    expect((await s.collect()).available).toBe(false);
  });
  it("timeout revokes while an uncancellable provider drains, without releasing the busy slot", async () => {
    vi.useFakeTimers();
    const s = setup();
    const native = deferred();
    vi.mocked(s.options.readController).mockImplementation(async () => {
      await native.promise;
      return s.controller;
    });
    const work = s.collect();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await s.collect()).toEqual({ available: false, reason: "BUSY" });
    native.resolve();
    expect(await work).toEqual({ available: false, reason: "CANCELLED" });
    expect(s.probe.probeTls).not.toHaveBeenCalled();
  });
  it("disposal drains and permanently closes collection", async () => {
    const s = setup();
    await s.collector.dispose();
    expect(await s.collect()).toEqual({ available: false, reason: "CANCELLED" });
  });
});
