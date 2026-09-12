import { NETWORK_TIMING, type NetworkReason } from "@shared/network";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import { evaluateRules, type KernelRule, type RuleContext } from "./rules";
import { evaluateRuleContextSet, type CurrentRuleContextSet } from "./rule-context-set";
import type { CurrentPathInputs } from "./path-input-reader";
import type { CurrentRuleBranchDecision } from "./current-rule-context";

/** Main-process input records, never renderer DTOs. The producer must retain their source records. */
export interface LiveRulesSnapshot {
  mode: string;
  generation: number;
  rulesVersion: string;
  kernelEpoch: string;
  rules: readonly KernelRule[];
  observedAtMono: number;
}

export interface LiveOutboundPolicy {
  /** Exact name selected by the live rule; a name containing DIRECT is not a type. */
  name: string;
  /** Main-process policy identity (e.g. kernel epoch + exact name + policy digest), not a fake API ID. */
  id: string;
  kind: "direct" | "other" | "unknown";
  dialer: "none" | "configured" | "unknown";
  policyVersion: string;
  kernelEpoch: string;
  generation: number;
  rulesVersion: string;
  observedAtMono: number;
}

/**
 * An independently validated path profile, not a controller's DIRECT observation.
 * These references must come from the main-process path verifier's actual records. This module
 * checks consistency but does not collect/attest interfaces, DNS, process identity or family limits.
 */
export interface ValidatedRulePath {
  source: "validated-path-profile";
  evidenceId: string;
  target: ProofTarget;
  contextId: string;
  kernelEpoch: string;
  generation: number;
  rulesVersion: string;
  outboundId: string;
  outboundPolicyVersion: string;
  effectivePathPolicyVersion: string;
  physicalRouteClass: string;
  transportCompatibilityEvidenceId: string;
  dnsPolicyEvidenceId: string;
  network: "tcp";
  processName?: string;
  processPath?: string;
  /** Both possible families, or one family with a separately validated constraint. */
  possibleAddressFamilies: readonly ProofTarget["addressFamily"][];
  familyConstraintEvidenceId: string | null;
  /** Latest check of this profile's current applicability; conformance artifact dates stay separate. */
  observedAtMono: number;
  expiresAtMono: number;
}

export interface LiveRuleEvidenceInput {
  target: ProofTarget;
  contextId: string;
  snapshot: LiveRulesSnapshot;
  outbound: LiveOutboundPolicy;
  /** Null until a real path verifier has supplied the referenced independent evidence. */
  path: ValidatedRulePath | null;
  ruleContexts?: {
    inputs: CurrentPathInputs;
    set: CurrentRuleContextSet;
    transportProfileId: string;
  };
}

export interface CurrentOrderedRuleEvidence {
  readonly source: "current-ordered-rules";
  readonly target: ProofTarget;
  readonly contextId: string;
  readonly generation: number;
  readonly rulesVersion: string;
  /** Compatibility representative (first branch); ruleBranches retains every contextual decision. */
  readonly ruleIndex: number;
  readonly ruleType: string;
  /** All matching branches, when the current source requires destination/process context. */
  readonly ruleBranches?: readonly Pick<CurrentRuleBranchDecision, "decision" | "matchedPolicy">[];
  readonly effectiveOutboundId: string;
  readonly outboundPolicyVersion: string;
  readonly effectivePathPolicyVersion: string;
  readonly pathEvidenceId: string;
  readonly possibleAddressFamilies: readonly ProofTarget["addressFamily"][];
  readonly observedAtMono: number;
  readonly expiresAtMono: number;
}

type Rejection = { valid: false; reason: NetworkReason };
export type LiveRuleEvidenceResult = Rejection | { valid: true; evidence: CurrentOrderedRuleEvidence };

// This is an in-process construction boundary, not cryptographic attestation of the producer.
// A renderer-shaped object, copied record, or renamed connection evidence is not a rule proof.
const constructed = new WeakSet<CurrentOrderedRuleEvidence>();
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const fresh = (at: number, now: number, ttl: number) =>
  Number.isFinite(at) && at >= 0 && at <= now && now - at < ttl;
const deny = (reason: NetworkReason): Rejection => ({ valid: false, reason });

/** Computes ordered live rules. Does not make an egress observation or grant account permission. */
export function createLiveRuleEvidence(
  input: LiveRuleEvidenceInput,
  nowMono: number,
  ttlMs: number = NETWORK_TIMING.proofTtlMs,
): LiveRuleEvidenceResult {
  const target = normalizeProofTarget(input.target);
  if (!target) return deny("UNKNOWN_TARGET");
  const { snapshot, outbound, path } = input;
  if (snapshot.mode === "global") return deny("GLOBAL_MODE");
  if (snapshot.mode !== "rule") return deny("RULE_UNVERIFIABLE");
  if (!nonempty(input.contextId) || !path || path.source !== "validated-path-profile")
    return deny("CONTEXT_UNVERIFIED");
  if (path.contextId !== input.contextId) return deny("CONTEXT_UNVERIFIED");
  if (proofTargetKey(path.target) !== proofTargetKey(target)) return deny("UNKNOWN_TARGET");
  if (
    !Number.isSafeInteger(snapshot.generation) ||
    snapshot.generation < 1 ||
    !nonempty(snapshot.rulesVersion) ||
    !nonempty(snapshot.kernelEpoch) ||
    path.generation !== snapshot.generation ||
    outbound.generation !== snapshot.generation ||
    path.rulesVersion !== snapshot.rulesVersion ||
    outbound.rulesVersion !== snapshot.rulesVersion ||
    path.kernelEpoch !== snapshot.kernelEpoch ||
    outbound.kernelEpoch !== snapshot.kernelEpoch
  )
    return deny("NETWORK_CHANGED");
  if (
    !nonempty(outbound.id) ||
    !nonempty(outbound.name) ||
    !nonempty(outbound.policyVersion) ||
    path.outboundId !== outbound.id ||
    path.outboundPolicyVersion !== outbound.policyVersion
  )
    return deny("NETWORK_CHANGED");
  if (outbound.kind === "unknown" || outbound.dialer === "unknown") return deny("RULE_UNVERIFIABLE");
  if (outbound.kind !== "direct" || outbound.dialer !== "none") return deny("NOT_DIRECT");
  if (
    path.network !== "tcp" ||
    ![
      path.evidenceId,
      path.effectivePathPolicyVersion,
      path.physicalRouteClass,
      path.transportCompatibilityEvidenceId,
      path.dnsPolicyEvidenceId,
    ].every(nonempty) ||
    (path.processName !== undefined && !nonempty(path.processName)) ||
    (path.processPath !== undefined && !nonempty(path.processPath))
  )
    return deny("CONTEXT_UNVERIFIED");
  const families = path.possibleAddressFamilies;
  if (
    !Array.isArray(families) ||
    families.length < 1 ||
    families.length > 2 ||
    new Set(families).size !== families.length ||
    families.some((family) => family !== "ipv4" && family !== "ipv6") ||
    !families.includes(target.addressFamily) ||
    (families.length === 1 && !nonempty(path.familyConstraintEvidenceId))
  )
    return deny("EGRESS_UNVERIFIED");
  if (
    !Number.isFinite(nowMono) ||
    nowMono < 0 ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > NETWORK_TIMING.proofTtlMs ||
    ![snapshot.observedAtMono, outbound.observedAtMono, path.observedAtMono].every((at) =>
      fresh(at, nowMono, ttlMs),
    ) ||
    !Number.isFinite(path.expiresAtMono) ||
    path.expiresAtMono <= nowMono
  )
    return deny("PROOF_EXPIRED");
  if (
    !Array.isArray(snapshot.rules) ||
    !snapshot.rules.length ||
    snapshot.rules.some(
      (rule) => !rule || !nonempty(rule.type) || typeof rule.payload !== "string" || !nonempty(rule.proxy),
    )
  )
    return deny("RULE_UNVERIFIABLE");

  const context: RuleContext = {
    host: target.host,
    port: target.port,
    network: path.network,
    ...(path.processName ? { processName: path.processName } : {}),
    ...(path.processPath ? { processPath: path.processPath } : {}),
  };
  // Reuse the conservative ordered matcher; resolve the selected endpoint from its real metadata.
  // A non-DIRECT alias still returns its matched index; unknown preceding branches never do.
  const contextual =
    input.ruleContexts === undefined
      ? null
      : evaluateRuleContextSet(
          input.ruleContexts.set,
          input.ruleContexts.inputs,
          snapshot,
          target,
          input.contextId,
          input.ruleContexts.transportProfileId,
          path.network,
          nowMono,
        );
  if (contextual?.route === "unknown") return deny(contextual.reason);
  if (contextual && contextual.matchedPolicy !== outbound.name) return deny("NOT_DIRECT");
  const decision = contextual
    ? contextual.branches[0]?.decision
    : evaluateRules(snapshot.mode, snapshot.rules, context);
  if (!decision || decision.route === "unknown" || decision.ruleIndex === null || !decision.ruleType)
    return deny(decision?.reason ?? "RULE_UNVERIFIABLE");
  if (snapshot.rules[decision.ruleIndex].proxy !== outbound.name) return deny("NOT_DIRECT");
  const observedAtMono = Math.min(snapshot.observedAtMono, outbound.observedAtMono, path.observedAtMono);
  const evidence: CurrentOrderedRuleEvidence = Object.freeze({
    source: "current-ordered-rules",
    target: Object.freeze({ ...target }),
    contextId: input.contextId,
    generation: snapshot.generation,
    rulesVersion: snapshot.rulesVersion,
    ruleIndex: decision.ruleIndex,
    ruleType: decision.ruleType,
    ...(contextual
      ? {
          ruleBranches: Object.freeze(
            contextual.branches.map((branch) =>
              Object.freeze({
                decision: branch.decision,
                matchedPolicy: branch.matchedPolicy,
              }),
            ),
          ),
        }
      : {}),
    effectiveOutboundId: outbound.id,
    outboundPolicyVersion: outbound.policyVersion,
    effectivePathPolicyVersion: path.effectivePathPolicyVersion,
    pathEvidenceId: path.evidenceId,
    possibleAddressFamilies: Object.freeze([...families]),
    observedAtMono,
    expiresAtMono: Math.min(
      observedAtMono + ttlMs,
      path.expiresAtMono,
      contextual?.expiresAtMono ?? Infinity,
    ),
  });
  constructed.add(evidence);
  return { valid: true, evidence };
}

/** Used only by DirectProof; full batches still require independently applicable egress/TLS/DNS. */
export function validateLiveRuleEvidence(
  evidence: CurrentOrderedRuleEvidence,
  expected: {
    target: ProofTarget;
    contextId: string;
    generation: number;
    rulesVersion: string;
    nowMono: number;
  },
): Rejection | { valid: true } {
  if (
    !constructed.has(evidence) ||
    ["connectionId", "correlationVerified", "chains", "ruleDecision"].some((key) => key in evidence)
  )
    return deny("RULE_UNVERIFIABLE");
  if (proofTargetKey(evidence.target) !== proofTargetKey(expected.target)) return deny("UNKNOWN_TARGET");
  if (evidence.contextId !== expected.contextId) return deny("CONTEXT_UNVERIFIED");
  if (evidence.generation !== expected.generation || evidence.rulesVersion !== expected.rulesVersion)
    return deny("NETWORK_CHANGED");
  if (
    !Number.isFinite(expected.nowMono) ||
    expected.nowMono < evidence.observedAtMono ||
    expected.nowMono >= evidence.expiresAtMono
  )
    return deny("PROOF_EXPIRED");
  return { valid: true };
}
