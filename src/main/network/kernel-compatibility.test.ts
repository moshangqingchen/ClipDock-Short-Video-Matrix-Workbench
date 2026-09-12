import { describe, expect, it } from "vitest";
import {
  createSelectedKernelCompatibility as create,
  hasCurrentMissingIpv6FakePoolCompatibility as current,
  KERNEL_COMPATIBILITY_PROFILE as PROFILE,
  type SelectedKernelCompatibilityInput,
} from "./kernel-compatibility";

const HASH = "a".repeat(64),
  OTHER = "b".repeat(64),
  missing = { present: false } as const;
function fixture(): SelectedKernelCompatibilityInput {
  return {
    loader: {
      source: "main-process-selected-loader-contract",
      selectionId: "selected-now",
      loaderProfileId: PROFILE.loaderProfileId,
      decoderIdentity: PROFILE.decoderIdentity,
      sourcePathIdentity: HASH,
      qualificationEvidenceIds: ["retained-main-source"],
      selectedAtMono: 1,
    },
    candidate: {
      kind: "local-config-candidate",
      runtimeConfigurationProven: false,
      sourceGeneration: 0,
      sourcePathIdentity: HASH,
      decoderIdentity: PROFILE.decoderIdentity,
      fileFingerprint: HASH,
      startedAtMono: 10,
      completedAtMono: 20,
      expiresAtMono: 15020,
      controllerFingerprint: HASH,
      controllerStartedAtMono: 12,
      controllerCompletedAtMono: 18,
      comparedConfigFields: ["/mode"],
      comparedRuleCount: 1,
      orderedRulesFingerprint: HASH,
      sourceRuleOptionsFingerprint: HASH,
      rules: [{ type: "Domain", payload: "synthetic.test", proxy: "DIRECT" }],
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
        kind: "unknown",
        interfaceName: null,
        dialer: "unknown",
        ipVersion: null,
        policyFingerprint: HASH,
        startedAtMono: 12,
        completedAtMono: 18,
      },
    },
    binary: { sha256: PROFILE.binarySha256, pathIdentity: HASH },
    artifactIdentity: HASH,
    controller: {
      version: PROFILE.controllerVersion,
      fingerprint: HASH,
      startedAtMono: 12,
      completedAtMono: 18,
    },
    checkedAtMono: 22,
  };
}

describe("exact selected-kernel compatibility", () => {
  it("binds the experimentally reviewed binary and live short version to this candidate without extending time", () => {
    const input = fixture();
    const record = create(input);
    expect(record).toMatchObject({
      profileId: PROFILE.id,
      missingIpv6FakePool: "none",
      sourceGeneration: 0,
      controllerStartedAtMono: 12,
      controllerCompletedAtMono: 18,
      checkedAtMono: 22,
      expiresAtMono: 15020,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(input.loader.kernelCompatibility).toBeUndefined();
    expect(input.candidate.runtimeConfigurationProven).toBe(false);
    expect(current(record!, input, HASH, 100)).toBe(true);
    expect(record?.checkedAtMono).toBe(22);
    expect(record?.expiresAtMono).toBe(15020);
  });
  it.each([null, { sha256: OTHER, pathIdentity: HASH }, { sha256: PROFILE.binarySha256, pathIdentity: "" }])(
    "requires exact available binary facts: %j",
    (binary) => expect(create({ ...fixture(), binary })).toBeNull(),
  );
  it.each([
    null,
    { version: "v424c2ef", fingerprint: HASH, startedAtMono: 12, completedAtMono: 18 },
    { version: PROFILE.controllerVersion, fingerprint: OTHER, startedAtMono: 12, completedAtMono: 18 },
    { version: PROFILE.controllerVersion, fingerprint: HASH, startedAtMono: 11, completedAtMono: 18 },
    { version: PROFILE.controllerVersion, fingerprint: HASH, startedAtMono: 12, completedAtMono: 19 },
  ])("uses this actual controller read, not a caller's claimed version: %j", (controller) => {
    expect(create({ ...fixture(), controller })).toBeNull();
  });
  it.each([
    { loaderProfileId: "different-client" },
    { decoderIdentity: "different-decoder" },
    { sourcePathIdentity: OTHER },
    { selectionId: "" },
  ])("rejects a different or missing selection field: %j", (patch) => {
    const input = fixture();
    expect(create({ ...input, loader: { ...input.loader, ...patch } })).toBeNull();
  });
  it.each([NaN, Infinity, 19, 15020])("cannot create a current attachment at time %s", (checkedAtMono) => {
    expect(create({ ...fixture(), checkedAtMono })).toBeNull();
  });
  it.each([
    { fileFingerprint: OTHER },
    { controllerFingerprint: OTHER },
    { sourceGeneration: 1 },
    { sourcePathIdentity: OTHER },
    { decoderIdentity: "other-decoder" },
  ])("does not transfer retained compatibility to different current inputs: %j", (patch) => {
    const input = fixture(),
      record = create(input)!;
    expect(current(record, { ...input, candidate: { ...input.candidate, ...patch } }, HASH, 30)).toBe(false);
  });
  it("does not transfer the attachment to a changed path policy, selection or current controller", () => {
    const input = fixture(),
      record = create(input)!;
    expect(
      current(
        record,
        {
          ...input,
          candidate: { ...input.candidate, policy: { ...input.candidate.policy, fingerprint: OTHER } },
        },
        HASH,
        30,
      ),
    ).toBe(false);
    expect(
      current(record, { ...input, loader: { ...input.loader, selectionId: "new-selection" } }, HASH, 30),
    ).toBe(false);
    expect(current(record, input, OTHER, 30)).toBe(false);
  });
  it("keeps both original attachment expiry and current candidate expiry", () => {
    const input = fixture(),
      record = create(input)!;
    expect(current(record, input, HASH, 21)).toBe(false);
    expect(current(record, input, HASH, 15019)).toBe(true);
    expect(current(record, input, HASH, 15020)).toBe(false);
    expect(
      current(record, { ...input, candidate: { ...input.candidate, expiresAtMono: 30 } }, HASH, 30),
    ).toBe(false);
    expect(
      current(record, { ...input, candidate: { ...input.candidate, expiresAtMono: 99999 } }, HASH, 15020),
    ).toBe(false);
  });
  it("fails closed for missing or altered compatibility records", () => {
    const input = fixture(),
      record = create(input)!;
    expect(current(undefined, input, HASH, 30)).toBe(false);
    expect(current({ ...record, binarySha256: OTHER }, input, HASH, 30)).toBe(false);
    expect(current({ ...record, controllerVersion: "other" }, input, HASH, 30)).toBe(false);
    expect(current({ ...record, profileId: "invented-profile" }, input, HASH, 30)).toBe(false);
    expect(current({} as typeof record, input, HASH, 30)).toBe(false);
  });
});
