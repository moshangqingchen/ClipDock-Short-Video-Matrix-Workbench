import { describe, expect, it } from "vitest";
import {
  createResolverFlowMapping,
  validateResolverFlowMapping,
  type ResolverFlowMappingInput,
} from "./resolver-flow-mapping";
import { associateCurrentConfiguration } from "./configuration-association";
import { parseAnonymousRequestSocket } from "./anonymous-request-socket";
import { projectSourcePolicyDetails } from "./source-policy-details";
import { KernelDnsReader } from "./kernel-dns";

import { fixture, dns, V, H, K, mutable } from "./fixtures/resolver-flow";
const create = (input = fixture(), at = 185) => createResolverFlowMapping(input, at);

function laterFlow(offset: number): ResolverFlowMappingInput {
  const input = fixture();
  for (const window of [input.appTcp, input.incomingBefore, input.incomingAfter]) {
    mutable(window).startedAtMono += offset;
    mutable(window).completedAtMono += offset;
  }
  mutable(input.window).sendAtMono += offset;
  mutable(input.window).headersAtMono += offset;
  mutable(input).kernelDns = dns(136 + offset);
  return input;
}

describe("retained fake-IP resolver flow mapping", () => {
  it("uses the independent fresh flow DNS after baseline work outlives the initial input DNS", () => {
    const input = laterFlow(1000);
    const original = structuredClone(input.inputs);
    expect(input.window.sendAtMono).toBeGreaterThan(input.configuration.expiresAtMono);
    const result = create(input, 1185);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observation).toMatchObject({ observedAtMono: 1160, kernelDnsExpiresAtMono: 2136 });
    expect(input.inputs).toEqual(original);
    expect(input.configuration.expiresAtMono).toBe(1100);
    expect(
      validateResolverFlowMapping(result.observation, input.inputs, input.loader, input.configuration, 1190),
    ).toBe(true);
  });

  it("still rejects a fresh flow when the original selected configuration expires at headers", () => {
    const input = laterFlow(1000);
    mutable(input.inputs.configurationBefore).expiresAtMono = input.window.headersAtMono;
    const associated = associateCurrentConfiguration({ inputs: input.inputs, loader: input.loader }, 131);
    if (!associated.valid) throw new Error(associated.reason);
    mutable(input).configuration = associated.association;
    expect(create(input, 1185)).toEqual({ valid: false, reason: "TIME_UNVERIFIED" });
  });

  it("does not substitute a still-current configuration for expired per-flow DNS", () => {
    const input = laterFlow(1000);
    mutable(input).kernelDns = dns(136);
    expect(create(input, 1185)).toEqual({ valid: false, reason: "DNS_UNVERIFIED" });
  });

  it("accepts real KernelDnsReader answer dates when the transport response starts after the outer query", async () => {
    const f = fixture();
    let now = 136;
    const dnsReader = new KernelDnsReader({
      now: () => now,
      concurrency: 1,
      classifyAddress: () => "real",
      readControllerVersion: async () => ({
        controllerVersion: V,
        startedAtMono: now,
        completedAtMono: (now += 0.01),
      }),
      reader: {
        readDnsQuery: async (host, type) => {
          const startedAtMono = (now += 0.01),
            completedAtMono = (now += 0.01);
          return {
            host,
            queryType: type,
            status: 0,
            truncated: false,
            question: { name: host, type: type === "A" ? 1 : 28 },
            answers: type === "A" ? [{ name: host, type: 1, ttl: 1, data: "223.5.5.5" }] : [],
            startedAtMono,
            completedAtMono,
          };
        },
      },
    });
    try {
      const observed = await dnsReader.read([f.target.host]);
      expect(observed.available).toBe(true);
      if (!observed.available) return;
      const query = observed.hosts[0].queries.find((q) => q.type === "A")!;
      expect(query.response!.startedAtMono).toBeGreaterThan(query.startedAtMono);
      expect(observed.hosts[0].answers[0].observedAtMono).toBe(query.response!.startedAtMono);
      const result = createResolverFlowMapping({ ...f, kernelDns: observed }, 185);
      expect(result.valid).toBe(true);
    } finally {
      dnsReader.dispose();
    }
  });

  it("constructs from the real pure NetLog parser, exact app tuple and own incoming without a physical socket", () => {
    const f = fixture(),
      result = create(f);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observation).toMatchObject({
      kind: "fake-ip-kernel-destination",
      physicalSocketProven: false,
      transportAddresses: ["198.18.0.2"],
      kernelAddresses: ["223.5.5.5", "223.6.6.6"],
      transportContextId: f.transportContextId,
      observedAtMono: 160,
      completedAtMono: 180,
    });
    expect(result.observation.incoming.processIdentity).toBeNull();
    expect(result.observation).not.toHaveProperty("expiresAtMono");
    expect(validateResolverFlowMapping(result.observation, f.inputs, f.loader, f.configuration, 190)).toBe(
      true,
    );
  });

  it("retains original DNS and request dates when postflight completes after the DNS deadline", () => {
    const f = fixture();
    mutable(f.appTcp).completedAtMono = 1200;
    mutable(f.incomingAfter).completedAtMono = 1200;
    const result = create(f, 1201);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observation).toMatchObject({
      observedAtMono: 160,
      completedAtMono: 1200,
      checkedAtMono: 1201,
      kernelDnsExpiresAtMono: 1136,
    });
    expect(validateResolverFlowMapping(result.observation, f.inputs, f.loader, f.configuration, 1210)).toBe(
      true,
    );
  });

  it("can retain a genuinely IPv6 tuple with an explicit IPv6 fake pool without guessing IPv4", () => {
    const f = fixture();
    mutable(f.target).addressFamily = "ipv6";
    mutable(f.inputs.targets[0]).addressFamily = "ipv6";
    for (const cfg of [f.inputs.configurationBefore, f.inputs.configurationAfter])
      mutable(cfg.policy).details = projectSourcePolicyDetails({
        dns: { "fake-ip-range": "198.18.0.1/16", "fake-ip-range6": "fc00::/18" },
      });
    const parsed = parseAnonymousRequestSocket(
      JSON.stringify({
        constants: {
          logEventTypes: { URL_REQUEST_START_JOB: 1, HTTP_STREAM_JOB_BOUND_TO_REQUEST: 2, TCP_CONNECT: 3 },
          logSourceType: { URL_REQUEST: 1, HTTP_STREAM_JOB: 2, SOCKET: 3 },
        },
        events: [
          { source: { id: 10, type: 1 }, type: 1, params: { url: `https://${f.target.host}/robots.txt` } },
          { source: { id: 10, type: 1 }, type: 2, params: { source_dependency: { id: 20 } } },
          {
            source: { id: 20, type: 3 },
            type: 3,
            params: { source_address: "[2400:3200::1]:50000", address: "[fc00::2]:443" },
          },
        ],
      }),
      f.target,
    );
    if (!parsed.available) throw new Error(parsed.reason);
    const real = "2606:4700:4700::1111",
      after = mutable(f.incomingAfter.connections[0]);
    mutable(f).requestSocket = parsed.observation;
    if (!f.appTcp.available) throw new Error("Expected TCP fixture");
    Object.assign(mutable(f.appTcp.sockets[0]), parsed.observation.tuple);
    after.sourceAddress = parsed.observation.tuple.sourceAddress;
    after.destinationIp = parsed.observation.tuple.remoteAddress;
    after.remoteDestinationIp = real;
    const host = mutable(f.kernelDns.hosts[0]),
      query = host.queries[0];
    host.ipv4 = [];
    host.ipv6 = [real];
    host.addresses = [{ address: real, addressFamily: "ipv6", addressClass: "real" }];
    query.type = "AAAA";
    Object.assign(query.response!, {
      queryType: "AAAA",
      question: { name: f.target.host, type: 28 },
      answers: [{ name: f.target.host, type: 28, ttl: 1, data: real }],
    });
    host.answers = [
      {
        queryType: "AAAA",
        name: f.target.host,
        type: 28,
        ttl: 1,
        data: real,
        observedAtMono: 136,
        expiresAtMono: 1136,
      },
    ];
    const association = associateCurrentConfiguration({ inputs: f.inputs, loader: f.loader }, 131);
    if (!association.valid) throw new Error(association.reason);
    const result = create({ ...f, configuration: association.association });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observation).toMatchObject({
      target: { addressFamily: "ipv6" },
      transportAddresses: ["fc00::2"],
      kernelAddresses: [real],
      physicalSocketProven: false,
    });
  });

  it("copies evidence and cannot restore constructor provenance from JSON", () => {
    const f = fixture(),
      result = create(f);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    mutable(f.incomingAfter.connections[0]).sourcePort = 1234;
    expect(result.observation.incoming.sourcePort).toBe(50000);
    expect(Object.isFrozen(result.observation.incoming)).toBe(true);
    expect(
      validateResolverFlowMapping(
        structuredClone(result.observation),
        f.inputs,
        f.loader,
        f.configuration,
        190,
      ),
    ).toBe(false);
    expect(
      validateResolverFlowMapping(
        result.observation,
        f.inputs,
        f.loader,
        structuredClone(f.configuration),
        190,
      ),
    ).toBe(false);
  });

  it.each([
    [
      "wrong scope",
      (f: ResolverFlowMappingInput) => {
        mutable(f.target).host = "another.example.com";
      },
    ],
    [
      "unknown factory",
      (f: ResolverFlowMappingInput) => {
        mutable(f).factoryId = "node-probe";
      },
    ],
    [
      "egress factory cannot borrow a TLS robots socket",
      (f: ResolverFlowMappingInput) => {
        mutable(f).factoryId = "clipdock-anonymous-egress-v1";
      },
    ],
    [
      "missing context",
      (f: ResolverFlowMappingInput) => {
        mutable(f).transportContextId = "";
      },
    ],
    [
      "copied association",
      (f: ResolverFlowMappingInput) => {
        mutable(f).configuration = structuredClone(f.configuration);
      },
    ],
    [
      "changed policy",
      (f: ResolverFlowMappingInput) => {
        mutable(f.inputs.configurationAfter.policy).fingerprint = K;
      },
    ],
    [
      "changed kernel owner",
      (f: ResolverFlowMappingInput) => {
        mutable(f.inputs.ownerAfter.owner).pid++;
      },
    ],
    [
      "changed OS",
      (f: ResolverFlowMappingInput) => {
        mutable(f.inputs.networkAfter).hash = K;
      },
    ],
    [
      "missing system hosts",
      (f: ResolverFlowMappingInput) => {
        delete mutable(f.inputs).systemHostsAfter;
      },
    ],
    [
      "changed hosts identity",
      (f: ResolverFlowMappingInput) => {
        mutable(f.inputs.systemHostsAfter!).fileIdentity = H;
      },
    ],
    [
      "missing fake pool",
      (f: ResolverFlowMappingInput) => {
        delete mutable(f.inputs.configurationAfter.policy).details;
      },
    ],
    [
      "app tuple differs",
      (f: ResolverFlowMappingInput) => {
        if (f.appTcp.available) mutable(f.appTcp.sockets[0]).remoteAddress = "198.18.0.3";
      },
    ],
    [
      "ambiguous app tuple",
      (f: ResolverFlowMappingInput) => {
        if (f.appTcp.available) mutable(f.appTcp.sockets).push(structuredClone(f.appTcp.sockets[0]));
      },
    ],
    [
      "wrong owner",
      (f: ResolverFlowMappingInput) => {
        if (f.appTcp.available) mutable(f.appTcp.sockets[0]).ownerPid++;
      },
    ],
    [
      "owner reused PID",
      (f: ResolverFlowMappingInput) => {
        mutable(f.appOwner).createdAtTicks = "639244035457234777";
      },
    ],
    [
      "closed app tuple",
      (f: ResolverFlowMappingInput) => {
        if (f.appTcp.available) mutable(f.appTcp.sockets[0]).state = "TimeWait";
      },
    ],
    [
      "incoming wrong source",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).sourceAddress = "10.0.0.3";
      },
    ],
    [
      "incoming wrong host",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).host = "another.example.com";
      },
    ],
    [
      "incoming sniff conflict",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).sniffHost = "another.example.com";
      },
    ],
    [
      "incoming wrong port",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).destinationPort = 444;
      },
    ],
    [
      "incoming UDP",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).network = "udp";
      },
    ],
    [
      "incoming proxy",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).route = "non-direct";
      },
    ],
    [
      "incoming process conflict",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).processIdentity = H;
      },
    ],
    [
      "old incoming ID",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingBefore.connections).push(structuredClone(f.incomingAfter.connections[0]));
      },
    ],
    [
      "ambiguous incoming",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections).push({ ...f.incomingAfter.connections[0], id: "second" });
      },
    ],
    [
      "dialed remote outside DNS",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).remoteDestinationIp = "8.8.8.8";
      },
    ],
    [
      "dialed IPv6 cannot become IPv4",
      (f: ResolverFlowMappingInput) => {
        mutable(f.incomingAfter.connections[0]).remoteDestinationIp = "2606:4700:4700::1111";
      },
    ],
    [
      "DNS wrong controller",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.controllerVersionAfter).controllerVersion = K;
      },
    ],
    [
      "DNS measured after send",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns).completedAtMono = 141;
      },
    ],
    [
      "DNS expires during response",
      (f: ResolverFlowMappingInput) => {
        mutable(f.window).headersAtMono = 1136;
      },
    ],
    [
      "DNS cap expires exactly at headers",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns).ttlCapAtMono = f.window.headersAtMono;
      },
    ],
    [
      "DNS response starts before its real query",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].queries[0].response!).startedAtMono = 135;
      },
    ],
    [
      "DNS response finishes outside its query",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].queries[0].response!).completedAtMono = 139;
      },
    ],
    [
      "DNS unclassified",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].addresses[0]).addressClass = "unknown";
      },
    ],
    [
      "DNS answer not in response",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].queries[0].response!).answers = [];
      },
    ],
    [
      "DNS TTL rewritten",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].answers[0]).expiresAtMono++;
      },
    ],
    [
      "DNS challenge status",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].queries[0].response!).status = 3;
      },
    ],
    [
      "DNS truncated",
      (f: ResolverFlowMappingInput) => {
        mutable(f.kernelDns.hosts[0].queries[0].response!).truncated = true;
      },
    ],
  ] as const)("rejects %s without a mapping", (_name, change) => {
    const f = fixture();
    change(f);
    expect(create(f).valid).toBe(false);
  });
});
