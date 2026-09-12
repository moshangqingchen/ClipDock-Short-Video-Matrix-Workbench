import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NETWORK_TIMING, type NetworkReason } from "@shared/network";
import {
  validateConfigurationAssociation,
  type CurrentConfigurationAssociation,
  type KnownSelectedLoaderContract,
} from "./configuration-association";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { LiveRulesSnapshot } from "./live-rule-evidence";
import type { CurrentPathInputs } from "./path-input-reader";
import {
  evaluateRules,
  normalizeKernelRule,
  type RuleDecision,
  type RuleDestination,
  type RuleSourceParameters,
} from "./rules";

/** Main-process references only. Preserve the original association outside structuredClone. */
export interface CurrentRuleConfiguration {
  readonly inputs: CurrentPathInputs;
  readonly loader: KnownSelectedLoaderContract | null;
  readonly association: CurrentConfigurationAssociation | null;
}

/**
 * A current producer's complete possible matching stages, not a fact collector or permission.
 * The producer must retain the referenced transport/stage observations or applicable behavior.
 * scopeContextId identifies the account operation scope, never a not-yet-created anonymous Session.
 */
export interface CurrentRuleContext {
  readonly source: "main-process-current-rule-context";
  readonly target: ProofTarget;
  readonly scopeContextId: string;
  readonly transportProfileId: string;
  readonly inputSampleId: string;
  readonly configurationEvidenceId: string;
  readonly generation: number;
  readonly rulesVersion: string;
  readonly kernelEpoch: string;
  readonly network: "tcp" | "udp";
  readonly processName?: string;
  readonly processPath?: string;
  /** Complete set, including an explicit unknown branch whenever the stage cannot be established. */
  readonly destinations: readonly RuleDestination[];
  readonly sourceEvidenceIds: readonly string[];
  /** Applicability check against this input round; does not replace original artifact dates. */
  readonly checkedAtMono: number;
  readonly expiresAtMono: number;
}

export interface CurrentRuleContextInput {
  readonly snapshot: LiveRulesSnapshot;
  readonly target: ProofTarget;
  readonly scopeContextId: string;
  readonly transportProfileId: string;
  readonly configuration: CurrentRuleConfiguration | null;
  readonly context: CurrentRuleContext | null;
}

export interface CurrentRuleBranchDecision {
  readonly destination: RuleDestination;
  readonly decision: Readonly<RuleDecision>;
  /** Exact policy name only, not a claim about the selected endpoint's real type. */
  readonly matchedPolicy: string | null;
}

/** Internal interpretation only; no Gate permission, DNS/AF claim, IPC projection or new certificate. */
export interface CurrentRuleContextResult {
  readonly route: RuleDecision["route"];
  readonly reason: NetworkReason;
  readonly branches: readonly CurrentRuleBranchDecision[];
  /** Non-null only when every possible branch selects this same exact endpoint. */
  readonly matchedPolicy: string | null;
  readonly expiresAtMono: number | null;
}

const MAX_BRANCHES = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const finiteTime = (value: number) => Number.isFinite(value) && value >= 0;
const deny = (reason: NetworkReason): CurrentRuleContextResult =>
  Object.freeze({
    route: "unknown",
    reason,
    branches: Object.freeze([]),
    matchedPolicy: null,
    expiresAtMono: null,
  });

/** Matches EffectiveConfigSource's canonical object digest; source parameter arrays use the same JSON. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function normalizeDestination(value: RuleDestination): RuleDestination | null {
  if (!value || typeof value !== "object") return null;
  if (value.stage === "unresolved" || value.stage === "unknown") {
    // Reject contradictory records such as unresolved+address instead of discarding the address.
    if (Object.keys(value).some((key) => key !== "stage")) return null;
    return Object.freeze({ stage: value.stage });
  }
  if (
    value.stage !== "resolved" ||
    Object.keys(value).some((key) => key !== "stage" && key !== "address") ||
    typeof value.address !== "string" ||
    value.address.length > 128 ||
    value.address.includes("%")
  )
    return null;
  const family = isIP(value.address);
  if (!family) return null;
  return Object.freeze({
    stage: "resolved",
    address: family === 6 ? new URL(`http://[${value.address}]`).hostname.slice(1, -1) : value.address,
  });
}

/** All branches are evaluated. No public request, DNS lookup, file read or fallback occurs here. */
export function evaluateCurrentRuleContext(
  input: CurrentRuleContextInput,
  nowMono: number,
): CurrentRuleContextResult {
  try {
    return evaluate(input, nowMono);
  } catch {
    return deny("RULE_UNVERIFIABLE");
  }
}

function evaluate(input: CurrentRuleContextInput, now: number): CurrentRuleContextResult {
  const { snapshot, configuration, context } = input;
  if (snapshot.mode === "global") return deny("GLOBAL_MODE");
  if (snapshot.mode !== "rule") return deny("RULE_UNVERIFIABLE");
  const target = normalizeProofTarget(input.target);
  if (!target) return deny("UNKNOWN_TARGET");
  if (!text(input.scopeContextId) || !text(input.transportProfileId) || !context)
    return deny("CONTEXT_UNVERIFIED");
  if (!configuration?.association || !configuration.loader) return deny("RULE_UNVERIFIABLE");
  if (
    !finiteTime(now) ||
    !finiteTime(snapshot.observedAtMono) ||
    snapshot.observedAtMono > now ||
    now - snapshot.observedAtMono >= NETWORK_TIMING.proofTtlMs
  )
    return deny("PROOF_EXPIRED");
  const { inputs, loader, association } = configuration;
  if (!validateConfigurationAssociation(association, inputs, loader, now)) return deny("RULE_UNVERIFIABLE");
  if (
    !Number.isSafeInteger(snapshot.generation) ||
    snapshot.generation < 1 ||
    !SHA256.test(snapshot.rulesVersion) ||
    !SHA256.test(snapshot.kernelEpoch) ||
    snapshot.generation !== inputs.generation ||
    snapshot.rulesVersion !== association.controllerFingerprint ||
    snapshot.kernelEpoch !== association.kernelEpoch
  )
    return deny("NETWORK_CHANGED");
  if (!inputs.targets.some((candidate) => proofTargetKey(candidate) === proofTargetKey(target)))
    return deny("UNKNOWN_TARGET");
  if (
    context.source !== "main-process-current-rule-context" ||
    context.scopeContextId !== input.scopeContextId ||
    context.transportProfileId !== input.transportProfileId ||
    proofTargetKey(context.target) !== proofTargetKey(target) ||
    context.inputSampleId !== inputs.sampleId ||
    context.configurationEvidenceId !== association.evidenceId ||
    context.generation !== snapshot.generation ||
    context.rulesVersion !== snapshot.rulesVersion ||
    context.kernelEpoch !== snapshot.kernelEpoch ||
    !["tcp", "udp"].includes(context.network) ||
    (context.processName !== undefined && !text(context.processName)) ||
    (context.processPath !== undefined && !text(context.processPath)) ||
    !Array.isArray(context.sourceEvidenceIds) ||
    !context.sourceEvidenceIds.length ||
    context.sourceEvidenceIds.length > 32 ||
    Array.from(context.sourceEvidenceIds).some((id) => !text(id)) ||
    new Set(context.sourceEvidenceIds).size !== context.sourceEvidenceIds.length
  )
    return deny("CONTEXT_UNVERIFIED");
  if (
    !finiteTime(context.checkedAtMono) ||
    context.checkedAtMono < inputs.completedAtMono ||
    context.checkedAtMono > now ||
    !finiteTime(context.expiresAtMono) ||
    context.expiresAtMono <= now ||
    now - context.checkedAtMono >= NETWORK_TIMING.proofTtlMs
  )
    return deny("PROOF_EXPIRED");
  if (
    !Array.isArray(context.destinations) ||
    !context.destinations.length ||
    context.destinations.length > MAX_BRANCHES
  )
    return deny("CONTEXT_UNVERIFIED");
  const destinations = context.destinations.map(normalizeDestination);
  if (
    destinations.some((value) => value === null) ||
    new Set(destinations.map(canonical)).size !== destinations.length
  )
    return deny("CONTEXT_UNVERIFIED");

  const before = inputs.configurationBefore,
    after = inputs.configurationAfter;
  if (
    !before.ruleParameters ||
    !after.ruleParameters ||
    !same(before.ruleParameters, after.ruleParameters) ||
    digest(before.ruleParameters) !== before.sourceRuleOptionsFingerprint ||
    digest(after.ruleParameters) !== after.sourceRuleOptionsFingerprint ||
    digest(before.rules.map(normalizeKernelRule)) !== before.orderedRulesFingerprint ||
    digest(after.rules.map(normalizeKernelRule)) !== after.orderedRulesFingerprint ||
    !same(snapshot.rules.map(normalizeKernelRule), after.rules.map(normalizeKernelRule))
  )
    return deny("RULE_UNVERIFIABLE");
  const sourceParameters: RuleSourceParameters = {
    rules: after.rules,
    parameters: after.ruleParameters,
    parametersFingerprint: after.sourceRuleOptionsFingerprint,
  };
  const branches = destinations.map((destination): CurrentRuleBranchDecision => {
    const decision = evaluateRules(
      snapshot.mode,
      snapshot.rules,
      {
        host: target.host,
        port: target.port,
        network: context.network,
        processName: context.processName,
        processPath: context.processPath,
        destination: destination!,
      },
      sourceParameters,
    );
    return Object.freeze({
      destination: destination!,
      decision: Object.freeze(decision),
      matchedPolicy:
        decision.route === "unknown" || decision.ruleIndex === null
          ? null
          : snapshot.rules[decision.ruleIndex].proxy,
    });
  });
  const unknown = branches.some((branch) => branch.decision.route === "unknown");
  const policy =
    !unknown && branches.every((branch) => branch.matchedPolicy === branches[0].matchedPolicy)
      ? branches[0].matchedPolicy
      : null;
  const route = unknown
    ? "unknown"
    : branches.every((branch) => branch.decision.route === "direct")
      ? "direct"
      : "proxy";
  return Object.freeze({
    route,
    reason: unknown ? "RULE_UNVERIFIABLE" : route === "direct" ? "READY" : "NOT_DIRECT",
    branches: Object.freeze(branches),
    matchedPolicy: policy,
    expiresAtMono: Math.min(
      association.expiresAtMono,
      context.expiresAtMono,
      context.checkedAtMono + NETWORK_TIMING.proofTtlMs,
      snapshot.observedAtMono + NETWORK_TIMING.proofTtlMs,
    ),
  });
}
