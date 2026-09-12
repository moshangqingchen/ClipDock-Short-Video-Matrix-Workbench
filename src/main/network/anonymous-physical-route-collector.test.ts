import { describe, expect, it, vi } from "vitest";
import { validateResolverFlowMapping } from "./resolver-flow-mapping";
import { physicalRouteFixture as setup } from "./fixtures/physical-route";
import { V } from "./fixtures/resolver-flow";

vi.mock("electron", () => ({ app: {}, session: {} }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("AnonymousPhysicalRouteCollector", () => {
  it("pairs different destinations by selective lifecycle and retains fresh branded resolver observations", async () => {
    const s = setup(),
      found = await s.collect();
    expect(found.available).toBe(true);
    if (!found.available) return;
    const o = found.observation;
    expect(s.closed).toEqual(s.incoming.map((row) => row.id));
    expect(o.flows.map((f) => f.kernelSocket)).toEqual(s.physical);
    expect(o.routeFacts.transportProfileIds).toEqual([s.f.transportProfileId]);
    expect(o.routeFacts).not.toHaveProperty("expiresAtMono");
    expect(o.qualificationGranted).toBe(false);
    expect(o.postflightInputs.startedAtMono).toBeGreaterThan(o.flows[1].timing.headersAtMono);
    expect(s.options.dns.read).toHaveBeenCalledTimes(2);
    for (const flow of o.flows) {
      expect(
        validateResolverFlowMapping(
          flow.resolverMapping,
          o.inputs,
          o.loader,
          o.configuration,
          o.completedAtMono,
        ),
      ).toBe(true);
      expect(flow.kernelDns.completedAtMono).toBeLessThan(flow.timing.sentAtMono);
      expect(flow.tls.completedAtMono).toBe(flow.timing.headersAtMono);
    }
    expect(s.events.indexOf("capture-finish:0")).toBeLessThan(s.events.indexOf("capture-start:1"));
    expect(s.events.indexOf("route")).toBeGreaterThan(s.events.indexOf("released:1"));
    expect(Object.isFrozen(o.flows[0].kernelSocket)).toBe(true);
  });
  it("distinguishes two fresh sockets to the same real destination without guessing by address", async () => {
    const s = setup();
    s.physical[1].remoteAddress = s.physical[0].remoteAddress;
    s.incoming[1].remoteDestinationIp = s.physical[0].remoteAddress;
    const result = await s.collect();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.observation.flows.map((flow) => flow.kernelSocket.sourcePort)).toEqual([61000, 61001]);
    expect(s.options.closeConnection).toHaveBeenCalledTimes(2);
  });
  it("retains original 1s DNS times after a real 1.5s baseline and uses each flow's newly read DNS", async () => {
    const s = setup(),
      original = s.options.createTcpReader!;
    Object.assign(
      s.postflight,
      JSON.parse(JSON.stringify(s.postflight), (key, value) =>
        typeof value === "number" && key.endsWith("AtMono") ? value + 2_000 : value,
      ),
    );
    s.options.createTcpReader = vi.fn((scope) => {
      const reader = original(scope);
      return {
        read: async () => {
          const result = await reader.read();
          if (scope.ownerPids.length === 1) {
            s.setNow(s.getNow() + 1_500);
            return { ...result, completedAtMono: s.getNow() };
          }
          return result;
        },
      };
    });
    const result = await s.collect();
    expect(result.available).toBe(true);
    if (!result.available) return;
    const o = result.observation;
    expect(o.configuration.expiresAtMono).toBe(1_100);
    expect(o.inputs.dnsAfter.hosts[0].answers[0].ttl).toBe(1);
    expect(o.snapshots[0].tcp.completedAtMono - o.snapshots[0].tcp.startedAtMono).toBeGreaterThanOrEqual(
      1_500,
    );
    for (const flow of o.flows) {
      expect(flow.timing.sentAtMono).toBeGreaterThan(o.configuration.expiresAtMono);
      expect(flow.kernelDns.startedAtMono).toBeGreaterThan(o.configuration.expiresAtMono);
      expect(flow.kernelDns.expiresAtMono).toBeGreaterThan(flow.timing.headersAtMono);
      expect(
        validateResolverFlowMapping(
          flow.resolverMapping,
          o.inputs,
          o.loader,
          o.configuration,
          o.completedAtMono,
        ),
      ).toBe(true);
    }
  });
  it("does not send after the actual non-DNS configuration window expired during baseline", async () => {
    const s = setup(),
      original = s.options.createTcpReader!;
    s.options.createTcpReader = vi.fn((scope) => {
      const reader = original(scope);
      return {
        read: async () => {
          const result = await reader.read();
          s.setNow(s.getNow() + 15_001);
          return { ...result, completedAtMono: s.getNow() };
        },
      };
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.timings).toHaveLength(0);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("refuses independently stale before-send DNS even while the configuration window remains valid", async () => {
    const s = setup(),
      original = s.options.dns.read;
    s.options.dns.read = vi.fn(async (...args) => {
      const result = await original(...args);
      s.setNow(s.getNow() + 1_001);
      return result;
    });
    expect((await s.collect()).available).toBe(false);
  });
  it.each(["generation", "target"] as const)(
    "rejects a different %s input before creating any anonymous request",
    async (kind) => {
      const s = setup(),
        original = s.options.inputs.read;
      s.options.inputs.read = vi.fn(async (...args) => {
        const value = structuredClone(await original(...args));
        if (value.state === "observed") {
          if (kind === "generation") return { ...value, generation: value.generation + 1 };
          return { ...value, targets: [{ ...s.f.target, host: "another.example" }] };
        }
        return value;
      });
      expect((await s.collect()).available).toBe(false);
      expect(s.options.probe!.probeTls).not.toHaveBeenCalled();
    },
  );
  it.each([
    "closeBoth",
    "failClose",
    "baselineOld",
    "incomingForeign",
    "duplicateIncoming",
    "changeOwner",
    "wrongFamily",
    "leaveB",
    "dropSurvivorApp",
    "changePostflight",
    "expireHold",
    "poisonDrain",
    "sameContext",
    "missingFreshDns",
    "extraCandidate",
    "badRoute",
    "stalePostflight",
  ] as const)("refuses %s without producing route authority", async (flag) => {
    const s = setup();
    s.flags[flag] = true;
    const result = await s.collect();
    expect(result.available).toBe(false);
    expect(s.closed.length).toBeLessThanOrEqual(2);
    if (flag === "poisonDrain")
      await expect(s.collector.whenIdle()).rejects.toThrow("PHYSICAL_COLLECTOR_CLEANUP_FAILED");
    else await s.collector.whenIdle();
    if (
      [
        "baselineOld",
        "incomingForeign",
        "duplicateIncoming",
        "changeOwner",
        "sameContext",
        "missingFreshDns",
        "extraCandidate",
        "expireHold",
        "wrongFamily",
      ].includes(flag)
    )
      expect(s.options.closeConnection).not.toHaveBeenCalled();
    if (["closeBoth", "failClose"].includes(flag)) expect(s.options.closeConnection).toHaveBeenCalledTimes(1);
    if (flag === "dropSurvivorApp") expect(s.options.closeConnection).toHaveBeenCalledTimes(1);
  });
  it("does not invoke any provider outside a real quiet window", async () => {
    const s = setup();
    s.setQuiet(false);
    expect(await s.collect()).toEqual({ available: false, reason: "QUIET_WINDOW_REQUIRED" });
    expect(s.options.readController).not.toHaveBeenCalled();
    expect(s.options.probe!.probeTls).not.toHaveBeenCalled();
  });
  it("rejects a non-200 challenge before any close", async () => {
    const s = setup();
    s.flags.echoStatus = 403;
    expect((await s.collect()).available).toBe(false);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("reserves the slot before reentrant provider calls and closes nothing on invalidation", async () => {
    const s = setup();
    let nested: ReturnType<typeof s.collect> | undefined;
    vi.mocked(s.options.readController).mockImplementationOnce(async (signal) => {
      nested = s.collect();
      s.collector.invalidate();
      expect(signal.aborted).toBe(true);
      return {
        mode: "rule",
        tun: true,
        mixedPort: 10090,
        version: "x",
        fingerprint: V,
        rules: [],
        directPolicy: s.f.inputs.configurationBefore.currentDirectPolicy,
      };
    });
    expect((await s.collect()).available).toBe(false);
    expect(await nested).toEqual({ available: false, reason: "BUSY" });
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("rechecks exact ID existence immediately before close", async () => {
    const s = setup();
    const original = s.options.readConnections;
    s.options.readConnections = vi.fn(async (...args) => {
      const value = await original(...args);
      if (s.events.includes("tcp:1")) return { ...value, connections: [] };
      return value;
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("never closes an ID already present in the flow's own before-send snapshot", async () => {
    const s = setup(),
      original = s.options.readConnections;
    let calls = 0;
    s.options.readConnections = vi.fn(async (...args) => {
      const value = await original(...args);
      if (++calls === 2) return { ...value, connections: [{ ...s.incoming[0] }] };
      return value;
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("does not close a connection after the native owner snapshot becomes stale", async () => {
    const s = setup(),
      original = s.options.readConnections;
    s.options.readConnections = vi.fn(async (...args) => {
      const value = await original(...args);
      if (s.events.includes("tcp:1")) s.setNow(s.getNow() + 501);
      return value;
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("requires enough real hold time before the first selective intervention", async () => {
    const s = setup(),
      original = s.options.createTcpReader!;
    s.options.createTcpReader = vi.fn((scope) => {
      const reader = original(scope);
      return {
        read: async () => {
          if (scope.ownerPids.includes(902)) s.setNow(s.timings[0].headersAtMono + 3_600);
          return reader.read();
        },
      };
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it("checks the actual controller again before closing an owned ID", async () => {
    const s = setup(),
      original = s.options.readController;
    s.options.readController = vi.fn(async (signal) => {
      const value = await original(signal);
      return s.events.includes("tcp:1") ? { ...value, mode: "global" } : value;
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.closeConnection).not.toHaveBeenCalled();
  });
  it.each(["quiet", "generation", "abort"] as const)(
    "rejects %s lost during the first intervention without closing B",
    async (kind) => {
      const s = setup(),
        original = s.options.closeConnection;
      s.options.closeConnection = vi.fn(async (...args) => {
        const response = await original(...args);
        if (kind === "quiet") s.setQuiet(false);
        else if (kind === "generation") s.setGeneration(2);
        else s.outer.abort();
        return response;
      });
      expect((await s.collect()).available).toBe(false);
      expect(s.options.closeConnection).toHaveBeenCalledTimes(1);
    },
  );
  it("retains real uncancellable provider work after dispose until it settles", async () => {
    const s = setup(),
      wait = deferred(),
      entered = deferred();
    const original = s.options.readController;
    s.options.readController = vi.fn(async (signal) => {
      entered.resolve();
      await wait.promise;
      return original(signal);
    });
    const running = s.collect();
    await entered.promise;
    let drained = false;
    const disposal = s.collector.dispose().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(await s.collect()).toEqual({ available: false, reason: "BUSY" });
    wait.resolve();
    await disposal;
    expect((await running).available).toBe(false);
    expect(drained).toBe(true);
  });
  it("does not accept a late provider that crossed the monotonic deadline without timer dispatch", async () => {
    const s = setup(),
      original = s.options.readController;
    s.options.readController = vi.fn(async (signal) => {
      const value = await original(signal);
      s.setNow(40_000);
      return value;
    });
    expect((await s.collect()).available).toBe(false);
    expect(s.options.probe!.probeTls).not.toHaveBeenCalled();
  });
  it("waits for every real drain even when a different cleanup throws synchronously", async () => {
    const s = setup(),
      reached = deferred(),
      drain = deferred();
    s.options.inputs.whenIdle = vi.fn(() => {
      throw Error("sensitive detail excluded");
    });
    s.options.readersWhenIdle = vi.fn(async () => {
      reached.resolve();
      await drain.promise;
    });
    const pending = s.collect();
    await reached.promise;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await s.collect()).toEqual({ available: false, reason: "BUSY" });
    drain.resolve();
    expect((await pending).available).toBe(false);
    expect(await s.collect()).toEqual({ available: false, reason: "CANCELLED" });
    expect(s.options.readersWhenIdle).toHaveBeenCalledTimes(1);
    expect(s.captures.every((capture) => capture.whenIdle.mock.calls.length > 0)).toBe(true);
    await expect(s.collector.whenIdle()).rejects.toThrow("PHYSICAL_COLLECTOR_CLEANUP_FAILED");
    await expect(s.collector.dispose()).rejects.toThrow("PHYSICAL_COLLECTOR_CLEANUP_FAILED");
  });
  it("propagates a delayed real drain failure through whenIdle and dispose without releasing the slot early", async () => {
    const s = setup(),
      entered = deferred(),
      release = deferred();
    s.options.readersWhenIdle = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      throw Error("underlying private failure details");
    });
    const pending = s.collect();
    await entered.promise;
    let idleFinished = false,
      disposeFinished = false;
    const idle = s.collector.whenIdle().finally(() => {
      idleFinished = true;
    });
    const disposed = s.collector.dispose().finally(() => {
      disposeFinished = true;
    });
    const idleAssertion = expect(idle).rejects.toThrow(/^PHYSICAL_COLLECTOR_CLEANUP_FAILED$/);
    const disposeAssertion = expect(disposed).rejects.toThrow(/^PHYSICAL_COLLECTOR_CLEANUP_FAILED$/);
    await Promise.resolve();
    expect(idleFinished).toBe(false);
    expect(disposeFinished).toBe(false);
    expect(await s.collect()).toEqual({ available: false, reason: "BUSY" });
    release.resolve();
    expect((await pending).available).toBe(false);
    await Promise.all([idleAssertion, disposeAssertion]);
    expect(idleFinished).toBe(true);
    expect(disposeFinished).toBe(true);
    expect(await s.collect()).toEqual({ available: false, reason: "CANCELLED" });
    await expect(s.collector.whenIdle()).rejects.toThrow(/^PHYSICAL_COLLECTOR_CLEANUP_FAILED$/);
    await expect(s.collector.dispose()).rejects.toThrow(/^PHYSICAL_COLLECTOR_CLEANUP_FAILED$/);
    expect(s.options.probe!.probeTls).toHaveBeenCalledTimes(2);
  });
});
