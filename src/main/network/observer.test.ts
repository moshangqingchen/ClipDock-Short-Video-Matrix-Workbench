import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NETWORK_SETTINGS,
  NETWORK_TIMING,
  type NetworkSettings,
  type NetworkSnapshot,
} from "@shared/network";
import type { Account } from "@shared/types";
import type { ClashReadResult } from "./clash-reader";
import type { DiagnosticResults } from "./diagnostics";
import { NetworkObserver } from "./observer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function kernel(fingerprint = "rules-a"): ClashReadResult {
  return {
    mode: "rule",
    tun: true,
    mixedPort: 10090,
    version: "test-kernel",
    fingerprint,
    rules: [{ type: "MATCH", payload: "", proxy: "DIRECT" }],
  };
}

function reachable(maskedIp = "203.0.*.*"): DiagnosticResults {
  const checkedAt = new Date().toISOString();
  return {
    direct: { state: "reachable", country: "CN", asn: 64512, maskedIp, checkedAt, routeVerified: false },
    proxy: {
      state: "reachable",
      country: "US",
      asn: 64513,
      maskedIp: "198.51.*.*",
      checkedAt,
      routeVerified: false,
    },
  };
}

// Promise-only fakes: no Electron sessions, local sockets or internet requests.
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("NetworkObserver observation lifecycle", () => {
  const observers: NetworkObserver[] = [];

  function fixture(readerFails = false) {
    let settings: NetworkSettings = { ...DEFAULT_NETWORK_SETTINGS };
    const account: Account = {
      id: "00000000-0000-4000-8000-000000000001",
      platformId: "bilibili",
      displayName: "测试账号",
      partition: "persist:sv-account-00000000-0000-4000-8000-000000000001",
      status: "online",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const read = vi.fn<() => Promise<ClashReadResult>>().mockResolvedValue(kernel());
    const reader = vi.fn((_settings: NetworkSettings) => {
      if (readerFails) throw new Error("sentinel private reader construction failure");
      return { read };
    });
    const diagnostics = {
      run: vi.fn<(port: number) => Promise<DiagnosticResults>>().mockResolvedValue(reachable()),
      stop: vi.fn(),
      pause: vi.fn(async () => {}),
      resume: vi.fn(),
      whenIdle: vi.fn(async () => {}),
    };
    const audit = vi.fn();
    const observer = new NetworkObserver({
      accounts: () => [account],
      settings: () => settings,
      reader,
      diagnostics,
      audit,
    });
    const events = vi.fn<(snapshot: NetworkSnapshot) => void>();
    observer.on("snapshot", events);
    observers.push(observer);
    return {
      observer,
      read,
      reader,
      diagnostics,
      events,
      audit,
      account,
      configure(value: NetworkSettings) {
        settings = value;
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
  });
  afterEach(() => {
    observers.splice(0).forEach((observer) => observer.stop());
    vi.useRealTimers();
  });

  it("shares one in-flight controller sample across startup, manual and timer refreshes", async () => {
    const pending = deferred<ClashReadResult>();
    const f = fixture();
    f.read.mockReturnValueOnce(pending.promise);
    f.observer.start();
    const first = f.observer.refresh();
    expect(f.observer.refresh()).toBe(first);
    vi.advanceTimersByTime(NETWORK_TIMING.renewMs * 2);
    expect(f.read).toHaveBeenCalledOnce();
    pending.resolve(kernel());
    await first;
    await settle();
    expect(f.observer.snapshot().controller.readable).toBe(true);
    await f.observer.refresh();
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("keeps config field digests and physical interface details out of IPC snapshots and audit", async () => {
    const f = fixture();
    f.read.mockResolvedValue({
      ...kernel(),
      configFieldHashes: { secret: "private-config-field-digest" },
      directPolicy: {
        kind: "direct",
        interfaceName: "private-physical-interface",
        dialer: "none",
        ipVersion: null,
        policyFingerprint: "private-policy-digest",
        startedAtMono: 1,
        completedAtMono: 2,
      },
      startedAtMono: 1,
      completedAtMono: 2,
    });
    f.observer.start();
    await f.observer.refresh();
    await settle();
    expect(JSON.stringify([f.observer.snapshot(), f.events.mock.calls, f.audit.mock.calls])).not.toMatch(
      /configFieldHashes|directPolicy|private-config-field|private-physical-interface|private-policy-digest/,
    );
  });

  it("discards a late controller reply after settings invalidation and reads the replacement settings", async () => {
    const oldRead = deferred<ClashReadResult>();
    const newRead = deferred<ClashReadResult>();
    const f = fixture();
    f.read.mockReturnValueOnce(oldRead.promise).mockReturnValue(newRead.promise);
    f.observer.start();
    const oldFlight = f.observer.refresh();
    const changed = { controllerUrl: "http://127.0.0.1:9090", diagnosticProxyPort: 7890 };
    f.configure(changed);
    f.observer.invalidate();
    expect(f.observer.snapshot().reason).toBe("NETWORK_CHANGED");
    oldRead.resolve({ ...kernel("obsolete-kernel"), mode: "global" });
    await oldFlight;
    await settle();
    expect(f.reader).toHaveBeenLastCalledWith(changed);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.observer.snapshot().controller.readable).toBe(false);
    expect(f.observer.snapshot().rulesVersion).toBeNull();
    expect(f.events.mock.calls.every(([value]) => value.rulesVersion !== "obsolete-kernel")).toBe(true);
    newRead.resolve(kernel("replacement-kernel"));
    await settle();
    expect(f.observer.snapshot().rulesVersion).toBe("replacement-kernel");
    expect(f.diagnostics.run).toHaveBeenCalledWith(7890);
  });

  it("does not project late diagnostic results after invalidation even when the rules fingerprint repeats", async () => {
    const oldDiagnostic = deferred<DiagnosticResults>();
    const f = fixture();
    f.diagnostics.run.mockReturnValueOnce(oldDiagnostic.promise).mockResolvedValue(reachable("192.0.*.*"));
    f.observer.start();
    await f.observer.refresh();
    expect(f.diagnostics.run).toHaveBeenCalledOnce();
    f.observer.invalidate();
    await settle();
    oldDiagnostic.resolve(reachable("obsolete-diagnostic"));
    await settle();
    expect(f.events.mock.calls.every(([value]) => value.direct.maskedIp !== "obsolete-diagnostic")).toBe(
      true,
    );
    await f.observer.refresh();
    await settle();
    expect(f.observer.snapshot().direct.maskedIp).toBe("192.0.*.*");
  });

  it.each(["resolve", "reject"] as const)(
    "discards an old diagnostic %s after rules change A → B → A",
    async (outcome) => {
      const oldDiagnostic = deferred<DiagnosticResults>();
      const f = fixture();
      f.diagnostics.run.mockReturnValueOnce(oldDiagnostic.promise).mockResolvedValue(reachable("192.0.*.*"));
      f.observer.start();
      await f.observer.refresh();
      f.read.mockResolvedValueOnce(kernel("rules-b"));
      await f.observer.refresh();
      await f.observer.refresh();
      expect(f.observer.snapshot().rulesVersion).toBe("rules-a");
      const eventCount = f.events.mock.calls.length;
      if (outcome === "resolve") oldDiagnostic.resolve(reachable("obsolete-diagnostic"));
      else oldDiagnostic.reject(new Error("obsolete diagnostic failure"));
      await settle();
      expect(f.events).toHaveBeenCalledTimes(eventCount);
      expect(f.observer.snapshot().direct.state).toBe("checking");
      await f.observer.refresh();
      await settle();
      expect(f.observer.snapshot().direct.maskedIp).toBe("192.0.*.*");
    },
  );

  it("does not restore a pre-outage diagnostic when the controller returns with the same rules", async () => {
    const oldDiagnostic = deferred<DiagnosticResults>();
    const f = fixture();
    f.diagnostics.run.mockReturnValueOnce(oldDiagnostic.promise).mockResolvedValue(reachable("192.0.*.*"));
    f.observer.start();
    await f.observer.refresh();
    f.read.mockRejectedValueOnce(new Error("temporary controller outage"));
    await f.observer.refresh();
    await f.observer.refresh();
    const eventCount = f.events.mock.calls.length;
    oldDiagnostic.resolve(reachable("pre-outage-diagnostic"));
    await settle();
    expect(f.events).toHaveBeenCalledTimes(eventCount);
    expect(f.observer.snapshot().direct.state).toBe("checking");
    await f.observer.refresh();
    await settle();
    expect(f.observer.snapshot().direct.maskedIp).toBe("192.0.*.*");
  });

  it("keeps construction-time reader failures contained and never creates evidence", async () => {
    const f = fixture(true);
    expect(() => f.observer.start()).not.toThrow();
    await expect(f.observer.refresh()).resolves.toEqual(
      expect.objectContaining({
        state: "checking",
        reason: "CONTROLLER_UNAVAILABLE",
        rulesVersion: null,
      }),
    );
    const value = f.observer.snapshot();
    expect(value.controller.readable).toBe(false);
    expect(value.direct.state).not.toBe("reachable");
    expect(value.proxy.state).not.toBe("reachable");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.diagnostics.run).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toContain("sentinel private reader");
  });

  it("clears old evidence when rebuilding a reader throws during configuration change", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    expect(f.observer.snapshot().direct.state).toBe("reachable");
    f.reader.mockImplementationOnce(() => {
      throw new Error("secret-bearing invalid controller configuration");
    });
    expect(() => f.observer.invalidate()).not.toThrow();
    await settle();
    const value = f.observer.snapshot();
    expect(value.controller.readable).toBe(false);
    expect(value.rulesVersion).toBeNull();
    expect(value.direct.state).not.toBe("reachable");
    expect(value.proxy.state).not.toBe("reachable");
    expect(value.accounts.every((account) => account.state !== "allowed")).toBe(true);
    expect(JSON.stringify(value)).not.toContain("secret-bearing");
  });

  it("keeps business eligibility unverified when rules and both anonymous endpoints look healthy", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    const value = f.observer.snapshot();
    expect(value.direct.state).toBe("reachable");
    expect(value.proxy.state).toBe("reachable");
    expect(value.targets.every((target) => target.route === "direct")).toBe(true);
    expect(value.state).toBe("checking");
    expect(value.enforcement).toBe("observe");
    expect(value.reason).toBe("CONTEXT_UNVERIFIED");
    expect(value.validation).toEqual({ context: false, loginCatalog: false, cancellation: false });
    expect(value.accounts).toEqual([expect.objectContaining({ state: "checking", proofExpiresAt: null })]);
    expect(f.account.status).toBe("online");
    value.accounts[0].state = "allowed";
    expect(f.observer.snapshot().accounts[0].state).toBe("checking");
  });

  it("clears prior reachability on controller failure without exposing provider errors", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    expect(f.observer.snapshot().direct.state).toBe("reachable");
    f.read.mockRejectedValueOnce(new Error("Authorization: sentinel-secret"));
    await f.observer.refresh();
    const value = f.observer.snapshot();
    expect(value.controller.readable).toBe(false);
    expect(value.reason).toBe("CONTROLLER_UNAVAILABLE");
    expect(value.direct.state).not.toBe("reachable");
    expect(value.proxy.state).not.toBe("reachable");
    expect(value.accounts.every((account) => account.state !== "allowed")).toBe(true);
    expect(JSON.stringify(value)).not.toContain("sentinel-secret");
    expect(f.diagnostics.stop).toHaveBeenCalled();
  });

  it("clears old anonymous green lights when a new diagnostic round rejects", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    expect(f.observer.snapshot().direct.state).toBe("reachable");
    vi.setSystemTime(Date.now() + NETWORK_TIMING.egressRefreshMs + 1);
    f.diagnostics.run.mockRejectedValueOnce(new Error("raw private diagnostic error"));
    await f.observer.refresh();
    await settle();
    const value = f.observer.snapshot();
    expect(value.direct.state).not.toBe("reachable");
    expect(value.proxy.state).not.toBe("reachable");
    expect(value.accounts.every((account) => account.state !== "allowed")).toBe(true);
    expect(JSON.stringify(value)).not.toContain("raw private diagnostic error");
  });

  it("expires old egress samples even when fresh controller samples keep arriving", async () => {
    const nextDiagnostic = deferred<DiagnosticResults>();
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    expect(f.observer.snapshot().direct.state).toBe("reachable");
    vi.setSystemTime(Date.now() + NETWORK_TIMING.egressTtlMs + 1);
    f.diagnostics.run.mockReturnValueOnce(nextDiagnostic.promise);
    await f.observer.refresh();
    const value = f.observer.snapshot();
    expect(value.controller.readable).toBe(true);
    expect(value.checkedAt).toBe(new Date().toISOString());
    expect(value.direct.state).not.toBe("reachable");
    expect(value.proxy.state).not.toBe("reachable");
    nextDiagnostic.resolve(reachable());
    await settle();
    expect(f.observer.snapshot().direct.state).toBe("reachable");
    expect(f.observer.snapshot().accounts[0].state).toBe("checking");
  });

  it("publishes nothing after stop, including late reads, late diagnostics and invalidation", async () => {
    const pendingRead = deferred<ClashReadResult>();
    const pendingDiagnostic = deferred<DiagnosticResults>();
    const f = fixture();
    f.diagnostics.run.mockReturnValueOnce(pendingDiagnostic.promise);
    f.observer.start();
    await f.observer.refresh();
    f.read.mockReturnValueOnce(pendingRead.promise);
    const readFlight = f.observer.refresh();
    f.observer.stop();
    const eventCount = f.events.mock.calls.length;
    pendingRead.resolve(kernel("stopped-read"));
    pendingDiagnostic.resolve(reachable("stopped-diagnostic"));
    await readFlight;
    await settle();
    f.observer.invalidate();
    vi.advanceTimersByTime(NETWORK_TIMING.renewMs * 2);
    await f.observer.refresh();
    expect(f.events).toHaveBeenCalledTimes(eventCount);
    expect(f.observer.snapshot().state).toBe("checking");
    expect(f.observer.snapshot().direct.state).not.toBe("reachable");
  });

  it("keeps controller timer and manual reads current while anonymous diagnostics are paused", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    const calls = f.diagnostics.run.mock.calls.length;
    const release = await f.observer.pauseDiagnostics();
    const reads = f.read.mock.calls.length;
    vi.setSystemTime(Date.now() + NETWORK_TIMING.egressRefreshMs + 1);
    await f.observer.refresh();
    vi.advanceTimersByTime(NETWORK_TIMING.renewMs);
    await settle();
    expect(f.read.mock.calls.length).toBeGreaterThan(reads);
    expect(f.observer.snapshot().controller.readable).toBe(true);
    expect(f.diagnostics.run).toHaveBeenCalledTimes(calls);
    expect(f.observer.snapshot().direct.state).not.toBe("reachable");
    release();
    expect(f.diagnostics.run).toHaveBeenCalledTimes(calls);
    await f.observer.refresh();
    await settle();
    expect(f.diagnostics.run).toHaveBeenCalledTimes(calls + 1);
  });

  it.each(["resolve", "reject"] as const)(
    "drains old diagnostics and discards their %s without pausing controller reads",
    async (outcome) => {
      const f = fixture(),
        old = deferred<DiagnosticResults>(),
        native = deferred<void>();
      f.diagnostics.run.mockReturnValueOnce(old.promise);
      f.diagnostics.whenIdle.mockReturnValue(native.promise);
      f.observer.start();
      await f.observer.refresh();
      let quiet = false;
      const pause = f.observer.pauseDiagnostics().then((release) => {
        quiet = true;
        return release;
      });
      await settle();
      expect(quiet).toBe(false);
      const readCount = f.read.mock.calls.length;
      await f.observer.refresh();
      expect(f.read).toHaveBeenCalledTimes(readCount + 1);
      if (outcome === "resolve") old.resolve(reachable("old-never-project"));
      else old.reject(Error("old-private-error"));
      await settle();
      expect(quiet).toBe(false);
      native.resolve();
      const release = await pause;
      expect(quiet).toBe(true);
      expect(JSON.stringify(f.events.mock.calls)).not.toContain("old-never-project");
      expect(JSON.stringify(f.events.mock.calls)).not.toContain("old-private-error");
      release();
      expect(f.diagnostics.run).toHaveBeenCalledTimes(1);
    },
  );

  it("nests idempotent release handles and preserves the original next-sample deadline", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    const first = await f.observer.pauseDiagnostics();
    const second = await f.observer.pauseDiagnostics();
    expect(f.diagnostics.pause).toHaveBeenCalledTimes(1);
    first();
    first();
    expect(f.diagnostics.resume).not.toHaveBeenCalled();
    await f.observer.refresh();
    expect(f.diagnostics.run).toHaveBeenCalledTimes(1);
    second();
    second();
    expect(f.diagnostics.resume).toHaveBeenCalledTimes(1);
    await f.observer.refresh();
    await settle();
    expect(f.diagnostics.run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + NETWORK_TIMING.egressRefreshMs);
    await f.observer.refresh();
    await settle();
    expect(f.diagnostics.run).toHaveBeenCalledTimes(2);
  });

  it("shares a pending native pause across multiple handles", async () => {
    const f = fixture(),
      native = deferred<void>();
    f.diagnostics.pause.mockReturnValue(native.promise);
    const first = f.observer.pauseDiagnostics(),
      second = f.observer.pauseDiagnostics();
    expect(f.diagnostics.pause).toHaveBeenCalledTimes(1);
    f.observer.start();
    await f.observer.refresh();
    expect(f.diagnostics.run).not.toHaveBeenCalled();
    native.resolve();
    const [releaseFirst, releaseSecond] = await Promise.all([first, second]);
    releaseSecond();
    expect(f.diagnostics.resume).not.toHaveBeenCalled();
    releaseFirst();
    expect(f.diagnostics.resume).toHaveBeenCalledTimes(1);
    expect(f.diagnostics.run).not.toHaveBeenCalled();
  });

  it.each(["snapshot listener", "native pause callback"])(
    "reserves pause before %s synchronously reenters",
    async (kind) => {
      const f = fixture(),
        native = deferred<void>();
      f.observer.start();
      await f.observer.refresh();
      await settle();
      const nested: Array<Promise<() => void>> = [];
      if (kind === "snapshot listener") {
        f.diagnostics.pause.mockReturnValue(native.promise);
        f.observer.once("snapshot", () => {
          nested.push(f.observer.pauseDiagnostics());
        });
      } else {
        f.diagnostics.pause.mockImplementation(() => {
          nested.push(f.observer.pauseDiagnostics());
          return native.promise;
        });
      }
      let outerQuiet = false,
        innerQuiet = false;
      const outer = f.observer.pauseDiagnostics().then((release) => {
        outerQuiet = true;
        return release;
      });
      expect(nested).toHaveLength(1);
      const inner = nested[0].then((release) => {
        innerQuiet = true;
        return release;
      });
      expect(f.diagnostics.pause).toHaveBeenCalledTimes(1);
      await settle();
      expect(outerQuiet).toBe(false);
      expect(innerQuiet).toBe(false);
      vi.setSystemTime(Date.now() + NETWORK_TIMING.egressRefreshMs + 1);
      await f.observer.refresh();
      expect(f.diagnostics.run).toHaveBeenCalledTimes(1);
      native.resolve();
      const [releaseOuter, releaseInner] = await Promise.all([outer, inner]);
      releaseInner();
      releaseInner();
      expect(f.diagnostics.resume).not.toHaveBeenCalled();
      releaseOuter();
      releaseOuter();
      expect(f.diagnostics.resume).toHaveBeenCalledTimes(1);
      expect(f.diagnostics.run).toHaveBeenCalledTimes(1);
    },
  );

  it("a nested handle waits for newer stop cleanup rather than borrowing an old idle result", async () => {
    const f = fixture();
    const first = await f.observer.pauseDiagnostics();
    const native = deferred<void>();
    f.diagnostics.whenIdle.mockReturnValue(native.promise);
    f.observer.invalidate();
    let quiet = false;
    const next = f.observer.pauseDiagnostics().then((release) => {
      quiet = true;
      return release;
    });
    await settle();
    expect(quiet).toBe(false);
    first();
    expect(f.diagnostics.resume).not.toHaveBeenCalled();
    native.resolve();
    const release = await next;
    release();
    expect(f.diagnostics.resume).toHaveBeenCalledTimes(1);
  });

  it("release after stop does not restart the observer or its requests", async () => {
    const f = fixture();
    f.observer.start();
    await f.observer.refresh();
    await settle();
    const release = await f.observer.pauseDiagnostics();
    f.observer.stop();
    const reads = f.read.mock.calls.length,
      requests = f.diagnostics.run.mock.calls.length;
    release();
    vi.advanceTimersByTime(NETWORK_TIMING.egressRefreshMs * 2);
    await f.observer.refresh();
    await settle();
    expect(f.read).toHaveBeenCalledTimes(reads);
    expect(f.diagnostics.run).toHaveBeenCalledTimes(requests);
  });

  it.each(["pause", "resume", "whenIdle"] as const)(
    "refuses a quiet claim with missing %s capability",
    async (capability) => {
      const f = fixture();
      delete (f.diagnostics as Partial<typeof f.diagnostics>)[capability];
      await expect(f.observer.pauseDiagnostics()).rejects.toThrow("DIAGNOSTICS_QUIET_UNAVAILABLE");
      expect(f.diagnostics.run).not.toHaveBeenCalled();
    },
  );

  it.each(["pause", "whenIdle"] as const)(
    "keeps anonymous work closed after failed %s drain but still reads controller",
    async (method) => {
      const f = fixture();
      f.observer.start();
      await f.observer.refresh();
      await settle();
      f.diagnostics[method].mockRejectedValue(Error("private-native-cleanup"));
      await expect(f.observer.pauseDiagnostics()).rejects.toThrow("DIAGNOSTICS_QUIET_UNAVAILABLE");
      const reads = f.read.mock.calls.length;
      vi.setSystemTime(Date.now() + NETWORK_TIMING.egressRefreshMs + 1);
      await f.observer.refresh();
      expect(f.read).toHaveBeenCalledTimes(reads + 1);
      expect(f.diagnostics.run).toHaveBeenCalledTimes(1);
      expect(f.diagnostics.resume).not.toHaveBeenCalled();
      await expect(f.observer.pauseDiagnostics()).rejects.toThrow("DIAGNOSTICS_QUIET_UNAVAILABLE");
    },
  );
});
