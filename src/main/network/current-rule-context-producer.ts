import { NETWORK_TIMING } from "@shared/network";
import { validateConfigurationAssociation } from "./configuration-association";
import type { CurrentRuleContext } from "./current-rule-context";
import { normalizeProofTarget, proofScopeKey, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { PathConformanceOptions } from "./path-conformance";

export type ConservativeRuleContextInput = Parameters<
  NonNullable<PathConformanceOptions["readRuleContexts"]>
>[0];

/** An explicit interpretation policy, not an ID of a fabricated packet/DNS/process observation. */
export const UNCONFIRMED_MATCH_STAGE_POLICY = "policy:conservative-current-rule-stage-unconfirmed-v1";

const ref = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const time = (value: number) => Number.isFinite(value) && value >= 0;

function targets(values: readonly ProofTarget[]): Map<string, ProofTarget> | null {
  if (!Array.isArray(values) || !values.length || values.length > 128) return null;
  const result = new Map<string, ProofTarget>();
  for (const value of values) {
    const target = normalizeProofTarget(value);
    if (!target || target.protocol !== "https:") return null;
    const key = proofTargetKey(target)!;
    if (result.has(key)) return null;
    result.set(key, target);
  }
  return result;
}
function echo(family: ProofTarget["addressFamily"]): ProofTarget {
  return {
    protocol: "https:",
    host: family === "ipv4" ? "myip.ipip.net" : "api6.ipify.org",
    port: 443,
    addressFamily: family,
  };
}

/**
 * Current, main-only conservative matching inputs. No DNS answer becomes rule-stage DstIP;
 * no process identity, transport qualification, route, country or permit is manufactured here.
 * An early DOMAIN rule can decide this unknown stage; a preceding dependent rule stays unknown.
 */
export function createConservativeRuleContexts(
  input: ConservativeRuleContextInput,
  nowMono: number,
): readonly CurrentRuleContext[] | null {
  try {
    const signal = input.request.signal;
    if (!signal || signal.aborted || !time(nowMono)) return null;
    // Preserve only the immutable, constructed association reference across copied input contents.
    const request = { ...input.request, scope: structuredClone(input.request.scope) };
    const inputs = structuredClone(input.inputs);
    const configuration = {
      ...input.configuration,
      inputs: structuredClone(input.configuration.inputs),
      loader: input.configuration.loader ? structuredClone(input.configuration.loader) : null,
    };
    const transport = structuredClone(input.transport);
    const association = configuration.association;
    if (
      !association ||
      !configuration.loader ||
      !validateConfigurationAssociation(association, inputs, configuration.loader, nowMono) ||
      !validateConfigurationAssociation(association, configuration.inputs, configuration.loader, nowMono) ||
      !ref(request.requestId) ||
      !ref(request.scope.accountId) ||
      !ref(request.scope.contextId) ||
      !ref(request.scope.catalogVersion) ||
      !time(request.startedAtMono) ||
      request.startedAtMono > inputs.startedAtMono ||
      request.generation !== inputs.generation ||
      request.rulesVersion !== inputs.rulesVersion ||
      ![
        transport.evidenceId,
        transport.accountProfileId,
        transport.tlsProfileId,
        transport.egressProfileId,
      ].every(ref) ||
      transport.tlsFactoryId !== "clipdock-anonymous-tls-v1" ||
      transport.egressFactoryId !== "clipdock-anonymous-egress-v1" ||
      !proofScopeKey(request.scope)
    )
      return null;

    const business = targets(request.scope.targets),
      current = targets(inputs.targets),
      configured = targets(configuration.inputs.targets);
    if (
      !business ||
      !current ||
      !configured ||
      current.size !== configured.size ||
      [...current.keys()].some((key) => !configured.has(key))
    )
      return null;
    const expected = new Map(business);
    const echoes = new Set<string>();
    for (const target of business.values()) {
      const diagnostic = echo(target.addressFamily),
        key = proofTargetKey(diagnostic)!;
      expected.set(key, diagnostic);
      echoes.add(key);
    }
    if (expected.size !== current.size || [...expected.keys()].some((key) => !current.has(key))) return null;

    const expiresAtMono = Math.min(
      association.expiresAtMono,
      inputs.expiresAtMono,
      nowMono + NETWORK_TIMING.proofTtlMs,
    );
    if (!time(expiresAtMono) || expiresAtMono <= nowMono) return null;
    const sourceEvidenceIds = Object.freeze([
      ...new Set([
        association.evidenceId,
        inputs.sampleId,
        transport.evidenceId,
        UNCONFIRMED_MATCH_STAGE_POLICY,
      ]),
    ]);
    const output: CurrentRuleContext[] = [];
    for (const [key, target] of current) {
      const profiles = new Set<string>();
      if (business.has(key)) {
        profiles.add(transport.accountProfileId);
        profiles.add(transport.tlsProfileId);
      }
      if (echoes.has(key)) profiles.add(transport.egressProfileId);
      for (const transportProfileId of profiles)
        output.push(
          Object.freeze({
            source: "main-process-current-rule-context",
            target: Object.freeze({ ...target }),
            scopeContextId: request.scope.contextId,
            transportProfileId,
            inputSampleId: inputs.sampleId,
            configurationEvidenceId: association.evidenceId,
            generation: inputs.generation,
            rulesVersion: inputs.rulesVersion,
            kernelEpoch: inputs.ownerAfter.kernelEpoch,
            network: "tcp",
            destinations: Object.freeze([Object.freeze({ stage: "unknown" as const })]),
            sourceEvidenceIds,
            checkedAtMono: nowMono,
            expiresAtMono,
          }),
        );
    }
    return signal.aborted ? null : Object.freeze(output);
  } catch {
    return null;
  }
}
