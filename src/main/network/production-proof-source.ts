import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NETWORK_TIMING, type NetworkReason } from "@shared/network";
import {
  ANONYMOUS_EGRESS_FACTORY_ID,
  type AnonymousEgressObservation,
  type AnonymousEgressProbe,
  type AnonymousEgressProvider,
} from "./anonymous-egress-probe";
import {
  ANONYMOUS_TLS_FACTORY_ID,
  type AnonymousProofProbe,
  type AnonymousTlsObservation,
} from "./anonymous-proof-probe";
import type { ClashReadResult } from "./clash-reader";
import {
  normalizeProofTarget,
  proofScopeKey,
  proofTargetKey,
  type ProofTarget,
  type TargetEvidence,
} from "./direct-proof";
import {
  createLiveRuleEvidence,
  type LiveOutboundPolicy,
  type LiveRulesSnapshot,
  type ValidatedRulePath,
} from "./live-rule-evidence";
import type { CurrentPathInputs, PathInputReader } from "./path-input-reader";
import type {
  ProofCollectionRequest,
  ProofCollectionResult,
  ProofEvidenceSource,
  ProofScopeVersion,
} from "./proof-issuer";
import { evaluateRules } from "./rules";
import { cloneRuleContextSet, evaluateRuleContextSet, type CurrentRuleContextSet } from "./rule-context-set";
import {
  verifyRouteApplicability,
  type RouteConformanceRecord,
  type CurrentPhysicalRouteProjection,
  type ValidatedRouteApplicability,
} from "./route-applicability";

/** An actual current DNS/path match produced from reviewed resolver conformance, never a UI flag. */
export interface CurrentDnsPathMatch {
  source: "current-dns-path-match";
  evidenceId: string;
  inputSampleId: string;
  target: ProofTarget;
  dnsPolicyEvidenceId: string;
  status: "resolved" | "fake-ip-mapped";
  candidateAddresses: readonly string[];
  resolvedAddresses: readonly string[];
  observedAtMono: number;
  expiresAtMono: number;
}

/**
 * Main-only verifier records. The producer must retain the original acceptance artifacts and
 * revalidate their applicability against inputs; changing these strings cannot create conformance.
 */
export interface ScopePathConformance {
  source: "current-scope-path-conformance";
  evidenceId: string;
  inputSampleId: string;
  accountContextId: string;
  generation: number;
  rulesVersion: string;
  kernelEpoch: string;
  fileFingerprint: string;
  effectivePathPolicyVersion: string;
  osNetworkHash: string;
  /** Current applicability check, distinct from the original route qualification sample times. */
  checkedAtMono: number;
  expiresAtMono: number;
  transport: {
    evidenceId: string;
    accountProfileId: string;
    tlsFactoryId: typeof ANONYMOUS_TLS_FACTORY_ID;
    tlsProfileId: string;
    egressFactoryId: typeof ANONYMOUS_EGRESS_FACTORY_ID;
    egressProfileId: string;
  };
  families: readonly {
    origin: Pick<ProofTarget, "protocol" | "host" | "port">;
    possibleAddressFamilies: readonly ProofTarget["addressFamily"][];
    constraintEvidenceId: string | null;
  }[];
  dns: readonly CurrentDnsPathMatch[];
  routes: readonly RouteConformanceRecord[];
  physicalRouteProjections: readonly CurrentPhysicalRouteProjection[];
  /** When supplied, every rule-dependent branch must use this same current input set; no legacy fallback. */
  ruleContexts?: CurrentRuleContextSet;
}

export function cloneScopePathConformance(value: ScopePathConformance): ScopePathConformance {
  return {
    ...structuredClone(value),
    ...(value.ruleContexts === undefined ? {} : { ruleContexts: cloneRuleContextSet(value.ruleContexts) }),
  };
}

export interface ProductionProofSourceOptions {
  inputs: Pick<PathInputReader, "read">;
  readController(signal: AbortSignal): Promise<ClashReadResult>;
  readVersion(): ProofScopeVersion | null;
  /** No default implementation: a configuration candidate is insufficient to fabricate these records. */
  conformance: {
    read(request: ProofCollectionRequest, inputs: CurrentPathInputs): Promise<ScopePathConformance | null>;
    /** Match original diagnostic paths and revalidate current applicability; never relabel an old sample. */
    bindSamples(input: {
      request: ProofCollectionRequest;
      inputs: CurrentPathInputs;
      conformance: ScopePathConformance;
      routes: readonly ValidatedRouteApplicability[];
      samples: readonly DiagnosticSampleInput[];
    }): Promise<readonly DiagnosticSamplePathBinding[] | null>;
  };
  tls: Pick<AnonymousProofProbe, "probeTls">;
  egress: Pick<AnonymousEgressProbe, "probe">;
  now?: () => number;
  maxConcurrent?: number;
}

export interface DiagnosticSampleInput {
  kind: "tls" | "egress";
  observation: AnonymousTlsObservation | AnonymousEgressObservation;
  previousBinding: DiagnosticSamplePathBinding | null;
}
export interface DiagnosticSamplePathBinding {
  source: "current-diagnostic-path-binding";
  evidenceId: string;
  observationDigest: string;
  factoryId: string;
  diagnosticContextId: string;
  origin: { host: string; port: number };
  originalStartedAtMono: number;
  originalObservedAtMono: number;
  originalPath: {
    evidenceId: string;
    sourceEvidenceIds: readonly string[];
    /** Actual physical socket family, if observed; never inferred from the IP in a response body. */
    observedPhysicalFamily: ProofTarget["addressFamily"] | null;
  };
  inputSampleId: string;
  conformanceEvidenceId: string;
  checkedAtMono: number;
  expiresAtMono: number;
  coverage: readonly {
    target: ProofTarget;
    physicalRouteClass: string;
    routeApplicabilityEvidenceId: string;
    accountTransportProfileId: string;
    basis: "observed-current-connection" | "validated-path-constraint" | "reviewed-path-equivalence";
    /** Retained constraint/equivalence qualification plus this round's dependency match records. */
    sourceEvidenceIds: readonly string[];
  }[];
}
export function diagnosticObservationDigest(
  value: AnonymousTlsObservation | AnonymousEgressObservation,
): string {
  return digest(value);
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const originKey = (value: Pick<ProofTarget, "protocol" | "host" | "port">) =>
  `${value.protocol}//${value.host}:${value.port}`;
const targetKey = (target: ProofTarget): string => {
  const key = proofTargetKey(target);
  if (!key) fail("UNKNOWN_TARGET");
  return key;
};
const validRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const setKey = (values: readonly string[]) => JSON.stringify([...values].sort());
const echoFor = (
  family: ProofTarget["addressFamily"],
): { provider: AnonymousEgressProvider; target: ProofTarget } => ({
  provider: family === "ipv4" ? "ipip" : "ipify-ipv6",
  target: {
    protocol: "https:",
    host: family === "ipv4" ? "myip.ipip.net" : "api6.ipify.org",
    port: 443,
    addressFamily: family,
  },
});
class SourceError extends Error {
  constructor(readonly reason: NetworkReason) {
    super(reason);
  }
}
function fail(reason: NetworkReason): never {
  throw new SourceError(reason);
}

/** Real builtin DIRECT metadata identity, shared with a trusted conformance-record producer. */
export function currentDirectOutbound(
  inputs: CurrentPathInputs,
  controller: ClashReadResult,
): LiveOutboundPolicy {
  const policy = controller.directPolicy;
  if (!policy || policy.policyFingerprint !== inputs.configurationAfter.currentDirectPolicy.policyFingerprint)
    fail("RULE_UNVERIFIABLE");
  return {
    name: "DIRECT",
    id: digest([inputs.ownerAfter.kernelEpoch, "DIRECT", policy.policyFingerprint]),
    kind: policy.kind,
    dialer: policy.dialer,
    policyVersion: policy.policyFingerprint,
    kernelEpoch: inputs.ownerAfter.kernelEpoch,
    generation: inputs.generation,
    rulesVersion: inputs.rulesVersion,
    observedAtMono: policy.completedAtMono,
  };
}

/**
 * Combines current readers and independently reviewed path facts into the existing Gate batch.
 * Does not own accounts, business Sessions, configuration writes, UI approvals or enforcement mode.
 */
export class ProductionProofSource implements ProofEvidenceSource {
  private readonly now: () => number;
  private readonly limit: number;
  private readonly active = new Set<AbortController>();
  private readonly egressCache = new Map<
    string,
    { observation: AnonymousEgressObservation; binding: DiagnosticSamplePathBinding }
  >();
  private epoch = 0;
  private disposed = false;

  constructor(private readonly options: ProductionProofSourceOptions) {
    this.now = options.now ?? (() => performance.now());
    this.limit = options.maxConcurrent ?? 2;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 4)
      throw Error("PROOF_SOURCE_OPTIONS_INVALID");
  }

  invalidate(): void {
    this.epoch++;
    this.egressCache.clear();
    for (const flight of this.active) flight.abort();
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  async collect(request: ProofCollectionRequest): Promise<ProofCollectionResult> {
    const callerSignal = request.signal;
    if (this.disposed || callerSignal.aborted) return { kind: "unavailable", reason: "GATE_REVOKED" };
    if (this.active.size >= this.limit) return { kind: "unavailable", reason: "EGRESS_UNVERIFIED" };
    const controller = new AbortController(),
      epoch = this.epoch;
    const abort = () => controller.abort();
    callerSignal.addEventListener("abort", abort, { once: true });
    if (callerSignal.aborted) abort();
    this.active.add(controller);
    try {
      const internalRequest = {
        ...request,
        scope: structuredClone(request.scope),
        signal: controller.signal,
      };
      const result = await this.collectOnce(internalRequest, epoch);
      // Revocation may run between the inner and outer async continuations.
      if (this.disposed || controller.signal.aborted || epoch !== this.epoch) fail("GATE_REVOKED");
      const version = this.options.readVersion();
      if (
        !version ||
        version.generation !== internalRequest.generation ||
        version.rulesVersion !== internalRequest.rulesVersion
      )
        fail("NETWORK_CHANGED");
      return result;
    } catch (error) {
      return {
        kind: "unavailable",
        reason:
          error instanceof SourceError
            ? error.reason
            : controller.signal.aborted
              ? "GATE_REVOKED"
              : "EGRESS_UNVERIFIED",
      };
    } finally {
      controller.abort();
      callerSignal.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }

  private async collectOnce(request: ProofCollectionRequest, epoch: number): Promise<ProofCollectionResult> {
    const check = () => {
      if (this.disposed || request.signal.aborted || epoch !== this.epoch) fail("GATE_REVOKED");
      const version = this.options.readVersion();
      if (
        !version ||
        version.generation !== request.generation ||
        version.rulesVersion !== request.rulesVersion
      )
        fail("NETWORK_CHANGED");
    };
    check();
    if (request.scope.catalogReviewed !== true) fail("CATALOG_UNVERIFIED");
    if (
      !validRef(request.requestId) ||
      !proofScopeKey(request.scope) ||
      request.scope.targets.length > 64 ||
      !Number.isFinite(request.startedAtMono) ||
      request.startedAtMono > this.now()
    )
      fail("UNKNOWN_TARGET");
    // This first source supports reviewed HTTPS/TCP operations. WSS remains explicitly unsupported.
    if (request.scope.targets.some((target) => target.protocol !== "https:")) fail("CONTEXT_UNVERIFIED");
    const scope = structuredClone(request.scope);
    const targets = scope.targets.map((target) => normalizeProofTarget(target)!);
    const families = [...new Set(targets.map((target) => target.addressFamily))];
    const echoes = families.map(echoFor);
    const required = [
      ...new Map(
        [...targets, ...echoes.map((item) => item.target)].map((target) => [targetKey(target), target]),
      ).values(),
    ];
    const readController = async () => {
      check();
      const floor = this.now();
      const value = await this.options.readController(request.signal);
      check();
      if (value.mode === "global") fail("GLOBAL_MODE");
      if (value.mode !== "rule") fail("RULE_UNVERIFIABLE");
      if (value.fingerprint !== request.rulesVersion) fail("NETWORK_CHANGED");
      if (
        !Number.isFinite(value.startedAtMono) ||
        !Number.isFinite(value.completedAtMono) ||
        value.startedAtMono! < floor ||
        value.completedAtMono! < value.startedAtMono! ||
        value.completedAtMono! > this.now()
      )
        fail("PROOF_EXPIRED");
      if (
        !value.directPolicy ||
        value.directPolicy.kind === "unknown" ||
        value.directPolicy.dialer === "unknown"
      )
        fail("RULE_UNVERIFIABLE");
      if (value.directPolicy.kind !== "direct" || value.directPolicy.dialer !== "none") fail("NOT_DIRECT");
      for (const target of required) {
        const result = evaluateRules(value.mode, value.rules, {
          host: target.host,
          port: target.port,
          network: "tcp",
        });
        // Destination/process-dependent rules need this round's configuration and
        // path context. Read-only inputs may proceed; HTTP probes remain behind
        // the complete rule/path checks below. Definite non-DIRECT still stops here.
        if (result.route === "unknown") continue;
        // This source reads the builtin's metadata only. An uninspected alias is not asserted to be a proxy.
        if (result.ruleIndex === null || value.rules[result.ruleIndex].proxy !== "DIRECT")
          fail("RULE_UNVERIFIABLE");
      }
      return structuredClone(value);
    };
    const firstController = await readController();
    const inputResult = await this.options.inputs.read(
      {
        generation: request.generation,
        rulesVersion: request.rulesVersion,
        targets: structuredClone(required),
      },
      request.signal,
    );
    check();
    if (inputResult.state !== "observed")
      fail(
        inputResult.reason === "INPUT_EXPIRED"
          ? "PROOF_EXPIRED"
          : inputResult.reason === "NETWORK_CHANGED"
            ? "NETWORK_CHANGED"
            : "EGRESS_UNVERIFIED",
      );
    const inputs = structuredClone(inputResult);
    if (
      inputs.startedAtMono < request.startedAtMono ||
      inputs.generation !== request.generation ||
      inputs.rulesVersion !== request.rulesVersion ||
      setKey(inputs.targets.map(targetKey)) !== setKey(required.map(targetKey))
    )
      fail("NETWORK_CHANGED");
    const record = await this.options.conformance.read(
      { ...request, scope: structuredClone(scope) },
      structuredClone(inputs),
    );
    check();
    if (!record) fail("CONTEXT_UNVERIFIED");
    const conformance = cloneScopePathConformance(record);
    this.checkConformance(request, inputs, conformance);
    const firstOutbound = currentDirectOutbound(inputs, firstController);
    const snapshot = (value: ClashReadResult): LiveRulesSnapshot => ({
      mode: value.mode,
      generation: request.generation,
      rulesVersion: value.fingerprint,
      kernelEpoch: inputs.ownerAfter.kernelEpoch,
      rules: value.rules,
      observedAtMono: value.completedAtMono!,
    });
    const checkScopedRules = (value: ClashReadResult): number => {
      const set = conformance.ruleContexts;
      if (set === undefined) return Infinity;
      let expiresAtMono = Infinity;
      for (const target of required) {
        const profiles = new Set<string>();
        if (targets.some((item) => targetKey(item) === targetKey(target))) {
          profiles.add(conformance.transport.accountProfileId);
          profiles.add(conformance.transport.tlsProfileId);
        }
        if (echoes.some((item) => targetKey(item.target) === targetKey(target)))
          profiles.add(conformance.transport.egressProfileId);
        for (const profile of profiles) {
          const decision = evaluateRuleContextSet(
            set,
            inputs,
            snapshot(value),
            target,
            scope.contextId,
            profile,
            "tcp",
            this.now(),
          );
          if (decision.route === "unknown") fail(decision.reason);
          if (decision.matchedPolicy !== firstOutbound.name) fail("NOT_DIRECT");
          if (decision.expiresAtMono === null || decision.expiresAtMono <= this.now()) fail("PROOF_EXPIRED");
          expiresAtMono = Math.min(expiresAtMono, decision.expiresAtMono);
        }
      }
      return expiresAtMono;
    };
    let ruleContextsExpireAt = checkScopedRules(firstController);
    const routes = new Map<string, ValidatedRouteApplicability>();
    for (const target of targets) {
      const echo = echoFor(target.addressFamily).target;
      const candidates = conformance.routes.filter(
        (item) => item.binding.addressFamily === target.addressFamily,
      );
      if (candidates.length !== 1) fail("CONTEXT_UNVERIFIED");
      const result = verifyRouteApplicability(
        {
          inputs,
          target,
          echo,
          outbound: firstOutbound,
          snapshot: snapshot(firstController),
          targetTransportProfileId: conformance.transport.accountProfileId,
          echoTransportProfileId: conformance.transport.egressProfileId,
          conformance: candidates[0],
          physicalRouteProjections: conformance.physicalRouteProjections,
          ruleContexts: conformance.ruleContexts,
          scopeContextId: scope.contextId,
        },
        this.now(),
      );
      if (!result.valid)
        fail(
          result.reason === "INPUT_EXPIRED"
            ? "PROOF_EXPIRED"
            : result.reason === "NETWORK_CHANGED" ||
                result.reason === "RULE_UNVERIFIABLE" ||
                result.reason === "NOT_DIRECT"
              ? result.reason
              : "CONTEXT_UNVERIFIED",
        );
      routes.set(targetKey(target), result.evidence);
    }
    check();
    const egress = new Map<ProofTarget["addressFamily"], AnonymousEgressObservation>();
    const samples: DiagnosticSampleInput[] = [];
    const egressKeys = new Map<string, string>();
    for (const { provider, target: echo } of echoes) {
      const selected = targets.filter((target) => target.addressFamily === echo.addressFamily);
      const classes = new Set(selected.map((target) => routes.get(targetKey(target))!.physicalRouteClass));
      if (classes.size !== 1) fail("EGRESS_UNVERIFIED");
      const key = digest([
        request.generation,
        request.rulesVersion,
        inputs.ownerAfter.kernelEpoch,
        inputs.networkAfter.hash,
        firstOutbound.id,
        echo.addressFamily,
        [...classes][0],
        conformance.transport.egressProfileId,
      ]);
      const previous = this.egressCache.get(key);
      let observation = previous?.observation;
      let previousBinding = previous?.binding ?? null;
      if (!observation || this.now() - observation.observedAtMono >= NETWORK_TIMING.egressRefreshMs) {
        const floor = this.now();
        const result = await this.options.egress.probe(provider, request.signal);
        check();
        if (!result.available) fail("EGRESS_UNVERIFIED");
        observation = structuredClone(result.observation);
        if (!Number.isFinite(observation.startedAtMono) || observation.startedAtMono < floor)
          fail("PROOF_EXPIRED");
        previousBinding = null;
      }
      this.checkEgress(observation, echo, request);
      samples.push({ kind: "egress", observation, previousBinding });
      egressKeys.set(diagnosticObservationDigest(observation), key);
      egress.set(echo.addressFamily, observation);
    }
    const tls = new Map<string, AnonymousTlsObservation>();
    // Per-origin coalescing, finite sequential work; actual samplers own their bounded Session pools.
    for (const target of targets) {
      const key = originKey(target);
      if (tls.has(key)) continue;
      const floor = this.now(),
        result = await this.options.tls.probeTls({ host: target.host, port: target.port }, request.signal);
      check();
      if (!result.available) fail("EGRESS_UNVERIFIED");
      const observation = structuredClone(result.observation);
      if (
        observation.factoryId !== ANONYMOUS_TLS_FACTORY_ID ||
        !validRef(observation.transportContextId) ||
        observation.origin.host !== target.host ||
        observation.origin.port !== target.port ||
        observation.credentials !== "omit" ||
        observation.certificateValidation !== "chromium-default" ||
        observation.responseFromCache !== false ||
        ![observation.statusCode, observation.startedAtMono, observation.completedAtMono].every(
          Number.isFinite,
        ) ||
        observation.statusCode < 200 ||
        observation.statusCode >= 500 ||
        (observation.statusCode >= 300 && observation.statusCode < 400) ||
        observation.startedAtMono < floor ||
        observation.completedAtMono < observation.startedAtMono ||
        observation.completedAtMono > this.now()
      )
        fail("CONTEXT_UNVERIFIED");
      tls.set(key, observation);
      samples.push({ kind: "tls", observation, previousBinding: null });
    }
    const lastController = await readController();
    check();
    const outbound = currentDirectOutbound(inputs, lastController);
    if (outbound.id !== firstOutbound.id) fail("NETWORK_CHANGED");
    ruleContextsExpireAt = Math.min(ruleContextsExpireAt, checkScopedRules(lastController));
    this.checkConformance(request, inputs, conformance);
    const bindingFloor = this.now();
    const bindings = await this.options.conformance.bindSamples({
      request: { ...request, scope: structuredClone(scope) },
      inputs: structuredClone(inputs),
      conformance: cloneScopePathConformance(conformance),
      routes: Object.freeze([...routes.values()]),
      samples: structuredClone(samples),
    });
    check();
    // bindSamples can await past a TLS/egress context deadline. Recheck the original copied set,
    // not a newly issued context from the provider, before accepting bindings or caching evidence.
    ruleContextsExpireAt = Math.min(ruleContextsExpireAt, checkScopedRules(lastController));
    if (!bindings || bindings.length !== samples.length) fail("CONTEXT_UNVERIFIED");
    const sampleBindings = this.checkSampleBindings(
      samples,
      bindings,
      inputs,
      conformance,
      routes,
      bindingFloor,
    );
    this.checkConformance(request, inputs, conformance);
    const evidence: TargetEvidence[] = targets.map((target) => {
      const key = targetKey(target),
        route = routes.get(key)!,
        echo = egress.get(target.addressFamily)!,
        targetTls = tls.get(originKey(target))!,
        dns = this.dnsMatch(target, inputs, conformance);
      const family = conformance.families.find((item) => originKey(item.origin) === originKey(target))!;
      const path: ValidatedRulePath = {
        source: "validated-path-profile",
        evidenceId: digest([
          route.evidenceId,
          conformance.evidenceId,
          targetTls.transportContextId,
          echo.transportContextId,
          dns.evidenceId,
          sampleBindings.get(diagnosticObservationDigest(targetTls))!.evidenceId,
          sampleBindings.get(diagnosticObservationDigest(echo))!.evidenceId,
        ]),
        target,
        contextId: scope.contextId,
        kernelEpoch: inputs.ownerAfter.kernelEpoch,
        generation: request.generation,
        rulesVersion: request.rulesVersion,
        outboundId: outbound.id,
        outboundPolicyVersion: outbound.policyVersion,
        effectivePathPolicyVersion: conformance.effectivePathPolicyVersion,
        physicalRouteClass: route.physicalRouteClass,
        transportCompatibilityEvidenceId: conformance.transport.evidenceId,
        dnsPolicyEvidenceId: dns.dnsPolicyEvidenceId,
        network: "tcp",
        possibleAddressFamilies: family.possibleAddressFamilies,
        familyConstraintEvidenceId: family.constraintEvidenceId,
        observedAtMono: conformance.checkedAtMono,
        expiresAtMono: Math.min(
          ruleContextsExpireAt,
          conformance.expiresAtMono,
          route.expiresAtMono,
          dns.expiresAtMono,
          inputs.expiresAtMono,
          sampleBindings.get(diagnosticObservationDigest(targetTls))!.expiresAtMono,
          sampleBindings.get(diagnosticObservationDigest(echo))!.expiresAtMono,
        ),
      };
      const result = createLiveRuleEvidence(
        {
          target,
          contextId: scope.contextId,
          snapshot: snapshot(lastController),
          outbound,
          path,
          ...(conformance.ruleContexts === undefined
            ? {}
            : {
                ruleContexts: {
                  inputs,
                  set: conformance.ruleContexts,
                  transportProfileId: conformance.transport.accountProfileId,
                },
              }),
        },
        this.now(),
      );
      if (!result.valid) fail(result.reason);
      if (
        this.now() - targetTls.completedAtMono >= NETWORK_TIMING.proofTtlMs ||
        dns.expiresAtMono <= this.now()
      )
        fail("PROOF_EXPIRED");
      return {
        target,
        route: result.evidence,
        egress: {
          target,
          contextId: scope.contextId,
          ip: echo.ip,
          countryCode: echo.countryCode,
          asn: echo.asn,
          source: `${echo.factoryId}:${echo.source}:${route.evidenceId}`,
          applicabilityVerified: true,
          observedAtMono: echo.observedAtMono,
        },
        tls: { verified: true, observedAtMono: targetTls.completedAtMono },
        dns: { status: dns.status, addressFamily: target.addressFamily, observedAtMono: dns.observedAtMono },
      };
    });
    check();
    if (ruleContextsExpireAt <= this.now()) fail("PROOF_EXPIRED");
    for (const sample of samples) {
      if (sample.kind !== "egress") continue;
      const hash = diagnosticObservationDigest(sample.observation),
        key = egressKeys.get(hash)!;
      if (this.egressCache.size >= 64) this.egressCache.delete(this.egressCache.keys().next().value!);
      this.egressCache.set(key, {
        observation: structuredClone(sample.observation as AnonymousEgressObservation),
        binding: sampleBindings.get(hash)!,
      });
    }
    return {
      kind: "evidence",
      requestId: request.requestId,
      batch: {
        sampleId: request.requestId,
        generation: request.generation,
        rulesVersion: request.rulesVersion,
        contextId: scope.contextId,
        catalogVersion: scope.catalogVersion,
        observedAtMono: Math.min(
          ...evidence.flatMap((item) => [
            item.route.observedAtMono,
            item.tls.observedAtMono,
            item.dns.observedAtMono,
          ]),
        ),
        targets: evidence,
      },
    };
  }

  private checkSampleBindings(
    samples: readonly DiagnosticSampleInput[],
    bindings: readonly DiagnosticSamplePathBinding[],
    inputs: CurrentPathInputs,
    conformance: ScopePathConformance,
    routes: ReadonlyMap<string, ValidatedRouteApplicability>,
    floor: number,
  ): Map<string, DiagnosticSamplePathBinding> {
    const output = new Map<string, DiagnosticSamplePathBinding>();
    const refs = (values: readonly string[]) =>
      Array.isArray(values) &&
      values.length > 0 &&
      values.length <= 64 &&
      values.every(validRef) &&
      new Set(values).size === values.length;
    for (const sample of samples) {
      const observation = sample.observation,
        hash = diagnosticObservationDigest(observation);
      const matching = bindings.filter((binding) => binding.observationDigest === hash);
      if (matching.length !== 1 || output.has(hash)) fail("CONTEXT_UNVERIFIED");
      const binding = structuredClone(matching[0]);
      const origin = "echo" in observation ? observation.echo.origin : observation.origin;
      const at = "observedAtMono" in observation ? observation.observedAtMono : observation.completedAtMono;
      if (
        binding.source !== "current-diagnostic-path-binding" ||
        !validRef(binding.evidenceId) ||
        binding.factoryId !== observation.factoryId ||
        binding.diagnosticContextId !== observation.transportContextId ||
        binding.origin.host !== origin.host ||
        binding.origin.port !== origin.port ||
        binding.originalStartedAtMono !== observation.startedAtMono ||
        binding.originalObservedAtMono !== at ||
        !validRef(binding.originalPath.evidenceId) ||
        !refs(binding.originalPath.sourceEvidenceIds) ||
        ![null, "ipv4", "ipv6"].includes(binding.originalPath.observedPhysicalFamily) ||
        binding.inputSampleId !== inputs.sampleId ||
        binding.conformanceEvidenceId !== conformance.evidenceId
      )
        fail("CONTEXT_UNVERIFIED");
      if (
        ![binding.checkedAtMono, binding.expiresAtMono].every(Number.isFinite) ||
        binding.checkedAtMono < floor ||
        binding.checkedAtMono > this.now() ||
        binding.expiresAtMono <= this.now()
      )
        fail("PROOF_EXPIRED");
      // A cached sample's original path cannot be replaced with a newly invented path record.
      if (
        sample.previousBinding &&
        digest(binding.originalPath) !== digest(sample.previousBinding.originalPath)
      )
        fail("CONTEXT_UNVERIFIED");
      const expected = [...routes.values()].filter((route) =>
        sample.kind === "egress"
          ? route.echo.host === origin.host && route.echo.port === origin.port
          : route.target.host === origin.host && route.target.port === origin.port,
      );
      if (
        !expected.length ||
        binding.coverage.length !== expected.length ||
        new Set(binding.coverage.map((item) => targetKey(item.target))).size !== expected.length
      )
        fail("CONTEXT_UNVERIFIED");
      if (
        sample.kind === "egress" &&
        binding.originalPath.observedPhysicalFamily !== null &&
        binding.originalPath.observedPhysicalFamily !==
          (observation as AnonymousEgressObservation).reportedAddressFamily
      )
        fail("EGRESS_UNVERIFIED");
      for (const route of expected) {
        const coverage = binding.coverage.find((item) => targetKey(item.target) === targetKey(route.target));
        if (
          !coverage ||
          coverage.physicalRouteClass !== route.physicalRouteClass ||
          coverage.routeApplicabilityEvidenceId !== route.evidenceId ||
          coverage.accountTransportProfileId !== conformance.transport.accountProfileId ||
          !refs(coverage.sourceEvidenceIds) ||
          !["observed-current-connection", "validated-path-constraint", "reviewed-path-equivalence"].includes(
            coverage.basis,
          )
        )
          fail("CONTEXT_UNVERIFIED");
        if (
          coverage.basis === "observed-current-connection" &&
          binding.originalPath.observedPhysicalFamily !== route.target.addressFamily
        )
          fail("EGRESS_UNVERIFIED");
        if (
          binding.expiresAtMono >
          Math.min(inputs.expiresAtMono, conformance.expiresAtMono, route.expiresAtMono)
        )
          fail("PROOF_EXPIRED");
      }
      output.set(hash, binding);
    }
    return output;
  }

  private checkConformance(
    request: ProofCollectionRequest,
    inputs: CurrentPathInputs,
    record: ScopePathConformance,
  ): void {
    if (
      record.source !== "current-scope-path-conformance" ||
      !validRef(record.evidenceId) ||
      record.inputSampleId !== inputs.sampleId ||
      record.accountContextId !== request.scope.contextId ||
      record.generation !== request.generation ||
      record.rulesVersion !== request.rulesVersion ||
      record.kernelEpoch !== inputs.ownerAfter.kernelEpoch ||
      record.fileFingerprint !== inputs.configurationAfter.fileFingerprint ||
      record.osNetworkHash !== inputs.networkAfter.hash ||
      record.effectivePathPolicyVersion !== inputs.configurationAfter.policy.fingerprint
    )
      fail("CONTEXT_UNVERIFIED");
    if (
      !Number.isFinite(record.checkedAtMono) ||
      record.checkedAtMono < inputs.completedAtMono ||
      record.checkedAtMono > this.now() ||
      !Number.isFinite(record.expiresAtMono) ||
      record.expiresAtMono <= this.now() ||
      inputs.expiresAtMono <= this.now()
    )
      fail("PROOF_EXPIRED");
    const transport = record.transport;
    if (
      ![
        transport.evidenceId,
        transport.accountProfileId,
        transport.tlsProfileId,
        transport.egressProfileId,
      ].every(validRef) ||
      transport.tlsFactoryId !== ANONYMOUS_TLS_FACTORY_ID ||
      transport.egressFactoryId !== ANONYMOUS_EGRESS_FACTORY_ID
    )
      fail("CONTEXT_UNVERIFIED");
    const origins = [...new Set(request.scope.targets.map(originKey))];
    if (
      record.families.length !== origins.length ||
      new Set(record.families.map((item) => originKey(item.origin))).size !== origins.length
    )
      fail("EGRESS_UNVERIFIED");
    for (const origin of origins) {
      const item = record.families.find((entry) => originKey(entry.origin) === origin);
      if (
        !item ||
        item.possibleAddressFamilies.length < 1 ||
        item.possibleAddressFamilies.length > 2 ||
        new Set(item.possibleAddressFamilies).size !== item.possibleAddressFamilies.length ||
        setKey(item.possibleAddressFamilies) !==
          setKey(
            request.scope.targets
              .filter((target) => originKey(target) === origin)
              .map((target) => target.addressFamily),
          ) ||
        (item.possibleAddressFamilies.length === 1 && !validRef(item.constraintEvidenceId))
      )
        fail("EGRESS_UNVERIFIED");
    }
  }

  private dnsMatch(
    target: ProofTarget,
    inputs: CurrentPathInputs,
    record: ScopePathConformance,
  ): CurrentDnsPathMatch {
    const matches = record.dns.filter((item) => proofTargetKey(item.target) === targetKey(target));
    const host = inputs.dnsAfter.hosts.find((item) => item.host === target.host);
    const query = host?.queries.find(
      (item) => item.type === (target.addressFamily === "ipv4" ? "A" : "AAAA"),
    );
    if (
      matches.length !== 1 ||
      !host ||
      !query?.response ||
      query.error ||
      query.response.status !== 0 ||
      query.response.truncated
    )
      fail("EGRESS_UNVERIFIED");
    const match = matches[0],
      addresses = host.addresses
        .filter((item) => item.addressFamily === target.addressFamily)
        .map((item) => item.address);
    if (
      match.source !== "current-dns-path-match" ||
      !validRef(match.evidenceId) ||
      !validRef(match.dnsPolicyEvidenceId) ||
      match.inputSampleId !== inputs.sampleId ||
      !["resolved", "fake-ip-mapped"].includes(match.status) ||
      !addresses.length ||
      setKey(addresses) !== setKey(match.candidateAddresses) ||
      !match.resolvedAddresses.length ||
      match.resolvedAddresses.some((ip) => isIP(ip) !== (target.addressFamily === "ipv4" ? 4 : 6)) ||
      (match.status === "resolved" && setKey(match.candidateAddresses) !== setKey(match.resolvedAddresses))
    )
      fail("EGRESS_UNVERIFIED");
    const answerDeadline = Math.min(
      ...host.answers.filter((item) => item.queryType === query.type).map((item) => item.expiresAtMono),
    );
    // The DNS record must agree with the physical destinations actually used by the route verifier.
    const destinations = host.addresses
      .filter((item) => item.addressFamily === target.addressFamily)
      .map((address) => {
        const mapped = record.physicalRouteProjections.filter(
          (item) =>
            item.host === target.host &&
            item.candidateAddress === address.address &&
            item.binding.addressFamily === target.addressFamily,
        );
        if (mapped.length > 1 || (!mapped.length && address.addressClass !== "real"))
          fail("EGRESS_UNVERIFIED");
        return mapped.length ? mapped[0].resolvedAddress : address.address;
      });
    if (setKey([...new Set(destinations)]) !== setKey(match.resolvedAddresses)) fail("EGRESS_UNVERIFIED");
    if (
      match.observedAtMono !== query.startedAtMono ||
      !Number.isFinite(answerDeadline) ||
      !Number.isFinite(match.expiresAtMono) ||
      match.expiresAtMono > answerDeadline ||
      match.expiresAtMono <= this.now()
    )
      fail("PROOF_EXPIRED");
    return match;
  }

  private checkEgress(
    observation: AnonymousEgressObservation,
    echo: ProofTarget,
    request: ProofCollectionRequest,
  ): void {
    if (
      observation.factoryId !== ANONYMOUS_EGRESS_FACTORY_ID ||
      !validRef(observation.transportContextId) ||
      observation.reportedAddressFamily !== echo.addressFamily ||
      isIP(observation.ip) !== (echo.addressFamily === "ipv4" ? 4 : 6) ||
      observation.echo.origin.host !== echo.host ||
      observation.echo.origin.port !== echo.port ||
      observation.echo.credentials !== "omit" ||
      observation.echo.responseFromCache !== false ||
      observation.echo.certificateValidation !== "chromium-default" ||
      observation.echo.statusCode !== 200 ||
      observation.geo.credentials !== "omit" ||
      observation.geo.statusCode !== 200 ||
      observation.geo.responseFromCache !== false ||
      observation.geo.certificateValidation !== "chromium-default" ||
      observation.geo.origin.host !== "ipwho.is" ||
      observation.geo.origin.port !== 443 ||
      ![
        observation.startedAtMono,
        observation.completedAtMono,
        observation.echo.startedAtMono,
        observation.echo.completedAtMono,
        observation.geo.startedAtMono,
        observation.geo.completedAtMono,
      ].every(Number.isFinite) ||
      observation.startedAtMono < 0 ||
      observation.echo.startedAtMono < observation.startedAtMono ||
      observation.echo.completedAtMono < observation.echo.startedAtMono ||
      observation.geo.startedAtMono < observation.echo.completedAtMono ||
      observation.geo.completedAtMono < observation.geo.startedAtMono ||
      observation.completedAtMono < observation.geo.completedAtMono ||
      observation.observedAtMono !== observation.echo.completedAtMono ||
      observation.completedAtMono > this.now() ||
      observation.observedAtMono > observation.completedAtMono ||
      this.now() - observation.observedAtMono >= NETWORK_TIMING.egressTtlMs ||
      !Number.isFinite(observation.observedAtMono)
    )
      fail("EGRESS_UNVERIFIED");
    if (observation.countryCode !== "CN") fail("EGRESS_OUTSIDE_CN");
    if (request.signal.aborted) fail("GATE_REVOKED");
  }
}
