import type { ClashReadResult } from "./clash-reader";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { EffectiveConfigCandidate } from "./effective-config-source";

/** Reviewed eight-case loopback observation of these exact bytes, not a mihomo default.
 * The JSON experiment report is documentation and is never loaded at runtime. This profile says
 * nothing about the application's selected AF, resolver equivalence, DIRECT or geography.
 */
export const KERNEL_COMPATIBILITY_PROFILE = Object.freeze({
  id: "mihomo-d354a6b3-missing-ipv6-fake-pool-v1",
  loaderProfileId: "maomaoyun-5.5.6-main-2e66e4eb-v1",
  decoderIdentity: "maomaoyun-5.5.6-aes128cbc-data-v1",
  binaryName: "mihomo-windows-386.exe",
  binarySha256: "d354a6b31e89db289a46fffd8913c2da4ee1e2218882d75cacc49c41b425dde9",
  controllerVersion: "424c2ef",
  missingIpv6FakePool: "none" as const,
});

/** Main-process current selected-loader observation. Not an attestation of loaded executable bytes. */
export interface SelectedKernelCompatibility {
  readonly source: "selected-kernel-compatibility";
  readonly model: "known-selected-loader-observation";
  readonly profileId: string;
  readonly missingIpv6FakePool: "none";
  readonly loaderSelectionId: string;
  readonly loaderProfileId: string;
  readonly sourcePathIdentity: string;
  readonly decoderIdentity: string;
  readonly binaryPathIdentity: string;
  readonly binarySha256: string;
  readonly artifactIdentity: string;
  readonly controllerVersion: string;
  readonly controllerFingerprint: string;
  readonly sourceGeneration: number;
  readonly fileFingerprint: string;
  readonly pathPolicyFingerprint: string;
  /** Actual controller read supplying the short version; preserved when checked again. */
  readonly controllerStartedAtMono: number;
  readonly controllerCompletedAtMono: number;
  readonly checkedAtMono: number;
  readonly expiresAtMono: number;
}

type Selection = {
  readonly loader: KnownSelectedLoaderContract;
  readonly candidate: EffectiveConfigCandidate;
};
export interface SelectedKernelCompatibilityInput extends Selection {
  readonly binary: Readonly<{ sha256: string; pathIdentity: string }> | null;
  readonly artifactIdentity: string;
  readonly controller: Pick<
    ClashReadResult,
    "version" | "fingerprint" | "startedAtMono" | "completedAtMono"
  > | null;
  readonly checkedAtMono: number;
}
const SHA256 = /^[a-f0-9]{64}$/;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;

function matchingSelection(
  record: SelectedKernelCompatibility,
  { loader, candidate }: Selection,
  now: number,
): boolean {
  const profile = KERNEL_COMPATIBILITY_PROFILE;
  return (
    record.source === "selected-kernel-compatibility" &&
    record.model === "known-selected-loader-observation" &&
    record.profileId === profile.id &&
    record.missingIpv6FakePool === "none" &&
    record.binarySha256 === profile.binarySha256 &&
    record.controllerVersion === profile.controllerVersion &&
    loader.source === "main-process-selected-loader-contract" &&
    record.loaderProfileId === profile.loaderProfileId &&
    loader.loaderProfileId === profile.loaderProfileId &&
    record.decoderIdentity === profile.decoderIdentity &&
    loader.decoderIdentity === profile.decoderIdentity &&
    candidate.decoderIdentity === profile.decoderIdentity &&
    text(loader.selectionId) &&
    record.loaderSelectionId === loader.selectionId &&
    record.sourcePathIdentity === loader.sourcePathIdentity &&
    record.sourcePathIdentity === candidate.sourcePathIdentity &&
    record.fileFingerprint === candidate.fileFingerprint &&
    record.pathPolicyFingerprint === candidate.policy.fingerprint &&
    record.controllerFingerprint === candidate.controllerFingerprint &&
    Number.isSafeInteger(record.sourceGeneration) &&
    record.sourceGeneration >= 0 &&
    record.sourceGeneration === candidate.sourceGeneration &&
    candidate.kind === "local-config-candidate" &&
    candidate.runtimeConfigurationProven === false &&
    [
      record.binaryPathIdentity,
      record.binarySha256,
      record.artifactIdentity,
      record.sourcePathIdentity,
      record.fileFingerprint,
      record.pathPolicyFingerprint,
      record.controllerFingerprint,
    ].every((value) => SHA256.test(value)) &&
    [
      now,
      loader.selectedAtMono,
      record.controllerStartedAtMono,
      record.controllerCompletedAtMono,
      record.checkedAtMono,
      record.expiresAtMono,
      candidate.completedAtMono,
      candidate.expiresAtMono,
    ].every(Number.isFinite) &&
    loader.selectedAtMono >= 0 &&
    loader.selectedAtMono <= record.controllerStartedAtMono &&
    record.controllerStartedAtMono <= record.controllerCompletedAtMono &&
    record.controllerCompletedAtMono <= record.checkedAtMono &&
    record.checkedAtMono <= now &&
    candidate.completedAtMono <= now &&
    now < record.expiresAtMono &&
    now < candidate.expiresAtMono
  );
}

/** Caller has just checked the selected artifact on both sides of this actual controller/source read. */
export function createSelectedKernelCompatibility(
  input: SelectedKernelCompatibilityInput,
): SelectedKernelCompatibility | null {
  try {
    const { loader, candidate, binary, controller, checkedAtMono } = input;
    if (
      !binary ||
      !controller ||
      controller.fingerprint !== candidate.controllerFingerprint ||
      controller.startedAtMono !== candidate.controllerStartedAtMono ||
      controller.completedAtMono !== candidate.controllerCompletedAtMono ||
      candidate.startedAtMono > candidate.controllerStartedAtMono ||
      candidate.controllerCompletedAtMono > candidate.completedAtMono ||
      candidate.completedAtMono > checkedAtMono
    )
      return null;
    const record: SelectedKernelCompatibility = Object.freeze({
      source: "selected-kernel-compatibility",
      model: "known-selected-loader-observation",
      profileId: KERNEL_COMPATIBILITY_PROFILE.id,
      missingIpv6FakePool: "none",
      loaderSelectionId: loader.selectionId,
      loaderProfileId: loader.loaderProfileId,
      sourcePathIdentity: loader.sourcePathIdentity,
      decoderIdentity: loader.decoderIdentity,
      binaryPathIdentity: binary.pathIdentity,
      binarySha256: binary.sha256,
      artifactIdentity: input.artifactIdentity,
      controllerVersion: controller.version,
      controllerFingerprint: controller.fingerprint,
      sourceGeneration: candidate.sourceGeneration,
      fileFingerprint: candidate.fileFingerprint,
      pathPolicyFingerprint: candidate.policy.fingerprint,
      controllerStartedAtMono: controller.startedAtMono!,
      controllerCompletedAtMono: controller.completedAtMono!,
      checkedAtMono,
      expiresAtMono: candidate.expiresAtMono,
    });
    return matchingSelection(record, input, checkedAtMono) ? record : null;
  } catch {
    return null;
  }
}

export function hasCurrentMissingIpv6FakePoolCompatibility(
  record: SelectedKernelCompatibility | undefined,
  input: Selection,
  controllerFingerprint: string,
  nowMono: number,
): boolean {
  try {
    return (
      !!record &&
      record.controllerFingerprint === controllerFingerprint &&
      matchingSelection(record, input, nowMono)
    );
  } catch {
    return false;
  }
}
