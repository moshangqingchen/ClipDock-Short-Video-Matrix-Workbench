import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { NetworkReason } from "@shared/network";
import type { CnPlatformId } from "@shared/platforms";
import { validateLiveRuleEvidence, type CurrentOrderedRuleEvidence } from "./live-rule-evidence";

/** Main-process evidence only. None of these types is an IPC or backup DTO. */
export interface ProofTarget {
  protocol: "https:" | "wss:";
  host: string;
  port: number;
  addressFamily: "ipv4" | "ipv6";
}

export interface AccountProofScope {
  accountId: string;
  platformId: CnPlatformId;
  /** Validated process/inbound/Chromium path identity, not an Electron process name alone. */
  contextId: string;
  catalogVersion: string;
  /** Set only from a reviewed main-process catalog; never from observed hosts or renderer input. */
  catalogReviewed: boolean;
  targets: readonly ProofTarget[];
}

export interface CorrelatedConnectionEvidence {
  source: "correlated-connection";
  contextId: string;
  rulesVersion: string;
  /** Result of the ordered interpreter against the running kernel's current data. */
  ruleDecision: "direct" | "proxy" | "unknown";
  /** The current anonymous probe's connection, correlated by source port and target/context. */
  connectionId: string;
  correlationVerified: boolean;
  chains: readonly string[];
  observedAtMono: number;
}

export interface TargetEvidence {
  target: ProofTarget;
  route: CorrelatedConnectionEvidence | CurrentOrderedRuleEvidence;
  egress: {
    /** The issuer must justify applicability to this exact target and transport path. */
    target: ProofTarget;
    contextId: string;
    ip: string;
    countryCode: string;
    asn: number | null;
    source: string;
    applicabilityVerified: boolean;
    observedAtMono: number;
  };
  tls: { verified: boolean; observedAtMono: number };
  dns: {
    /** A fake address without a verified mapping is explicitly insufficient. */
    status: "resolved" | "fake-ip-mapped" | "unverified";
    addressFamily: "ipv4" | "ipv6";
    observedAtMono: number;
  };
}

/** One new anonymous sampling round over the entire registered operation scope. */
export interface DirectEvidenceBatch {
  sampleId: string;
  generation: number;
  rulesVersion: string;
  contextId: string;
  catalogVersion: string;
  observedAtMono: number;
  targets: readonly TargetEvidence[];
}

export interface ProofEnvironment {
  controllerReadable: boolean;
  mode: string;
  tun: boolean;
  rulesVersion: string | null;
  generation: number;
  expiresAtMono: number;
}

export interface DirectProof {
  proofId: string;
  accountId: string;
  generation: number;
  rulesVersion: string;
  contextId: string;
  catalogVersion: string;
  scopeKey: string;
  sampleId: string;
  observedAtMono: number;
  expiresAtMono: number;
  targets: readonly ProofTarget[];
}

export interface ProofTiming {
  proofTtlMs: number;
  egressTtlMs: number;
}

/** Exact targets only: no suffix inference, IP literals, credentials, paths or unknown families. */
export function normalizeProofTarget(target: ProofTarget): ProofTarget | null {
  if (
    !target ||
    !["https:", "wss:"].includes(target.protocol) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535 ||
    !["ipv4", "ipv6"].includes(target.addressFamily) ||
    typeof target.host !== "string" ||
    /[\s/:@?#%\\]/.test(target.host)
  )
    return null;
  const host = domainToASCII(target.host.toLowerCase().replace(/\.$/, ""));
  let urlHost: string;
  try {
    urlHost = new URL(`https://${host}`).hostname;
  } catch {
    return null;
  }
  if (
    !host ||
    host.length > 253 ||
    isIP(host) ||
    urlHost !== host ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return { protocol: target.protocol, host, port: target.port, addressFamily: target.addressFamily };
}

export function proofTargetKey(target: ProofTarget): string | null {
  const normalized = normalizeProofTarget(target);
  return normalized ? JSON.stringify(normalized) : null;
}

export function proofScopeKey(scope: AccountProofScope): string | null {
  const keys = scope.targets.map(proofTargetKey);
  if (!keys.length || keys.some((key) => key === null) || new Set(keys).size !== keys.length) return null;
  return createHash("sha256")
    .update(JSON.stringify([scope.platformId, scope.contextId, scope.catalogVersion, keys.sort()]))
    .digest("hex");
}

function fresh(time: number, now: number, ttl: number): boolean {
  return Number.isFinite(time) && time >= 0 && time <= now && now - time < ttl;
}

export type EvidenceValidation =
  | { valid: false; reason: NetworkReason }
  | { valid: true; scopeKey: string; expiresAtMono: number; targets: ProofTarget[] };

/**
 * Checks trusted main-process observations, not reachability summaries. This does not collect or
 * invent evidence: correlation, catalog review and target-specific exit applicability belong to
 * the issuer and must have an independently recorded stage-2 validation.
 */
export function validateDirectEvidence(
  scope: AccountProofScope,
  batch: DirectEvidenceBatch,
  environment: ProofEnvironment,
  now: number,
  timing: ProofTiming,
): EvidenceValidation {
  const deny = (reason: NetworkReason): EvidenceValidation => ({ valid: false, reason });
  if (environment.controllerReadable !== true) return deny("CONTROLLER_UNAVAILABLE");
  if (environment.mode === "global") return deny("GLOBAL_MODE");
  if (environment.mode !== "rule") return deny("RULE_UNVERIFIABLE");
  if (
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(environment.expiresAtMono) ||
    environment.expiresAtMono <= now
  )
    return deny("PROOF_EXPIRED");
  if (
    !environment.rulesVersion ||
    batch.generation !== environment.generation ||
    batch.rulesVersion !== environment.rulesVersion
  )
    return deny("NETWORK_CHANGED");
  if (!scope.contextId || batch.contextId !== scope.contextId) return deny("CONTEXT_UNVERIFIED");
  if (
    scope.catalogReviewed !== true ||
    !scope.catalogVersion ||
    batch.catalogVersion !== scope.catalogVersion
  )
    return deny("CATALOG_UNVERIFIED");
  const scopeKey = proofScopeKey(scope);
  if (!scopeKey || batch.targets.length !== scope.targets.length) return deny("UNKNOWN_TARGET");
  if (!batch.sampleId || !fresh(batch.observedAtMono, now, timing.proofTtlMs)) return deny("PROOF_EXPIRED");
  const expected = new Set(scope.targets.map(proofTargetKey));
  const seen = new Set<string>();
  const targets: ProofTarget[] = [];
  let expiresAtMono = Math.min(environment.expiresAtMono, batch.observedAtMono + timing.proofTtlMs);
  for (const evidence of batch.targets) {
    const target = normalizeProofTarget(evidence.target);
    const key = proofTargetKey(evidence.target);
    if (!target || !key || !expected.has(key) || seen.has(key)) return deny("UNKNOWN_TARGET");
    seen.add(key);
    const route = evidence.route;
    if (route.contextId !== scope.contextId) return deny("CONTEXT_UNVERIFIED");
    if (route.rulesVersion !== environment.rulesVersion) return deny("NETWORK_CHANGED");
    if (route.source === "correlated-connection") {
      // Keep the existing connection source strict. Rule evidence cannot be relabelled as a socket.
      if ("ruleIndex" in route || "pathEvidenceId" in route || "effectiveOutboundId" in route)
        return deny("RULE_UNVERIFIABLE");
      if (route.correlationVerified !== true || !route.connectionId) return deny("CONTEXT_UNVERIFIED");
      if (route.ruleDecision === "unknown") return deny("RULE_UNVERIFIABLE");
      if (route.ruleDecision !== "direct" || route.chains.length !== 1 || route.chains[0] !== "DIRECT")
        return deny("NOT_DIRECT");
    } else if (route.source === "current-ordered-rules") {
      const result = validateLiveRuleEvidence(route, {
        target,
        contextId: scope.contextId,
        generation: environment.generation,
        rulesVersion: environment.rulesVersion,
        nowMono: now,
      });
      if (!result.valid) return deny(result.reason);
      // Unknown actual AF is an AND over all possible branches, never an IPv4 guess.
      if (
        route.possibleAddressFamilies.some(
          (addressFamily) => !expected.has(proofTargetKey({ ...target, addressFamily })),
        )
      )
        return deny("EGRESS_UNVERIFIED");
      expiresAtMono = Math.min(expiresAtMono, route.expiresAtMono);
    } else return deny("RULE_UNVERIFIABLE");
    const egress = evidence.egress;
    if (
      egress.contextId !== scope.contextId ||
      proofTargetKey(egress.target) !== key ||
      egress.applicabilityVerified !== true ||
      !egress.source ||
      isIP(egress.ip) !== (target.addressFamily === "ipv4" ? 4 : 6)
    )
      return deny("EGRESS_UNVERIFIED");
    if (egress.countryCode !== "CN") return deny("EGRESS_OUTSIDE_CN");
    if (
      evidence.tls.verified !== true ||
      !["resolved", "fake-ip-mapped"].includes(evidence.dns.status) ||
      evidence.dns.addressFamily !== target.addressFamily
    )
      return deny("EGRESS_UNVERIFIED");
    const shortSamples = [route.observedAtMono, evidence.tls.observedAtMono, evidence.dns.observedAtMono];
    if (
      shortSamples.some((at) => !fresh(at, now, timing.proofTtlMs)) ||
      !fresh(egress.observedAtMono, now, timing.egressTtlMs)
    )
      return deny("PROOF_EXPIRED");
    expiresAtMono = Math.min(
      expiresAtMono,
      ...shortSamples.map((at) => at + timing.proofTtlMs),
      egress.observedAtMono + timing.egressTtlMs,
    );
    targets.push(target);
  }
  return { valid: true, scopeKey, expiresAtMono, targets };
}
