import { createHash } from "node:crypto";
import { NETWORK_TIMING } from "@shared/network";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { CurrentPathInputs } from "./path-input-reader";
import { normalizeProofTarget } from "./direct-proof";
import type { SelectedKernelCompatibility } from "./kernel-compatibility";

/**
 * Explicit main-process selection, supplied by the known client adapter, never inferred from a
 * candidate's matching rules. References identify its retained loader/path qualification records;
 * this module neither obtains those records nor upgrades arbitrary strings into measured facts.
 */
export interface KnownSelectedLoaderContract {
  readonly source: "main-process-selected-loader-contract";
  readonly selectionId: string;
  readonly loaderProfileId: string;
  readonly sourcePathIdentity: string;
  readonly decoderIdentity: string;
  readonly qualificationEvidenceIds: readonly string[];
  /** Current application's explicit selection, made before this observation round. */
  readonly selectedAtMono: number;
  /** Optional current exact-binary compatibility observation; not a configuration association. */
  readonly kernelCompatibility?: SelectedKernelCompatibility;
}

export const CONFIGURATION_ASSOCIATION_ASSUMPTIONS = Object.freeze([
  "KNOWN_SELECTED_LOADER_USES_SELECTED_SOURCE",
  "UNOBSERVED_EXTERNAL_HIDDEN_RELOAD_IS_OUTSIDE_SUPPORTED_MODEL",
] as const);

/** Association under an explicit supported-loader assumption; no Gate, DNS or physical egress claim. */
export interface CurrentConfigurationAssociation {
  readonly source: "current-configuration-association";
  readonly model: "known-selected-loader-observation";
  readonly runtimeConfigurationProven: false;
  readonly evidenceId: string;
  readonly inputSampleId: string;
  readonly loaderSelectionId: string;
  readonly loaderProfileId: string;
  readonly loaderSelectedAtMono: number;
  readonly qualificationEvidenceIds: readonly string[];
  readonly supportAssumptions: typeof CONFIGURATION_ASSOCIATION_ASSUMPTIONS;
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly sourcePathIdentity: string;
  readonly decoderIdentity: string;
  readonly fileFingerprint: string;
  readonly effectivePathPolicyVersion: string;
  readonly controllerFingerprint: string;
  readonly orderedRulesFingerprint: string;
  readonly sourceRuleOptionsFingerprint: string;
  readonly directPolicyFingerprint: string;
  readonly kernelEpoch: string;
  readonly controllerOwnerScopeHash: string;
  readonly osNetworkHash: string;
  /** Content, parser, file identity and target projection; absent legacy input is not empty. */
  readonly systemHostsFingerprint?: string;
  readonly comparedRuleCount: number;
  readonly comparedConfigFields: readonly string[];
  /** Original current input window; checking the same record never rewrites these dates. */
  readonly startedAtMono: number;
  readonly completedAtMono: number;
  readonly checkedAtMono: number;
  readonly expiresAtMono: number;
}

export interface ConfigurationAssociationInput {
  readonly inputs: CurrentPathInputs;
  readonly loader: KnownSelectedLoaderContract | null;
}
export type ConfigurationAssociationReason =
  | "INPUT_INVALID"
  | "LOADER_UNSELECTED"
  | "LOADER_CONTRACT_INVALID"
  | "LOADER_SOURCE_MISMATCH"
  | "INPUT_EXPIRED"
  | "SOURCE_CHANGED"
  | "CONTROLLER_CHANGED"
  | "KERNEL_CHANGED"
  | "NETWORK_CHANGED";
export type ConfigurationAssociationResult =
  | Readonly<{ valid: false; reason: ConfigurationAssociationReason }>
  | Readonly<{ valid: true; association: CurrentConfigurationAssociation }>;

const SHA256 = /^[a-f0-9]{64}$/;
const constructed = new WeakSet<CurrentConfigurationAssociation>();
// Keep the original non-DNS deadline outside the DTO. Neither a copied association nor later
// mutation of a caller-owned input can manufacture a longer configuration observation window.
const configurationDeadlines = new WeakMap<CurrentConfigurationAssociation, number>();
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const interval = (start: number, end: number, floor: number, ceiling: number) =>
  [start, end, floor, ceiling].every(Number.isFinite) &&
  floor >= 0 &&
  floor <= start &&
  start <= end &&
  end <= ceiling;
const references = (values: readonly string[], maximum: number) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.length <= maximum &&
  values.every(text) &&
  new Set(values).size === values.length;
const deny = (reason: ConfigurationAssociationReason): ConfigurationAssociationResult =>
  Object.freeze({ valid: false, reason });

function loaderValid(loader: KnownSelectedLoaderContract): boolean {
  return (
    loader.source === "main-process-selected-loader-contract" &&
    text(loader.selectionId) &&
    text(loader.loaderProfileId) &&
    SHA256.test(loader.sourcePathIdentity) &&
    /^[a-zA-Z0-9_.-]{1,128}$/.test(loader.decoderIdentity) &&
    references(loader.qualificationEvidenceIds, 32) &&
    Number.isFinite(loader.selectedAtMono) &&
    loader.selectedAtMono >= 0
  );
}
function sourceIdentity(value: EffectiveConfigCandidate): unknown[] {
  return [
    value.sourceGeneration,
    value.sourcePathIdentity,
    value.fileFingerprint,
    value.decoderIdentity,
    value.orderedRulesFingerprint,
    value.sourceRuleOptionsFingerprint,
    value.comparedRuleCount,
    value.comparedConfigFields,
    value.rules,
    value.policy,
  ];
}
function directIdentity(value: EffectiveConfigCandidate): unknown[] {
  const policy = value.currentDirectPolicy;
  return [policy.kind, policy.interfaceName, policy.dialer, policy.ipVersion, policy.policyFingerprint];
}
function candidateValid(candidate: EffectiveConfigCandidate): boolean {
  return (
    candidate.kind === "local-config-candidate" &&
    candidate.runtimeConfigurationProven === false &&
    // EffectiveConfigSource starts at generation 0; this is distinct from Gate generation.
    Number.isSafeInteger(candidate.sourceGeneration) &&
    candidate.sourceGeneration >= 0 &&
    /^[a-zA-Z0-9_.-]{1,128}$/.test(candidate.decoderIdentity) &&
    [
      candidate.sourcePathIdentity,
      candidate.fileFingerprint,
      candidate.controllerFingerprint,
      candidate.orderedRulesFingerprint,
      candidate.sourceRuleOptionsFingerprint,
      candidate.policy.fingerprint,
      candidate.currentDirectPolicy.policyFingerprint,
    ].every((hash) => SHA256.test(hash)) &&
    references(candidate.comparedConfigFields, 4096) &&
    Number.isSafeInteger(candidate.comparedRuleCount) &&
    candidate.comparedRuleCount >= 0 &&
    candidate.comparedRuleCount <= 20000 &&
    Array.isArray(candidate.rules) &&
    candidate.rules.length === candidate.comparedRuleCount &&
    candidate.rules.every((rule) => text(rule.type) && typeof rule.payload === "string" && text(rule.proxy))
  );
}

function configurationDeadline(inputs: CurrentPathInputs): number {
  const records = [
    inputs.configurationBefore,
    inputs.configurationAfter,
    inputs.ownerBefore,
    inputs.ownerAfter,
    inputs.networkBefore,
    inputs.networkAfter,
    ...[inputs.systemHostsBefore, inputs.systemHostsAfter].filter((value) => value !== undefined),
  ];
  return Math.min(
    inputs.configurationBefore.expiresAtMono,
    inputs.configurationAfter.expiresAtMono,
    ...records.map((record) => record.startedAtMono + NETWORK_TIMING.proofTtlMs),
  );
}

/**
 * Reconcile actual current reader records with an already selected loader contract. Matching visible
 * rules is insufficient on its own. No file/report read, reload, network request or persistence here.
 */
export function associateCurrentConfiguration(
  input: ConfigurationAssociationInput,
  nowMono: number,
): ConfigurationAssociationResult {
  try {
    return associate(input, nowMono);
  } catch {
    return deny("INPUT_INVALID");
  }
}
function associate(
  { inputs, loader }: ConfigurationAssociationInput,
  now: number,
): ConfigurationAssociationResult {
  if (!loader) return deny("LOADER_UNSELECTED");
  if (!loaderValid(loader)) return deny("LOADER_CONTRACT_INVALID");
  if (
    inputs.kind !== "current-path-inputs" ||
    inputs.state !== "observed" ||
    !text(inputs.sampleId) ||
    !positiveInteger(inputs.generation) ||
    !SHA256.test(inputs.rulesVersion)
  )
    return deny("INPUT_INVALID");
  const before = inputs.configurationBefore,
    after = inputs.configurationAfter;
  if (!candidateValid(before) || !candidateValid(after)) return deny("INPUT_INVALID");
  if (
    !interval(inputs.startedAtMono, inputs.completedAtMono, loader.selectedAtMono, now) ||
    !Number.isFinite(inputs.expiresAtMono) ||
    inputs.expiresAtMono <= now
  )
    return deny("INPUT_EXPIRED");
  if (
    [before, after].some(
      (value) =>
        value.sourcePathIdentity !== loader.sourcePathIdentity ||
        value.decoderIdentity !== loader.decoderIdentity,
    )
  )
    return deny("LOADER_SOURCE_MISMATCH");
  if (!same(sourceIdentity(before), sourceIdentity(after))) return deny("SOURCE_CHANGED");
  if (
    before.controllerFingerprint !== inputs.rulesVersion ||
    after.controllerFingerprint !== inputs.rulesVersion ||
    !same(directIdentity(before), directIdentity(after))
  )
    return deny("CONTROLLER_CHANGED");
  const owners = [inputs.ownerBefore, inputs.ownerAfter] as const;
  if (
    owners.some(
      (value) =>
        !value.available ||
        value.basis !== "windows-controller-listener" ||
        !SHA256.test(value.kernelEpoch) ||
        !SHA256.test(value.scopeHash) ||
        !positiveInteger(value.owner.pid) ||
        !/^[1-9]\d{15,18}$/.test(value.owner.createdAtTicks) ||
        (value.owner.executablePathIdentity !== null && !SHA256.test(value.owner.executablePathIdentity)) ||
        !Array.isArray(value.listeners) ||
        value.listeners.length < 1 ||
        value.listeners.length > 64,
    )
  )
    return deny("INPUT_INVALID");
  if (
    inputs.ownerBefore.kernelEpoch !== inputs.ownerAfter.kernelEpoch ||
    inputs.ownerBefore.scopeHash !== inputs.ownerAfter.scopeHash ||
    !same(inputs.ownerBefore.owner, inputs.ownerAfter.owner) ||
    !same(inputs.ownerBefore.listeners, inputs.ownerAfter.listeners)
  )
    return deny("KERNEL_CHANGED");
  const networks = [inputs.networkBefore, inputs.networkAfter];
  if (networks.some((value) => !SHA256.test(value.hash))) return deny("INPUT_INVALID");
  if (inputs.networkBefore.hash !== inputs.networkAfter.hash) return deny("NETWORK_CHANGED");

  const systemHosts = [inputs.systemHostsBefore, inputs.systemHostsAfter];
  let systemHostsFingerprint: string | undefined;
  if (systemHosts.some((value) => value !== undefined)) {
    const hosts = [...new Set(inputs.targets.map((target) => normalizeProofTarget(target)?.host))].sort();
    if (
      systemHosts.some(
        (value) =>
          !value ||
          !value.available ||
          value.kind !== "windows-system-hosts-targets" ||
          value.source !== "windows-system-hosts-file" ||
          value.resolutionProven !== false ||
          value.parserProfile !== "windows-hosts-ascii-aliases-v1" ||
          ![value.fileHash, value.fileIdentity, value.scopeHash].every((hash) => SHA256.test(hash)) ||
          value.scopeHash !== digest(hosts) ||
          !same(value.hosts.map((row) => row.host).sort(), hosts),
      )
    )
      return deny("INPUT_INVALID");
    const identity = (value: NonNullable<CurrentPathInputs["systemHostsBefore"]>) => [
      value.fileHash,
      value.fileIdentity,
      value.scopeHash,
      value.parserProfile,
      value.hosts,
    ];
    if (!same(identity(systemHosts[0]!), identity(systemHosts[1]!))) return deny("NETWORK_CHANGED");
    systemHostsFingerprint = digest(identity(systemHosts[1]!));
  }

  // Use each provider's own actual window, never a timestamp assigned by this checker.
  const currentRecords = [
    before,
    after,
    ...owners,
    ...networks,
    ...systemHosts.filter((value) => value !== undefined),
  ];
  if (
    currentRecords.some(
      (value) =>
        !interval(value.startedAtMono, value.completedAtMono, inputs.startedAtMono, inputs.completedAtMono),
    )
  )
    return deny("INPUT_EXPIRED");
  for (const candidate of [before, after]) {
    if (
      !interval(
        candidate.controllerStartedAtMono,
        candidate.controllerCompletedAtMono,
        candidate.startedAtMono,
        candidate.completedAtMono,
      ) ||
      !interval(
        candidate.currentDirectPolicy.startedAtMono,
        candidate.currentDirectPolicy.completedAtMono,
        candidate.controllerStartedAtMono,
        candidate.controllerCompletedAtMono,
      ) ||
      !Number.isFinite(candidate.expiresAtMono) ||
      candidate.expiresAtMono <= now
    )
      return deny("INPUT_EXPIRED");
  }
  const configurationExpiresAtMono = configurationDeadline(inputs);
  const expiresAtMono = Math.min(inputs.expiresAtMono, configurationExpiresAtMono);
  if (expiresAtMono <= now) return deny("INPUT_EXPIRED");
  const fields = {
    inputSampleId: inputs.sampleId,
    loaderSelectionId: loader.selectionId,
    loaderProfileId: loader.loaderProfileId,
    loaderSelectedAtMono: loader.selectedAtMono,
    qualificationEvidenceIds: Object.freeze([...loader.qualificationEvidenceIds]),
    generation: inputs.generation,
    sourceGeneration: after.sourceGeneration,
    sourcePathIdentity: after.sourcePathIdentity,
    decoderIdentity: after.decoderIdentity,
    fileFingerprint: after.fileFingerprint,
    effectivePathPolicyVersion: after.policy.fingerprint,
    controllerFingerprint: after.controllerFingerprint,
    orderedRulesFingerprint: after.orderedRulesFingerprint,
    sourceRuleOptionsFingerprint: after.sourceRuleOptionsFingerprint,
    directPolicyFingerprint: after.currentDirectPolicy.policyFingerprint,
    kernelEpoch: inputs.ownerAfter.kernelEpoch,
    controllerOwnerScopeHash: inputs.ownerAfter.scopeHash,
    osNetworkHash: inputs.networkAfter.hash,
    ...(systemHostsFingerprint ? { systemHostsFingerprint } : {}),
    comparedRuleCount: after.comparedRuleCount,
    comparedConfigFields: Object.freeze([...after.comparedConfigFields]),
    startedAtMono: inputs.startedAtMono,
    completedAtMono: inputs.completedAtMono,
    checkedAtMono: now,
    expiresAtMono,
  };
  const association: CurrentConfigurationAssociation = Object.freeze({
    source: "current-configuration-association",
    model: "known-selected-loader-observation",
    runtimeConfigurationProven: false,
    evidenceId: digest(fields),
    supportAssumptions: CONFIGURATION_ASSOCIATION_ASSUMPTIONS,
    ...fields,
  });
  constructed.add(association);
  configurationDeadlines.set(association, configurationExpiresAtMono);
  return Object.freeze({ valid: true, association });
}

/** A serialized/copied result cannot be restored as a live association, including from old reports. */
export function validateConfigurationAssociation(
  association: CurrentConfigurationAssociation | null,
  inputs: CurrentPathInputs,
  loader: KnownSelectedLoaderContract | null,
  nowMono: number,
): boolean {
  if (
    !association ||
    !constructed.has(association) ||
    !Number.isFinite(nowMono) ||
    nowMono < association.checkedAtMono ||
    nowMono >= association.expiresAtMono
  )
    return false;
  const current = associateCurrentConfiguration({ inputs, loader }, nowMono);
  if (!current.valid) return false;
  const value = current.association;
  // All dependencies and the original round must still match; this check cannot extend old expiry.
  const identity = (record: CurrentConfigurationAssociation) => {
    const { evidenceId: _id, checkedAtMono: _at, ...rest } = record;
    return rest;
  };
  return same(identity(association), identity(value));
}

/**
 * Configuration-only prerequisite for a request whose DNS is independently sampled and checked.
 * First validate the original branded association at its actual checkedAt; then enforce the original
 * selected configuration/controller, owner, OS and hosts windows. This does not refresh dates,
 * validate the new DNS, or authorize a request. The ordinary full-input validator is unchanged.
 */
export function validateConfigurationAssociationForFreshDns(
  association: CurrentConfigurationAssociation | null,
  inputs: CurrentPathInputs,
  loader: KnownSelectedLoaderContract | null,
  nowMono: number,
): boolean {
  try {
    if (
      !association ||
      !Number.isFinite(nowMono) ||
      nowMono < association.checkedAtMono ||
      !validateConfigurationAssociation(association, inputs, loader, association.checkedAtMono)
    )
      return false;
    const originalDeadline = configurationDeadlines.get(association);
    const deadline = Math.min(originalDeadline ?? NaN, configurationDeadline(inputs));
    return Number.isFinite(deadline) && nowMono < deadline;
  } catch {
    return false;
  }
}
