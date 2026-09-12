import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AccountProofScope, ProofTarget } from "./direct-proof";
import { EgressGate, type GateClock } from "./egress-gate";
import { ProofCoordinator, type ProofScopeEvent, type ProofScopeSource } from "./proof-coordinator";
import type { ProofCollectionRequest, ProofCollectionResult, ProofEvidenceSource } from "./proof-issuer";
import { NetworkRuntime, type NetworkSession } from "./runtime";

const target: ProofTarget = {
  protocol: "https:",
  host: "member.bilibili.com",
  port: 443,
  addressFamily: "ipv4",
};
const scope: AccountProofScope = {
  accountId: "account",
  platformId: "bilibili",
  contextId: "ready-session-context",
  catalogVersion: "synthetic-reviewed-scope",
  catalogReviewed: true,
  targets: [target],
};
const network = { controllerReadable: true, mode: "rule", tun: true, rulesVersion: "current-rules" };

class ScopeSource implements ProofScopeSource {
  readonly rows = new Map<string, AccountProofScope>();
  readonly listeners = new Set<(event: ProofScopeEvent) => void>();
  listProofScopes = vi.fn(() => [...this.rows.values()].map((row) => structuredClone(row)));
  subscribeProofScopes(listener: (event: ProofScopeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  upsert(row: AccountProofScope) {
    this.rows.set(row.accountId, structuredClone(row));
    for (const listener of this.listeners) listener({ type: "upsert", scope: row });
  }
  remove(accountId: string) {
    if (!this.rows.delete(accountId)) return;
    for (const listener of this.listeners) listener({ type: "remove", accountId });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function evidence(request: ProofCollectionRequest): ProofCollectionResult {
  const at = request.startedAtMono;
  return {
    kind: "evidence",
    requestId: request.requestId,
    batch: {
      sampleId: request.requestId,
      generation: request.generation,
      rulesVersion: request.rulesVersion,
      contextId: request.scope.contextId,
      catalogVersion: request.scope.catalogVersion,
      observedAtMono: at,
      targets: request.scope.targets.map((target) => ({
        target,
        route: {
          source: "correlated-connection",
          contextId: request.scope.contextId,
          rulesVersion: request.rulesVersion,
          ruleDecision: "direct",
          connectionId: `synthetic-${request.requestId}`,
          correlationVerified: true,
          chains: ["DIRECT"],
          observedAtMono: at,
        },
        egress: {
          target,
          contextId: request.scope.contextId,
          ip: "192.0.2.1",
          countryCode: "CN",
          source: "synthetic-test-only",
          applicabilityVerified: true,
          observedAtMono: at,
        },
        tls: { verified: true, observedAtMono: at },
        dns: { status: "resolved", addressFamily: target.addressFamily, observedAtMono: at },
      })),
    },
  };
}

describe("ProofCoordinator main-process lifecycle bridge", () => {
  const owned: { coordinator: ProofCoordinator; gate: EgressGate }[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const item of owned.splice(0)) {
      item.coordinator.dispose();
      item.gate.dispose();
    }
    vi.useRealTimers();
  });
  const flush = async () => {
    for (let n = 0; n < 16; n++) await Promise.resolve();
  };
  function fixture(
    options: { source?: ProofEvidenceSource | null; enforcement?: "strict" | "observe" } = {},
  ) {
    const clock: GateClock = {
      monotonicMs: () => Date.now(),
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    const gate = new EgressGate({
      clock,
      enforcement: options.enforcement,
      timing: { controllerTtlMs: 120_000 },
    });
    const scopes = new ScopeSource();
    scopes.upsert(scope);
    const collect = vi
      .fn<ProofEvidenceSource["collect"]>()
      .mockImplementation(async (request) => evidence(request));
    const coordinator = new ProofCoordinator({
      gate,
      scopes,
      source: options.source === null ? undefined : (options.source ?? { collect }),
      issuerOptions: { clock },
    });
    owned.push({ coordinator, gate });
    const activate = async () => {
      gate.setNetworkState(network);
      coordinator.start();
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(true);
    };
    return { coordinator, gate, scopes, collect, activate };
  }

  it("constructs without starting and never invents a successful default source", async () => {
    const f = fixture({ source: null });
    f.gate.setNetworkState(network);
    await flush();
    expect(f.scopes.listProofScopes).not.toHaveBeenCalled();
    expect(f.scopes.listeners.size).toBe(0);
    f.coordinator.start();
    expect((await f.coordinator.request(scope.accountId)).reason).toBe("EGRESS_UNVERIFIED");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
  });

  it("uses committed network recovery and ignores UI state notifications rather than recursing", async () => {
    const f = fixture();
    f.coordinator.start();
    await flush();
    expect(f.collect).not.toHaveBeenCalled();
    f.gate.setNetworkState(network);
    await flush();
    expect(f.collect).toHaveBeenCalledOnce();
    for (let i = 0; i < 10; i++) {
      f.gate.emit("state", f.gate.snapshot());
      f.scopes.upsert(scope);
      f.gate.setNetworkState(network);
    }
    await flush();
    expect(f.collect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.collect).toHaveBeenCalledTimes(2);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(true);
    expect(f.scopes.listProofScopes.mock.calls.length).toBeLessThan(5);
  });

  it("does not register in global mode and requires two new rounds after OS invalidation", async () => {
    const f = fixture();
    f.gate.setNetworkState({ ...network, mode: "global" });
    f.coordinator.start();
    await flush();
    expect(f.collect).not.toHaveBeenCalled();
    f.gate.setNetworkState(network);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    const oldGeneration = f.gate.generation;
    f.gate.invalidate("NETWORK_CHANGED");
    expect(lease.signal.aborted).toBe(true);
    expect(f.coordinator.snapshot().accounts).toEqual([]);
    f.gate.setNetworkState(network);
    await flush();
    expect(f.collect.mock.calls.at(-1)?.[0].generation).toBeGreaterThan(oldGeneration);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(true);
  });

  it("waits for Runtime's ready scope after asynchronous cleanup and does not duplicate revocation", async () => {
    const f = fixture();
    await f.activate();
    const cleanup = deferred<void>();
    const revoke = vi.fn(() => {
      f.scopes.remove(scope.accountId);
      void cleanup.promise.then(() => f.scopes.upsert(scope));
    });
    f.gate.on("revoked", revoke);
    f.gate.revoke(scope.accountId, "NETWORK_CHANGED");
    expect(revoke).toHaveBeenCalledOnce();
    expect(f.coordinator.snapshot().accounts).toEqual([]);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.collect).toHaveBeenCalledTimes(2);
    cleanup.resolve();
    await flush();
    expect(f.collect).toHaveBeenCalledTimes(3);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(true);
    f.gate.removeListener("revoked", revoke);
  });

  it("cancels a removed scope and ignores its late callback without resurrecting an account", async () => {
    const pending = deferred<ProofCollectionResult>();
    let request!: ProofCollectionRequest;
    const f = fixture({
      source: {
        collect: async (input) => {
          request = input;
          return pending.promise;
        },
      },
    });
    f.gate.setNetworkState(network);
    f.coordinator.start();
    f.gate.unregisterAccount(scope.accountId);
    f.scopes.remove(scope.accountId);
    expect(request.signal.aborted).toBe(true);
    pending.resolve(evidence(request));
    await flush();
    expect(f.gate.registeredScopes()).toEqual([]);
    expect(f.coordinator.snapshot().accounts).toEqual([]);
  });

  it("retires old scope evidence before sampling a changed target and context", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    const replacement = {
      ...scope,
      contextId: "new-session-context",
      targets: [{ ...target, host: "www.bilibili.com" }],
    };
    f.gate.registerAccount(replacement); // Runtime commits its scope before announcing readiness.
    f.scopes.upsert(replacement);
    expect(lease.signal.aborted).toBe(true);
    await flush();
    expect(f.collect.mock.calls.at(-1)?.[0].scope).toEqual(replacement);
    expect(f.gate.checkAction(scope.accountId, replacement.contextId).allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.gate.checkAction(scope.accountId, replacement.contextId).allowed).toBe(true);
  });

  it("source loss clears every binding and recovery waits for a current controller observation", async () => {
    let unavailable = false;
    const collect = vi
      .fn<ProofEvidenceSource["collect"]>()
      .mockImplementation(async (request) =>
        unavailable ? { kind: "unavailable", reason: "CONTROLLER_UNAVAILABLE" } : evidence(request),
      );
    const f = fixture({ source: { collect } });
    await f.activate();
    unavailable = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.gate.currentProofVersion()).toBeNull();
    expect(f.coordinator.snapshot().accounts).toEqual([]);
    unavailable = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(collect).toHaveBeenCalledTimes(3);
    f.gate.setNetworkState(network);
    await flush();
    expect(collect).toHaveBeenCalledTimes(4);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
  });

  it("stop withdraws leases before restart and queued lifecycle callbacks cannot restart work", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    f.scopes.upsert(scope); // Queued reconciliation must be invalidated by stop.
    f.coordinator.stop();
    expect(lease.signal.aborted).toBe(true);
    expect(f.scopes.listeners.size).toBe(0);
    expect(f.gate.listenerCount("network")).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.collect).toHaveBeenCalledTimes(2);
    f.coordinator.start();
    await flush();
    expect(f.collect).toHaveBeenCalledTimes(3);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
    f.coordinator.dispose();
    f.scopes.upsert(scope);
    f.gate.setNetworkState(network);
    await flush();
    expect(f.collect).toHaveBeenCalledTimes(3);
    expect(() => f.coordinator.start()).toThrow("disposed");
  });

  it("fails closed when the Runtime scope projection becomes unreadable", async () => {
    const f = fixture();
    await f.activate();
    f.scopes.listProofScopes.mockImplementation(() => {
      throw new Error("internal detail");
    });
    f.gate.setNetworkState(network);
    await flush();
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
    expect(f.coordinator.snapshot().accounts).toEqual([]);
  });

  it("observation results do not gain enforcement authority from coordinator wiring", async () => {
    const f = fixture({ enforcement: "observe" });
    await f.activate();
    expect(f.gate.checkAction(scope.accountId, scope.contextId)).toMatchObject({
      allowed: true,
      enforce: false,
      cancel: false,
    });
    expect(f.gate.acquireLease(scope.accountId, scope.contextId).lease).toBeNull();
    f.coordinator.stop();
    expect(f.gate.checkAction(scope.accountId, scope.contextId).cancel).toBe(false);
  });

  it("integrates real Runtime readiness, waits for cleanup, and retains a fresh warm-up", async () => {
    const clock: GateClock = {
      monotonicMs: () => Date.now(),
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    const gate = new EgressGate({ clock, timing: { controllerTtlMs: 120_000 } });
    gate.setNetworkState(network);
    const initialize = deferred<void>();
    const cleanup = deferred<void>();
    const session = Object.assign(new EventEmitter(), {
      setProxy: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined).mockReturnValueOnce(initialize.promise),
      clearHostResolverCache: vi.fn().mockResolvedValue(undefined),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    });
    const suspend = vi.fn();
    const runtime = new NetworkRuntime({
      enforcement: "strict",
      gate,
      networkReadiness: () => true,
      onSuspend: suspend,
      resolveScope: (input) => ({ ...scope, contextId: input.contextId }),
    });
    const collect = vi
      .fn<ProofEvidenceSource["collect"]>()
      .mockImplementation(async (request) => evidence(request));
    const coordinator = new ProofCoordinator({
      gate,
      scopes: runtime,
      source: { collect },
      issuerOptions: { clock },
    });
    try {
      coordinator.start();
      const registration = runtime.registerSession(
        session as unknown as NetworkSession,
        scope.accountId,
        scope.platformId,
      );
      await flush();
      expect(collect).not.toHaveBeenCalled();
      initialize.resolve();
      await registration.ready;
      await flush();
      expect(collect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.check(scope.accountId).allowed).toBe(true);
      session.closeAllConnections.mockReturnValueOnce(cleanup.promise);
      gate.revoke(scope.accountId, "NETWORK_CHANGED");
      await flush();
      expect(runtime.listProofScopes()).toEqual([]);
      expect(suspend).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(collect).toHaveBeenCalledTimes(2);
      cleanup.resolve();
      await flush();
      expect(collect).toHaveBeenCalledTimes(3);
      expect(runtime.check(scope.accountId).allowed).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.check(scope.accountId).allowed).toBe(true);
    } finally {
      initialize.resolve();
      cleanup.resolve();
      coordinator.dispose();
      await runtime.dispose();
    }
  });

  it("real Runtime cleanup cannot erase the failed source's retry interval", async () => {
    const clock: GateClock = {
      monotonicMs: () => Date.now(),
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    const gate = new EgressGate({ clock, timing: { controllerTtlMs: 120_000 } });
    gate.setNetworkState(network);
    const session = Object.assign(new EventEmitter(), {
      setProxy: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
      clearHostResolverCache: vi.fn().mockResolvedValue(undefined),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    });
    const suspend = vi.fn();
    const runtime = new NetworkRuntime({
      enforcement: "strict",
      gate,
      networkReadiness: () => true,
      onSuspend: suspend,
      resolveScope: (input) => ({ ...scope, contextId: input.contextId }),
    });
    const collect = vi
      .fn<ProofEvidenceSource["collect"]>()
      .mockResolvedValue({ kind: "unavailable", reason: "EGRESS_UNVERIFIED" });
    const coordinator = new ProofCoordinator({
      gate,
      scopes: runtime,
      source: { collect },
      issuerOptions: { clock },
    });
    try {
      coordinator.start();
      await runtime.registerSession(session as unknown as NetworkSession, scope.accountId, scope.platformId)
        .ready;
      await flush();
      expect(collect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(collect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(collect).toHaveBeenCalledTimes(3);
      expect(suspend).toHaveBeenCalledTimes(3);
      expect(runtime.check(scope.accountId).allowed).toBe(false);
      expect(coordinator.snapshot().activeSources).toBe(0);
    } finally {
      coordinator.dispose();
      await runtime.dispose();
    }
  });
});
