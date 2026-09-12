import type { ProofTarget } from "./direct-proof";
import { proofTargetKey } from "./direct-proof";
import type { LiveRulesSnapshot } from "./live-rule-evidence";
import type { CurrentPathInputs } from "./path-input-reader";
import {
  evaluateCurrentRuleContext,
  type CurrentRuleConfiguration,
  type CurrentRuleContext,
  type CurrentRuleContextResult,
} from "./current-rule-context";

/** Same-round matching inputs shared by Source, path checking and final rule recomputation. */
export interface CurrentRuleContextSet {
  readonly configuration: Omit<CurrentRuleConfiguration, "inputs">;
  readonly contexts: readonly CurrentRuleContext[];
}

/** Contents are copied; the original immutable, branded association stays a main-process reference. */
export function cloneRuleContextSet(value: CurrentRuleContextSet): CurrentRuleContextSet {
  return {
    ...structuredClone(value),
    configuration: {
      ...structuredClone(value.configuration),
      association: value.configuration.association,
    },
  };
}

export function evaluateRuleContextSet(
  set: CurrentRuleContextSet,
  inputs: CurrentPathInputs,
  snapshot: LiveRulesSnapshot,
  target: ProofTarget,
  scopeContextId: string,
  transportProfileId: string,
  expectedNetwork: "tcp" | "udp",
  nowMono: number,
): CurrentRuleContextResult {
  const valid = set && Array.isArray(set.contexts) && set.contexts.length > 0 && set.contexts.length <= 768;
  const contexts = valid
    ? set.contexts.filter(
        (item) =>
          item &&
          proofTargetKey(item.target) === proofTargetKey(target) &&
          item.scopeContextId === scopeContextId &&
          item.transportProfileId === transportProfileId,
      )
    : [];
  return evaluateCurrentRuleContext(
    {
      snapshot,
      target,
      scopeContextId,
      transportProfileId,
      configuration: valid && set.configuration ? { ...set.configuration, inputs } : null,
      // Check after exact selection: filtering by network would conceal duplicate/conflicting records.
      context:
        contexts.length === 1 &&
        ["tcp", "udp"].includes(expectedNetwork) &&
        contexts[0].network === expectedNetwork
          ? contexts[0]
          : null,
    },
    nowMono,
  );
}
