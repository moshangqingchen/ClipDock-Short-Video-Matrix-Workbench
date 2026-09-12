import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseAnonymousRequestSocket } from "./anonymous-request-socket";

const expected = { host: "api.bilibili.com", port: 443 };
const url = "https://api.bilibili.com/robots.txt";
const types = {
  URL_REQUEST_START_JOB: 1,
  HTTP_STREAM_JOB_BOUND_TO_REQUEST: 2,
  SOCKET_POOL_BOUND_TO_SOCKET: 3,
  TCP_CONNECT: 4,
  SOCKET_ALIVE: 5,
  HOST_RESOLVER_MANAGER_JOB: 6,
  URL_REQUEST_BOUND_TO_JOB: 7,
  UDP_CONNECT: 8,
  UDP_SOCKET_LOCAL_ADDRESS: 9,
  HTTP_STREAM_JOB_CONTROLLER_PROXY_SERVER_RESOLVED: 10,
  CERT_VERIFIER_REQUEST_BOUND_TO_JOB: 11,
};
const sourceTypes = {
  URL_REQUEST: 1,
  HTTP_STREAM_JOB: 2,
  SOCKET: 3,
  HOST_RESOLVER_IMPL_JOB: 4,
  CERT_VERIFIER_JOB: 5,
};
const event = (id: number, type: number, params: Record<string, unknown>, sourceType?: number) => ({
  source: { id, type: sourceType ?? (id === 1 || type === 1 ? 1 : id === 2 ? 2 : type === 6 ? 4 : 3) },
  type,
  params,
  phase: 2,
  time: "7890123",
});
const dependency = (id: number) => ({ source_dependency: { id, type: 1 } });
function fixture() {
  return {
    constants: { logEventTypes: types, logSourceType: sourceTypes },
    events: [
      event(1, 1, { url, headers: "Cookie: must-not-appear" }),
      event(2, 2, dependency(1)),
      event(2, 3, dependency(3)),
      event(3, 4, { address_list: ["198.18.0.1:443"] }),
      event(3, 5, { source_address: "198.18.0.1:51234" }),
    ],
  };
}
const parse = (value = fixture()) => parseAnonymousRequestSocket(JSON.stringify(value), expected);
function observation(value = fixture()) {
  const result = parse(value);
  expect(result.available).toBe(true);
  if (!result.available) throw Error(result.reason);
  return result.observation;
}

describe("isolated anonymous request NetLog socket extraction", () => {
  it("replays the actual Electron 43 loopback TLS trace with request-local certificate events", () => {
    const trace = readFileSync(
      new URL("../../../docs/network-netlog-socket-local.fixture.json", import.meta.url),
      "utf8",
    );
    const result = parseAnonymousRequestSocket(trace, { host: "clipdock-netlog-local.test", port: 51013 });
    expect(result.available).toBe(true);
    if (!result.available) throw Error(result.reason);
    expect(result.observation).toMatchObject({
      rootId: 29,
      socketSourceId: 36,
      tuple: { sourceAddress: "127.0.0.1", sourcePort: 61139, remoteAddress: "127.0.0.1", remotePort: 51013 },
    });
  });

  it("follows the request dependency graph and retains the exact TCP tuple and original clock", () => {
    const actual = observation();
    expect(actual).toMatchObject({
      kind: "anonymous-netlog-request-socket",
      origin: { protocol: "https:", ...expected },
      rootId: 1,
      socketSourceId: 3,
      relatedSourceIds: [1, 2, 3],
      tuple: { sourceAddress: "198.18.0.1", sourcePort: 51234, remoteAddress: "198.18.0.1", remotePort: 443 },
    });
    expect(actual.eventEvidence.every((row) => row.timeTicks === "7890123")).toBe(true);
    expect(actual.evidenceId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(actual.tuple)).toBe(true);
    expect(Object.isFrozen(actual.eventEvidence[0].dependentSourceIds)).toBe(true);
    expect(JSON.stringify(actual)).not.toMatch(/must-not-appear|Cookie|robots\.txt|headers/);
  });

  it("does not associate an unrelated socket by port, host or proximity", () => {
    const value = fixture();
    value.events.push(
      event(20, 1, { url: "https://unrelated.example/?secret=private" }),
      event(30, 4, {
        source_address: "192.168.1.2:44444",
        address: "192.0.2.22:443",
      }),
    );
    expect(observation(value)).toEqual(observation());
  });

  it("excludes globally shared resolver sources, including edges pointed at them", () => {
    const value = fixture();
    value.events.push(
      event(1, 7, dependency(90)),
      event(90, 6, dependency(30)),
      event(30, 4, {
        source_address: "192.168.1.2:44444",
        address: "192.0.2.22:443",
      }),
    );
    expect(observation(value).relatedSourceIds).toEqual([1, 2, 3]);
    expect(observation(value).eventEvidence.every((row) => !row.dependentSourceIds.includes(90))).toBe(true);
  });

  it("keeps request-local proxy and certificate events without crossing their shared-service edges", () => {
    const value = fixture();
    value.events.push(
      event(2, 10, {}),
      event(3, 11, dependency(90)),
      event(90, 11, dependency(30), 5),
      event(30, 4, { source_address: "192.0.2.1:22222", address: "192.0.2.2:443" }),
    );
    expect(observation(value).tuple).toEqual(observation().tuple);
    expect(observation(value).relatedSourceIds).toEqual([1, 2, 3]);
  });

  it("does not interpret a shared service's socket-shaped events as a request socket", () => {
    const value = fixture();
    value.events.push(
      event(2, 3, dependency(90)),
      event(90, 4, { source_address: "192.0.2.1:22222", address: "192.0.2.2:443" }, 5),
    );
    expect(observation(value).tuple).toEqual(observation().tuple);
  });

  it("rejects a source whose type changes within the log", () => {
    const value = fixture();
    value.events.push(event(3, 4, {}, 5));
    expect(parse(value)).toEqual({ available: false, reason: "INPUT_INVALID" });
  });

  it("does not connect a request and socket through an unobserved source", () => {
    const value = fixture();
    value.events = [
      value.events[0],
      event(1, 7, dependency(99)),
      event(3, 5, dependency(99)),
      ...value.events.slice(3),
    ];
    expect(parse(value)).toEqual({ available: false, reason: "SOCKET_AMBIGUOUS" });
  });

  it("rejects repeated exact-URL roots even if only one root obtains a socket", () => {
    const value = fixture();
    value.events.push(event(4, 1, { url }));
    expect(parse(value)).toEqual({ available: false, reason: "REQUEST_AMBIGUOUS" });
  });

  it("rejects a second request connected through a shared HTTP socket", () => {
    const value = fixture();
    value.events.push(event(4, 1, { url: "https://another.example/private" }), event(4, 7, dependency(2), 1));
    expect(parse(value)).toEqual({ available: false, reason: "REQUEST_AMBIGUOUS" });
  });

  it("rejects redirects instead of attributing the second hop to the original URL", () => {
    const value = fixture();
    value.events.push(event(1, 1, { url: "https://api.bilibili.com/other" }));
    expect(parse(value)).toEqual({ available: false, reason: "REQUEST_AMBIGUOUS" });
  });

  it("rejects multiple request-related TCP sockets", () => {
    const value = fixture();
    value.events.push(
      event(2, 3, dependency(4)),
      event(4, 4, { source_address: "198.18.0.1:51235", address: "198.18.0.2:443" }),
    );
    expect(parse(value)).toEqual({ available: false, reason: "SOCKET_AMBIGUOUS" });
  });

  it("does not overwrite conflicting socket records with the last event", () => {
    const value = fixture();
    value.events.push(event(3, 4, { source_address: "198.18.0.1:51234", address: "198.18.0.2:443" }));
    expect(parse(value)).toEqual({ available: false, reason: "SOCKET_AMBIGUOUS" });
  });

  it("accepts repeated observations of the exact same socket", () => {
    const value = fixture();
    value.events.push(value.events[4]);
    expect(observation(value).tuple).toEqual(observation().tuple);
  });

  it("does not choose an arbitrary endpoint from an ambiguous peer list", () => {
    const value = fixture();
    value.events[3] = event(3, 4, { address_list: ["198.18.0.1:443", "198.18.0.2:443"] });
    expect(parse(value)).toEqual({ available: false, reason: "SOCKET_AMBIGUOUS" });
  });

  it("uses an actual local/remote pair without mistaking unselected candidates for sockets", () => {
    const value = fixture();
    value.events[3] = event(3, 4, { address_list: ["198.18.0.1:443", "198.18.0.2:443"] });
    value.events[4] = event(3, 5, { source_address: "198.18.0.1:51234", address: "198.18.0.2:443" });
    expect(observation(value).tuple.remoteAddress).toBe("198.18.0.2");
  });

  it("normalizes bracketed IPv6 without claiming the physical outbound address family", () => {
    const value = fixture();
    value.events[3] = event(3, 4, { address: "[2001:0DB8:0:0::1]:443" });
    value.events[4] = event(3, 5, { local_address: "[2001:db8::2]:51234" });
    expect(observation(value).tuple).toMatchObject({
      sourceAddress: "2001:db8::2",
      remoteAddress: "2001:db8::1",
    });
  });

  it.each(["198.18.0.1:444", "198.18.0.1:0", "198.18.0.1:65536", "[fe80::1%1]:443", "example.com:443"])(
    "rejects an unusable or wrong-port destination %s",
    (address) => {
      const value = fixture();
      value.events[3] = event(3, 4, { address_list: [address] });
      expect(parse(value)).toMatchObject({ available: false });
    },
  );

  it("rejects UDP socket facts even when the URL dependency graph matches", () => {
    const value = fixture();
    value.events[3] = event(3, 8, { address: "198.18.0.1:443" });
    value.events[4] = event(3, 9, { source_address: "198.18.0.1:51234" });
    expect(parse(value)).toEqual({ available: false, reason: "SOCKET_AMBIGUOUS" });
  });

  it("does not invent a monotonic timestamp when NetLog does not provide one", () => {
    const value = fixture();
    value.events.forEach((row) => {
      row.time = "not-a-time";
    });
    expect(observation(value).eventEvidence.every((row) => row.timeTicks === null)).toBe(true);
  });

  it.each(["https://api.bilibili.com", "api.bilibili.com@evil.example", "api.bilibili.com/path"])(
    "rejects invalid expected hostname %s",
    (host) => {
      expect(parseAnonymousRequestSocket(JSON.stringify(fixture()), { host, port: 443 })).toMatchObject({
        available: false,
      });
    },
  );

  it("handles corrupt JSON and missing or duplicate type maps without throwing", () => {
    expect(parseAnonymousRequestSocket("{", expected)).toMatchObject({ available: false });
    expect(parseAnonymousRequestSocket("{}", expected)).toMatchObject({ available: false });
    const value = fixture();
    value.constants.logEventTypes = { ...types, UDP_CONNECT: 4 };
    expect(parse(value)).toMatchObject({ available: false });
  });

  it("bounds raw log bytes and reachable dependency graph", () => {
    expect(parseAnonymousRequestSocket(" ".repeat(8 * 1024 * 1024 + 1), expected)).toEqual({
      available: false,
      reason: "LOG_LIMIT",
    });
    const value = fixture();
    for (let id = 3; id <= 131; id++) value.events.push(event(id, 7, dependency(id + 1)));
    expect(parse(value)).toEqual({ available: false, reason: "LOG_LIMIT" });
  });
});
