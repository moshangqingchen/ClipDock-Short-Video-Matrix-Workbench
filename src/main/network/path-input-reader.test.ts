import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { WindowsSystemHostsObservation, WindowsSystemHostsSnapshot } from "./windows-system-hosts";
import { PathInputReader, type PathInputReaderOptions, type PathInputRequest } from "./path-input-reader";
import type { EffectiveConfigCandidate, EffectiveConfigSourceSnapshot } from "./effective-config-source";
import type { KernelDnsCandidates, KernelDnsHostCandidate, KernelDnsSnapshot } from "./kernel-dns";
import type { KernelDnsQueryType } from "./clash-reader";
import type { ProofTarget } from "./direct-proof";
import type { ProofScopeVersion } from "./proof-issuer";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";
import type { WindowsRouteSelection, WindowsRouteSelectionSnapshot } from "./windows-route-selection";

const VERSION = "a".repeat(64),
  HASH = "b".repeat(64),
  OTHER = "c".repeat(64);
const HOST = "creator.example.com";
const instances: PathInputReader[] = [];
const target = (host = HOST, addressFamily: ProofTarget["addressFamily"] = "ipv4"): ProofTarget => ({
  host,
  protocol: "https:",
  port: 443,
  addressFamily,
});
const request = (targets: readonly ProofTarget[] = [target()]): PathInputRequest => ({
  generation: 4,
  rulesVersion: VERSION,
  targets,
});
const missing = { present: false } as const;
function config(time = 100): EffectiveConfigCandidate {
  return {
    kind: "local-config-candidate",
    runtimeConfigurationProven: false,
    sourceGeneration: 2,
    sourcePathIdentity: HASH,
    fileFingerprint: HASH,
    decoderIdentity: "synthetic-plaintext-v1",
    startedAtMono: time,
    completedAtMono: time,
    expiresAtMono: time + 10000,
    controllerFingerprint: VERSION,
    controllerStartedAtMono: time,
    controllerCompletedAtMono: time,
    comparedConfigFields: ["mode"],
    comparedRuleCount: 1,
    orderedRulesFingerprint: HASH,
    sourceRuleOptionsFingerprint: HASH,
    rules: [{ type: "DOMAIN", payload: HOST, proxy: "DIRECT" }],
    policy: {
      fingerprint: HASH,
      dns: missing,
      hosts: missing,
      sniffer: missing,
      tun: missing,
      ipv6: missing,
      dnsFlags: {
        enable: missing,
        ipv6: missing,
        "use-hosts": missing,
        "use-system-hosts": missing,
        "respect-rules": missing,
      },
      dnsMode: missing,
      snifferFlags: {
        enable: missing,
        "force-dns-mapping": missing,
        "override-destination": missing,
        "parse-pure-ip": missing,
      },
      tunEnabled: missing,
      directOutbounds: { count: 0, fingerprint: HASH, builtinNameConfigured: false, entries: [] },
    },
    currentDirectPolicy: {
      kind: "direct",
      interfaceName: null,
      dialer: "none",
      ipVersion: null,
      policyFingerprint: HASH,
      startedAtMono: time,
      completedAtMono: time,
    },
  };
}
const configSnapshot = (candidate = config()): EffectiveConfigSourceSnapshot => ({
  state: "candidate",
  generation: candidate.sourceGeneration,
  candidate,
});
function owner(time = 100): Extract<WindowsControllerOwnerSnapshot, { available: true }> {
  return {
    available: true,
    basis: "windows-controller-listener",
    startedAtMono: time,
    completedAtMono: time,
    scopeHash: HASH,
    kernelEpoch: HASH,
    owner: { pid: 401, createdAtTicks: "639244035457234678", executablePathIdentity: null },
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port: 9790, coverage: "exact" }],
  };
}
function dnsHost(
  host: string,
  time: number,
  addresses: readonly string[] = ["203.0.113.8", "2001:db8::8"],
): KernelDnsHostCandidate {
  const answers = addresses.map((address) => ({
    queryType: (address.includes(":") ? "AAAA" : "A") as KernelDnsQueryType,
    name: host,
    type: (address.includes(":") ? 28 : 1) as 1 | 28,
    ttl: 10,
    data: address,
    observedAtMono: time,
    expiresAtMono: time + 10000,
  }));
  return {
    host,
    status: "unverified",
    reasons: ["ADDRESS_CLASS_UNKNOWN"],
    ipv4: addresses.filter((address) => !address.includes(":")),
    ipv6: addresses.filter((address) => address.includes(":")),
    addresses: addresses.map((address) => ({
      address,
      addressFamily: address.includes(":") ? "ipv6" : "ipv4",
      addressClass: "unknown",
    })),
    answers,
    queries: (["A", "AAAA"] as const).map((type) => ({
      type,
      startedAtMono: time,
      completedAtMono: time,
      error: null,
      response: {
        host,
        queryType: type,
        status: 0,
        truncated: false,
        question: { name: host, type: type === "A" ? 1 : 28 },
        answers: answers
          .filter((answer) => answer.queryType === type)
          .map(({ name, type: answerType, ttl, data }) => ({ name, type: answerType, ttl, data })),
        startedAtMono: time,
        completedAtMono: time,
      },
    })),
    startedAtMono: time,
    completedAtMono: time,
    expiresAtMono: time + 10000,
  };
}
function dns(
  hosts: readonly string[] = [HOST],
  time = 100,
  addresses?: readonly string[],
): KernelDnsCandidates {
  return {
    available: true,
    kind: "kernel-dns-candidates",
    chromiumResolutionProven: false,
    status: "unverified",
    controllerVersionBefore: { controllerVersion: VERSION, startedAtMono: time, completedAtMono: time },
    controllerVersionAfter: {
      controllerVersion: VERSION,
      startedAtMono: time,
      completedAtMono: time,
    },
    startedAtMono: time,
    completedAtMono: time,
    expiresAtMono: time + 10000,
    hosts: hosts.map((host) => dnsHost(host, time, addresses)),
  };
}
function shortDns(hosts: readonly string[], time: number): KernelDnsCandidates {
  const value = dns(hosts, time);
  return {
    ...value,
    ttlCapAtMono: time + 15_000,
    expiresAtMono: time + 1_000,
    hosts: value.hosts.map((host) => ({
      ...host,
      expiresAtMono: time + 1_000,
      answers: host.answers.map((answer) => ({ ...answer, ttl: 1, expiresAtMono: time + 1_000 })),
      queries: host.queries.map((query) => ({
        ...query,
        response: {
          ...query.response!,
          answers: query.response!.answers.map((answer) => ({ ...answer, ttl: 1 })),
        },
      })),
    })),
  };
}
function route(address: string): WindowsRouteSelection {
  const ipv6 = address.includes(":");
  return {
    targetAddress: address,
    sourceAddress: ipv6 ? "2001:db8::2" : "192.0.2.2",
    addressFamily: ipv6 ? "ipv6" : "ipv4",
    sourceState: "Preferred",
    skipAsSource: false,
    interfaceIndex: 12,
    interfaceGuid: "00000001-0002-0003-0004-000000000005",
    interfaceIdentity: HASH,
    hardwareInterface: true,
    adapterStatus: "Up",
    adapterUp: true,
    interfaceConnection: "Connected",
    interfaceMetric: 20,
    destinationPrefix: ipv6 ? "::/0" : "0.0.0.0/0",
    nextHop: ipv6 ? "fe80::1" : "192.0.2.1",
    routeMetric: 0,
    routeState: "Alive",
  };
}
function routes(
  addresses: readonly string[],
  time = 100,
): Extract<WindowsRouteSelectionSnapshot, { available: true }> {
  return {
    available: true,
    basis: "windows-best-route-query",
    socketObserved: false,
    startedAtMono: time,
    completedAtMono: time,
    scopeHash: HASH,
    selectionHash: HASH,
    selections: addresses.map(route),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(overrides: Partial<PathInputReaderOptions> = {}) {
  let time = 100;
  let version: ProofScopeVersion | null = { generation: 4, rulesVersion: VERSION };
  const events: string[] = [];
  const stamp = () => {
    return time;
  };
  const configuration = {
    read: vi.fn<PathInputReaderOptions["configuration"]["read"]>(async () => {
      events.push("configuration");
      return configSnapshot(config(stamp()));
    }),
  };
  const processOwner = {
    read: vi.fn<PathInputReaderOptions["owner"]["read"]>(async () => {
      events.push("owner");
      return owner(stamp());
    }),
  };
  const network = {
    readObservation: vi.fn<PathInputReaderOptions["network"]["readObservation"]>(async () => {
      events.push("network");
      const time = stamp();
      return { available: true, hash: HASH, startedAtMono: time, completedAtMono: time };
    }),
  };
  const resolver = {
    read: vi.fn<PathInputReaderOptions["dns"]["read"]>(async (hosts) => {
      events.push("dns");
      return dns(hosts, stamp());
    }),
  };
  const routeReaders: {
    selected: readonly string[];
    read: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<WindowsRouteSelectionSnapshot>>>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const createRouteReader = vi.fn<NonNullable<PathInputReaderOptions["createRouteReader"]>>((addresses) => {
    const reader = {
      selected: [...addresses],
      read: vi.fn(async (_signal?: AbortSignal): Promise<WindowsRouteSelectionSnapshot> => {
        events.push("routes");
        return routes(addresses, stamp());
      }),
      dispose: vi.fn(),
    };
    routeReaders.push(reader);
    return reader;
  });
  const readVersion = vi.fn(() => version);
  const service = new PathInputReader({
    configuration,
    owner: processOwner,
    network,
    dns: resolver,
    readVersion,
    createRouteReader,
    now: () => time,
    ...overrides,
  });
  instances.push(service);
  return {
    service,
    configuration,
    owner: processOwner,
    network,
    dns: resolver,
    createRouteReader,
    routeReaders,
    readVersion,
    events,
    time: () => time,
    setTime: (next: number) => {
      time = next;
    },
    setVersion: (next: ProofScopeVersion | null) => {
      version = next;
    },
  };
}
afterEach(() => {
  instances.splice(0).forEach((service) => service.dispose());
  vi.useRealTimers();
});

describe("PathInputReader coherent observations", () => {
  const hostsObservation = (hosts: readonly string[] = [HOST], at = 100): WindowsSystemHostsObservation => ({
    available: true,
    kind: "windows-system-hosts-targets",
    source: "windows-system-hosts-file",
    resolutionProven: false,
    parserProfile: "windows-hosts-ascii-aliases-v1",
    scopeHash: createHash("sha256").update(JSON.stringify(hosts)).digest("hex"),
    fileHash: HASH,
    fileIdentity: HASH,
    startedAtMono: at,
    completedAtMono: at,
    hosts: hosts.map((host) => ({ host, ipv4: [], ipv6: [] })),
  });

  it("reads system hosts on both sides of the route queries without promoting file contents to resolution proof", async () => {
    const raw = hostsObservation();
    const read = vi.fn(async () => raw);
    const input = setup({ systemHosts: { read } });
    const result = await input.service.read(request([target(), target(HOST, "ipv6")]));
    expect(result.state).toBe("observed");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls).toHaveLength(2);
    if (result.state !== "observed") return;
    expect(result.systemHostsBefore).toEqual(raw);
    expect(result.systemHostsAfter).not.toBe(raw);
    expect(Object.isFrozen(result.systemHostsAfter!.hosts)).toBe(true);
    expect(result.systemHostsAfter!.resolutionProven).toBe(false);
    expect(Object.isFrozen(raw)).toBe(false);
  });

  it.each(["fileHash", "fileIdentity", "hosts"] as const)(
    "rejects a system-hosts %s change during the round",
    async (field) => {
      const before = hostsObservation();
      const after = {
        ...before,
        [field]: field === "hosts" ? [{ host: HOST, ipv4: ["192.0.2.4"], ipv6: [] }] : OTHER,
      };
      const read = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      const input = setup({ systemHosts: { read } });
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "NETWORK_CHANGED",
      });
    },
  );

  it.each(["unavailable", "test source", "wrong target", "scope hash", "stale"] as const)(
    "does not replace %s system hosts with an empty file",
    async (kind) => {
      let value: WindowsSystemHostsSnapshot = hostsObservation();
      if (kind === "unavailable")
        value = { available: false, reason: "FILE_UNAVAILABLE", startedAtMono: 100, completedAtMono: 100 };
      if (kind === "test source") value = { ...hostsObservation(), source: "explicit-test-hosts-file" };
      if (kind === "wrong target") value = hostsObservation(["different.example.com"]);
      if (kind === "scope hash") value = { ...hostsObservation(), scopeHash: OTHER };
      if (kind === "stale") value = hostsObservation([HOST], 99);
      const input = setup({ systemHosts: { read: vi.fn(async () => value) } });
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: kind === "stale" ? "INPUT_EXPIRED" : "SYSTEM_HOSTS_UNAVAILABLE",
      });
      expect(input.dns.read).not.toHaveBeenCalled();
      expect(input.createRouteReader).not.toHaveBeenCalled();
    },
  );

  it("keeps the real hosts read occupied after public cancellation until file work settles", async () => {
    const holding = deferred<WindowsSystemHostsSnapshot>();
    const input = setup({ systemHosts: { read: vi.fn(() => holding.promise) } });
    const reading = input.service.read(request());
    await flush();
    input.service.dispose();
    expect(await reading).toMatchObject({ state: "unavailable", reason: "DISPOSED" });
    const finished = vi.fn();
    const idle = input.service.whenIdle().then(finished);
    await flush();
    expect(finished).not.toHaveBeenCalled();
    holding.resolve(hostsObservation());
    await idle;
    expect(input.dns.read).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledOnce();
  });

  it("brackets routes with current config/owner/OS then refreshes DNS, returning frozen inputs, never permission", async () => {
    const input = setup();
    const result = await input.service.read(
      request([target(HOST.toUpperCase() + "."), target(HOST, "ipv6")]),
    );
    expect(result).toMatchObject({
      state: "observed",
      kind: "current-path-inputs",
      generation: 4,
      rulesVersion: VERSION,
    });
    if (result.state !== "observed") throw Error("Expected observed inputs");
    expect(input.events).toEqual([
      "configuration",
      "owner",
      "network",
      "dns",
      "routes",
      "configuration",
      "owner",
      "network",
      "dns",
    ]);
    expect(input.dns.read.mock.calls.map(([hosts]) => hosts)).toEqual([[HOST], [HOST]]);
    expect(result.targets).toEqual([target(), target(HOST, "ipv6")]);
    expect(result.configurationBefore.runtimeConfigurationProven).toBe(false);
    expect(result.dnsBefore.chromiumResolutionProven).toBe(false);
    expect(result.dnsAfter.status).toBe("unverified");
    expect(result.ownerBefore.owner.executablePathIdentity).toBeNull();
    expect(result.routeBatches[0].socketObserved).toBe(false);
    expect(result).not.toHaveProperty("permit");
    expect(result).not.toHaveProperty("validatedRulePath");
    expect(result).not.toHaveProperty("allowed");
    expect(result.expiresAtMono).toBe(
      Math.min(
        result.configurationBefore.expiresAtMono,
        result.configurationAfter.expiresAtMono,
        result.dnsAfter.expiresAtMono,
      ),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(Object.isFrozen(result.configurationBefore.policy)).toBe(true);
    expect(Object.isFrozen(result.routeBatches[0].selections[0])).toBe(true);
    expect(input.routeReaders[0].dispose).toHaveBeenCalledOnce();
  });

  it("clones provider records and request targets rather than freezing or following external mutation", async () => {
    const input = setup(),
      captured = request(),
      candidate = config();
    input.configuration.read.mockResolvedValue(configSnapshot(candidate));
    const reading = input.service.read(captured);
    captured.targets[0].host = "mutated.example.com";
    const result = await reading;
    if (result.state !== "observed") throw Error("Expected observed inputs");
    expect(result.targets[0].host).toBe(HOST);
    expect(Object.isFrozen(candidate)).toBe(false);
    expect(result.configurationBefore).not.toBe(candidate);
  });

  it.each([
    "fileFingerprint",
    "sourceGeneration",
    "sourcePathIdentity",
    "decoderIdentity",
    "orderedRulesFingerprint",
    "sourceRuleOptionsFingerprint",
    "policy",
    "directPolicy",
  ])("rejects changed configuration %s", async (field) => {
    const input = setup(),
      before = config(),
      after = config();
    let changed: EffectiveConfigCandidate;
    if (field === "sourceGeneration") changed = { ...after, sourceGeneration: 3 };
    else if (field === "policy") changed = { ...after, policy: { ...after.policy, fingerprint: OTHER } };
    else if (field === "directPolicy")
      changed = { ...after, currentDirectPolicy: { ...after.currentDirectPolicy, policyFingerprint: OTHER } };
    else changed = { ...after, [field]: OTHER };
    input.configuration.read
      .mockResolvedValueOnce(configSnapshot(before))
      .mockResolvedValueOnce(configSnapshot(changed));
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "NETWORK_CHANGED",
    });
  });

  it.each(["epoch", "listenerScope", "osHash"])("rejects changed %s", async (kind) => {
    const input = setup();
    if (kind === "osHash")
      input.network.readObservation
        .mockResolvedValueOnce({ available: true, hash: HASH, startedAtMono: 100, completedAtMono: 100 })
        .mockResolvedValueOnce({ available: true, hash: OTHER, startedAtMono: 100, completedAtMono: 100 });
    else
      input.owner.read
        .mockResolvedValueOnce(owner())
        .mockResolvedValueOnce({ ...owner(), [kind === "epoch" ? "kernelEpoch" : "scopeHash"]: OTHER });
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "NETWORK_CHANGED",
    });
  });

  it.each(["address", "classification", "answer", "queryStatus", "queryError"])(
    "rejects DNS %s changes between route reads",
    async (kind) => {
      const input = setup(),
        before = dns(),
        after = dns(),
        host = after.hosts[0];
      let changed: KernelDnsHostCandidate = host;
      if (kind === "address")
        changed = {
          ...host,
          addresses: [{ ...host.addresses[0], address: "203.0.113.9" }, host.addresses[1]],
        };
      if (kind === "classification")
        changed = { ...host, addresses: host.addresses.map((row) => ({ ...row, addressClass: "real" })) };
      if (kind === "answer")
        changed = { ...host, answers: [{ ...host.answers[0], name: "cdn.example.com" }, host.answers[1]] };
      if (kind === "queryStatus")
        changed = {
          ...host,
          queries: [
            { ...host.queries[0], response: { ...host.queries[0].response!, status: 3 } },
            host.queries[1],
          ],
        };
      if (kind === "queryError")
        changed = {
          ...host,
          queries: [{ ...host.queries[0], error: "QUERY_FAILED", response: null }, host.queries[1]],
        };
      input.dns.read.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...after, hosts: [changed] });
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "NETWORK_CHANGED",
      });
    },
  );

  it.each(["ipv4", "ipv6"] as const)(
    "keeps an explicitly scoped %s observation when only the unrequested family changes",
    async (family) => {
      const input = setup();
      const before = dns();
      const queryType = family === "ipv4" ? "AAAA" : "A";
      const unrelatedFamily = family === "ipv4" ? "ipv6" : "ipv4";
      const changedAddress = family === "ipv4" ? "2001:db8::99" : "203.0.113.99";
      const host = before.hosts[0];
      const changedHost: KernelDnsHostCandidate = {
        ...host,
        [unrelatedFamily]: [changedAddress],
        addresses: host.addresses.map((row) =>
          row.addressFamily === unrelatedFamily
            ? { ...row, address: changedAddress, addressClass: "fake-ip" }
            : row,
        ),
        answers: host.answers.map((row) =>
          row.queryType === queryType ? { ...row, data: changedAddress } : row,
        ),
        queries: host.queries.map((row) =>
          row.type === queryType ? { ...row, error: "QUERY_FAILED", response: null } : row,
        ),
      };
      const after = { ...before, hosts: [changedHost] };
      input.dns.read.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      const result = await input.service.read(request([target(HOST, family)]));
      expect(result.state).toBe("observed");
      if (result.state !== "observed") throw Error("Expected scoped observation");
      expect(result.dnsAfter).toEqual(after);
      expect(result.dnsAfter.chromiumResolutionProven).toBe(false);
      expect(
        result.routeBatches.flatMap((batch) => batch.selections.map((row) => row.targetAddress)),
      ).toEqual([family === "ipv4" ? "203.0.113.8" : "2001:db8::8"]);
      expect(result).not.toHaveProperty("allowed");
      await flush();
      input.dns.read.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      expect(await input.service.read(request([target(), target(HOST, "ipv6")]))).toMatchObject({
        state: "unavailable",
        reason: "NETWORK_CHANGED",
      });
    },
  );

  it.each(["ipv4", "ipv6"] as const)(
    "uses only declared %s answer TTLs and the real source cap, preserving expired other-family data",
    async (family) => {
      const input = setup();
      const base = dns();
      const unrelatedQuery = family === "ipv4" ? "AAAA" : "A";
      const source: KernelDnsCandidates = {
        ...base,
        ttlCapAtMono: 4_500,
        expiresAtMono: 1_100,
        hosts: base.hosts.map((host) => ({
          ...host,
          expiresAtMono: 1_100,
          answers: host.answers.map((row) =>
            row.queryType === unrelatedQuery ? { ...row, ttl: 1, expiresAtMono: 1_100 } : row,
          ),
          queries: host.queries.map((row) =>
            row.type === unrelatedQuery
              ? {
                  ...row,
                  response: {
                    ...row.response!,
                    answers: row.response!.answers.map((answer) => ({ ...answer, ttl: 1 })),
                  },
                }
              : row,
          ),
        })),
      };
      const refreshed = { ...source, completedAtMono: 1_600 };
      input.dns.read.mockResolvedValueOnce(source).mockImplementationOnce(async () => {
        input.setTime(1_600);
        return refreshed;
      });
      const result = await input.service.read(request([target(HOST, family)]));
      expect(result).toMatchObject({ state: "observed", expiresAtMono: 4_500 });
      if (result.state !== "observed") throw Error("Expected scoped observation");
      expect(result.dnsAfter).toEqual(refreshed);
      expect(result.dnsAfter.expiresAtMono).toBeLessThan(result.completedAtMono);
      expect(result.dnsAfter.hosts[0].answers.find((row) => row.queryType === unrelatedQuery)?.ttl).toBe(1);
      expect(result.dnsAfter.status).toBe("unverified");
    },
  );

  it.each(["required-answer", "both-families", "missing-cap", "invalid-cap", "expired-cap"])(
    "does not extend DNS freshness for %s",
    async (kind) => {
      const input = setup();
      const base = dns();
      const shortQuery = kind === "required-answer" ? "A" : "AAAA";
      const source: KernelDnsCandidates = {
        ...base,
        ...(kind === "missing-cap"
          ? {}
          : { ttlCapAtMono: kind === "invalid-cap" ? NaN : kind === "expired-cap" ? 100 : 4_500 }),
        expiresAtMono: 100,
        hosts: base.hosts.map((host) => ({
          ...host,
          expiresAtMono: 100,
          answers: host.answers.map((row) =>
            row.queryType === shortQuery ? { ...row, ttl: 0, expiresAtMono: 100 } : row,
          ),
        })),
      };
      input.dns.read.mockResolvedValue(source);
      expect(
        await input.service.read(
          kind === "both-families" ? request([target(), target(HOST, "ipv6")]) : request(),
        ),
      ).toMatchObject({ state: "unavailable", reason: "INPUT_EXPIRED" });
    },
  );

  it.each(["missing-query", "nodata"])(
    "retains %s for a declared family as unverified observation without inventing an address or permit",
    async (kind) => {
      const input = setup();
      const base = dns([HOST], 100, []);
      const source: KernelDnsCandidates = {
        ...base,
        ttlCapAtMono: 900,
        hosts: base.hosts.map((host) => ({
          ...host,
          reasons: [kind === "missing-query" ? "QUERY_FAILED" : "FAMILY_MISSING"],
          queries:
            kind === "missing-query" ? host.queries.filter((query) => query.type !== "A") : host.queries,
        })),
      };
      input.dns.read.mockResolvedValue(source);
      const result = await input.service.read(request());
      expect(result).toMatchObject({ state: "observed", expiresAtMono: 900, routeBatches: [] });
      if (result.state !== "observed") throw Error("Expected unverified observation");
      expect(result.dnsAfter).toEqual(source);
      expect(result.dnsAfter.status).toBe("unverified");
      expect(input.createRouteReader).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty("permit");
    },
  );

  it.each(["configBefore", "configAfter", "dnsBefore", "dnsAfter"])(
    "refuses unrelated controller version from %s",
    async (which) => {
      const input = setup();
      if (which.startsWith("config")) {
        const changed = configSnapshot({ ...config(), controllerFingerprint: OTHER });
        input.configuration.read
          .mockResolvedValueOnce(which === "configBefore" ? changed : configSnapshot())
          .mockResolvedValueOnce(changed);
      } else {
        const changed = {
          ...dns(),
          controllerVersionAfter: { ...dns().controllerVersionAfter, controllerVersion: OTHER },
        };
        input.dns.read
          .mockResolvedValueOnce(which === "dnsBefore" ? changed : dns())
          .mockResolvedValueOnce(changed);
      }
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "NETWORK_CHANGED",
      });
    },
  );

  it.each(["generation", "rulesVersion", "missing"])(
    "refuses Gate %s changed while routes were being read",
    async (kind) => {
      const input = setup();
      input.createRouteReader.mockImplementation((addresses) => ({
        read: async () => {
          input.setVersion(
            kind === "missing"
              ? null
              : {
                  generation: kind === "generation" ? 5 : 4,
                  rulesVersion: kind === "rulesVersion" ? OTHER : VERSION,
                },
          );
          return routes(addresses);
        },
        dispose: vi.fn(),
      }));
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "NETWORK_CHANGED",
      });
      expect(input.dns.read).toHaveBeenCalledOnce();
    },
  );

  it.each(["configBefore", "configAfter", "dnsAfter", "notFinite"])(
    "rejects %s expiration at completion",
    async (which) => {
      const input = setup(),
        expired = configSnapshot({ ...config(), expiresAtMono: which === "notFinite" ? NaN : 100 });
      if (which === "dnsAfter")
        input.dns.read.mockResolvedValueOnce(dns()).mockResolvedValueOnce({ ...dns(), expiresAtMono: 100 });
      else
        input.configuration.read
          .mockResolvedValueOnce(which === "configAfter" ? configSnapshot() : expired)
          .mockResolvedValueOnce(expired);
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "INPUT_EXPIRED",
      });
    },
  );

  it("accepts refreshed identical DNS despite earlier TTL countdown, retaining both original observations", async () => {
    const input = setup(),
      before = { ...dns(), expiresAtMono: 105 },
      later = dns([HOST], 200);
    const refreshed = {
      ...later,
      hosts: later.hosts.map((host) => ({
        ...host,
        answers: host.answers.map((answer) => ({ ...answer, ttl: 5, expiresAtMono: 5110 })),
      })),
    };
    input.dns.read.mockResolvedValueOnce(before).mockResolvedValueOnce(refreshed);
    input.createRouteReader.mockImplementation((addresses) => ({
      read: async () => {
        input.setTime(200);
        return routes(addresses, 100);
      },
      dispose: vi.fn(),
    }));
    const result = await input.service.read(request());
    if (result.state !== "observed") throw Error("Expected observed inputs");
    expect(result.completedAtMono).toBeGreaterThan(before.expiresAtMono);
    expect(result.dnsBefore.expiresAtMono).toBe(105);
    expect(result.dnsBefore.hosts[0].answers[0].ttl).toBe(10);
    expect(result.dnsAfter.hosts[0].answers[0].ttl).toBe(5);
  });

  it("refreshes actual 1s DNS after a 1.5s owner postflight without extending any recorded TTL", async () => {
    const readHosts = vi.fn(async (hosts: readonly string[]): Promise<WindowsSystemHostsObservation> =>
      hostsObservation(hosts, input.time()),
    );
    const input = setup({ systemHosts: { read: readHosts } });
    const slowOwner = deferred<WindowsControllerOwnerSnapshot>();
    input.owner.read.mockResolvedValueOnce(owner()).mockReturnValueOnce(slowOwner.promise);
    input.dns.read.mockImplementation(async (hosts) => shortDns(hosts, input.time()));
    const reading = input.service.read(request([target(), target(HOST, "ipv6")]));
    await flush();
    expect(input.owner.read).toHaveBeenCalledTimes(2);
    expect(input.dns.read).toHaveBeenCalledOnce();
    input.setTime(1_600);
    slowOwner.resolve({ ...owner(100), completedAtMono: 1_600 });
    const result = await reading;
    expect(result).toMatchObject({ state: "observed", completedAtMono: 1_600, expiresAtMono: 2_600 });
    if (result.state !== "observed") throw Error("Expected refreshed observation");
    expect(result.dnsBefore).toEqual(shortDns([HOST], 100));
    expect(result.dnsAfter).toEqual(shortDns([HOST], 1_600));
    expect(result.dnsBefore.expiresAtMono).toBeLessThan(result.completedAtMono);
    expect(result.ownerAfter).toEqual({ ...owner(100), completedAtMono: 1_600 });
    expect(result.dnsAfter.startedAtMono).toBeGreaterThanOrEqual(
      Math.max(
        result.configurationAfter.completedAtMono,
        result.ownerAfter.completedAtMono,
        result.networkAfter.completedAtMono,
        result.systemHostsAfter!.completedAtMono,
      ),
    );
    expect(readHosts).toHaveBeenCalledTimes(2);
    expect(input.dns.read).toHaveBeenCalledTimes(2);
    expect(result.dnsAfter.chromiumResolutionProven).toBe(false);
    expect(result).not.toHaveProperty("permit");
  });

  it.each([
    { kind: "controller-before", reason: "NETWORK_CHANGED" },
    { kind: "controller-after", reason: "NETWORK_CHANGED" },
    { kind: "gate-version", reason: "NETWORK_CHANGED" },
    { kind: "address-set", reason: "NETWORK_CHANGED" },
    { kind: "answer-expired", reason: "INPUT_EXPIRED" },
    { kind: "source-cap-expired", reason: "INPUT_EXPIRED" },
    { kind: "shared-old-dns", reason: "INPUT_EXPIRED" },
    { kind: "configuration-expired", reason: "INPUT_EXPIRED" },
  ])("still rejects $kind in the final DNS refresh after slow postflight", async ({ kind, reason }) => {
    const input = setup();
    const slowOwner = deferred<WindowsControllerOwnerSnapshot>();
    input.owner.read.mockResolvedValueOnce(owner()).mockReturnValueOnce(slowOwner.promise);
    if (kind === "configuration-expired")
      input.configuration.read.mockResolvedValueOnce(configSnapshot({ ...config(), expiresAtMono: 1_600 }));
    input.dns.read.mockResolvedValueOnce(shortDns([HOST], 100)).mockImplementationOnce(async (hosts) => {
      const sample = shortDns(hosts, input.time());
      if (kind === "controller-before")
        return {
          ...sample,
          controllerVersionBefore: { ...sample.controllerVersionBefore, controllerVersion: OTHER },
        };
      if (kind === "controller-after")
        return {
          ...sample,
          controllerVersionAfter: { ...sample.controllerVersionAfter, controllerVersion: OTHER },
        };
      if (kind === "gate-version") input.setVersion({ generation: 5, rulesVersion: VERSION });
      if (kind === "address-set")
        return {
          ...sample,
          hosts: sample.hosts.map((host) => ({
            ...host,
            ipv4: ["203.0.113.9"],
            addresses: host.addresses.map((address) =>
              address.addressFamily === "ipv4" ? { ...address, address: "203.0.113.9" } : address,
            ),
            answers: host.answers.map((answer) =>
              answer.type === 1 ? { ...answer, data: "203.0.113.9" } : answer,
            ),
            queries: host.queries.map((query) => ({
              ...query,
              response: {
                ...query.response!,
                answers: query.response!.answers.map((answer) =>
                  answer.type === 1 ? { ...answer, data: "203.0.113.9" } : answer,
                ),
              },
            })),
          })),
        };
      if (kind === "answer-expired") {
        // A fresh call can still consume its own entire 1s TTL; do not stamp a new deadline on return.
        input.setTime(input.time() + 1_000);
        return {
          ...sample,
          completedAtMono: input.time(),
          controllerVersionAfter: {
            ...sample.controllerVersionAfter,
            startedAtMono: input.time(),
            completedAtMono: input.time(),
          },
        };
      }
      if (kind === "source-cap-expired") return { ...sample, ttlCapAtMono: sample.startedAtMono };
      if (kind === "shared-old-dns") return shortDns(hosts, 100);
      return sample;
    });
    const reading = input.service.read(request());
    await flush();
    expect(input.dns.read).toHaveBeenCalledOnce();
    input.setTime(1_600);
    slowOwner.resolve({ ...owner(), completedAtMono: 1_600 });
    expect(await reading).toMatchObject({ state: "unavailable", reason });
    expect(input.dns.read).toHaveBeenCalledTimes(2);
    expect(input.createRouteReader).toHaveBeenCalledOnce();
  });
});

describe("PathInputReader provider sampling windows", () => {
  const providers = ["configuration", "owner", "network", "dns", "routes"] as const;
  const cases = providers.flatMap((provider) =>
    (["stale", "future", "inverted", "not-finite"] as const).map((kind) => ({ provider, kind })),
  );
  it.each(cases)("rejects $provider with a $kind actual sampling window", async ({ provider, kind }) => {
    const input = setup();
    const window = {
      startedAtMono: kind === "stale" ? 99 : kind === "not-finite" ? NaN : 100,
      completedAtMono: kind === "future" ? 101 : kind === "inverted" ? 99 : 100,
    };
    if (provider === "configuration")
      input.configuration.read.mockResolvedValue(configSnapshot({ ...config(), ...window }));
    if (provider === "owner") input.owner.read.mockResolvedValue({ ...owner(), ...window });
    if (provider === "network")
      input.network.readObservation.mockResolvedValue({ available: true, hash: HASH, ...window });
    if (provider === "dns") input.dns.read.mockResolvedValue({ ...dns(), ...window });
    if (provider === "routes")
      input.createRouteReader.mockImplementation((addresses) => ({
        read: async () => ({ ...routes(addresses), ...window }),
        dispose: vi.fn(),
      }));
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "INPUT_EXPIRED",
    });
  });

  it.each(["configuration", "owner", "network", "dns"] as const)(
    "does not relabel an old shared %s sample as a fresh after observation",
    async (provider) => {
      const input = setup();
      // These objects represent an underlying sampler returning the same in-flight/shared read.
      if (provider === "configuration") input.configuration.read.mockResolvedValue(configSnapshot());
      if (provider === "owner") input.owner.read.mockResolvedValue(owner());
      if (provider === "network")
        input.network.readObservation.mockResolvedValue({
          available: true,
          hash: HASH,
          startedAtMono: 100,
          completedAtMono: 100,
        });
      if (provider === "dns") input.dns.read.mockResolvedValue(dns());
      input.createRouteReader.mockImplementation((addresses) => ({
        read: async () => {
          input.setTime(200);
          return routes(addresses, 100);
        },
        dispose: vi.fn(),
      }));
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "INPUT_EXPIRED",
      });
    },
  );
});

describe("PathInputReader target completeness and limits", () => {
  it("does not substitute a source-constrained query for the actual unconstrained OS path", async () => {
    const input = setup();
    input.createRouteReader.mockImplementation((addresses) => ({
      read: async () => ({
        ...routes(addresses),
        basis: "windows-source-route-query" as const,
        localAddress: "192.0.2.10",
      }),
      dispose: vi.fn(),
    }));
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "ROUTES_UNAVAILABLE",
    });
  });

  it("deduplicates addresses across hosts and reads every requested family in batches of at most 16", async () => {
    const input = setup(),
      addresses = Array.from({ length: 33 }, (_, i) => `203.0.113.${i + 1}`);
    addresses.push("2001:db8::1");
    input.dns.read.mockImplementation(async (hosts) => dns(hosts, 100, addresses));
    const result = await input.service.read(
      request([
        target(),
        target(HOST, "ipv6"),
        target("second.example.com"),
        target("second.example.com", "ipv6"),
      ]),
    );
    expect(result.state).toBe("observed");
    expect(input.createRouteReader.mock.calls.map(([selected]) => selected.length)).toEqual([16, 16, 2]);
    expect(input.createRouteReader.mock.calls.flatMap(([selected]) => selected).sort()).toEqual(
      [...addresses].sort(),
    );
    expect(input.routeReaders.every((reader) => reader.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("keeps unrequested DNS families as observations without requiring their OS routes", async () => {
    const input = setup();
    const result = await input.service.read(request());
    expect(result.state).toBe("observed");
    expect(input.createRouteReader).toHaveBeenCalledWith(["203.0.113.8"]);
    if (result.state !== "observed") throw Error("Expected observed inputs");
    expect(result.dnsAfter.hosts[0].ipv6).toEqual(["2001:db8::8"]);
    expect(result.targets).toEqual([target()]);
    expect(result).not.toHaveProperty("familyConstraintEvidenceId");
  });

  it("refuses an address set above the bound before constructing route readers", async () => {
    const input = setup({ maxAddresses: 16 });
    input.dns.read.mockResolvedValue(
      dns(
        [HOST],
        100,
        Array.from({ length: 17 }, (_, i) => `203.0.113.${i + 1}`),
      ),
    );
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "ROUTES_UNAVAILABLE",
    });
    expect(input.createRouteReader).not.toHaveBeenCalled();
  });

  it("enforces the default 128 distinct address bound", async () => {
    const input = setup();
    input.dns.read.mockResolvedValue(
      dns(
        [HOST],
        100,
        Array.from({ length: 129 }, (_, i) => `203.0.113.${i + 1}`),
      ),
    );
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "ROUTES_UNAVAILABLE",
    });
    expect(input.createRouteReader).not.toHaveBeenCalled();
  });

  it.each(["missing", "extra", "duplicate", "unavailable"])(
    "refuses %s route targets and disposes the completed reader",
    async (kind) => {
      const input = setup(),
        dispose = vi.fn();
      input.createRouteReader.mockImplementation((addresses) => ({
        read: async () => {
          if (kind === "unavailable")
            return { available: false, reason: "READ_UNAVAILABLE", startedAtMono: 100, completedAtMono: 100 };
          const selected =
            kind === "missing"
              ? addresses.slice(1)
              : kind === "extra"
                ? [...addresses, "203.0.113.99"]
                : [addresses[0], addresses[0]];
          return routes(selected);
        },
        dispose,
      }));
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: "ROUTES_UNAVAILABLE",
      });
      expect(dispose).toHaveBeenCalledOnce();
      expect(input.dns.read).toHaveBeenCalledOnce();
    },
  );

  it.each(["missing", "duplicate", "unrelated"])("refuses %s DNS host set", async (kind) => {
    const input = setup(),
      hosts = kind === "missing" ? [] : kind === "duplicate" ? [HOST, HOST] : ["unrelated.example.com"];
    input.dns.read.mockResolvedValue(dns(hosts));
    expect(await input.service.read(request())).toMatchObject({
      state: "unavailable",
      reason: "DNS_UNAVAILABLE",
    });
    expect(input.createRouteReader).not.toHaveBeenCalled();
  });

  it("retains empty/unverified DNS as observation only rather than inventing route or permission", async () => {
    const input = setup();
    input.dns.read.mockResolvedValue(dns([HOST], 100, []));
    const result = await input.service.read(request());
    expect(result).toMatchObject({ state: "observed", dnsAfter: { status: "unverified" }, routeBatches: [] });
    expect(input.createRouteReader).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("permit");
  });

  it.each([
    request([]),
    request([target(), target(HOST.toUpperCase())]),
    request([target("127.0.0.1")]),
    request(Array.from({ length: 129 }, (_, i) => target(`h${i}.example.com`))),
    { ...request(), generation: 0 },
    { ...request(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...request(), rulesVersion: "" },
    { ...request(), rulesVersion: "x".repeat(257) },
  ])("rejects invalid target/version input before touching providers", async (value) => {
    const input = setup();
    expect(await input.service.read(value)).toMatchObject({ state: "unavailable", reason: "INPUT_INVALID" });
    expect(input.configuration.read).not.toHaveBeenCalled();
    expect(input.owner.read).not.toHaveBeenCalled();
  });
});

describe("PathInputReader real pending slots", () => {
  it("coalesces same normalized target set while a different key is busy", async () => {
    const input = setup(),
      holding = deferred<EffectiveConfigSourceSnapshot>();
    input.configuration.read.mockReturnValueOnce(holding.promise);
    const a = input.service.read(request([target(), target("other.example.com")]));
    const b = input.service.read(request([target("OTHER.EXAMPLE.COM."), target(HOST.toUpperCase())]));
    expect(a).toBe(b);
    expect(await input.service.read(request([target("third.example.com")]))).toMatchObject({
      state: "unavailable",
      reason: "READ_BUSY",
    });
    expect(input.configuration.read).toHaveBeenCalledOnce();
    holding.resolve(configSnapshot());
    const firstResult = await a;
    expect(firstResult.state).toBe("observed");
    await flush();
    const next = await input.service.read(request());
    expect(next.state).toBe("observed");
    if (next.state === "observed" && firstResult.state === "observed")
      expect(next.sampleId).not.toBe(firstResult.sampleId);
  });

  it.each(["first", "final"])(
    "keeps %s parallel batch slot after one provider rejects until its sibling settles",
    async (which) => {
      const input = setup(),
        holding = deferred<WindowsControllerOwnerSnapshot>();
      if (which === "final") {
        input.configuration.read.mockResolvedValueOnce(configSnapshot());
        input.owner.read.mockResolvedValueOnce(owner());
      }
      input.configuration.read.mockRejectedValueOnce(Error("synthetic-private-provider-error"));
      input.owner.read.mockReturnValueOnce(holding.promise);
      const pending = input.service.read(request());
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
      expect(input.service.read(request())).toBe(pending);
      expect(await input.service.read(request([target("different.example.com")]))).toMatchObject({
        state: "unavailable",
        reason: "READ_BUSY",
      });
      expect(input.owner.read).toHaveBeenCalledTimes(which === "first" ? 1 : 2);
      holding.resolve(owner());
      const result = await pending;
      expect(result).toMatchObject({ state: "unavailable", reason: "SOURCE_UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
      await flush();
      expect((await input.service.read(request())).state).toBe("observed");
    },
  );

  it("joined cancellation returns promptly but retains a still-running provider slot and discards its late result", async () => {
    const input = setup(),
      holding = deferred<WindowsControllerOwnerSnapshot>(),
      abort = new AbortController();
    input.owner.read.mockReturnValueOnce(holding.promise);
    const pending = input.service.read(request());
    expect(input.service.read(request(), abort.signal)).toBe(pending);
    abort.abort("synthetic-private-reason");
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ state: "unavailable", reason: "READ_CANCELLED" });
    expect(input.owner.read.mock.calls[0][0]?.aborted).toBe(true);
    expect(input.service.read(request())).toBe(pending);
    expect(await input.service.read(request([target("different.example.com")]))).toMatchObject({
      reason: "READ_BUSY",
    });
    holding.resolve(owner());
    await flush();
    expect(input.dns.read).not.toHaveBeenCalled();
    expect((await input.service.read(request())).state).toBe("observed");
  });

  it("an unavailable kernel result does not detach a still-running configuration provider", async () => {
    const input = setup(),
      holding = deferred<EffectiveConfigSourceSnapshot>();
    input.configuration.read.mockReturnValueOnce(holding.promise);
    input.owner.read.mockResolvedValueOnce({
      available: false,
      reason: "READ_UNAVAILABLE",
      startedAtMono: 100,
      completedAtMono: 100,
    });
    const pending = input.service.read(request());
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await flush();
    expect(completed).toBe(false);
    expect(input.service.read(request())).toBe(pending);
    expect(await input.service.read(request([target("other.example.com")]))).toMatchObject({
      reason: "READ_BUSY",
    });
    holding.resolve(configSnapshot());
    expect(await pending).toMatchObject({ state: "unavailable", reason: "KERNEL_UNAVAILABLE" });
    expect(input.dns.read).not.toHaveBeenCalled();
  });

  it("retains the route slot until optional whenIdle settles even after read returned and caller cancelled", async () => {
    const input = setup(),
      idle = deferred<void>(),
      abort = new AbortController(),
      dispose = vi.fn();
    const whenIdle = vi.fn(() => idle.promise);
    input.createRouteReader.mockImplementationOnce((addresses) => ({
      read: async () => routes(addresses),
      dispose,
      whenIdle,
    }));
    const pending = input.service.read(request(), abort.signal);
    await flush();
    expect(dispose).toHaveBeenCalledOnce();
    expect(whenIdle).toHaveBeenCalledOnce();
    abort.abort();
    expect(await pending).toMatchObject({ state: "unavailable", reason: "READ_CANCELLED" });
    expect(input.service.read(request())).toBe(pending);
    expect(await input.service.read(request([target("other.example.com")]))).toMatchObject({
      reason: "READ_BUSY",
    });
    expect(input.createRouteReader).toHaveBeenCalledOnce();
    idle.resolve();
    await flush();
    expect(input.dns.read).toHaveBeenCalledOnce();
    expect((await input.service.read(request())).state).toBe("observed");
  });

  it("timeout keeps an uncooperative route provider occupied and disposes it only after real settlement", async () => {
    const input = setup({ timeoutMs: 20 }),
      holding = deferred<WindowsRouteSelectionSnapshot>(),
      dispose = vi.fn();
    input.createRouteReader.mockImplementationOnce(() => ({ read: () => holding.promise, dispose }));
    const pending = input.service.read(request());
    const result = await pending;
    expect(result).toMatchObject({ state: "unavailable", reason: "READ_TIMEOUT" });
    expect(dispose).not.toHaveBeenCalled();
    expect(input.service.read(request())).toBe(pending);
    expect(await input.service.read(request([target("other.example.com")]))).toMatchObject({
      reason: "READ_BUSY",
    });
    expect(input.createRouteReader).toHaveBeenCalledOnce();
    holding.resolve(routes(["203.0.113.8", "2001:db8::8"]));
    await flush();
    expect(dispose).toHaveBeenCalledOnce();
    expect(input.dns.read).toHaveBeenCalledOnce();
    expect((await input.service.read(request())).state).toBe("observed");
  });

  it("does not let a pre-aborted caller cancel an existing batch", async () => {
    const input = setup(),
      holding = deferred<EffectiveConfigSourceSnapshot>(),
      abort = new AbortController();
    input.configuration.read.mockReturnValueOnce(holding.promise);
    const pending = input.service.read(request());
    abort.abort();
    expect(await input.service.read(request(), abort.signal)).toMatchObject({ reason: "READ_CANCELLED" });
    holding.resolve(configSnapshot());
    expect((await pending).state).toBe("observed");
  });

  it("removes finished caller abort listeners and does not cancel the next round", async () => {
    const input = setup(),
      old = new AbortController();
    expect((await input.service.read(request(), old.signal)).state).toBe("observed");
    await flush();
    const holding = deferred<EffectiveConfigSourceSnapshot>();
    input.configuration.read.mockReturnValueOnce(holding.promise);
    const pending = input.service.read(request());
    old.abort();
    holding.resolve(configSnapshot());
    expect((await pending).state).toBe("observed");
  });

  it("disposal cancels pending work without allowing future reads or late observations", async () => {
    const input = setup(),
      holding = deferred<KernelDnsSnapshot>();
    input.dns.read.mockReturnValueOnce(holding.promise);
    const pending = input.service.read(request());
    await flush();
    input.service.dispose();
    expect(await pending).toMatchObject({ state: "unavailable", reason: "DISPOSED" });
    expect(await input.service.read(request())).toMatchObject({ state: "unavailable", reason: "DISPOSED" });
    const settled = vi.fn();
    const idle = input.service.whenIdle().then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    holding.resolve(dns());
    await idle;
    expect(settled).toHaveBeenCalledOnce();
    expect(input.createRouteReader).not.toHaveBeenCalled();
  });

  it.each(["source", "kernel", "network", "dns"])(
    "returns a dedicated %s unavailable result",
    async (kind) => {
      const input = setup();
      if (kind === "source") input.configuration.read.mockResolvedValue({ state: "checking", generation: 2 });
      if (kind === "kernel")
        input.owner.read.mockResolvedValue({
          available: false,
          reason: "READ_UNAVAILABLE",
          startedAtMono: 100,
          completedAtMono: 100,
        });
      if (kind === "network")
        input.network.readObservation.mockResolvedValue({
          available: false,
          hash: null,
          startedAtMono: 100,
          completedAtMono: 100,
        });
      if (kind === "dns")
        input.dns.read.mockResolvedValue({
          available: false,
          reason: "CONTROLLER_UNAVAILABLE",
          startedAtMono: 100,
          completedAtMono: 100,
        });
      expect(await input.service.read(request())).toMatchObject({
        state: "unavailable",
        reason: `${kind.toUpperCase()}_UNAVAILABLE`,
      });
    },
  );
});
