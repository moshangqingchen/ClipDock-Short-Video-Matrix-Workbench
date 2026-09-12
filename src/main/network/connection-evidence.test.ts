import { describe, expect, it } from "vitest";
import {
  connectionHostScope,
  correlateProbeConnection,
  executablePathIdentity,
  parseScopedConnections,
  type KernelConnectionObservation,
  type KernelConnectionsSnapshot,
  type ProbeSocketObservation,
} from "./connection-evidence";

const executable = "C:\\ClipDock\\短视频矩阵工作台.exe";
function fixture() {
  const connection: KernelConnectionObservation = {
    id: "new-connection",
    host: "creator.douyin.com",
    sniffHost: null,
    sourceAddress: "198.18.0.0",
    sourcePort: 51234,
    destinationPort: 443,
    destinationIp: null,
    remoteDestinationIp: null,
    network: "tcp",
    inboundType: "Tun",
    processIdentity: executablePathIdentity(executable),
    route: "direct",
    startedAtMs: 1_700_000_000_050,
  };
  const before: KernelConnectionsSnapshot = { startedAtMono: 10, completedAtMono: 20, connections: [] };
  const after: KernelConnectionsSnapshot = {
    startedAtMono: 120,
    completedAtMono: 130,
    connections: [connection],
  };
  const socket: ProbeSocketObservation = {
    contextId: "measured-chromium-context",
    target: { host: connection.host, protocol: "https:", port: 443, addressFamily: "ipv4" },
    sourceAddress: connection.sourceAddress,
    sourcePort: connection.sourcePort,
    processIdentity: executablePathIdentity(executable)!,
    inboundType: "Tun",
    network: "tcp",
    startedAtWallMs: 1_700_000_000_000,
    completedAtWallMs: 1_700_000_000_080,
    startedAtMono: 30,
    completedAtMono: 110,
  };
  return {
    connection,
    before,
    after,
    socket,
    correlate: () => correlateProbeConnection(socket, before, after, 140, 1_000),
  };
}

describe("scoped kernel connection evidence", () => {
  it("retains only requested targets and no provider/user executable path or URL details", () => {
    const base = {
      id: "connection-1",
      start: "2026-09-07T10:00:00Z",
      chains: ["private-node-password"],
      metadata: {
        host: "creator.douyin.com",
        sourceIP: "198.18.0.0",
        sourcePort: "51234",
        destinationPort: "443",
        destinationIP: "",
        network: "tcp",
        type: "Tun",
        processPath: "C:\\Users\\private-user\\ClipDock.exe",
        process: "ClipDock.exe",
        url: "https://secret/credential",
        specialRules: "secret-token",
      },
    };
    const rows = parseScopedConnections(
      {
        connections: [
          base,
          { ...base, id: "private-connection", metadata: { ...base.metadata, host: "private.example" } },
        ],
      },
      connectionHostScope(["Creator.Douyin.com."]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      host: "creator.douyin.com",
      destinationIp: null,
      route: "non-direct",
      processIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(rows)).not.toMatch(/private|password|credential|secret|url|processPath/);
  });
  it("matches a fresh exact socket without inventing a destination IP or egress proof", () => {
    const f = fixture();
    expect(executablePathIdentity("c:/clipdock/短视频矩阵工作台.exe")).toBe(f.socket.processIdentity);
    expect(f.correlate()).toEqual({
      matched: true,
      contextId: f.socket.contextId,
      connectionId: f.connection.id,
      observedAtMono: 120,
      destinationIp: null,
      remoteDestinationIp: null,
    });
    expect(f.correlate()).not.toHaveProperty("directProof");
  });
  it("cannot borrow old IDs or another source port even for the same process and host", () => {
    const f = fixture();
    f.before.connections = [f.connection];
    expect(f.correlate()).toMatchObject({ matched: false, reason: "NO_MATCH" });
    f.before.connections = [];
    f.socket.sourcePort++;
    expect(f.correlate()).toMatchObject({ matched: false, reason: "NO_MATCH" });
    f.socket.sourcePort--;
    f.socket.sourceAddress = "192.168.1.2";
    expect(f.correlate()).toMatchObject({ matched: false, reason: "NO_MATCH" });
  });
  it("rejects same-port ambiguity instead of taking the first matching host", () => {
    const f = fixture();
    f.after.connections = [f.connection, { ...f.connection, id: "second-new-connection" }];
    expect(f.correlate()).toMatchObject({ matched: false, reason: "AMBIGUOUS_MATCH" });
  });
  it.each(["process", "inbound", "sniff"])("rejects mismatching %s context", (field) => {
    const f = fixture();
    if (field === "process") f.connection.processIdentity = executablePathIdentity("C:\\Other\\electron.exe");
    if (field === "inbound") f.connection.inboundType = "HTTP";
    if (field === "sniff") f.connection.sniffHost = "another.example";
    expect(f.correlate()).toMatchObject({ matched: false, reason: "CONTEXT_MISMATCH" });
  });
  it("rejects unverified/chained routes and missing executable identity", () => {
    const f = fixture();
    for (const route of ["unknown", "non-direct"] as const) {
      f.connection.route = route;
      expect(f.correlate()).toMatchObject({ matched: false, reason: "NOT_DIRECT" });
    }
    f.socket.processIdentity = "";
    expect(f.correlate()).toMatchObject({ matched: false, reason: "SOCKET_UNVERIFIED" });
  });
  it("keeps absent kernel process information absent even when the independently measured path is known", () => {
    const f = fixture();
    f.connection.processIdentity = null;
    expect(f.correlate()).toMatchObject({ matched: false, reason: "CONTEXT_MISMATCH" });
  });
  it("rejects a probe started before its baseline was read", () => {
    const f = fixture();
    f.socket.startedAtMono = 15;
    expect(f.correlate()).toMatchObject({ matched: false, reason: "STALE_CONNECTION_SNAPSHOT" });
  });
  it("rejects a wall-clock jump widening a short monotonic probe window", () => {
    const f = fixture();
    f.socket.completedAtWallMs += 86_400_000;
    expect(f.correlate()).toMatchObject({ matched: false, reason: "STALE_CONNECTION_SNAPSHOT" });
  });
  it("only retains a literal DIRECT TCP remote destination without interpreting it as egress", () => {
    const scope = connectionHostScope(["creator.douyin.com"]);
    const metadata = {
      host: "creator.douyin.com",
      sourceIP: "198.18.0.0",
      sourcePort: 51234,
      destinationPort: 443,
      network: "tcp",
      type: "Tun",
      remoteDestination: "123.234.3.167",
    };
    const row = { id: "new-route", start: "2026-09-07T10:00:00Z", chains: ["DIRECT"], metadata };
    const parse = (entry: unknown) => parseScopedConnections({ connections: [entry] }, scope)[0];
    expect(parse(row)).toMatchObject({
      remoteDestinationIp: "123.234.3.167",
      destinationIp: null,
      processIdentity: null,
    });
    expect(parse({ ...row, chains: ["private-proxy"] }).remoteDestinationIp).toBeNull();
    expect(parse({ ...row, metadata: { ...metadata, network: "udp" } }).remoteDestinationIp).toBeNull();
    for (const remoteDestination of [
      "host.example",
      "123.234.3.167:443",
      "https://secret/path",
      "fe80::1%12",
      "198.18.0.77",
      "10.0.0.1",
      "127.0.0.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "::ffff:123.234.3.167",
      "64:ff9b::7bea:3a7",
      "2001:db8::1",
      "3fff::1",
      "fc00::1",
    ]) {
      expect(parse({ ...row, metadata: { ...metadata, remoteDestination } }).remoteDestinationIp).toBeNull();
    }
    expect(
      parse({ ...row, metadata: { ...metadata, remoteDestination: "240E:0:0:0::1" } }).remoteDestinationIp,
    ).toBe("240e::1");
    expect(parse(row)).not.toHaveProperty("countryCode");
  });
  it("fails a scoped malformed batch instead of dropping a second ambiguous socket", () => {
    const valid = {
      id: "first",
      start: "2026-09-07T10:00:00Z",
      chains: ["DIRECT"],
      metadata: {
        host: "creator.douyin.com",
        sourceIP: "198.18.0.0",
        sourcePort: 51234,
        destinationPort: 443,
        network: "tcp",
        type: "Tun",
      },
    };
    const malformed = { ...valid, id: "second", metadata: { ...valid.metadata, sourceIP: "invalid-source" } };
    expect(() =>
      parseScopedConnections(
        { connections: [valid, malformed] },
        connectionHostScope(["creator.douyin.com"]),
      ),
    ).toThrow("INVALID_CONNECTION_RESPONSE");
  });
  it("does not relabel stale, future or reverse-ordered observations as current", () => {
    const f = fixture();
    expect(correlateProbeConnection(f.socket, f.before, f.after, 1_010, 1_000)).toMatchObject({
      matched: false,
      reason: "STALE_CONNECTION_SNAPSHOT",
    });
    expect(correlateProbeConnection(f.socket, f.before, f.after, 100, 1_000)).toMatchObject({
      matched: false,
      reason: "STALE_CONNECTION_SNAPSHOT",
    });
    f.after.startedAtMono = 5;
    expect(f.correlate()).toMatchObject({ matched: false, reason: "STALE_CONNECTION_SNAPSHOT" });
  });
  it.each(["127.0.0.1", "https://secret/path", "other.example/path", 3])(
    "does not erase a present invalid sniff host %s",
    (sniffHost) => {
      const row = {
        id: "first",
        start: "2026-09-07T10:00:00Z",
        chains: ["DIRECT"],
        metadata: {
          host: "creator.douyin.com",
          sniffHost,
          sourceIP: "198.18.0.0",
          sourcePort: 51234,
          destinationPort: 443,
          network: "tcp",
          type: "Tun",
        },
      };
      expect(() =>
        parseScopedConnections({ connections: [row] }, connectionHostScope(["creator.douyin.com"])),
      ).toThrow("INVALID_CONNECTION_RESPONSE");
    },
  );
  it.each([
    { hosts: [] },
    { hosts: ["https://creator.douyin.com/?token=x"] },
    { hosts: ["127.0.0.1"] },
    { hosts: ["*.douyin.com"] },
    { hosts: ["user@douyin.com"] },
  ])("rejects an invalid host scope before querying the controller", ({ hosts }) => {
    expect(() => connectionHostScope(hosts)).toThrow("INVALID_CONNECTION_SCOPE");
  });
});
