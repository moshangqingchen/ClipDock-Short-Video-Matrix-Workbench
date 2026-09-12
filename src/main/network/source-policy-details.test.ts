import { describe, expect, it, vi } from "vitest";
import { projectSourcePolicyDetails, querySourcePolicyTarget } from "./source-policy-details";

describe("parsed source policy details", () => {
  it("does not fill in missing kernel defaults", () => {
    const details = projectSourcePolicyDetails({});
    expect(details.dns.fakeIpRange).toEqual({ state: "missing" });
    expect(details.dns.fakeIpRange6).toEqual({ state: "missing" });
    expect(details.dns.fakeIpFilterMode).toEqual({ state: "missing" });
    expect(details.sniffer.overrideDestination).toEqual({ state: "missing" });
    expect(details.sniffer.protocols.TLS.state).toBe("missing");
    const target = querySourcePolicyTarget(details, "example.test");
    for (const entry of Object.values(target)) expect(entry.state).toBe("unknown");
  });

  it.each([null, undefined, true, 4, "https://secret.test", [], new Date()])(
    "keeps malformed roots unknown: %j",
    (raw) => {
      const details = projectSourcePolicyDetails(raw);
      expect(details.dns.fakeIpRange).toEqual({ state: "unknown" });
      expect(details.hosts.complete).toBe(false);
      expect(querySourcePolicyTarget(details, "example.test").hosts.state).toBe("unknown");
    },
  );

  it("retains only explicit correctly typed fake-IP scalars including range host bits", () => {
    const details = projectSourcePolicyDetails({
      dns: {
        "fake-ip-range": "198.18.0.1/16",
        "fake-ip-range6": "FDFE:DCBA:9876:0000::1/64",
        "fake-ip-filter-mode": "whitelist",
      },
    });
    expect(details.dns.fakeIpRange).toEqual({ state: "known", value: "198.18.0.1/16" });
    expect(details.dns.fakeIpRange6).toEqual({ state: "known", value: "fdfe:dcba:9876::1/64" });
    expect(details.dns.fakeIpFilterMode).toEqual({ state: "known", value: "whitelist" });
  });

  it.each([
    ["fake-ip-range", "2001:db8::/32"],
    ["fake-ip-range6", "198.18.0.1/16"],
    ["fake-ip-range", "198.18.0.1/33"],
    ["fake-ip-range6", "2001:db8::/129"],
    ["fake-ip-range", "198.18.0.1"],
    ["fake-ip-range6", "fe80::1%12/64"],
    ["fake-ip-range6", "[2001:db8::]/64"],
    ["fake-ip-range", "198.18.0.1/016"],
    ["fake-ip-range", "https://secret.test/16"],
    ["fake-ip-range", "198.18.0.1/16?secret=x"],
    ["fake-ip-range", null],
    ["fake-ip-range6", false],
    ["fake-ip-filter-mode", "future-mode-secret"],
    ["fake-ip-filter-mode", true],
    ["fake-ip-filter-mode", ["blacklist"]],
  ])("does not retain invalid scalar %s=%j", (key, value) => {
    const details = projectSourcePolicyDetails({ dns: { [key]: value } });
    const selected =
      key === "fake-ip-range"
        ? details.dns.fakeIpRange
        : key === "fake-ip-range6"
          ? details.dns.fakeIpRange6
          : details.dns.fakeIpFilterMode;
    expect(selected).toEqual({ state: "unknown" });
    expect(JSON.stringify(details)).not.toContain("secret");
  });

  it.each([
    ["exact.test", "exact.test", true],
    ["exact.test", "a.exact.test", false],
    ["+.example.test", "example.test", true],
    ["+.example.test", "a.b.example.test", true],
    ["+.example.test", "badexample.test", false],
    ["*.example.test", "a.example.test", true],
    ["*.example.test", "example.test", false],
    ["*.example.test", "a.b.example.test", false],
  ])("uses the documented domain subset %s on %s", (pattern, target, matched) => {
    const details = projectSourcePolicyDetails({
      dns: {
        "fake-ip-filter-mode": "blacklist",
        "fake-ip-filter": [pattern],
      },
      sniffer: { "force-domain": [pattern], "skip-domain": [pattern] },
    });
    const result = querySourcePolicyTarget(details, target.toUpperCase());
    for (const key of ["fakeIpFilter", "forceDomain", "skipDomain"] as const) {
      expect(result[key].state).toBe(matched ? "matched" : "not-matched");
      expect(result[key].complete).toBe(true);
    }
  });

  it.each([
    "geosite:cn",
    "rule-set:private",
    ".example.test",
    "x.*.example.test",
    "Mijia Cloud",
    "https://secret.test/?token=sentinel",
  ])("does not turn an unsupported domain form into no-match: %s", (unsupported) => {
    const details = projectSourcePolicyDetails({
      dns: {
        "fake-ip-filter-mode": "blacklist",
        "fake-ip-filter": ["known.test", unsupported],
      },
    });
    expect(details.dns.fakeIpFilter).toMatchObject({ complete: false, unsupportedCount: 1 });
    expect(querySourcePolicyTarget(details, "unrelated.test").fakeIpFilter.state).toBe("unknown");
    const positive = querySourcePolicyTarget(details, "known.test").fakeIpFilter;
    expect(positive.state).toBe("unknown");
    expect(positive.matches).toHaveLength(1);
    expect(JSON.stringify(details)).not.toContain(unsupported);
  });

  it("keeps rule-mode filters in their separate unsupported grammar", () => {
    const details = projectSourcePolicyDetails({
      dns: {
        "fake-ip-filter-mode": "rule",
        "fake-ip-filter": ["known.test", "DOMAIN,known.test,real-ip", "MATCH,fake-ip"],
      },
    });
    expect(details.dns.fakeIpFilterMode).toEqual({ state: "known", value: "rule" });
    expect(details.dns.fakeIpFilter).toMatchObject({ entries: [], complete: false, unsupportedCount: 3 });
    expect(querySourcePolicyTarget(details, "known.test").fakeIpFilter.state).toBe("unknown");
  });

  it.each([{}, { "fake-ip-filter-mode": "future-secret" }])(
    "does not infer filter behavior when the mode is missing or unknown",
    (mode) => {
      const details = projectSourcePolicyDetails({ dns: { ...mode, "fake-ip-filter": [] } });
      expect(details.dns.fakeIpFilter.complete).toBe(true);
      expect(querySourcePolicyTarget(details, "known.test").fakeIpFilter.state).toBe("unknown");
    },
  );

  it("projects safe hosts mappings without picking wildcard precedence or resolving aliases", () => {
    const details = projectSourcePolicyDetails({
      hosts: {
        "exact.test": "2001:DB8::1",
        "*.exact.test": ["192.0.2.1", "2001:db8::2"],
        "+.exact.test": "alias.test",
      },
    });
    expect(details.hosts.complete).toBe(true);
    const exact = querySourcePolicyTarget(details, "exact.test").hosts;
    expect(exact.state).toBe("matched");
    expect(exact.matches).toHaveLength(2);
    expect(exact.matches[0].target).toEqual({ kind: "addresses", addresses: ["2001:db8::1"] });
    expect(exact.matches[1].target).toEqual({ kind: "alias", host: "alias.test" });
    const child = querySourcePolicyTarget(details, "a.exact.test").hosts;
    expect(child.matches).toHaveLength(2);
    expect(querySourcePolicyTarget(details, "other.test").hosts.state).toBe("not-matched");
  });

  it.each([
    { "unsafe.test": "https://user:secret@upstream.test/path" },
    { "unsafe.test": ["alias.test"] },
    { "unsafe.test": [] },
    { "unsafe.test": ["192.0.2.1", "https://secret.test"] },
    { "*.bad.*.test": "192.0.2.1" },
  ])("keeps unsupported hosts values as uncertainty, not an empty match table", (hosts) => {
    const details = projectSourcePolicyDetails({ hosts });
    expect(details.hosts.complete).toBe(false);
    expect(details.hosts.unsupportedCount).toBe(1);
    expect(querySourcePolicyTarget(details, "other.test").hosts.state).toBe("unknown");
    expect(JSON.stringify(details)).not.toContain("secret");
  });

  it("projects sniffer address ranges and independent protocol ports/override without defaults", () => {
    const details = projectSourcePolicyDetails({
      sniffer: {
        enable: true,
        "force-dns-mapping": false,
        "parse-pure-ip": true,
        "override-destination": false,
        "skip-src-address": ["192.0.2.1/32", "2001:DB8::/32"],
        "skip-dst-address": [],
        sniff: {
          HTTP: { ports: [80, "8080-8880"], "override-destination": true },
          TLS: { ports: [443, "8443"] },
          QUIC: { ports: [443], "override-destination": false },
        },
      },
    });
    expect(details.sniffer.enable).toEqual({ state: "known", value: true });
    expect(details.sniffer.forceDnsMapping).toEqual({ state: "known", value: false });
    expect(details.sniffer.skipSrcAddress.entries).toEqual(["192.0.2.1/32", "2001:db8::/32"]);
    expect(details.sniffer.skipDstAddress.complete).toBe(true);
    expect(details.sniffer.protocols.HTTP.ports.entries).toEqual([
      { from: 80, to: 80 },
      { from: 8080, to: 8880 },
    ]);
    expect(details.sniffer.protocols.HTTP.overrideDestination).toEqual({ state: "known", value: true });
    expect(details.sniffer.protocols.TLS.overrideDestination).toEqual({ state: "missing" });
    expect(details.sniffer.overrideDestination).toEqual({ state: "known", value: false });
    expect(details.sniffer.protocolsComplete).toBe(true);
  });

  it("rejects malformed sniffer values and drops unknown protocol/option names", () => {
    const details = projectSourcePolicyDetails({
      sniffer: {
        enable: "true",
        "override-destination": "secret",
        "skip-src-address": ["192.0.2.1", "2001:db8::/129", "https://secret.test"],
        sniff: {
          TLS: { ports: [0, 65536, "443-80", "443/8443", true], secret: "secret" },
          "private-protocol-secret": { ports: [443] },
        },
      },
    });
    expect(details.sniffer.enable).toEqual({ state: "unknown" });
    expect(details.sniffer.overrideDestination).toEqual({ state: "unknown" });
    expect(details.sniffer.skipSrcAddress.unsupportedCount).toBe(3);
    expect(details.sniffer.protocols.TLS.ports.unsupportedCount).toBe(5);
    expect(details.sniffer.protocols.TLS.unsupportedCount).toBe(1);
    expect(details.sniffer.unsupportedProtocolCount).toBe(1);
    expect(details.sniffer.protocolsComplete).toBe(false);
    expect(JSON.stringify(details)).not.toContain("secret");
  });

  it("distinguishes absent lists from explicitly empty complete lists", () => {
    const missing = projectSourcePolicyDetails({});
    const empty = projectSourcePolicyDetails({ hosts: {}, sniffer: { "force-domain": [] } });
    expect(missing.hosts).toMatchObject({ state: "missing", complete: false });
    expect(empty.hosts).toMatchObject({ state: "present", complete: true });
    expect(querySourcePolicyTarget(empty, "unknown.test").hosts.state).toBe("not-matched");
    expect(querySourcePolicyTarget(empty, "unknown.test").forceDomain.state).toBe("not-matched");
    expect(querySourcePolicyTarget(empty, "unknown.test").skipDomain.state).toBe("unknown");
  });

  it("bounds list, host mapping, address vector and port projection without pretending truncation is complete", () => {
    const hostMap = Object.fromEntries(
      Array.from({ length: 514 }, (_, index) => [`h${index}.test`, "192.0.2.1"]),
    );
    const details = projectSourcePolicyDetails({
      hosts: hostMap,
      dns: { "fake-ip-filter-mode": "blacklist", "fake-ip-filter": Array(515).fill("known.test") },
      sniffer: { sniff: { TLS: { ports: Array(130).fill(443) } } },
    });
    expect(details.hosts).toMatchObject({ complete: false, truncated: true, unsupportedCount: 2 });
    expect(details.hosts.entries).toHaveLength(512);
    expect(details.dns.fakeIpFilter).toMatchObject({ complete: false, truncated: true, unsupportedCount: 3 });
    expect(details.dns.fakeIpFilter.entries).toHaveLength(512);
    expect(details.sniffer.protocols.TLS.ports).toMatchObject({
      complete: false,
      truncated: true,
      unsupportedCount: 2,
    });
    const largeValue = projectSourcePolicyDetails({ hosts: { "many.test": Array(33).fill("192.0.2.1") } });
    expect(largeValue.hosts.entries).toEqual([]);
    expect(largeValue.hosts.complete).toBe(false);
    expect(querySourcePolicyTarget(details, "missing.test").hosts.state).toBe("unknown");
  });

  it("copies and freezes retained policy values and never retains upstreams or source object references", () => {
    const raw = {
      dns: {
        "fake-ip-filter-mode": "blacklist",
        "fake-ip-filter": ["known.test"],
        nameserver: ["https://secret.test/dns?token=sentinel"],
      },
      hosts: { "known.test": ["192.0.2.1"] },
      secret: "sentinel",
    };
    const details = projectSourcePolicyDetails(raw);
    raw.hosts["known.test"].push("192.0.2.2");
    raw.dns["fake-ip-filter"][0] = "changed.test";
    expect(details.hosts.entries[0].target).toEqual({ kind: "addresses", addresses: ["192.0.2.1"] });
    expect(querySourcePolicyTarget(details, "known.test").fakeIpFilter.state).toBe("matched");
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.dns.fakeIpFilter.entries[0])).toBe(true);
    expect(JSON.stringify(details)).not.toMatch(/secret|sentinel|nameserver/);
    expect(details).not.toHaveProperty("route");
    expect(details).not.toHaveProperty("runtimeConfigurationProven");
  });

  it("does not execute getters or treat inherited settings as parsed own fields", () => {
    const getter = vi.fn(() => "198.18.0.1/16");
    const dns = Object.defineProperty({}, "fake-ip-range", { get: getter });
    expect(projectSourcePolicyDetails({ dns }).dns.fakeIpRange).toEqual({ state: "unknown" });
    expect(getter).not.toHaveBeenCalled();
    const inherited = Object.create({ "fake-ip-range": "198.18.0.1/16" });
    expect(projectSourcePolicyDetails({ dns: inherited }).dns.fakeIpRange).toEqual({ state: "unknown" });
  });

  it.each(["https://known.test", "known.test/path", "*.known.test", "192.0.2.1", ""])(
    "does not accept non-host target %j as an unmatched query",
    (target) => {
      const details = projectSourcePolicyDetails({ hosts: {} });
      expect(querySourcePolicyTarget(details, target).hosts.state).toBe("unknown");
    },
  );
});
