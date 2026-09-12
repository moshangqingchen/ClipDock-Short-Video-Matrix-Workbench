import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkingNetworkSnapshot, NETWORK_TIMING, type NetworkSnapshot } from "@shared/network";

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), refresh: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock("@renderer/lib/api", () => ({
  api: { network: { snapshot: transport.snapshot, refresh: transport.refresh }, on: transport.on },
}));

import { isGlobalProxyEnabled, startNetworkSubscription, useNetwork } from "./network";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshot(instanceId: string, sequence: number): NetworkSnapshot {
  return {
    ...checkingNetworkSnapshot(),
    instanceId,
    sequence,
    state: "domestic",
    reason: "READY",
    checkedAt: new Date().toISOString(),
    accounts: [
      {
        accountId: "test-account",
        state: "allowed",
        reason: "READY",
        generation: sequence,
        checkedAt: new Date().toISOString(),
        proofExpiresAt: new Date(Date.now() + NETWORK_TIMING.proofTtlMs).toISOString(),
      },
    ],
  };
}

function exclusiveSnapshot(sequence: number): NetworkSnapshot {
  return {
    ...snapshot("exclusive-main", sequence),
    enforcement: "strict",
    policy: "exclusive",
    switching: {
      state: "domestic",
      proxy: "off",
      reason: "READY",
      generation: sequence,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 2000).toISOString(),
    },
  };
}

it.each([
  ["dual", "on", true],
  ["overseas", "on", true],
  ["dual", "off", false],
  ["dual", "unknown", false],
  ["domestic", "off", false],
  ["checking", "on", false],
  ["unavailable", "on", false],
] as const)("enables global UI only for a ready proxy: %s / %s", (state, proxy, expected) => {
  const switching = { ...exclusiveSnapshot(1).switching!, state, proxy };
  expect(isGlobalProxyEnabled(switching)).toBe(expected);
  expect(isGlobalProxyEnabled(undefined)).toBe(false);
});

describe("transient renderer network state", () => {
  let push: (value: NetworkSnapshot) => void;
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
    vi.clearAllMocks();
    transport.snapshot.mockResolvedValue(checkingNetworkSnapshot());
    transport.refresh.mockResolvedValue(checkingNetworkSnapshot());
    transport.on.mockImplementation((_event, listener: (value: NetworkSnapshot) => void) => {
      push = listener;
      return transport.off;
    });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("starts checking and ignores an older initial reply after a main-process push", async () => {
    const initial = deferred<NetworkSnapshot>();
    transport.snapshot.mockReturnValue(initial.promise);
    stop = startNetworkSubscription();
    expect(useNetwork.getState().snapshot.state).toBe("checking");
    expect(transport.on).toHaveBeenCalledWith("network-state", expect.any(Function));
    push(snapshot("new-main", 7));
    initial.resolve(snapshot("old-main", 90));
    await initial.promise;
    expect(useNetwork.getState().snapshot.instanceId).toBe("new-main");
    expect(useNetwork.getState().snapshot.sequence).toBe(7);
  });

  it.each(["domestic", "overseas", "dual"] as const)(
    "keeps startup presentation separate from permission until a %s decision arrives",
    async (state) => {
      stop = startNetworkSubscription();
      await Promise.resolve();
      expect(useNetwork.getState().startupPending).toBe(true);
      expect(useNetwork.getState().snapshot.state).toBe("checking");
      expect(useNetwork.getState().snapshot.accounts).toEqual([]);
      const warming = {
        ...exclusiveSnapshot(1),
        state: "checking" as const,
        reason: "NETWORK_CHANGED" as const,
        accounts: [],
      };
      warming.switching = {
        ...warming.switching!,
        state: "checking",
        proxy: "unknown",
        reason: "NETWORK_CHANGED",
        checkedAt: null,
        expiresAt: null,
      };
      push(warming);
      expect(useNetwork.getState().startupPending).toBe(true);
      const ready = exclusiveSnapshot(2);
      ready.policy = state === "dual" ? "rule-split" : "exclusive";
      ready.state = state;
      ready.switching!.state = state;
      ready.switching!.proxy = state === "domestic" ? "off" : "on";
      ready.switching!.reason = state === "domestic" ? "READY" : "PROXY_ENABLED";
      push(ready);
      expect(useNetwork.getState().startupPending).toBe(false);
      expect(useNetwork.getState().snapshot.switching?.state).toBe(state);
      push({ ...warming, sequence: 3 });
      expect(useNetwork.getState().startupPending).toBe(false);
    },
  );

  it("ends the default startup presentation when detection or IPC fails", async () => {
    stop = startNetworkSubscription();
    await Promise.resolve();
    push({ ...checkingNetworkSnapshot(), instanceId: "main", sequence: 1, reason: "PROXY_STATE_UNKNOWN" });
    expect(useNetwork.getState().startupPending).toBe(false);
    stop();
    transport.snapshot.mockRejectedValue(new Error("unavailable"));
    stop = startNetworkSubscription();
    await Promise.resolve();
    await Promise.resolve();
    expect(useNetwork.getState().startupPending).toBe(false);
    expect(useNetwork.getState().error).toBe("无法获取主进程网络状态，请重试");
  });

  it("rejects out-of-order sequence numbers and retired main-process instances", async () => {
    stop = startNetworkSubscription();
    await Promise.resolve();
    push(snapshot("main-a", 4));
    push(snapshot("main-a", 3));
    expect(useNetwork.getState().snapshot.sequence).toBe(4);
    push(snapshot("main-b", 1));
    push(snapshot("main-a", 99));
    expect(useNetwork.getState().snapshot.instanceId).toBe("main-b");
    expect(useNetwork.getState().snapshot.sequence).toBe(1);
  });

  it("expires green displays without waiting for another IPC event", async () => {
    stop = startNetworkSubscription();
    await Promise.resolve();
    push(snapshot("main", 1));
    vi.advanceTimersByTime(NETWORK_TIMING.proofTtlMs + 1);
    const state = useNetwork.getState().snapshot;
    expect(state.state).toBe("checking");
    expect(state.reason).toBe("PROOF_EXPIRED");
    expect(state.accounts[0].state).toBe("checking");
    expect(state.direct.routeVerified).toBe(false);
    push(snapshot("main", 1));
    expect(useNetwork.getState().snapshot.state).toBe("checking");
  });

  it("uses an earlier account proof expiry and rejects already expired snapshots", async () => {
    stop = startNetworkSubscription();
    await Promise.resolve();
    const next = snapshot("main", 1);
    next.accounts[0].proofExpiresAt = new Date(Date.now() + 1000).toISOString();
    push(next);
    vi.advanceTimersByTime(1001);
    expect(useNetwork.getState().snapshot.reason).toBe("PROOF_EXPIRED");
    const stale = snapshot("main", 2);
    stale.checkedAt = new Date(Date.now() - NETWORK_TIMING.proofTtlMs - 1).toISOString();
    push(stale);
    expect(useNetwork.getState().snapshot.state).toBe("checking");
  });

  it("cleans up subscriptions and discards replies after disposal", async () => {
    const initial = deferred<NetworkSnapshot>();
    transport.snapshot.mockReturnValue(initial.promise);
    stop = startNetworkSubscription();
    push(snapshot("main", 1));
    stop();
    expect(transport.off).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(useNetwork.getState().snapshot.instanceId).toBe("");
    initial.resolve(snapshot("main", 2));
    await initial.promise;
    push(snapshot("main", 3));
    expect(useNetwork.getState().snapshot.state).toBe("checking");
    expect(useNetwork.getState().snapshot.accounts).toEqual([]);
  });

  it("does not let a failed old request erase a newer push or expose exception details", async () => {
    const initial = deferred<NetworkSnapshot>();
    transport.snapshot.mockReturnValue(initial.promise);
    stop = startNetworkSubscription();
    push(snapshot("main", 5));
    initial.reject(new Error("sensitive raw error"));
    await initial.promise.catch(() => undefined);
    expect(useNetwork.getState().snapshot.sequence).toBe(5);
    expect(useNetwork.getState().error).toBeNull();
    transport.refresh.mockRejectedValue(new Error("sensitive raw error"));
    await useNetwork.getState().refresh();
    expect(useNetwork.getState().snapshot.state).toBe("checking");
    expect(useNetwork.getState().error).toBe("无法获取主进程网络状态，请重试");
  });

  it("expires the exclusive switching projection before the longer account proof", async () => {
    stop = startNetworkSubscription();
    await Promise.resolve();
    push(exclusiveSnapshot(1));
    expect(useNetwork.getState().snapshot.switching?.state).toBe("domestic");
    vi.advanceTimersByTime(2000);
    const expired = useNetwork.getState().snapshot;
    expect(expired.policy).toBe("exclusive");
    expect(expired.enforcement).toBe("strict");
    expect(expired.state).toBe("checking");
    expect(expired.switching).toMatchObject({
      state: "checking",
      proxy: "unknown",
      reason: "PROOF_EXPIRED",
      expiresAt: null,
    });
    expect(expired.accounts[0].state).toBe("checking");
    push(exclusiveSnapshot(1));
    expect(useNetwork.getState().snapshot.switching?.state).toBe("checking");
  });

  it.each([null, "2026-09-06T12:00:00.000Z"])(
    "uses the actual switching time when the historical observer time is %s",
    async (checkedAt) => {
      stop = startNetworkSubscription();
      await Promise.resolve();
      const value = exclusiveSnapshot(1);
      value.checkedAt = checkedAt;
      push(value);
      expect(useNetwork.getState().snapshot.switching?.state).toBe("domestic");
      vi.advanceTimersByTime(2000);
      expect(useNetwork.getState().snapshot.switching?.state).toBe("checking");
    },
  );

  it.each(["missing", "expired", "invalid"] as const)(
    "does not show an exclusive allowance with %s switching validity",
    async (kind) => {
      stop = startNetworkSubscription();
      await Promise.resolve();
      const value = exclusiveSnapshot(1);
      if (kind === "missing") delete value.switching;
      else
        value.switching!.expiresAt =
          kind === "expired" ? new Date(Date.now() - 1).toISOString() : "not-a-time";
      push(value);
      expect(useNetwork.getState().snapshot.policy).toBe("exclusive");
      expect(useNetwork.getState().snapshot.switching?.state).toBe("checking");
      expect(useNetwork.getState().snapshot.accounts[0].state).toBe("checking");
    },
  );

  it("keeps exclusive checking after a failed refresh and starts a new subscription without old green state", async () => {
    stop = startNetworkSubscription();
    await Promise.resolve();
    push(exclusiveSnapshot(1));
    transport.refresh.mockRejectedValue(new Error("private controller error"));
    await useNetwork.getState().refresh();
    expect(useNetwork.getState().snapshot.policy).toBe("exclusive");
    expect(useNetwork.getState().snapshot.switching?.state).toBe("checking");
    stop();
    transport.snapshot.mockReturnValue(new Promise(() => {}));
    stop = startNetworkSubscription();
    expect(useNetwork.getState().snapshot.state).toBe("checking");
    expect(useNetwork.getState().snapshot.switching?.state).not.toBe("domestic");
    expect(useNetwork.getState().snapshot.accounts).toEqual([]);
  });
});
