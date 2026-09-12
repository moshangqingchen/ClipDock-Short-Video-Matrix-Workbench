import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowsControllerOwnerSnapshot } from "@main/network/windows-controller-owner";
import type { ProxyTunnelContext } from "./proxy-transport";
import {
  ProxyTunnelAuthorizer,
  proxyTunnelChainFingerprint,
  type ProxyTunnelAuthorityState,
  type ProxyTunnelReadResult,
} from "./proxy-tunnel-authorizer";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
});

function fixture(targetScope?: "api" | "website") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 1000;
  const context: ProxyTunnelContext = {
    id: "owned-context",
    platformId: "x",
    target: { host: "api.x.com", port: 443 },
    proxy: { host: "127.0.0.1", port: 7890 },
    socket: { localAddress: "127.0.0.1", localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 7890 },
    connectedAtMono: 990,
  };
  const owner = {
    pid: 1234,
    createdAtTicks: "134332323232323232",
    executablePathIdentity: hash("kernel-path"),
  };
  const proxies = {
    proxies: {
      "synthetic-node": { type: "Shadowsocks", id: "synthetic-node-id" },
      "synthetic-group": { type: "Selector", now: "synthetic-node" },
    },
  };
  const chain = ["synthetic-node", "synthetic-group"];
  let state: ProxyTunnelAuthorityState | null = {
    generation: 3,
    revision: "settings-v1",
    proxy: context.proxy,
    controller: { host: "127.0.0.1", port: 9790 },
    controllerFingerprint: hash("controller-config"),
    kernelOwner: owner,
    proxyState: "on",
    checkedAtMono: 900,
    expiresAtMono: 15_900,
    egress: {
      sampleId: "actual-anonymous-sample",
      generation: 3,
      revision: "settings-v1",
      countryCode: "JP",
      allowedCountries: ["JP", "US"],
      chainFingerprint: proxyTunnelChainFingerprint(chain, proxies)!,
      observedAtMono: 850,
      expiresAtMono: 15_850,
    },
  };
  const ownerSnapshot = (port: number): WindowsControllerOwnerSnapshot => ({
    available: true,
    basis: "windows-controller-listener",
    startedAtMono: 950,
    completedAtMono: 955,
    scopeHash: hash(JSON.stringify({ address: "127.0.0.1", port })),
    owner,
    kernelEpoch: hash(`owner-${port}`),
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port, coverage: "exact" }],
  });
  const evidence = (): ProxyTunnelReadResult => ({
    contextId: context.id,
    generation: 3,
    revision: "settings-v1",
    startedAtMono: 1000,
    completedAtMono: 1005,
    controllerBefore: {
      fingerprint: hash("controller-config"),
      mixedPort: 7890,
      mode: "rule",
      startedAtMono: 1000,
      completedAtMono: 1001,
    },
    controllerAfter: {
      fingerprint: hash("controller-config"),
      mixedPort: 7890,
      mode: "rule",
      startedAtMono: 1004,
      completedAtMono: 1005,
    },
    controllerOwner: ownerSnapshot(9790),
    proxyOwner: ownerSnapshot(7890),
    connections: {
      startedAtMono: 1002,
      completedAtMono: 1003,
      value: {
        connections: [
          {
            id: "actual-kernel-flow",
            chains: chain,
            metadata: {
              host: "api.x.com",
              sniffHost: "",
              type: "HTTPS",
              network: "tcp",
              sourceIP: "127.0.0.1",
              sourcePort: "50000",
              inboundIP: "127.0.0.1",
              inboundPort: "7890",
              destinationPort: "443",
            },
          },
        ],
      },
    },
    proxies: { startedAtMono: 1002, completedAtMono: 1003, value: proxies },
  });
  const listeners = new Set<() => void>();
  const readState = vi.fn(() => state),
    subscribeState = vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
  const readTunnel = vi.fn(async () => {
    now = 1005;
    return evidence();
  });
  const whenIdle = vi.fn(async () => undefined);
  const authorizer = new ProxyTunnelAuthorizer({
    targetScope,
    readState,
    subscribeState,
    readTunnel,
    whenIdle,
    now: () => now,
  });
  disposals.push(() => authorizer.dispose());
  return {
    context,
    owner,
    proxies,
    chain,
    evidence,
    readState,
    readTunnel,
    whenIdle,
    subscribeState,
    listeners,
    authorizer,
    get state() {
      return state!;
    },
    set state(value: ProxyTunnelAuthorityState | null) {
      state = value;
    },
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    authorize: (signal = new AbortController().signal) => authorizer.authorizeTunnel(context, signal),
  };
}
function mutable<T>(value: T): { -readonly [P in keyof T]: T[P] } {
  return value;
}
function flow(value: ProxyTunnelReadResult) {
  return (
    value.connections.value as {
      connections: { id: string; chains: string[]; metadata: Record<string, unknown> }[];
    }
  ).connections[0];
}

describe("actual CONNECT tunnel authorization", () => {
  it("grants a website target only in the explicit website scope", async () => {
    const api = fixture();
    Object.assign(api.context.target, { host: "x.com" });
    expect(await api.authorize()).toBeNull();
    expect(api.readTunnel).not.toHaveBeenCalled();
    const web = fixture("website");
    Object.assign(web.context.target, { host: "x.com" });
    web.readTunnel.mockImplementation(async () => {
      web.now = 1005;
      const value = web.evidence();
      flow(value).metadata.host = "x.com";
      return value;
    });
    const lease = await web.authorize();
    expect(lease?.isCurrent()).toBe(true);
    web.state.proxyState = "off";
    web.emit();
    expect(lease?.signal.aborted).toBe(true);
  });
  function currentEvidence(f: ReturnType<typeof fixture>): ProxyTunnelReadResult {
    const offset = f.now - 1000;
    const shift = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shift);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          (key === "startedAtMono" || key === "completedAtMono") && typeof child === "number"
            ? child + offset
            : shift(child),
        ]),
      );
    };
    return shift(f.evidence()) as ProxyTunnelReadResult;
  }
  function freshSource(f: ReturnType<typeof fixture>) {
    f.state = {
      ...f.state,
      checkedAtMono: f.now - 100,
      expiresAtMono: f.now + 14900,
      egress: {
        ...f.state.egress!,
        sampleId: `sample-${f.now}`,
        observedAtMono: f.now - 100,
        expiresAtMono: f.now + 14900,
      },
    };
  }
  it("uses fresh identically bound source evidence for a new grant without extending a returned lease", async () => {
    const f = fixture();
    mutable(f.state).expiresAtMono = 1300;
    mutable(f.state.egress!).expiresAtMono = 1300;
    f.readTunnel.mockImplementation(async () => {
      const evidence = f.evidence();
      f.now = 1005;
      freshSource(f);
      f.emit();
      return evidence;
    });
    const lease = await f.authorize();
    expect(lease?.expiresAtMono).toBe(6005);
    f.now = 1500; freshSource(f); f.emit();
    expect(lease?.expiresAtMono).toBe(6005);
    expect(lease?.isCurrent()).toBe(true);
  });
  it("reissues short leases for the same still-open kernel flow beyond the original connection age", async () => {
    const f = fixture();
    let lease = (await f.authorize())!;
    const original = lease;
    f.readTunnel.mockImplementation(async () => {
      const value = currentEvidence(f);
      f.now += 5;
      return value;
    });
    for (let i = 0; i < 12; i++) {
      f.now += 2500;
      freshSource(f);
      const next = await f.authorizer.renewTunnel(f.context, lease, new AbortController().signal);
      expect(next).not.toBeNull();
      expect(next).not.toBe(lease);
      expect(next!.expiresAtMono).toBe(f.now + 5000);
      expect(lease.expiresAtMono).toBeLessThan(next!.expiresAtMono);
      lease.release();
      expect(next!.isCurrent()).toBe(true);
      lease = next!;
    }
    expect(f.now - f.context.connectedAtMono).toBeGreaterThan(30000);
    expect(original.expiresAtMono).toBe(6005);
    expect(original.signal.aborted).toBe(true);
    expect(f.readTunnel).toHaveBeenCalledTimes(13);
  });
  it.each(["id", "host", "port", "time"])(
    "rejects renewed %s context substitution before reading",
    async (kind) => {
      const f = fixture(),
        lease = (await f.authorize())!;
      const changed = structuredClone(f.context);
      if (kind === "id") Object.assign(changed, { id: "different" });
      if (kind === "host") Object.assign(changed.target, { host: "api.twitter.com" });
      if (kind === "port") Object.assign(changed.socket, { localPort: 50001 });
      if (kind === "time") Object.assign(changed, { connectedAtMono: 1000 });
      expect(await f.authorizer.renewTunnel(changed, lease, new AbortController().signal)).toBeNull();
      expect(f.readTunnel).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["copy", "released", "expired"])(
    "a %s old lease cannot renew or trigger new evidence",
    async (kind) => {
      const f = fixture();
      let lease = (await f.authorize())!;
      if (kind === "copy") lease = { ...lease };
      if (kind === "released") lease.release();
      if (kind === "expired") f.now = lease.expiresAtMono;
      expect(await f.authorizer.renewTunnel(f.context, lease, new AbortController().signal)).toBeNull();
      expect(f.readTunnel).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["flow", "chain", "stale", "no-extension"])(
    "renewal with %s evidence refuses and revokes the prior permission",
    async (kind) => {
      const f = fixture(),
        lease = (await f.authorize())!;
      f.now = 3500;
      if (kind === "no-extension") {
        f.state = {
          ...f.state,
          expiresAtMono: lease.expiresAtMono,
          egress: { ...f.state.egress!, expiresAtMono: lease.expiresAtMono },
        };
      }
      f.readTunnel.mockImplementation(async () => {
        const evidence = kind === "stale" ? f.evidence() : currentEvidence(f);
        if (kind === "flow") flow(evidence).id = "replacement-flow";
        if (kind === "chain") flow(evidence).chains = ["DIRECT"];
        f.now += 5;
        return evidence;
      });
      expect(await f.authorizer.renewTunnel(f.context, lease, new AbortController().signal)).toBeNull();
      expect(lease.signal.aborted).toBe(true);
    },
  );
  it("coalesces nothing across lease identities, refuses parallel renewal, and retains an ignored abort's real drain", async () => {
    const f = fixture(),
      lease = (await f.authorize())!;
    f.now = 3500;
    const pending = deferred<ProxyTunnelReadResult | null>(),
      evidence = currentEvidence(f);
    disposals.unshift(async () => {
      pending.resolve(evidence);
    });
    f.readTunnel.mockImplementation(() => pending.promise);
    const first = f.authorizer.renewTunnel(f.context, lease, new AbortController().signal);
    await flush();
    expect(await f.authorizer.renewTunnel(f.context, lease, new AbortController().signal)).toBeNull();
    expect(f.readTunnel).toHaveBeenCalledTimes(2);
    f.now = lease.expiresAtMono;
    f.emit();
    expect(await first).toBeNull();
    let idle = false;
    void f.authorizer.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    pending.resolve(evidence);
    await f.authorizer.whenIdle();
    expect(idle).toBe(true);
  });
  it("a still-live new lease cannot be obtained by reusing the previous lease after a successful handoff", async () => {
    const f = fixture(),
      lease = (await f.authorize())!;
    f.now = 3500;
    f.readTunnel.mockImplementation(async () => {
      const evidence = currentEvidence(f);
      f.now += 5;
      return evidence;
    });
    const next = (await f.authorizer.renewTunnel(f.context, lease, new AbortController().signal))!;
    expect(next).not.toBeNull();
    expect(await f.authorizer.renewTunnel(f.context, lease, new AbortController().signal)).toBeNull();
    expect(f.readTunnel).toHaveBeenCalledTimes(2);
    next.release();
  });
  it("never treats the anonymous diagnostic context as a business authorization", async () => {
    const f = fixture();
    Object.assign(f.context, {
      platformId: "anonymous-egress",
      target: { host: "www.cloudflare.com", port: 443 },
    });
    expect(await f.authorize()).toBeNull();
    expect(f.readTunnel).not.toHaveBeenCalled();
    expect(f.subscribeState).not.toHaveBeenCalled();
  });
  it("checks the exact listener scope digest through the shared evidence verifier", async () => {
    const f = fixture();
    f.readTunnel.mockImplementation(async () => {
      f.now = 1005;
      const evidence = f.evidence();
      Object.assign(evidence.proxyOwner, { scopeHash: hash("another-listener-scope") });
      return evidence;
    });
    expect(await f.authorize()).toBeNull();
  });
  it("constructs without reads, subscriptions or permission; grants only the matched owned HTTPS/TCP flow and sampled proxy chain", async () => {
    const f = fixture();
    expect(f.readState).not.toHaveBeenCalled();
    expect(f.subscribeState).not.toHaveBeenCalled();
    expect(f.readTunnel).not.toHaveBeenCalled();
    const lease = await f.authorize();
    expect(lease).toMatchObject({ generation: 3, expiresAtMono: 6005 });
    expect(lease!.isCurrent()).toBe(true);
    expect(f.readTunnel).toHaveBeenCalledTimes(1);
    expect(f.whenIdle).toHaveBeenCalledTimes(1);
    lease!.release();
    expect(lease!.signal.aborted).toBe(true);
    expect(lease!.isCurrent()).toBe(false);
    expect(f.listeners.size).toBe(0);
  });

  it.each([
    "missing",
    "proxy-off",
    "unknown",
    "health-missing",
    "country",
    "expired",
    "egress-generation",
    "egress-revision",
    "owner-unknown",
    "remote-proxy",
  ])("%s state refuses before any tunnel read or listener", async (mode) => {
    const f = fixture(),
      state = structuredClone(f.state);
    if (mode === "missing") f.state = null;
    else {
      if (mode === "proxy-off") mutable(state).proxyState = "off";
      if (mode === "unknown") mutable(state).proxyState = "unknown";
      if (mode === "health-missing") mutable(state).egress = null;
      if (mode === "country") mutable(state.egress!).countryCode = "CN";
      if (mode === "expired") mutable(state).expiresAtMono = 1000;
      if (mode === "egress-generation") mutable(state.egress!).generation = 2;
      if (mode === "egress-revision") mutable(state.egress!).revision = "old-settings";
      if (mode === "owner-unknown") mutable(state.kernelOwner).executablePathIdentity = null;
      if (mode === "remote-proxy") mutable(state.proxy).host = "10.0.0.2";
      f.state = state;
    }
    expect(await f.authorize()).toBeNull();
    expect(f.readTunnel).not.toHaveBeenCalled();
    expect(f.subscribeState).not.toHaveBeenCalled();
  });

  it.each([
    "target",
    "source-ip",
    "source-port",
    "inbound-ip",
    "inbound-port",
    "destination-port",
    "sniff",
    "inbound-type",
    "udp",
    "process-conflict",
    "ambiguous",
    "missing",
  ])("rejects %s mismatching ownership instead of selecting another host candidate", async (mode) => {
    const f = fixture(),
      result = f.evidence(),
      metadata = flow(result).metadata;
    if (mode === "target") metadata.host = "oauth2.googleapis.com";
    if (mode === "source-ip") metadata.sourceIP = "127.0.0.2";
    if (mode === "source-port") metadata.sourcePort = "50001";
    if (mode === "inbound-ip") metadata.inboundIP = "127.0.0.2";
    if (mode === "inbound-port") metadata.inboundPort = "7891";
    if (mode === "destination-port") metadata.destinationPort = "444";
    if (mode === "sniff") metadata.sniffHost = "creator.douyin.com";
    if (mode === "inbound-type") metadata.type = "HTTP";
    if (mode === "udp") metadata.network = "udp";
    if (mode === "process-conflict") metadata.processPath = "C:\\some-other-program.exe";
    const rows = (result.connections.value as { connections: unknown[] }).connections;
    if (mode === "ambiguous") rows.push(structuredClone(rows[0]));
    if (mode === "missing") rows.length = 0;
    f.readTunnel.mockImplementation(async () => {
      f.now = 1005;
      return result;
    });
    expect(await f.authorize()).toBeNull();
    expect(f.listeners.size).toBe(0);
  });

  it("normalizes Windows IPv4-mapped socket addresses without assuming process metadata must exist", async () => {
    const f = fixture();
    mutable(f.context.socket).localAddress = "::ffff:7f00:1";
    const lease = await f.authorize();
    expect(lease?.isCurrent()).toBe(true);
  });

  it.each([
    "direct-group",
    "direct-alias",
    "reject-alias",
    "unknown-type",
    "missing-type",
    "different-chain",
    "changed-policy",
  ])("%s cannot be mistaken for the anonymous sample's actual overseas chain", async (mode) => {
    const f = fixture(),
      result = f.evidence(),
      node = (result.proxies.value as typeof f.proxies).proxies["synthetic-node"];
    if (mode === "direct-group") flow(result).chains = ["DIRECT", "synthetic-group"];
    if (mode === "direct-alias") node.type = "Direct";
    if (mode === "reject-alias") node.type = "Reject";
    if (mode === "unknown-type") node.type = "FutureUnknown";
    if (mode === "missing-type") delete (node as { type?: string }).type;
    if (mode === "different-chain") flow(result).chains = ["synthetic-node"];
    if (mode === "changed-policy") node.id = "changed-node-endpoint-config";
    f.readTunnel.mockImplementation(async () => {
      f.now = 1005;
      return result;
    });
    expect(await f.authorize()).toBeNull();
  });

  it.each([
    "context",
    "generation",
    "revision",
    "fingerprint-before",
    "fingerprint-after",
    "mixed-port",
    "controller-mode",
    "owner-pid",
    "owner-birth",
    "owner-path",
    "listener-port",
    "cross-family",
    "owner-unavailable",
    "old-owner",
    "old-evidence",
    "early-postflight",
    "future",
  ])("%s evidence refuses without changing any recorded original times", async (mode) => {
    const f = fixture(),
      result = f.evidence();
    if (mode === "context") mutable(result).contextId = "different-owned-socket";
    if (mode === "generation") mutable(result).generation = 2;
    if (mode === "revision") mutable(result).revision = "previous-settings";
    if (mode === "fingerprint-before") mutable(result.controllerBefore).fingerprint = hash("other");
    if (mode === "fingerprint-after") mutable(result.controllerAfter).fingerprint = hash("other");
    if (mode === "mixed-port") mutable(result.controllerAfter).mixedPort = 7891;
    if (mode === "controller-mode") mutable(result.controllerAfter).mode = "direct";
    const owned = structuredClone(result.proxyOwner);
    if (owned.available) {
      if (mode === "owner-pid") mutable(owned.owner).pid++;
      if (mode === "owner-birth") mutable(owned.owner).createdAtTicks = "134332323232323233";
      if (mode === "owner-path") mutable(owned.owner).executablePathIdentity = hash("not-kernel");
      if (mode === "listener-port") mutable(owned.listeners[0]).port++;
      if (mode === "cross-family") mutable(owned.listeners[0]).coverage = "cross-family-unverified";
      if (mode === "old-owner") mutable(owned).startedAtMono = -20_000;
    }
    mutable(result).proxyOwner = owned;
    if (mode === "owner-unavailable")
      mutable(result).proxyOwner = {
        available: false,
        startedAtMono: 1000,
        completedAtMono: 1001,
        reason: "READ_UNAVAILABLE",
      };
    if (mode === "old-evidence") mutable(result).startedAtMono = 999;
    if (mode === "early-postflight") mutable(result.controllerAfter).startedAtMono = 1002;
    if (mode === "future") mutable(result).completedAtMono = 1006;
    f.readTunnel.mockImplementation(async () => {
      f.now = 1005;
      return result;
    });
    expect(await f.authorize()).toBeNull();
  });

  it.each(["source-loss", "generation", "settings", "controller", "kernel", "proxy-off", "shorter-expiry"])(
    "%s change synchronously aborts an existing lease",
    async (mode) => {
      const f = fixture(),
        lease = (await f.authorize())!,
        state = structuredClone(f.state);
      if (mode === "source-loss") f.state = null;
      else {
        if (mode === "generation") mutable(state).generation++;
        if (mode === "settings") mutable(state).revision = "new-settings";
        if (mode === "controller") mutable(state).controllerFingerprint = hash("new-controller");
        if (mode === "kernel") mutable(state.kernelOwner).pid++;
        if (mode === "proxy-off") mutable(state).proxyState = "off";
        if (mode === "shorter-expiry") mutable(state).expiresAtMono = 2000;
        f.state = state;
      }
      f.emit();
      expect(lease.signal.aborted).toBe(true);
      expect(lease.isCurrent()).toBe(false);
      expect(f.listeners.size).toBe(0);
    },
  );

  it("isCurrent detects unannounced loss and a timer independently revokes at the minimum original deadline", async () => {
    const f = fixture();
    mutable(f.state.egress!).expiresAtMono = 1100;
    const lease = (await f.authorize())!;
    expect(lease.expiresAtMono).toBe(1100);
    f.now = 1100;
    await vi.advanceTimersByTimeAsync(95);
    expect(lease.signal.aborted).toBe(true);
    const other = fixture(),
      second = (await other.authorize())!;
    other.state = null;
    expect(second.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });

  it("same-generation newer state samples cannot extend an already returned lease", async () => {
    const f = fixture(),
      lease = (await f.authorize())!;
    f.now = 2000;
    mutable(f.state).checkedAtMono = 2000;
    mutable(f.state).expiresAtMono = 17_000;
    mutable(f.state.egress!).observedAtMono = 2000;
    mutable(f.state.egress!).expiresAtMono = 17_000;
    f.emit();
    expect(lease.isCurrent()).toBe(true);
    expect(lease.expiresAtMono).toBe(6005);
    f.now = 6005;
    expect(lease.isCurrent()).toBe(false);
  });

  it("aborts public authorization but retains actual work and reader drain until late source completion", async () => {
    const f = fixture(),
      reader = deferred<ProxyTunnelReadResult | null>(),
      drain = deferred<void>(),
      abort = new AbortController();
    f.readTunnel.mockImplementation(() => reader.promise);
    f.whenIdle.mockImplementation(() => drain.promise);
    const pending = f.authorize(abort.signal);
    await flush();
    abort.abort();
    expect(await pending).toBeNull();
    let idle = false;
    const idlePromise = f.authorizer.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    reader.resolve(f.evidence());
    await flush();
    expect(idle).toBe(false);
    drain.resolve();
    await idlePromise;
    expect(idle).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  it("does not grant while cleanup/drain is pending; source cleanup failure never grants", async () => {
    const f = fixture(),
      drain = deferred<void>();
    f.whenIdle.mockImplementation(() => drain.promise);
    let finished = false;
    const pending = f.authorize().then((value) => {
      finished = true;
      return value;
    });
    await flush();
    expect(finished).toBe(false);
    f.authorizer.invalidate();
    drain.resolve();
    expect(await pending).toBeNull();
    const other = fixture();
    other.whenIdle.mockRejectedValue(new Error("private reader failure"));
    expect(await other.authorize()).toBeNull();
  });

  it("snapshots returned raw evidence before waiting for reader drain and never changes the caller's actual context", async () => {
    const f = fixture(),
      drain = deferred<void>(),
      result = f.evidence();
    f.whenIdle.mockImplementation(() => drain.promise);
    f.readTunnel.mockImplementation(async (passed) => {
      mutable(passed.target).host = "changed-only-private-copy";
      f.now = 1005;
      return result;
    });
    const pending = f.authorize();
    await flush();
    flow(result).metadata.host = "later-reused-object.test";
    drain.resolve();
    expect((await pending)?.isCurrent()).toBe(true);
    expect(f.context.target.host).toBe("api.x.com");
  });

  it("discarding stale callbacks and synchronous readState reentry never resurrects a lease", async () => {
    const f = fixture(),
      reader = deferred<ProxyTunnelReadResult | null>();
    f.readTunnel.mockImplementation(() => reader.promise);
    const pending = f.authorize();
    await flush();
    f.authorizer.invalidate();
    reader.resolve(f.evidence());
    expect(await pending).toBeNull();
    const other = fixture(),
      state = other.state;
    other.readState.mockImplementation(() => {
      other.authorizer.invalidate();
      return state;
    });
    expect(await other.authorize()).toBeNull();
    expect(other.readTunnel).not.toHaveBeenCalled();
  });

  it("a subscribe-time invalidation cleans up its subscription even before an unsubscribe handle returns", async () => {
    const f = fixture(),
      off = vi.fn();
    f.subscribeState.mockImplementation(() => {
      f.authorizer.invalidate();
      return off;
    });
    expect(await f.authorize()).toBeNull();
    expect(off).toHaveBeenCalledTimes(1);
    expect(f.readTunnel).not.toHaveBeenCalled();
  });

  it("subscribe reentry into whenIdle waits the already reserved authorization and its later real reader", async () => {
    const f = fixture(),
      reader = deferred<ProxyTunnelReadResult | null>();
    let finished = false,
      idle!: Promise<void>;
    f.readTunnel.mockImplementation(() => reader.promise);
    f.subscribeState.mockImplementation(() => {
      idle = f.authorizer.whenIdle().then(() => {
        finished = true;
      });
      return () => undefined;
    });
    const pending = f.authorize();
    await flush();
    expect(f.readTunnel).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    f.now = 1005;
    reader.resolve(f.evidence());
    await pending;
    await idle;
    expect(finished).toBe(true);
  });

  it("subscribe reentry into dispose waits the reserved call and cannot start a reader after disposal", async () => {
    const f = fixture(),
      off = vi.fn();
    let disposal!: Promise<void>,
      done = false;
    f.subscribeState.mockImplementation(() => {
      disposal = f.authorizer.dispose();
      void disposal.then(() => {
        done = true;
      });
      expect(done).toBe(false);
      return off;
    });
    expect(await f.authorize()).toBeNull();
    await disposal;
    expect(done).toBe(true);
    expect(f.readTunnel).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("refuses duplicate contexts and bounds uncancellable work after public cancellation", async () => {
    const f = fixture(),
      reader = deferred<ProxyTunnelReadResult | null>();
    f.readTunnel.mockImplementation(() => reader.promise);
    const pending = f.authorize();
    await flush();
    expect(await f.authorize()).toBeNull();
    f.authorizer.invalidate();
    expect(await pending).toBeNull();
    for (let i = 0; i < 7; i++) {
      const abort = new AbortController(),
        next = f.authorize(abort.signal);
      await flush();
      abort.abort();
      expect(await next).toBeNull();
    }
    expect(f.readTunnel).toHaveBeenCalledTimes(8);
    expect(await f.authorize()).toBeNull();
    expect(f.readTunnel).toHaveBeenCalledTimes(8);
    reader.resolve(null);
    await f.authorizer.whenIdle();
  });

  it("dispose is idempotent and waits an uncooperative original read, not a cancelled replacement promise", async () => {
    const f = fixture(),
      reader = deferred<ProxyTunnelReadResult | null>();
    f.readTunnel.mockImplementation(() => reader.promise);
    const pending = f.authorize();
    await flush();
    const disposal = f.authorizer.dispose();
    expect(f.authorizer.dispose()).toBe(disposal);
    expect(await pending).toBeNull();
    let done = false;
    void disposal.then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    reader.resolve(null);
    await disposal;
    expect(done).toBe(true);
    expect(await f.authorize()).toBeNull();
  });
});

describe("bounded ordered proxy policy digest", () => {
  it("ignores telemetry but binds API-visible node identity/policy and actual ordered selection", () => {
    const f = fixture(),
      original = proxyTunnelChainFingerprint(f.chain, f.proxies);
    const current = structuredClone(f.proxies);
    Object.assign(current.proxies["synthetic-node"], { alive: false, history: [{ delay: 123 }] });
    expect(proxyTunnelChainFingerprint(f.chain, current)).toBe(original);
    current.proxies["synthetic-node"].id = "another-node";
    expect(proxyTunnelChainFingerprint(f.chain, current)).not.toBe(original);
    expect(proxyTunnelChainFingerprint([...f.chain].reverse(), f.proxies)).toBeNull();
  });
  it.each([
    [],
    ["DIRECT"],
    ["REJECT"],
    ["synthetic-group"],
    ["missing-node"],
    ["synthetic-node", "synthetic-node"],
    Array(33).fill("node"),
  ])("refuses unknown, direct, group-only or malformed chain %j", (chain) => {
    const f = fixture();
    expect(proxyTunnelChainFingerprint(chain, f.proxies)).toBeNull();
  });
});
