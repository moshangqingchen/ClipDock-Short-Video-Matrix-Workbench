import { createHash } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import { EffectiveConfigSource, type EffectiveConfigCandidate } from "./effective-config-source";
import { classifyCurrentKernelDnsAddress as classify } from "./kernel-dns-address-policy";
import { projectSourcePolicyDetails } from "./source-policy-details";
import {
  createSelectedKernelCompatibility,
  KERNEL_COMPATIBILITY_PROFILE as COMPATIBILITY,
} from "./kernel-compatibility";

const VERSION = "a".repeat(64),
  HASH = "b".repeat(64),
  OTHER = "c".repeat(64);
const missing = { present: false } as const;
type Fixture = { candidate: EffectiveConfigCandidate; loader: KnownSelectedLoaderContract };
function fixture(dns: Record<string, unknown> = { "fake-ip-range": "198.18.0.1/16" }): Fixture {
  return {
    loader: {
      source: "main-process-selected-loader-contract",
      selectionId: "current-selection",
      loaderProfileId: "selected-client-v1",
      sourcePathIdentity: HASH,
      decoderIdentity: "decoder-v1",
      qualificationEvidenceIds: ["retained-loader-observation"],
      selectedAtMono: 0,
    },
    candidate: {
      kind: "local-config-candidate",
      runtimeConfigurationProven: false,
      sourceGeneration: 0,
      sourcePathIdentity: HASH,
      fileFingerprint: HASH,
      decoderIdentity: "decoder-v1",
      startedAtMono: 100,
      completedAtMono: 104,
      expiresAtMono: 15104,
      controllerFingerprint: VERSION,
      controllerStartedAtMono: 101,
      controllerCompletedAtMono: 103,
      comparedConfigFields: ["/mode"],
      comparedRuleCount: 1,
      orderedRulesFingerprint: HASH,
      sourceRuleOptionsFingerprint: HASH,
      rules: [{ type: "match", payload: "", proxy: "DIRECT" }],
      policy: {
        fingerprint: HASH,
        dns: { present: true, kind: "object", fingerprint: HASH },
        hosts: missing,
        sniffer: missing,
        tun: missing,
        ipv6: missing,
        dnsFlags: {
          enable: { present: true, value: true },
          ipv6: missing,
          "use-hosts": missing,
          "use-system-hosts": missing,
          "respect-rules": missing,
        },
        dnsMode: { present: true, value: "fake-ip" },
        snifferFlags: {
          enable: missing,
          "force-dns-mapping": missing,
          "override-destination": missing,
          "parse-pure-ip": missing,
        },
        tunEnabled: missing,
        directOutbounds: { count: 0, fingerprint: HASH, builtinNameConfigured: false, entries: [] },
        details: projectSourcePolicyDetails({ dns }),
      },
      currentDirectPolicy: {
        kind: "unknown",
        interfaceName: null,
        dialer: "unknown",
        ipVersion: null,
        policyFingerprint: HASH,
        startedAtMono: 101,
        completedAtMono: 103,
      },
    },
  };
}
const run = (address: string, input = fixture(), now = 105) => classify(address, VERSION, input, now);

describe("current kernel DNS candidate address classification", () => {
  function withCompatibility(dns?: Record<string, unknown>): Fixture {
    const input = fixture(dns);
    input.loader = {
      ...input.loader,
      loaderProfileId: COMPATIBILITY.loaderProfileId,
      decoderIdentity: COMPATIBILITY.decoderIdentity,
    };
    input.candidate = { ...input.candidate, decoderIdentity: COMPATIBILITY.decoderIdentity };
    const record = createSelectedKernelCompatibility({
      ...input,
      binary: { sha256: COMPATIBILITY.binarySha256, pathIdentity: HASH },
      artifactIdentity: HASH,
      controller: {
        version: COMPATIBILITY.controllerVersion,
        fingerprint: VERSION,
        startedAtMono: 101,
        completedAtMono: 103,
      },
      checkedAtMono: 104,
    });
    expect(record).not.toBeNull();
    input.loader = { ...input.loader, kernelCompatibility: record! };
    return input;
  }
  it("uses the exact current binary compatibility only for an omitted IPv6 fake pool", () => {
    const input = withCompatibility();
    expect(run("2606:4700:4700::1111", input)).toBe("real");
    expect(run("240e:1::1", input)).toBe("real");
    expect(run("198.18.0.2", input)).toBe("fake-ip");
    expect(input.candidate.runtimeConfigurationProven).toBe(false);
    expect(input.candidate.currentDirectPolicy.kind).toBe("unknown");
    expect(input.candidate.policy.details?.dns.fakeIpRange6.state).toBe("missing");
  });
  it.each([null, "", false, 0, "not-a-range", "2001:db8::/129"])(
    "never uses the missing-only compatibility for an explicit invalid range6=%j",
    (value) => {
      expect(run("2606:4700:4700::1111", withCompatibility({ "fake-ip-range6": value }))).toBe("unknown");
    },
  );
  it("keeps explicit range classification ahead of compatibility", () => {
    const input = withCompatibility({ "fake-ip-range6": "2606:4700:4700::/48" });
    expect(run("2606:4700:4700::1111", input)).toBe("fake-ip");
    expect(run("240e:1::1", input)).toBe("real");
  });
  it.each(["::1", "fc00::1", "fe80::1", "2001:db8::1", "2002::1", "3fff::1", "ff02::1", "::ffff:8.8.8.8"])(
    "does not promote special IPv6 %s with missing-pool compatibility",
    (address) => expect(run(address, withCompatibility())).toBe("unknown"),
  );
  it("rejects stale compatibility after configuration, selection or attachment expiry changes", () => {
    const input = withCompatibility();
    expect(run("2606:4700:4700::1111", input, 15104)).toBe("unknown");
    expect(
      run("2606:4700:4700::1111", { ...input, loader: { ...input.loader, kernelCompatibility: undefined } }),
    ).toBe("unknown");
    expect(
      run("2606:4700:4700::1111", { ...input, candidate: { ...input.candidate, fileFingerprint: OTHER } }),
    ).toBe("unknown");
    expect(
      run("2606:4700:4700::1111", { ...input, loader: { ...input.loader, selectionId: "replacement" } }),
    ).toBe("unknown");
    expect(
      run("2606:4700:4700::1111", {
        ...input,
        loader: {
          ...input.loader,
          kernelCompatibility: { ...input.loader.kernelCompatibility!, controllerVersion: "other-version" },
        },
      }),
    ).toBe("unknown");
  });
  it("does not apply the IPv6 compatibility to a missing IPv4 pool", () => {
    expect(run("223.5.5.5", withCompatibility({}))).toBe("unknown");
  });
  it("classifies an ordinary public address outside the explicit pool without asserting DIRECT", () => {
    const input = fixture();
    expect(input.candidate.currentDirectPolicy.kind).toBe("unknown");
    expect(input.candidate.runtimeConfigurationProven).toBe(false);
    expect(run("223.5.5.5", input)).toBe("real");
    expect(run("8.8.8.8", input)).toBe("real");
  });

  it.each(["198.18.0.0", "198.18.0.1", "198.18.99.254", "198.18.255.255"])(
    "marks %s as fake using the whole CIDR, including source host bits",
    (address) => {
      expect(run(address)).toBe("fake-ip");
    },
  );
  it("does not assume the whole benchmark range is the configured fake pool", () => {
    expect(run("198.19.0.1")).toBe("unknown");
    expect(run("198.17.255.255")).toBe("real");
    expect(run("198.20.0.1")).toBe("real");
    expect(run("198.18.0.1", fixture({}))).toBe("unknown");
  });
  it("handles explicit exact host /32 and a non-octet /25 allocation", () => {
    const host = fixture({ "fake-ip-range": "8.8.8.8/32" });
    expect(run("8.8.8.8", host)).toBe("fake-ip");
    expect(run("8.8.8.9", host)).toBe("real");
    const subnet = fixture({ "fake-ip-range": "8.8.8.129/25" });
    expect(run("8.8.8.127", subnet)).toBe("real");
    expect(run("8.8.8.128", subnet)).toBe("fake-ip");
    expect(run("8.8.8.255", subnet)).toBe("fake-ip");
    expect(run("8.8.9.0", subnet)).toBe("real");
  });
  it("does not overflow full width prefixes or /0", () => {
    expect(run("223.5.5.5", fixture({ "fake-ip-range": "0.0.0.0/0" }))).toBe("fake-ip");
    const allV6 = fixture({ "fake-ip-range6": "::/0" });
    expect(run("2606:4700:4700::1111", allV6)).toBe("fake-ip");
  });

  it.each([
    undefined,
    null,
    true,
    "198.18.0.1",
    "198.18.0.1/33",
    "198.18.0.1/-1",
    "198.18.0.1/016",
    "198.18.0.1/16junk",
    "198.18.0.1/16/1",
    "fc00::/18",
    " 198.18.0.1/16",
  ])("cannot fill a missing or invalid IPv4 range: %s", (value) => {
    const input = value === undefined ? fixture({}) : fixture({ "fake-ip-range": value });
    expect(run("223.5.5.5", input)).toBe("unknown");
    expect(run("198.18.0.1", input)).toBe("unknown");
  });
  it("revalidates a malformed allegedly known range instead of trusting only the projection tag", () => {
    const input = fixture();
    const details = input.candidate.policy.details!;
    input.candidate = {
      ...input.candidate,
      policy: {
        ...input.candidate.policy,
        details: {
          ...details,
          dns: { ...details.dns, fakeIpRange: { state: "known", value: "fc00::/18" } },
        },
      },
    };
    expect(run("223.5.5.5", input)).toBe("unknown");
  });

  it.each([false, true])(
    "does not use DNS/global ipv6=%s as a transport constraint or missing-range substitute",
    (ipv6) => {
      const input = fixture();
      input.candidate = {
        ...input.candidate,
        policy: {
          ...input.candidate.policy,
          ipv6: { present: true, value: ipv6 },
          dnsFlags: { ...input.candidate.policy.dnsFlags, ipv6: { present: true, value: ipv6 } },
        },
      };
      expect(run("2606:4700:4700::1111", input)).toBe("unknown");
      expect(run("223.5.5.5", input)).toBe("real");
    },
  );
  it("classifies both families separately when both explicit ranges exist", () => {
    const input = fixture({ "fake-ip-range": "198.18.0.1/16", "fake-ip-range6": "fc00::1/18" });
    expect(run("198.18.2.4", input)).toBe("fake-ip");
    expect(run("FC00:3FFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF", input)).toBe("fake-ip");
    expect(run("fc00:4000::", input)).toBe("unknown");
    expect(run("2606:4700:4700:0:0:0:0:1111", input)).toBe("real");
  });
  it("recognizes compressed, expanded and mixed IPv6 without losing /128 boundaries", () => {
    const input = fixture({ "fake-ip-range6": "2606:4700:4700::1111/128" });
    expect(run("2606:4700:4700:0000:0000:0000:0000:1111", input)).toBe("fake-ip");
    expect(run("2606:4700:4700::0.0.17.17", input)).toBe("fake-ip");
    expect(run("2606:4700:4700::1112", input)).toBe("real");
  });

  it.each([
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.8",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("leaves private/local/special IPv4 %s unknown outside an explicit fake allocation", (address) => {
    expect(run(address)).toBe("unknown");
  });
  it.each([
    "::",
    "::1",
    "::192.0.2.1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:2::1",
    "2001:20::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "2620:4f:8000::1",
    "3fff::1",
    "5f00::1",
    "fc01::1",
    "fe80::1",
    "ff02::1",
  ])("leaves special/unsupported IPv6 %s unknown", (address) => {
    expect(run(address, fixture({ "fake-ip-range6": "fc00::1/18" }))).toBe("unknown");
  });
  it.each([
    "::ffff:8.8.8.8",
    "::FFFF:808:808",
    "0:0:0:0:0:ffff:0808:0808",
    "::ffff:198.18.0.1",
    "fe80::1%12",
  ])("never converts a mapped or zoned address %s into a classification, even with /0", (address) => {
    expect(run(address, fixture({ "fake-ip-range6": "::/0", "fake-ip-range": "0.0.0.0/0" }))).toBe("unknown");
  });
  it.each([
    "",
    "localhost",
    "8.8.8.8:443",
    "[2606:4700::1111]",
    "223.5.5.5 ",
    " 223.5.5.5",
    "8.8.8.8\n",
    "010.0.0.1",
    "2130706433",
    "0x7f000001",
    "8.8.8.8/32",
    "2606:::1",
  ])("rejects a non-address spelling %s", (address) => expect(run(address)).toBe("unknown"));

  it.each(["missing", "redir-host", "Fake-IP", "fake-ip "])(
    "does not guess allocation behavior for mode %s",
    (mode) => {
      const input = fixture();
      input.candidate = {
        ...input.candidate,
        policy: {
          ...input.candidate.policy,
          dnsMode: mode === "missing" ? missing : { present: true, value: mode },
        },
      };
      expect(run("223.5.5.5", input)).toBe("unknown");
      expect(run("198.18.0.1", input)).toBe("unknown");
    },
  );
  it.each([false, undefined])("requires explicit enabled DNS rather than enable=%s", (value) => {
    const input = fixture();
    input.candidate = {
      ...input.candidate,
      policy: {
        ...input.candidate.policy,
        dnsFlags: {
          ...input.candidate.policy.dnsFlags,
          enable: value === undefined ? missing : { present: true, value },
        },
      },
    };
    expect(run("223.5.5.5", input)).toBe("unknown");
  });
  it("does not require a fake filter rule to classify allocation membership", () => {
    const input = fixture({
      "fake-ip-range": "198.18.0.1/16",
      "fake-ip-filter-mode": "rule",
      "fake-ip-filter": ["RULE-SET,unsupported,real-ip"],
    });
    expect(run("198.18.1.2", input)).toBe("fake-ip");
    expect(run("223.5.5.5", input)).toBe("real");
  });

  it.each([
    ["source path", { sourcePathIdentity: OTHER }],
    ["decoder", { decoderIdentity: "other-decoder" }],
    ["controller", { controllerFingerprint: OTHER }],
    ["file hash", { fileFingerprint: "" }],
    ["generation", { sourceGeneration: -1 }],
    ["expired", { expiresAtMono: 105 }],
    ["not yet sampled", { completedAtMono: 106 }],
    ["controller before file", { controllerStartedAtMono: 99 }],
    ["controller after file", { controllerCompletedAtMono: 105 }],
    ["reverse controller", { controllerStartedAtMono: 104 }],
    ["non-finite", { expiresAtMono: Infinity }],
  ] as const)("rejects invalid or mismatching current source: %s", (_label, patch) => {
    const input = fixture();
    input.candidate = { ...input.candidate, ...patch };
    expect(run("223.5.5.5", input)).toBe("unknown");
    expect(run("198.18.0.1", input)).toBe("unknown");
  });
  it.each([
    ["late selection", { selectedAtMono: 101 }],
    ["negative selection", { selectedAtMono: -1 }],
    ["missing identity", { selectionId: "" }],
    ["unknown profile", { loaderProfileId: "" }],
    ["no references", { qualificationEvidenceIds: [] }],
    ["duplicate references", { qualificationEvidenceIds: ["one", "one"] }],
  ] as const)("rejects invalid selection: %s", (_label, patch) => {
    const input = fixture();
    input.loader = { ...input.loader, ...patch };
    expect(run("223.5.5.5", input)).toBe("unknown");
  });
  it("rejects absent input records and controller mismatch, never retaining an earlier result", () => {
    const input = fixture();
    expect(run("223.5.5.5", input, 104)).toBe("real");
    expect(run("223.5.5.5", input, 15103.9)).toBe("real");
    expect(run("223.5.5.5", input, 15104)).toBe("unknown");
    expect(classify("223.5.5.5", OTHER, input, 105)).toBe("unknown");
    expect(classify("223.5.5.5", VERSION, { ...input, candidate: null }, 105)).toBe("unknown");
    expect(classify("223.5.5.5", VERSION, { ...input, loader: null }, 105)).toBe("unknown");
    expect(run("223.5.5.5", input, NaN)).toBe("unknown");
    expect(run("223.5.5.5", input, 103)).toBe("unknown");
  });
  it("fails closed for malformed source records instead of throwing", () => {
    const input = fixture();
    expect(classify("223.5.5.5", VERSION, { ...input, candidate: {} as EffectiveConfigCandidate }, 105)).toBe(
      "unknown",
    );
    input.candidate = { ...input.candidate, policy: { ...input.candidate.policy, details: undefined } };
    expect(run("223.5.5.5", input)).toBe("unknown");
  });

  it("consumes the real source reader's current file/controller candidate, with no public network", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clipdock-dns-policy-"));
    const file = path.join(directory, "synthetic.yaml");
    let source: EffectiveConfigSource | undefined;
    try {
      await writeFile(
        file,
        "mode: rule\ndns:\n  enable: true\n  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\nrules:\n  - MATCH,DIRECT\n",
      );
      const selectedAtMono = performance.now();
      source = new EffectiveConfigSource({
        path: file,
        format: "yaml",
        readController: async () => {
          const at = performance.now();
          const modeHash = createHash("sha256").update(JSON.stringify("rule")).digest("hex");
          return {
            mode: "rule",
            tun: true,
            mixedPort: 7890,
            version: "synthetic-kernel",
            fingerprint: VERSION,
            rules: [{ type: "Match", payload: "", proxy: "DIRECT" }],
            configFieldHashes: { mode: modeHash },
            configPathHashes: { "/mode": modeHash },
            startedAtMono: at,
            completedAtMono: at,
            directPolicy: {
              kind: "direct",
              interfaceName: null,
              dialer: "none",
              ipVersion: null,
              policyFingerprint: HASH,
              startedAtMono: at,
              completedAtMono: at,
            },
          };
        },
      });
      const snapshot = await source.read();
      expect(snapshot.state).toBe("candidate");
      if (snapshot.state !== "candidate") throw new Error("EXPECTED_CURRENT_CANDIDATE");
      const candidate = snapshot.candidate;
      const loader = {
        ...fixture().loader,
        sourcePathIdentity: candidate.sourcePathIdentity,
        decoderIdentity: candidate.decoderIdentity,
        selectedAtMono,
      };
      const now = performance.now();
      expect(classify("198.18.1.2", VERSION, { candidate, loader }, now)).toBe("fake-ip");
      expect(classify("223.5.5.5", VERSION, { candidate, loader }, now)).toBe("real");
      expect(classify("2606:4700:4700::1111", VERSION, { candidate, loader }, now)).toBe("unknown");
    } finally {
      source?.dispose();
      await source?.whenIdle();
      // Only this test's exact synthetic file and then its empty temporary directory.
      await unlink(file);
      await rmdir(directory);
    }
  });
});
