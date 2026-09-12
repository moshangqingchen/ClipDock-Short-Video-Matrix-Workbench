import { createHash } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClashReadResult } from "./clash-reader";
import { evaluateRules } from "./rules";
import { querySourcePolicyTarget } from "./source-policy-details";
import {
  EffectiveConfigSource,
  type EffectiveConfigSourceOptions,
  type EffectiveConfigSourceSnapshot,
} from "./effective-config-source";

const sources: EffectiveConfigSource[] = [];
const temporaryFiles: string[] = [];
const temporaryDirectories: string[] = [];

const YAML = `mode: rule
mixed-port: 7890
ipv6: true
tun:
  enable: true
dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  use-hosts: true
  respect-rules: true
  nameserver: [https://resolver.invalid/private-synthetic-value]
hosts:
  synthetic.invalid: 192.0.2.90
sniffer:
  enable: true
  override-destination: true
secret: synthetic-controller-secret
proxies:
  - name: synthetic-proxy-name
    type: socks5
    server: synthetic-node.invalid
    password: synthetic-proxy-password
rules:
  - DOMAIN,creator.example.invalid,DIRECT
  - RULE-SET,not-installed-and-not-needed,DIRECT
  - MATCH,synthetic-proxy-name
`;
const visible = () => ({
  mode: "rule",
  "mixed-port": 7890,
  ipv6: true,
  tun: { enable: true, stack: "mixed" },
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function paths(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (node: unknown, pointer: string) => {
    result[pointer] = hash(node);
    if (node && typeof node === "object" && !Array.isArray(node))
      for (const [key, child] of Object.entries(node))
        visit(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  };
  visit(value, "");
  return result;
}
function live(config: Record<string, unknown> = visible()): ClashReadResult {
  const now = performance.now();
  return {
    mode: "rule",
    tun: true,
    mixedPort: 7890,
    version: "synthetic-test-kernel",
    fingerprint: "a".repeat(64),
    rules: [
      { type: "Domain", payload: "creator.example.invalid", proxy: "DIRECT" },
      { type: "RuleSet", payload: "not-installed-and-not-needed", proxy: "DIRECT" },
      { type: "Match", payload: "", proxy: "synthetic-proxy-name" },
    ],
    configFieldHashes: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, hash(value)])),
    configPathHashes: paths(config),
    startedAtMono: now,
    completedAtMono: now,
    directPolicy: {
      kind: "direct",
      interfaceName: "",
      dialer: "none",
      ipVersion: null,
      policyFingerprint: "d".repeat(64),
      startedAtMono: now,
      completedAtMono: now,
    },
  };
}
async function fixture(contents: string | Uint8Array = YAML): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clipdock-effective-source-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "selected-config.yaml");
  temporaryFiles.push(file);
  await writeFile(file, contents);
  return file;
}
function source(file: string, options: Partial<EffectiveConfigSourceOptions> = {}): EffectiveConfigSource {
  const instance = new EffectiveConfigSource({
    path: file,
    format: "yaml",
    readController: async () => live(),
    ...options,
  });
  sources.push(instance);
  return instance;
}
function candidate(snapshot: EffectiveConfigSourceSnapshot) {
  expect(snapshot.state).toBe("candidate");
  if (snapshot.state !== "candidate") throw new Error("expected candidate");
  return snapshot.candidate;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const instance of sources.splice(0)) instance.dispose();
  vi.restoreAllMocks();
  // Only exact synthetic fixture paths, never recursive removal or a user config path.
  for (const file of temporaryFiles.splice(0))
    await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  for (const directory of temporaryDirectories.splice(0)) await rmdir(directory);
});

describe("EffectiveConfigSource local candidate", () => {
  it("starts checking, reads a real file, compares shared explicit leaves and all ordered rules", async () => {
    const file = await fixture(),
      before = await readFile(file);
    const current = source(file);
    expect(current.getSnapshot()).toEqual({ state: "checking", generation: 0 });
    const result = candidate(await current.read());
    expect(result).toMatchObject({
      kind: "local-config-candidate",
      runtimeConfigurationProven: false,
      sourceGeneration: 0,
      decoderIdentity: "plaintext-yaml-v1",
      comparedRuleCount: 3,
      comparedConfigFields: ["/ipv6", "/mixed-port", "/mode", "/tun/enable"],
    });
    expect(result.fileFingerprint).toBe(createHash("sha256").update(before).digest("hex"));
    expect(result.sourcePathIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.controllerStartedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(result.controllerCompletedAtMono).toBeLessThanOrEqual(result.completedAtMono);
    expect(result.expiresAtMono - result.completedAtMono).toBe(15000);
    expect(await readFile(file)).toEqual(before);
    expect(Object.isFrozen(result.rules[0])).toBe(true);
    expect(result.ruleParameters).toEqual([[], [], []]);
    expect(Object.isFrozen(result.ruleParameters)).toBe(true);
    expect(Object.isFrozen(result.ruleParameters?.[0])).toBe(true);
  });

  it("preserves absent defaults and retains finite main-only policy details without resolver or credential values", async () => {
    const result = candidate(await source(await fixture()).read());
    expect(result.policy.dnsFlags["use-system-hosts"]).toEqual({ present: false });
    expect(result.policy.dnsFlags["respect-rules"]).toEqual({ present: true, value: true });
    expect(result.policy.dnsMode).toEqual({ present: true, value: "fake-ip" });
    expect(result.policy.snifferFlags["force-dns-mapping"]).toEqual({ present: false });
    expect(result.currentDirectPolicy.ipVersion).toBeNull();
    expect(result.policy.directOutbounds.count).toBe(0);
    expect(result.policy.details?.dns.fakeIpRange).toEqual({ state: "missing" });
    expect(result.policy.details?.dns.fakeIpRange6).toEqual({ state: "missing" });
    expect(result.policy.details?.dns.fakeIpFilterMode).toEqual({ state: "missing" });
    // This synthetic hosts address is now intentional main-only policy input, not a secret.
    expect(result.policy.details?.hosts.entries[0].target).toEqual({
      kind: "addresses",
      addresses: ["192.0.2.90"],
    });
    const { details, ...digestsAndScalars } = result.policy;
    expect(Object.isFrozen(details?.hosts.entries[0].target)).toBe(true);
    expect(JSON.stringify(digestsAndScalars)).not.toContain("192.0.2.90");
    const text = JSON.stringify(result);
    for (const secret of [
      "synthetic-controller-secret",
      "synthetic-proxy-password",
      "synthetic-node.invalid",
      "resolver.invalid",
    ])
      expect(text).not.toContain(secret);
  });

  it("projects explicit policy details from the same actual YAML file into a non-permission candidate", async () => {
    const yaml = YAML.replace(
      "  enhanced-mode: fake-ip",
      `  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-range6: fdfe:dcba:9876::1/64
  fake-ip-filter-mode: blacklist
  fake-ip-filter: ['+.example.invalid', '*.local.invalid']`,
    ).replace(
      "  override-destination: true",
      `  override-destination: true
  force-domain: ['+.example.invalid']
  skip-domain: []
  skip-src-address: [192.0.2.1/32]
  skip-dst-address: ['2001:db8::/32']
  sniff:
    TLS:
      ports: [443, 8443-8444]
      override-destination: false
    HTTP:
      ports: [80]`,
    );
    const file = await fixture(yaml);
    const result = candidate(await source(file).read());
    const details = result.policy.details!;
    expect(details.dns).toMatchObject({
      fakeIpRange: { state: "known", value: "198.18.0.1/16" },
      fakeIpRange6: { state: "known", value: "fdfe:dcba:9876::1/64" },
      fakeIpFilterMode: { state: "known", value: "blacklist" },
      fakeIpFilter: { complete: true, unsupportedCount: 0 },
    });
    expect(details.sniffer.protocols.TLS.ports.entries).toEqual([
      { from: 443, to: 443 },
      { from: 8443, to: 8444 },
    ]);
    expect(details.sniffer.protocols.TLS.overrideDestination).toEqual({ state: "known", value: false });
    expect(details.sniffer.protocols.HTTP.overrideDestination).toEqual({ state: "missing" });
    expect(querySourcePolicyTarget(details, "creator.example.invalid").fakeIpFilter.state).toBe("matched");
    expect(querySourcePolicyTarget(details, "creator.example.invalid").hosts.state).toBe("not-matched");
    expect(result.runtimeConfigurationProven).toBe(false);
    expect(result.fileFingerprint).toBe(createHash("sha256").update(yaml).digest("hex"));
    expect(await readFile(file, "utf8")).toBe(yaml);
  });

  it("does not expose unknown policy strings or misclassify unsupported YAML entries as absent matches", async () => {
    const yaml = YAML.replace(
      "  enhanced-mode: fake-ip",
      `  enhanced-mode: fake-ip
  fake-ip-range: https://synthetic-range-secret.invalid
  fake-ip-range6: 198.18.0.1/16
  fake-ip-filter-mode: synthetic-mode-secret
  fake-ip-filter: ['geosite:cn', 'https://synthetic-filter-secret.invalid']`,
    )
      .replace(
        "  synthetic.invalid: 192.0.2.90",
        "  synthetic.invalid: https://synthetic-host-secret.invalid",
      )
      .replace(
        "  override-destination: true",
        `  override-destination: true
  skip-domain: ['https://synthetic-skip-secret.invalid']
  sniff:
    TLS:
      ports: [443, https://synthetic-port-secret.invalid]
      private-option: synthetic-protocol-secret`,
      );
    const result = candidate(await source(await fixture(yaml)).read());
    const details = result.policy.details!;
    expect(details.dns.fakeIpRange).toEqual({ state: "unknown" });
    expect(details.dns.fakeIpRange6).toEqual({ state: "unknown" });
    expect(details.dns.fakeIpFilterMode).toEqual({ state: "unknown" });
    expect(details.dns.fakeIpFilter.complete).toBe(false);
    const target = querySourcePolicyTarget(details, "creator.example.invalid");
    expect(target.hosts.state).toBe("unknown");
    expect(target.fakeIpFilter.state).toBe("unknown");
    expect(target.skipDomain.state).toBe("unknown");
    expect(details.sniffer.protocols.TLS.ports.complete).toBe(false);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "synthetic-controller-secret",
      "synthetic-proxy-password",
      "synthetic-node.invalid",
      "resolver.invalid",
      "synthetic-range-secret",
      "synthetic-mode-secret",
      "synthetic-filter-secret",
      "synthetic-host-secret",
      "synthetic-skip-secret",
      "synthetic-port-secret",
      "synthetic-protocol-secret",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("withdraws the previous candidate when only a retained policy detail changes", async () => {
    const yaml = YAML.replace(
      "  enhanced-mode: fake-ip",
      "  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16",
    );
    const file = await fixture(yaml),
      current = source(file);
    const before = candidate(await current.read());
    await writeFile(file, yaml.replace("198.18.0.1/16", "198.19.0.1/16"));
    expect(await current.read()).toMatchObject({ state: "unavailable", reason: "SOURCE_CHANGED" });
    const after = candidate(await current.read());
    expect(after.sourceGeneration).toBeGreaterThan(before.sourceGeneration);
    expect(after.policy.details?.dns.fakeIpRange).toEqual({ state: "known", value: "198.19.0.1/16" });
    expect(before.policy.details?.dns.fakeIpRange).toEqual({ state: "known", value: "198.18.0.1/16" });
    expect(after.fileFingerprint).not.toBe(before.fileFingerprint);
    expect(after.policy.fingerprint).not.toBe(before.policy.fingerprint);
    expect(after.rules).toEqual(before.rules);
    expect(after.runtimeConfigurationProven).toBe(false);
  });

  it("does not require unrelated providers/geo files after an early DOMAIN rule", async () => {
    const file = await fixture(
      `${YAML}\nrule-providers:\n  not-installed-and-not-needed:\n    type: file\n    path: definitely-nonexistent-private-path\n`,
    );
    const result = candidate(await source(file).read());
    expect(result.rules[0]).toEqual({ type: "domain", payload: "creator.example.invalid", proxy: "DIRECT" });
    expect(JSON.stringify(result)).not.toContain("definitely-nonexistent-private-path");
  });

  it("accepts normal YAML anchors/merge and retains explicit null without inventing flags", async () => {
    const file = await fixture(
      `defaults: &defaults\n  enable: true\n${YAML.replace("tun:\n  enable: true", "tun:\n  <<: *defaults").replace(/hosts:\n {2}synthetic.invalid: 192.0.2.90/, "hosts: null")}`,
    );
    const result = candidate(await source(file).read());
    expect(result.policy.hosts).toMatchObject({ present: true, kind: "null" });
    expect(result.policy.tunEnabled).toEqual({ present: true, value: true });
  });

  it("records configured DIRECT names, interfaces and dialers without exposing their values", async () => {
    const file = await fixture(
      YAML.replace(
        "proxies:\n",
        `proxies:\n  - name: DIRECT\n    type: direct\n    interface-name: synthetic-private-interface\n    ip-version: ipv4\n    dialer-proxy: synthetic-private-dialer\n`,
      ),
    );
    const result = candidate(await source(file).read());
    expect(result.policy.directOutbounds).toMatchObject({
      count: 1,
      builtinNameConfigured: true,
      entries: [
        {
          type: "direct",
          interface: { present: true },
          ipVersion: { present: true, value: "ipv4" },
          dialer: "configured",
        },
      ],
    });
    expect(JSON.stringify(result.policy)).not.toContain("synthetic-private");
  });

  it("normalizes only API spelling and records source options separately, not as runtime-verified", async () => {
    const file = await fixture(
      YAML.replace(
        "  - RULE-SET,not-installed-and-not-needed,DIRECT",
        "  - GEOIP,CN,DIRECT,no-resolve\n  - IP-CIDR6,2001:db8::/32,DIRECT",
      ),
    );
    const current = source(file, {
      readController: async () => {
        const result = live();
        result.rules.splice(
          1,
          1,
          { type: "GeoIP", payload: "cn", proxy: "DIRECT" },
          { type: "IPCIDR", payload: "2001:db8::/32", proxy: "DIRECT" },
        );
        return result;
      },
    });
    const result = candidate(await current.read());
    expect(result.comparedRuleCount).toBe(4);
    expect(result.ruleParameters).toEqual([[], ["no-resolve"], [], []]);
    expect(result.sourceRuleOptionsFingerprint).toBe(hash(result.ruleParameters));
    expect(result.rules[1]).toEqual({ type: "geoip", payload: "cn", proxy: "DIRECT" });
    expect(result.runtimeConfigurationProven).toBe(false);
  });

  it("retains parameters from the same real file for CIDR interpretation without promoting the candidate", async () => {
    const file = await fixture(
      YAML.replace(
        "  - DOMAIN,creator.example.invalid,DIRECT",
        "  - IP-CIDR,10.0.0.0/8,REJECT,no-resolve\n  - DOMAIN,creator.example.invalid,DIRECT",
      ),
    );
    const controller = () => {
      const result = live();
      result.rules.unshift({ type: "IPCIDR", payload: "10.0.0.0/8", proxy: "REJECT" });
      return result;
    };
    const current = source(file, { readController: async () => controller() });
    const result = candidate(await current.read());
    expect(result.ruleParameters).toEqual([["no-resolve"], [], [], []]);
    expect(result.sourceRuleOptionsFingerprint).toBe(hash(result.ruleParameters));
    const ctx = {
      host: "creator.example.invalid",
      port: 443,
      network: "tcp" as const,
      destination: { stage: "unresolved" as const },
    };
    const parameters = {
      rules: result.rules,
      parameters: result.ruleParameters!,
      parametersFingerprint: result.sourceRuleOptionsFingerprint,
    };
    // This asserts parser/interpreter behavior only. A real caller also needs current association.
    expect(evaluateRules("rule", controller().rules, ctx, parameters).route).toBe("direct");
    expect(
      evaluateRules("rule", controller().rules, { ...ctx, destination: { stage: "unknown" } }, parameters)
        .route,
    ).toBe("unknown");
    expect(result.runtimeConfigurationProven).toBe(false);

    await writeFile(file, (await readFile(file, "utf8")).replace(",REJECT,no-resolve", ",REJECT"));
    expect(await current.read()).toMatchObject({ state: "unavailable", reason: "SOURCE_CHANGED" });
    const changed = candidate(await current.read());
    expect(changed.rules).toEqual(result.rules);
    expect(changed.orderedRulesFingerprint).toBe(result.orderedRulesFingerprint);
    expect(changed.ruleParameters).toEqual([[], [], [], []]);
    expect(changed.sourceRuleOptionsFingerprint).not.toBe(result.sourceRuleOptionsFingerprint);
    expect(changed.fileFingerprint).not.toBe(result.fileFingerprint);
    expect(
      evaluateRules("rule", controller().rules, ctx, {
        rules: changed.rules,
        parameters: changed.ruleParameters!,
        parametersFingerprint: changed.sourceRuleOptionsFingerprint,
      }).route,
    ).toBe("unknown");
  });

  it("preserves src, duplicate and unknown modifiers instead of filtering them into a safe no-resolve", async () => {
    const file = await fixture(
      YAML.replace(
        "  - DOMAIN,creator.example.invalid,DIRECT",
        "  - IP-CIDR,10.0.0.0/8,REJECT,no-resolve,src,no-resolve,future-option\n  - DOMAIN,creator.example.invalid,DIRECT",
      ),
    );
    const current = source(file, {
      readController: async () => {
        const result = live();
        result.rules.unshift({ type: "IPCIDR", payload: "10.0.0.0/8", proxy: "REJECT" });
        return result;
      },
    });
    const result = candidate(await current.read());
    expect(result.ruleParameters?.[0]).toEqual(["no-resolve", "src", "no-resolve", "future-option"]);
    expect(
      evaluateRules(
        "rule",
        result.rules,
        { host: "creator.example.invalid", port: 443, network: "tcp", destination: { stage: "unresolved" } },
        {
          rules: result.rules,
          parameters: result.ruleParameters!,
          parametersFingerprint: result.sourceRuleOptionsFingerprint,
        },
      ).route,
    ).toBe("unknown");
  });

  it.each(["order", "target", "payload"])(
    "rejects a real %s mismatch in the current ordered rules",
    async (change) => {
      const current = source(await fixture(), {
        readController: async () => {
          const result = live();
          if (change === "order") result.rules.reverse();
          if (change === "target") result.rules[0].proxy = "synthetic-proxy-name";
          if (change === "payload") result.rules[0].payload = "different.invalid";
          return result;
        },
      });
      expect(await current.read()).toMatchObject({ state: "unavailable", reason: "RULES_MISMATCH" });
    },
  );

  it("rejects an explicit nested visible field difference while tolerating additional runtime defaults", async () => {
    const current = source(await fixture(), {
      readController: async () => live({ ...visible(), tun: { enable: false, stack: "mixed" } }),
    });
    expect(await current.read()).toMatchObject({ state: "unavailable", reason: "CONFIG_MISMATCH" });
  });

  it("compares arrays atomically and handles escaped JSON Pointer names", async () => {
    const file = await fixture(`${YAML}\nexperimental:\n  a/b~c: [one, two]\n`);
    const current = source(file, {
      readController: async () => live({ ...visible(), experimental: { "a/b~c": ["two", "one"] } }),
    });
    expect(await current.read()).toMatchObject({ state: "unavailable", reason: "CONFIG_MISMATCH" });
  });

  it("rejects an object/scalar shape mismatch instead of skipping its explicit children", async () => {
    const current = source(await fixture(), {
      readController: async () => live({ ...visible(), tun: false }),
    });
    expect(await current.read()).toMatchObject({ reason: "CONFIG_MISMATCH" });
  });

  it("rejects internally inconsistent top-level and JSON Pointer controller digests", async () => {
    const current = source(await fixture(), {
      readController: async () => {
        const result = live();
        result.configPathHashes = { ...result.configPathHashes, "/mode": "e".repeat(64) };
        return result;
      },
    });
    expect(await current.read()).toMatchObject({ reason: "CONTROLLER_COMPARISON_UNAVAILABLE" });
  });

  it.each([
    "configFieldHashes",
    "configPathHashes",
    "directPolicy",
    "startedAtMono",
    "completedAtMono",
  ] as const)("rejects legacy/missing controller %s instead of treating it as evidence", async (key) => {
    const current = source(await fixture(), {
      readController: async () => {
        const result = live();
        delete result[key];
        return result;
      },
    });
    expect(await current.read()).toMatchObject({
      state: "unavailable",
      reason: "CONTROLLER_COMPARISON_UNAVAILABLE",
    });
  });

  it("rejects historical controller sampling and invalid DIRECT metadata", async () => {
    const previous = live();
    const current = source(await fixture(), { readController: async () => previous });
    expect(await current.read()).toMatchObject({ reason: "CONTROLLER_COMPARISON_UNAVAILABLE" });
    const invalid = source(await fixture(), {
      readController: async () => {
        const result = live();
        result.directPolicy!.completedAtMono = result.completedAtMono! + 1;
        return result;
      },
    });
    expect(await invalid.read()).toMatchObject({ reason: "CONTROLLER_COMPARISON_UNAVAILABLE" });
  });

  it("copies known controller fields, not arbitrary adapter properties", async () => {
    const current = source(await fixture(), {
      readController: async () => {
        const result = live();
        Object.assign(result.directPolicy!, { secret: "synthetic-adapter-secret" });
        return result;
      },
    });
    expect(JSON.stringify(candidate(await current.read()))).not.toContain("synthetic-adapter-secret");
  });
});

describe("EffectiveConfigSource file and lifecycle boundaries", () => {
  it("requires an explicit decoder and never guesses ciphertext format or credentials", async () => {
    const file = await fixture("synthetic-ciphertext-does-not-parse-as-config");
    expect(await source(file).read()).toMatchObject({ state: "unavailable" });
    expect(() => source(file, { format: "decoded-yaml" })).toThrow("EFFECTIVE_CONFIG_SOURCE_OPTIONS_INVALID");
    const decode = vi.fn((bytes: Uint8Array) => {
      expect(Buffer.from(bytes).toString()).toBe("synthetic-ciphertext-does-not-parse-as-config");
      bytes.fill(0);
      return YAML;
    });
    const result = candidate(
      await source(file, {
        format: "decoded-yaml",
        decoderIdentity: "explicit-test-adapter-v1",
        decode,
      }).read(),
    );
    expect(result.decoderIdentity).toBe("explicit-test-adapter-v1");
    expect(await readFile(file, "utf8")).toBe("synthetic-ciphertext-does-not-parse-as-config");
    expect(decode).toHaveBeenCalledOnce();
  });

  it("rejects file changes inside the controller comparison window", async () => {
    const file = await fixture();
    const current = source(file, {
      readController: async () => {
        await writeFile(file, `${YAML}\n# changed during current batch\n`);
        return live();
      },
    });
    expect(await current.read()).toMatchObject({
      state: "unavailable",
      reason: "SOURCE_CHANGED",
      generation: 1,
    });
  });

  it("invalidates a previously accepted file revision before establishing a new current candidate", async () => {
    const file = await fixture(),
      callback = vi.fn(async () => live());
    const current = source(file, { readController: callback });
    const first = candidate(await current.read());
    await writeFile(file, `${YAML}\n# new file revision\n`);
    expect(await current.read()).toMatchObject({
      state: "unavailable",
      reason: "SOURCE_CHANGED",
      generation: 1,
    });
    const replacement = candidate(await current.read());
    expect(replacement.sourceGeneration).toBe(1);
    expect(replacement.fileFingerprint).not.toBe(first.fileFingerprint);
    expect(replacement.runtimeConfigurationProven).toBe(false);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("shares concurrent reads but starts a fresh live comparison after an awaited completion", async () => {
    const callback = vi.fn(async () => live()),
      current = source(await fixture(), { readController: callback });
    const a = current.read(),
      b = current.read();
    expect(a).toBe(b);
    await a;
    candidate(await current.read());
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("expires current evidence and notifies with a new generation", async () => {
    const changes: EffectiveConfigSourceSnapshot[] = [];
    const current = source(await fixture(), { ttlMs: 10, onChange: (value) => changes.push(value) });
    candidate(await current.read());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(current.getSnapshot()).toMatchObject({ state: "unavailable", generation: 1, reason: "EXPIRED" });
    expect(changes.map((value) => value.state)).toEqual(["candidate", "unavailable"]);
  });

  it("manual invalidation aborts the current generation and ignores late completion", async () => {
    const entered = deferred<void>(),
      gate = deferred<void>();
    const current = source(await fixture(), {
      readController: async () => {
        entered.resolve();
        await gate.promise;
        return live();
      },
    });
    const result = current.read();
    await entered.promise;
    current.invalidate();
    expect(await result).toMatchObject({ reason: "INVALIDATED", generation: 1 });
    const settled = vi.fn();
    const idle = current.whenIdle().then(settled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    gate.resolve();
    await idle;
    expect(settled).toHaveBeenCalledOnce();
    expect(current.getSnapshot()).toMatchObject({ reason: "INVALIDATED", generation: 1 });
  });

  it("a stalled decoder times out without overlapping another read or surfacing its secret error", async () => {
    const entered = deferred<void>(),
      gate = deferred<string>();
    const decode = vi.fn(async () => {
      entered.resolve();
      return gate.promise;
    });
    const file = await fixture("cipher");
    // Advance the timeout only after real file I/O has entered the stalled decoder.
    // Keep both the timer and monotonic deadline controlled while those reads finish.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const current = source(file, {
      format: "decoded-yaml",
      decoderIdentity: "stall-v1",
      decode,
      timeoutMs: 30,
    });
    try {
      const result = current.read();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30);
      expect(await result).toMatchObject({ state: "unavailable", reason: "READ_TIMEOUT" });
      expect(await current.read()).toMatchObject({ reason: "READ_TIMEOUT" });
      expect(decode).toHaveBeenCalledOnce();
      current.dispose();
      const settled = vi.fn();
      const idle = current.whenIdle().then(settled);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      gate.resolve(YAML);
      await idle;
      expect(settled).toHaveBeenCalledOnce();
      expect(current.getSnapshot()).toMatchObject({ reason: "DISPOSED" });
    } finally {
      gate.resolve(YAML);
      current.dispose();
      await current.whenIdle();
      vi.useRealTimers();
    }
  });

  it("disposal is terminal and does not start another file/controller read", async () => {
    const callback = vi.fn(async () => live()),
      current = source(await fixture(), { readController: callback });
    current.dispose();
    expect(await current.read()).toMatchObject({ reason: "DISPOSED" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("missing/deleted files revoke candidates and sanitize OS errors", async () => {
    const file = await fixture(),
      current = source(file);
    candidate(await current.read());
    await unlink(file);
    const result = await current.read();
    expect(result).toMatchObject({ state: "unavailable", reason: "SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain(file);
  });

  it("bounds raw and decoded bytes before invoking later controller work", async () => {
    const callback = vi.fn(async () => live()),
      file = await fixture();
    expect(await source(file, { maxFileBytes: 10, readController: callback }).read()).toMatchObject({
      reason: "SOURCE_LIMIT_EXCEEDED",
    });
    expect(await source(file, { maxYamlBytes: 10, readController: callback }).read()).toMatchObject({
      reason: "SOURCE_LIMIT_EXCEEDED",
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    "secret: one\nsecret: two\nrules: [MATCH,DIRECT]",
    "secret: !!js/function function(){}\nrules: [MATCH,DIRECT]",
    "loop: &loop [*loop]\nrules: ['MATCH,DIRECT']",
    "__proto__: dangerous\nrules: ['MATCH,DIRECT']",
    "dns: {enable: 'true'}\nrules: ['MATCH,DIRECT']",
  ])("rejects malformed/unsafe YAML and policy values without echoing contents", async (text) => {
    const callback = vi.fn(async () => live());
    expect(await source(await fixture(text), { readController: callback }).read()).toMatchObject({
      state: "unavailable",
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("sanitizes decoder/controller exceptions and rejects nonlocal/relative sources", async () => {
    const file = await fixture();
    const current = source(file, {
      readController: async () => {
        throw new Error("synthetic-controller-secret");
      },
    });
    const result = await current.read();
    expect(result).toMatchObject({ reason: "SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("synthetic-controller-secret");
    for (const invalid of [
      "relative.yaml",
      "\\\\remote.invalid\\config.yaml",
      "https://config.invalid/config.yaml",
    ])
      expect(() => source(invalid)).toThrow("EFFECTIVE_CONFIG_SOURCE_OPTIONS_INVALID");
  });
});
