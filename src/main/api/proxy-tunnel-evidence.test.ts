import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WindowsControllerOwnerSnapshot } from "@main/network/windows-controller-owner";
import {
  proxyTunnelChainFingerprint,
  verifyDomesticTunnelEvidence,
  verifyProxyTunnelEvidence,
  verifyWebProxyTunnelEvidence,
  type AnonymousProxyTunnelContext,
  type ProxyTunnelEvidenceInput,
  type WindowsProxyAcceptedSnapshot,
} from "./proxy-tunnel-evidence";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const context: AnonymousProxyTunnelContext = {
    id: "anonymous-own-socket",
    platformId: "anonymous-egress",
    target: { host: "www.cloudflare.com", port: 443 },
    proxy: { host: "127.0.0.1", port: 10090 },
    socket: { localAddress: "127.0.0.1", localPort: 55000, remoteAddress: "127.0.0.1", remotePort: 10090 },
    connectedAtMono: 900,
  };
  const kernelOwner = {
    pid: 1234,
    createdAtTicks: "134332323232323232",
    executablePathIdentity: hash("kernel-owner"),
  };
  const owner = (port: number): WindowsControllerOwnerSnapshot => ({
    available: true,
    basis: "windows-controller-listener",
    owner: { ...kernelOwner },
    startedAtMono: 1002,
    completedAtMono: 1004,
    scopeHash: hash(JSON.stringify({ address: "127.0.0.1", port })),
    kernelEpoch: hash(`endpoint-dependent-epoch-${port}`),
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port, coverage: "exact" }],
  });
  const flow = {
    id: "owned-kernel-flow",
    chains: ["remote", "selection"],
    metadata: {
      host: "www.cloudflare.com",
      sniffHost: "",
      sourceIP: "127.0.0.1",
      sourcePort: "55000",
      inboundIP: "127.0.0.1",
      inboundPort: "10090",
      destinationPort: "443",
      type: "HTTPS",
      network: "tcp",
      processPath: process.execPath,
    },
  };
  const proxies = {
    proxies: {
      remote: { type: "Shadowsocks", id: "remote-id" },
      selection: { type: "Selector", now: "remote" },
    },
  };
  const input: ProxyTunnelEvidenceInput = {
    context,
    controller: { host: "127.0.0.1", port: 9790 },
    proxy: context.proxy,
    generation: 3,
    revision: "current-config",
    nowMono: 1010,
    readStartedAtMono: 1000,
    evidence: {
      contextId: context.id,
      generation: 3,
      revision: "current-config",
      startedAtMono: 1000,
      completedAtMono: 1006,
      controllerBefore: {
        fingerprint: hash("config"),
        mixedPort: 10090,
        mode: "rule",
        startedAtMono: 1000,
        completedAtMono: 1001,
      },
      controllerAfter: {
        fingerprint: hash("config"),
        mixedPort: 10090,
        mode: "rule",
        startedAtMono: 1005,
        completedAtMono: 1006,
      },
      controllerOwner: owner(9790),
      proxyOwner: owner(10090),
      connections: { startedAtMono: 1002, completedAtMono: 1004, value: { connections: [flow] } },
      proxies: { startedAtMono: 1002, completedAtMono: 1004, value: proxies },
    },
  };
  return { input, flow, proxies, kernelOwner };
}

describe("same-socket proxy tunnel evidence", () => {
  function directFixture() {
    const f = fixture();
    f.input.context = {
      ...f.input.context,
      platformId: "xiaohongshu",
      target: { host: "creator.xiaohongshu.com", port: 443 },
    };
    f.flow.metadata.host = "creator.xiaohongshu.com";
    Object.assign(f.flow.metadata, { remoteDestination: "110.43.50.20" });
    f.flow.chains = ["DIRECT"];
    f.input.evidence.proxies.value = {
      proxies: { DIRECT: { type: "Direct", name: "DIRECT", "dialer-proxy": "" } },
    };
    return f;
  }
  it("admits the domestic same-socket DIRECT lane while overseas verifiers reject it", () => {
    const f = directFixture();
    expect(verifyDomesticTunnelEvidence(f.input)).not.toBeNull();
    expect(verifyWebProxyTunnelEvidence(f.input)).toBeNull();
    expect(verifyProxyTunnelEvidence(f.input)).toBeNull();
  });
  it.each(["global", "direct"])("rejects domestic traffic in %s mode", (mode) => {
    const f = directFixture();
    f.input.evidence.controllerBefore.mode = mode;
    f.input.evidence.controllerAfter.mode = mode;
    expect(verifyDomesticTunnelEvidence(f.input)).toBeNull();
  });
  it.each(["", "::1", "2001:4860:4860::8888", "198.18.1.1", "127.0.0.1", "10.1.1.1"])(
    "rejects unqualified domestic destination %s",
    (remoteDestination) => {
      const f = directFixture();
      Object.assign(f.flow.metadata, { remoteDestination });
      expect(verifyDomesticTunnelEvidence(f.input)).toBeNull();
    },
  );
  it("rejects proxy routing, target substitution and stale domestic proof", () => {
    const f = directFixture();
    f.flow.chains = ["remote", "selection"];
    expect(verifyDomesticTunnelEvidence(f.input)).toBeNull();
    f.flow.chains = ["DIRECT"];
    f.flow.metadata.sourcePort = "55001";
    expect(verifyDomesticTunnelEvidence(f.input)).toBeNull();
    f.flow.metadata.sourcePort = "55000";
    f.input.nowMono = 20000;
    expect(verifyDomesticTunnelEvidence(f.input)).toBeNull();
  });
  it("keeps website evidence separate and still rejects DIRECT or the wrong socket", () => {
    const f = fixture();
    f.input = {
      ...f.input,
      context: {
        ...f.input.context,
        platformId: "youtube",
        target: { host: "studio.youtube.com", port: 443 },
      },
    };
    f.flow.metadata.host = "studio.youtube.com";
    expect(verifyProxyTunnelEvidence(f.input)).toBeNull();
    expect(verifyWebProxyTunnelEvidence(f.input)).not.toBeNull();
    f.flow.metadata.sourcePort = "55001";
    expect(verifyWebProxyTunnelEvidence(f.input)).toBeNull();
    f.flow.metadata.sourcePort = "55000";
    f.flow.chains = ["DIRECT"];
    expect(verifyWebProxyTunnelEvidence(f.input)).toBeNull();
  });
  it("does not accept the anonymous diagnostic context as a website connection", () => {
    expect(verifyWebProxyTunnelEvidence(fixture().input)).toBeNull();
  });
  function acceptedFixture() {
    const f = fixture();
    const context = f.input.context;
    const scope = {
      ownerPids: [f.kernelOwner.pid],
      remotes: [{ address: context.socket.localAddress, port: context.socket.localPort }],
    };
    const socketSnapshot = {
      available: true as const,
      startedAtMono: 1002,
      completedAtMono: 1004,
      scopeHash: hash(JSON.stringify(scope)),
      owners: [{ ...f.kernelOwner }],
      sockets: [
        {
          ownerPid: f.kernelOwner.pid,
          sourceAddress: context.socket.remoteAddress,
          sourcePort: context.socket.remotePort,
          remoteAddress: context.socket.localAddress,
          remotePort: context.socket.localPort,
          state: "Established",
        },
      ],
    };
    const accepted: WindowsProxyAcceptedSnapshot = {
      available: true,
      basis: "windows-proxy-accepted",
      startedAtMono: socketSnapshot.startedAtMono,
      completedAtMono: socketSnapshot.completedAtMono,
      scopeHash: socketSnapshot.scopeHash,
      owner: { ...f.kernelOwner },
      socketSnapshot,
    };
    Object.assign(f.input.evidence, { proxyOwner: accepted });
    return { ...f, accepted, socketSnapshot };
  }

  it("accepts the exact established reverse tuple without making any claim about a :: listener", () => {
    const f = acceptedFixture();
    expect(verifyProxyTunnelEvidence(f.input)).not.toBeNull();
    expect(f.accepted).not.toHaveProperty("listeners");
  });

  it.each([
    "local",
    "remote",
    "port",
    "state",
    "duplicate",
    "owner",
    "birth",
    "path",
    "scope",
    "time",
    "retimestamp",
    "unavailable",
  ])("rejects invalid accepted socket evidence: %s", (kind) => {
    const { input, accepted, socketSnapshot } = acceptedFixture();
    const row = socketSnapshot.sockets[0];
    if (kind === "local") row.sourceAddress = "127.0.0.2";
    if (kind === "remote") row.remoteAddress = "127.0.0.2";
    if (kind === "port") row.remotePort++;
    if (kind === "state") row.state = "CloseWait";
    if (kind === "duplicate") socketSnapshot.sockets.push({ ...row });
    if (kind === "owner") row.ownerPid++;
    if (kind === "birth") socketSnapshot.owners[0].createdAtTicks = "134332323232323233";
    if (kind === "path") socketSnapshot.owners[0].executablePathIdentity = hash("unrelated-kernel");
    if (kind === "scope") socketSnapshot.scopeHash = hash("another-scope");
    if (kind === "time") socketSnapshot.startedAtMono = 999;
    if (kind === "retimestamp") Object.assign(accepted, { completedAtMono: 1006 });
    if (kind === "unavailable") Object.assign(socketSnapshot, { available: false });
    expect(verifyProxyTunnelEvidence(input)).toBeNull();
  });

  it("does not relax controller IPv4 ownership to accept a :: wildcard listener", () => {
    const { input } = acceptedFixture();
    if (input.evidence.controllerOwner.available)
      Object.assign(input.evidence.controllerOwner.listeners[0], {
        address: "::",
        addressFamily: "ipv6",
        coverage: "same-family-wildcard",
      });
    expect(verifyProxyTunnelEvidence(input)).toBeNull();
  });
  it("returns only frozen observed facts, with the original evidence deadline and no business permission", () => {
    const f = fixture();
    const value = verifyProxyTunnelEvidence(f.input)!;
    expect(value).toEqual({
      contextId: f.input.context.id,
      connectionId: f.flow.id,
      generation: 3,
      revision: "current-config",
      target: { host: "www.cloudflare.com", port: 443 },
      chainFingerprint: proxyTunnelChainFingerprint(f.flow.chains, f.proxies),
      kernelOwner: f.kernelOwner,
      controllerFingerprint: hash("config"),
      evidenceExpiresAtMono: 16000,
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.target)).toBe(true);
    expect(Object.isFrozen(value.kernelOwner)).toBe(true);
    Object.assign(f.input.context.target, { host: "changed.example" });
    Object.assign(f.kernelOwner, { pid: 9999 });
    expect(value.target.host).toBe("www.cloudflare.com");
    expect(value.kernelOwner.pid).toBe(1234);
    expect(value).not.toHaveProperty("allowed");
    expect(value).not.toHaveProperty("countryCode");
    expect(value).not.toHaveProperty("signal");
  });

  it("recognizes an old business connection only with a matching continuity ID and fresh evidence from this read", () => {
    const f = fixture();
    f.flow.metadata.host = "api.x.com";
    const input: ProxyTunnelEvidenceInput = {
      ...f.input,
      context: { ...f.input.context, platformId: "x", target: { host: "api.x.com", port: 443 } },
      nowMono: 31010,
      readStartedAtMono: 31000,
      evidence: JSON.parse(
        JSON.stringify(f.input.evidence, (key, value) =>
          key === "startedAtMono" || key === "completedAtMono" ? value + 30000 : value,
        ),
      ),
    };
    expect(verifyProxyTunnelEvidence(input)).toBeNull();
    const continued = { ...input, expectedConnectionId: f.flow.id };
    expect(verifyProxyTunnelEvidence(continued)).toMatchObject({
      connectionId: f.flow.id,
      evidenceExpiresAtMono: 46000,
    });
    expect(verifyProxyTunnelEvidence({ ...continued, expectedConnectionId: "another-flow" })).toBeNull();
    expect(verifyProxyTunnelEvidence({ ...continued, evidence: f.input.evidence })).toBeNull();
    expect(input.context.connectedAtMono).toBe(900);
  });

  it("does not use a continuity hint to extend an anonymous diagnostic connection", () => {
    const f = fixture();
    expect(verifyProxyTunnelEvidence({ ...f.input, expectedConnectionId: f.flow.id })).toBeNull();
  });

  it.each(["wrong-host", "wrong-platform", "business-cannot-use-anonymous", "wrong-port"])(
    "refuses target widening: %s",
    (kind) => {
      const { input } = fixture();
      if (kind === "wrong-host") Object.assign(input.context.target, { host: "example.com" });
      if (kind === "wrong-platform") Object.assign(input.context, { platformId: "other" });
      if (kind === "business-cannot-use-anonymous") Object.assign(input.context, { platformId: "youtube" });
      if (kind === "wrong-port") Object.assign(input.context.target, { port: 8443 });
      expect(verifyProxyTunnelEvidence(input)).toBeNull();
    },
  );

  it.each([
    "context",
    "generation",
    "revision",
    "controller-change",
    "mixed-port",
    "mode-change",
    "old-read",
    "expired",
    "source-ip",
    "source-port",
    "inbound-ip",
    "inbound-port",
    "target",
    "sniff",
    "process",
    "network",
    "type",
    "duplicate",
    "direct-leaf",
    "direct-alias",
    "owner-scope",
    "owner-identity",
    "owner-stale",
    "owner-invalid-time",
    "listener",
  ])("rejects a mismatched or stale fact: %s", (kind) => {
    const { input, flow, proxies } = fixture();
    const e = input.evidence;
    if (kind === "context") Object.assign(e, { contextId: "another-context" });
    if (kind === "generation") Object.assign(e, { generation: 2 });
    if (kind === "revision") Object.assign(e, { revision: "old-revision" });
    if (kind === "controller-change") Object.assign(e.controllerAfter, { fingerprint: hash("new-config") });
    if (kind === "mixed-port") Object.assign(e.controllerBefore, { mixedPort: 7890 });
    if (kind === "mode-change") Object.assign(e.controllerAfter, { mode: "global" });
    if (kind === "old-read") Object.assign(input, { readStartedAtMono: 1001 });
    if (kind === "expired") Object.assign(input, { nowMono: 16000 });
    if (kind === "source-ip") flow.metadata.sourceIP = "127.0.0.2";
    if (kind === "source-port") flow.metadata.sourcePort = "55001";
    if (kind === "inbound-ip") flow.metadata.inboundIP = "127.0.0.2";
    if (kind === "inbound-port") flow.metadata.inboundPort = "7890";
    if (kind === "target") flow.metadata.host = "api.x.com";
    if (kind === "sniff") flow.metadata.sniffHost = "api.x.com";
    if (kind === "process") flow.metadata.processPath = "C:\\unrelated.exe";
    if (kind === "network") flow.metadata.network = "udp";
    if (kind === "type") flow.metadata.type = "Tun";
    if (kind === "duplicate")
      (e.connections.value as { connections: unknown[] }).connections.push(structuredClone(flow));
    if (kind === "direct-leaf") flow.chains[0] = "DIRECT";
    if (kind === "direct-alias") proxies.proxies.remote.type = "Direct";
    if (kind === "owner-scope") Object.assign(e.proxyOwner, { scopeHash: hash("different-endpoint") });
    if (kind === "owner-identity" && e.proxyOwner.available) Object.assign(e.proxyOwner.owner, { pid: 9999 });
    if (kind === "owner-stale") Object.assign(e.controllerOwner, { startedAtMono: 0, completedAtMono: 1 });
    if (kind === "owner-stale") Object.assign(input, { nowMono: 15000 });
    if (kind === "owner-invalid-time") Object.assign(e.proxyOwner, { completedAtMono: Number.NaN });
    if (kind === "listener" && e.proxyOwner.available)
      Object.assign(e.proxyOwner.listeners[0], { port: 7890 });
    expect(verifyProxyTunnelEvidence(input)).toBeNull();
  });

  it("keeps mapped IPv4 compatible with the exact plain IPv4 tuple", () => {
    const { input, flow } = fixture();
    flow.metadata.sourceIP = "::ffff:7f00:1";
    flow.metadata.inboundIP = "::ffff:127.0.0.1";
    expect(verifyProxyTunnelEvidence(input)).not.toBeNull();
  });

  it("uses the same checks for an official business target without assigning an egress policy", () => {
    const { input, flow } = fixture();
    Object.assign(input.context, {
      platformId: "youtube",
      target: { host: "oauth2.googleapis.com", port: 443 },
    });
    flow.metadata.host = "oauth2.googleapis.com";
    expect(verifyProxyTunnelEvidence(input)?.target.host).toBe("oauth2.googleapis.com");
  });
});
