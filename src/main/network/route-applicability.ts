import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NETWORK_TIMING } from "@shared/network";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { CurrentPathInputs } from "./path-input-reader";
import type { LiveOutboundPolicy, LiveRulesSnapshot } from "./live-rule-evidence";
import { evaluateRules } from "./rules";
import { evaluateRuleContextSet, type CurrentRuleContextSet } from "./rule-context-set";
import type { WindowsRouteSelection } from "./windows-route-selection";
import type { WindowsTcpSocketRow } from "./windows-tcp-sockets";

/** Main-process records only. None of these observations is an account permit or a CN exit claim. */
export interface RouteApplicabilityBinding {
  readonly generation: number;
  readonly rulesVersion: string;
  readonly kernelEpoch: string;
  readonly sourceGeneration: number;
  readonly sourcePathIdentity: string;
  readonly fileFingerprint: string;
  readonly effectivePathPolicyVersion: string;
  readonly osNetworkHash: string;
  readonly outboundId: string;
  readonly outboundPolicyVersion: string;
  readonly network: "tcp";
  readonly addressFamily: ProofTarget["addressFamily"];
}

export interface RouteConformanceSample {
  readonly evidenceId: string;
  readonly target: ProofTarget;
  readonly transportProfileId: string;
  /** A TCP row alone does not establish Session ownership. The producer retains that correlation. */
  readonly correlationEvidenceId: string;
  readonly socketEvidenceId: string;
  readonly routeEvidenceId: string;
  readonly ownerRole: "kernel-direct-outbound" | "native-physical";
  readonly owner: {
    readonly pid: number;
    readonly createdAtTicks: string;
    readonly executablePathIdentity: string | null;
  };
  readonly socket: WindowsTcpSocketRow;
  readonly physicalRoute: WindowsRouteSelection;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}

/** Retained qualification artifact. Rechecking applicability must not rewrite its sampling dates. */
export interface RouteConformanceRecord {
  readonly source: "main-process-route-conformance";
  readonly evidenceId: string;
  readonly binding: RouteApplicabilityBinding;
  readonly transportProfileIds: readonly string[];
  readonly sourceEvidenceIds: readonly string[];
  readonly samples: readonly RouteConformanceSample[];
  readonly observedAtMono: number;
  readonly expiresAtMono: number;
}

/**
 * A current producer's actual selected physical route for a kernel outbound/fake-IP mapping.
 * Windows' route into TUN is retained separately and cannot stand in for this record.
 * Source references must resolve to retained main-process records; this type does not collect them.
 */
export interface CurrentPhysicalRouteProjection {
  readonly source: "current-physical-route-projection";
  readonly evidenceId: string;
  readonly binding: RouteApplicabilityBinding;
  readonly host: string;
  readonly candidateAddress: string;
  readonly resolvedAddress: string;
  readonly observedOsRoute: WindowsRouteSelection;
  readonly physicalRoute: WindowsRouteSelection;
  readonly sourceEvidenceIds: readonly string[];
  /** Required when the kernel candidate is fake/unknown or differs from the actual destination. */
  readonly dnsMappingEvidenceId: string | null;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}

export interface RouteApplicabilityInput {
  readonly inputs: CurrentPathInputs;
  readonly snapshot: LiveRulesSnapshot;
  readonly target: ProofTarget;
  readonly echo: ProofTarget;
  readonly outbound: LiveOutboundPolicy;
  readonly targetTransportProfileId: string;
  readonly echoTransportProfileId: string;
  readonly conformance: RouteConformanceRecord | null;
  readonly physicalRouteProjections?: readonly CurrentPhysicalRouteProjection[];
  readonly ruleContexts?: CurrentRuleContextSet;
  readonly scopeContextId?: string;
}

export interface ValidatedRouteApplicability {
  readonly source: "validated-route-applicability";
  readonly evidenceId: string;
  readonly target: ProofTarget;
  readonly echo: ProofTarget;
  readonly binding: RouteApplicabilityBinding;
  readonly physicalRouteClass: string;
  readonly conformanceEvidenceId: string;
  /** Original artifact date, distinct from the current route/rule applicability check. */
  readonly conformanceObservedAtMono: number;
  readonly sourceEvidenceIds: readonly string[];
  readonly checkedAtMono: number;
  readonly expiresAtMono: number;
}
export type RouteApplicabilityReason =
  | "INPUT_INVALID"
  | "INPUT_EXPIRED"
  | "NETWORK_CHANGED"
  | "RULE_UNVERIFIABLE"
  | "NOT_DIRECT"
  | "CONFORMANCE_UNAVAILABLE"
  | "CONFORMANCE_INVALID"
  | "TRANSPORT_UNQUALIFIED"
  | "DNS_UNVERIFIED"
  | "ROUTE_UNAVAILABLE"
  | "PHYSICAL_ROUTE_UNVERIFIED"
  | "ROUTE_CLASS_MISMATCH";
export type RouteApplicabilityResult =
  | Readonly<{ valid: true; evidence: ValidatedRouteApplicability }>
  | Readonly<{ valid: false; reason: RouteApplicabilityReason }>;

const constructed = new WeakSet<ValidatedRouteApplicability>();
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const integer = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const windowValid = (start: number, end: number, floor: number, now: number) =>
  [start, end, floor, now].every(Number.isFinite) &&
  floor >= 0 &&
  start >= floor &&
  end >= start &&
  end <= now;
const refsValid = (refs: readonly string[], max = 64) =>
  Array.isArray(refs) &&
  refs.length > 0 &&
  refs.length <= max &&
  refs.every(nonempty) &&
  new Set(refs).size === refs.length;
const fail = (reason: RouteApplicabilityReason): RouteApplicabilityResult => ({ valid: false, reason });

export function routeApplicabilityBinding(
  inputs: CurrentPathInputs,
  outbound: LiveOutboundPolicy,
  addressFamily: ProofTarget["addressFamily"],
): RouteApplicabilityBinding {
  const config = inputs.configurationAfter;
  return Object.freeze({
    generation: inputs.generation,
    rulesVersion: inputs.rulesVersion,
    kernelEpoch: inputs.ownerAfter.kernelEpoch,
    sourceGeneration: config.sourceGeneration,
    sourcePathIdentity: config.sourcePathIdentity,
    fileFingerprint: config.fileFingerprint,
    effectivePathPolicyVersion: config.policy.fingerprint,
    osNetworkHash: inputs.networkAfter.hash,
    outboundId: outbound.id,
    outboundPolicyVersion: outbound.policyVersion,
    network: "tcp",
    addressFamily,
  });
}

function bindingValid(binding: RouteApplicabilityBinding): boolean {
  return (
    integer(binding.generation, 1) &&
    integer(binding.sourceGeneration) &&
    binding.network === "tcp" &&
    ["ipv4", "ipv6"].includes(binding.addressFamily) &&
    [
      binding.rulesVersion,
      binding.kernelEpoch,
      binding.sourcePathIdentity,
      binding.fileFingerprint,
      binding.effectivePathPolicyVersion,
      binding.osNetworkHash,
      binding.outboundId,
      binding.outboundPolicyVersion,
    ].every(nonempty)
  );
}
function bindingMatches(left: RouteApplicabilityBinding, right: RouteApplicabilityBinding): boolean {
  return (
    bindingValid(left) &&
    Object.keys(right).every(
      (key) => left[key as keyof RouteApplicabilityBinding] === right[key as keyof RouteApplicabilityBinding],
    )
  );
}
function normalizeIp(value: string): string | null {
  if (typeof value !== "string" || value.length > 64 || value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return canonical.startsWith("::ffff:") ? null : canonical;
}
function ipNumber(value: string): bigint {
  if (isIP(value) === 4) return value.split(".").reduce((total, part) => total * 256n + BigInt(part), 0n);
  const [left, right] = value.split("::");
  const before = left ? left.split(":") : [];
  const after = right ? right.split(":") : [];
  const parts =
    right === undefined
      ? before
      : [...before, ...Array<string>(8 - before.length - after.length).fill("0"), ...after];
  return parts.reduce((total, part) => total * 65536n + BigInt(`0x${part}`), 0n);
}
function normalizedPrefix(prefix: string, target: string): string | null {
  if (typeof prefix !== "string") return null;
  const parts = prefix.split("/");
  if (parts.length !== 2 || !/^(0|[1-9]\d{0,2})$/.test(parts[1])) return null;
  const base = normalizeIp(parts[0]),
    bits = Number(parts[1]),
    width = isIP(target) === 4 ? 32 : 128;
  if (!base || isIP(base) !== isIP(target) || bits > width) return null;
  const shift = BigInt(width - bits),
    baseNumber = ipNumber(base);
  if ((baseNumber >> shift) << shift !== baseNumber || baseNumber >> shift !== ipNumber(target) >> shift)
    return null;
  return `${base}/${bits}`;
}
function routeClass(route: WindowsRouteSelection): string | null {
  const target = normalizeIp(route.targetAddress),
    source = normalizeIp(route.sourceAddress);
  const family = route.addressFamily === "ipv4" ? 4 : route.addressFamily === "ipv6" ? 6 : 0;
  if (
    !target ||
    !source ||
    isIP(target) !== family ||
    isIP(source) !== family ||
    ["0.0.0.0", "::"].includes(source) ||
    !route.hardwareInterface ||
    !route.adapterUp ||
    route.adapterStatus !== "Up" ||
    route.interfaceConnection !== "Connected" ||
    route.sourceState !== "Preferred" ||
    route.skipAsSource ||
    route.routeState !== "Alive" ||
    !integer(route.interfaceIndex, 1) ||
    route.interfaceIndex > 0xffff_ffff ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(route.interfaceGuid) ||
    !nonempty(route.interfaceIdentity) ||
    !integer(route.routeMetric) ||
    (route.interfaceMetric !== null && !integer(route.interfaceMetric))
  )
    return null;
  const nextHopParts = route.nextHop.split("%");
  if (
    nextHopParts.length > 2 ||
    (nextHopParts.length === 2 &&
      (family !== 6 || !/^\d+$/.test(nextHopParts[1]) || Number(nextHopParts[1]) !== route.interfaceIndex))
  )
    return null;
  const nextHop = normalizeIp(nextHopParts[0]),
    prefix = normalizedPrefix(route.destinationPrefix, target);
  if (!nextHop || isIP(nextHop) !== family || !prefix) return null;
  // Destination-specific prefix, source selection and next hop are part of the class, not just NIC.
  return hash([
    route.addressFamily,
    route.interfaceIndex,
    route.interfaceGuid.toLowerCase(),
    route.interfaceIdentity,
    source,
    prefix,
    nextHop,
    route.interfaceMetric,
    route.routeMetric,
  ]);
}

/** Pure consistency verifier; actual conformance/projection producers retain their referenced records. */
export function verifyRouteApplicability(
  input: RouteApplicabilityInput,
  nowMono: number,
): RouteApplicabilityResult {
  try {
    return verify(input, nowMono);
  } catch {
    return fail("INPUT_INVALID");
  }
}

function verify(input: RouteApplicabilityInput, now: number): RouteApplicabilityResult {
  const { inputs, snapshot, outbound, conformance } = input;
  const target = normalizeProofTarget(input.target),
    echo = normalizeProofTarget(input.echo);
  if (
    !target ||
    !echo ||
    echo.protocol !== "https:" ||
    target.addressFamily !== echo.addressFamily ||
    !nonempty(input.targetTransportProfileId) ||
    !nonempty(input.echoTransportProfileId) ||
    inputs.state !== "observed" ||
    inputs.kind !== "current-path-inputs" ||
    !nonempty(inputs.sampleId)
  )
    return fail("INPUT_INVALID");
  const binding = routeApplicabilityBinding(inputs, outbound, target.addressFamily);
  if (!bindingValid(binding)) return fail("INPUT_INVALID");
  if (
    !windowValid(inputs.startedAtMono, inputs.completedAtMono, 0, now) ||
    !Number.isFinite(inputs.expiresAtMono) ||
    inputs.expiresAtMono <= now ||
    ![snapshot.observedAtMono, outbound.observedAtMono].every(
      (at) => windowValid(at, at, 0, now) && now - at < NETWORK_TIMING.proofTtlMs,
    )
  )
    return fail("INPUT_EXPIRED");
  const before = inputs.configurationBefore,
    after = inputs.configurationAfter;
  if (
    inputs.ownerBefore.kernelEpoch !== binding.kernelEpoch ||
    !same(inputs.ownerBefore.owner, inputs.ownerAfter.owner) ||
    !same(inputs.ownerBefore.listeners, inputs.ownerAfter.listeners) ||
    inputs.ownerBefore.scopeHash !== inputs.ownerAfter.scopeHash ||
    inputs.networkBefore.hash !== binding.osNetworkHash ||
    !same(
      [
        before.sourceGeneration,
        before.sourcePathIdentity,
        before.fileFingerprint,
        before.decoderIdentity,
        before.controllerFingerprint,
        before.orderedRulesFingerprint,
        before.sourceRuleOptionsFingerprint,
        before.policy.fingerprint,
        before.currentDirectPolicy.policyFingerprint,
      ],
      [
        after.sourceGeneration,
        after.sourcePathIdentity,
        after.fileFingerprint,
        after.decoderIdentity,
        after.controllerFingerprint,
        after.orderedRulesFingerprint,
        after.sourceRuleOptionsFingerprint,
        after.policy.fingerprint,
        after.currentDirectPolicy.policyFingerprint,
      ],
    ) ||
    ![snapshot, outbound].every(
      (value) =>
        value.generation === binding.generation &&
        value.rulesVersion === binding.rulesVersion &&
        value.kernelEpoch === binding.kernelEpoch,
    ) ||
    after.controllerFingerprint !== binding.rulesVersion ||
    !same(snapshot.rules, after.rules)
  )
    return fail("NETWORK_CHANGED");
  if (snapshot.mode !== "rule") return fail("RULE_UNVERIFIABLE");
  if (outbound.kind !== "direct" || outbound.dialer !== "none" || !nonempty(outbound.name))
    return fail("NOT_DIRECT");
  let ruleContextsExpireAt = Infinity;
  for (const destination of [target, echo]) {
    if (!inputs.targets.some((value) => proofTargetKey(value) === proofTargetKey(destination)))
      return fail("INPUT_INVALID");
    if (input.ruleContexts !== undefined) {
      const profile = destination === target ? input.targetTransportProfileId : input.echoTransportProfileId;
      const decision = evaluateRuleContextSet(
        input.ruleContexts,
        inputs,
        snapshot,
        destination,
        input.scopeContextId ?? "",
        profile,
        "tcp",
        now,
      );
      if (decision.route === "unknown") return fail("RULE_UNVERIFIABLE");
      if (decision.matchedPolicy !== outbound.name) return fail("NOT_DIRECT");
      if (decision.expiresAtMono === null || decision.expiresAtMono <= now) return fail("INPUT_EXPIRED");
      ruleContextsExpireAt = Math.min(ruleContextsExpireAt, decision.expiresAtMono);
      continue;
    }
    const decision = evaluateRules(snapshot.mode, snapshot.rules, {
      host: destination.host,
      port: destination.port,
      network: "tcp",
    });
    if (decision.route === "unknown" || decision.ruleIndex === null) return fail("RULE_UNVERIFIABLE");
    if (snapshot.rules[decision.ruleIndex].proxy !== outbound.name) return fail("NOT_DIRECT");
  }
  if (!conformance) return fail("CONFORMANCE_UNAVAILABLE");
  if (
    conformance.source !== "main-process-route-conformance" ||
    !nonempty(conformance.evidenceId) ||
    !refsValid(conformance.sourceEvidenceIds) ||
    !refsValid(conformance.transportProfileIds, 16) ||
    !Array.isArray(conformance.samples) ||
    conformance.samples.length < 1 ||
    conformance.samples.length > 32
  )
    return fail("CONFORMANCE_INVALID");
  if (!bindingMatches(conformance.binding, binding)) return fail("NETWORK_CHANGED");
  if (
    !windowValid(conformance.observedAtMono, conformance.observedAtMono, 0, now) ||
    !Number.isFinite(conformance.expiresAtMono) ||
    conformance.expiresAtMono <= now
  )
    return fail("INPUT_EXPIRED");
  if (
    ![input.targetTransportProfileId, input.echoTransportProfileId].every((id) =>
      conformance.transportProfileIds.includes(id),
    )
  )
    return fail("TRANSPORT_UNQUALIFIED");
  const classes = new Set<string>();
  const references = new Set([inputs.sampleId, conformance.evidenceId, ...conformance.sourceEvidenceIds]);
  const sampleIds = new Set<string>();
  for (const sample of conformance.samples) {
    const sampleTarget = normalizeProofTarget(sample.target),
      physicalClass = routeClass(sample.physicalRoute);
    if (
      !sampleTarget ||
      sampleTarget.addressFamily !== target.addressFamily ||
      !physicalClass ||
      !conformance.transportProfileIds.includes(sample.transportProfileId) ||
      ![
        sample.evidenceId,
        sample.correlationEvidenceId,
        sample.socketEvidenceId,
        sample.routeEvidenceId,
      ].every(nonempty) ||
      sampleIds.has(sample.evidenceId) ||
      !windowValid(sample.startedAtMono, sample.completedAtMono, conformance.observedAtMono, now) ||
      sample.completedAtMono >= conformance.expiresAtMono ||
      !integer(sample.owner.pid, 1) ||
      !/^[1-9]\d{0,19}$/.test(sample.owner.createdAtTicks) ||
      (sample.owner.executablePathIdentity !== null && !nonempty(sample.owner.executablePathIdentity)) ||
      sample.socket.ownerPid !== sample.owner.pid ||
      sample.socket.state !== "Established" ||
      !integer(sample.socket.sourcePort, 1) ||
      sample.socket.sourcePort > 65535 ||
      sample.socket.remotePort !== sampleTarget.port ||
      normalizeIp(sample.socket.sourceAddress) !== normalizeIp(sample.physicalRoute.sourceAddress) ||
      normalizeIp(sample.socket.remoteAddress) !== normalizeIp(sample.physicalRoute.targetAddress) ||
      sample.physicalRoute.addressFamily !== target.addressFamily ||
      !["native-physical", "kernel-direct-outbound"].includes(sample.ownerRole)
    )
      return fail("CONFORMANCE_INVALID");
    if (
      sample.ownerRole === "kernel-direct-outbound" &&
      (sample.owner.pid !== inputs.ownerAfter.owner.pid ||
        sample.owner.createdAtTicks !== inputs.ownerAfter.owner.createdAtTicks ||
        (sample.owner.executablePathIdentity !== null &&
          inputs.ownerAfter.owner.executablePathIdentity !== null &&
          sample.owner.executablePathIdentity !== inputs.ownerAfter.owner.executablePathIdentity))
    )
      return fail("NETWORK_CHANGED");
    sampleIds.add(sample.evidenceId);
    classes.add(physicalClass);
    [
      sample.evidenceId,
      sample.correlationEvidenceId,
      sample.socketEvidenceId,
      sample.routeEvidenceId,
    ].forEach((ref) => references.add(ref));
  }
  if (classes.size !== 1) return fail("ROUTE_CLASS_MISMATCH");
  const physicalRouteClass = [...classes][0];
  let expires = Math.min(
    ruleContextsExpireAt,
    inputs.expiresAtMono,
    conformance.expiresAtMono,
    snapshot.observedAtMono + NETWORK_TIMING.proofTtlMs,
    outbound.observedAtMono + NETWORK_TIMING.proofTtlMs,
  );
  const projections = input.physicalRouteProjections ?? [];
  if (!Array.isArray(projections) || projections.length > 256) return fail("INPUT_INVALID");
  for (const destination of [target, echo]) {
    const hosts = inputs.dnsAfter.hosts.filter((host) => host.host === destination.host);
    if (hosts.length !== 1) return fail("DNS_UNVERIFIED");
    const host = hosts[0],
      queryType = destination.addressFamily === "ipv4" ? "A" : "AAAA";
    const queries = host.queries.filter((query) => query.type === queryType);
    // Host.status can be unverified solely because an unrelated address family is absent.
    if (
      queries.length !== 1 ||
      queries[0].error ||
      !queries[0].response ||
      queries[0].response.status !== 0 ||
      queries[0].response.truncated ||
      queries[0].response.host !== destination.host ||
      queries[0].response.queryType !== queryType
    )
      return fail("DNS_UNVERIFIED");
    const addresses = host.addresses.filter((address) => address.addressFamily === destination.addressFamily);
    if (
      !addresses.length ||
      addresses.length > 128 ||
      new Set(addresses.map((value) => normalizeIp(value.address))).size !== addresses.length
    )
      return fail("DNS_UNVERIFIED");
    for (const address of addresses) {
      const normalized = normalizeIp(address.address);
      if (!normalized || isIP(normalized) !== (destination.addressFamily === "ipv4" ? 4 : 6))
        return fail("DNS_UNVERIFIED");
      const answers = host.answers.filter(
        (answer) =>
          answer.queryType === queryType &&
          answer.type === (queryType === "A" ? 1 : 28) &&
          normalizeIp(answer.data) === normalized,
      );
      if (
        !answers.length ||
        answers.some(
          (answer) =>
            !windowValid(answer.observedAtMono, answer.observedAtMono, 0, now) ||
            !Number.isFinite(answer.expiresAtMono) ||
            answer.expiresAtMono <= now,
        )
      )
        return fail("DNS_UNVERIFIED");
      expires = Math.min(expires, ...answers.map((answer) => answer.expiresAtMono));
      const candidates = inputs.routeBatches.flatMap((batch) =>
        batch.selections
          .filter((route) => normalizeIp(route.targetAddress) === normalized)
          .map((route) => ({ batch, route })),
      );
      if (candidates.length !== 1) return fail("ROUTE_UNAVAILABLE");
      const { batch, route } = candidates[0];
      if (
        !batch.available ||
        batch.basis !== "windows-best-route-query" ||
        batch.socketObserved !== false ||
        !windowValid(
          batch.startedAtMono,
          batch.completedAtMono,
          inputs.startedAtMono,
          inputs.completedAtMono,
        ) ||
        route.addressFamily !== destination.addressFamily
      )
        return fail("ROUTE_UNAVAILABLE");
      let currentClass = address.addressClass === "real" ? routeClass(route) : null;
      const selected = projections.filter(
        (projection) =>
          projection.host === destination.host && normalizeIp(projection.candidateAddress) === normalized,
      );
      if (selected.length > 1) return fail("PHYSICAL_ROUTE_UNVERIFIED");
      if (selected.length === 1) {
        const projection = selected[0];
        if (
          projection.source !== "current-physical-route-projection" ||
          !nonempty(projection.evidenceId) ||
          !bindingMatches(projection.binding, binding) ||
          !refsValid(projection.sourceEvidenceIds) ||
          !same(projection.observedOsRoute, route) ||
          !windowValid(projection.startedAtMono, projection.completedAtMono, inputs.startedAtMono, now) ||
          now - projection.startedAtMono >= NETWORK_TIMING.proofTtlMs ||
          normalizeIp(projection.resolvedAddress) !== normalizeIp(projection.physicalRoute.targetAddress) ||
          projection.physicalRoute.addressFamily !== destination.addressFamily ||
          ((address.addressClass !== "real" || normalizeIp(projection.resolvedAddress) !== normalized) &&
            !nonempty(projection.dnsMappingEvidenceId))
        )
          return fail("PHYSICAL_ROUTE_UNVERIFIED");
        currentClass = routeClass(projection.physicalRoute);
        expires = Math.min(expires, projection.startedAtMono + NETWORK_TIMING.proofTtlMs);
        [projection.evidenceId, ...projection.sourceEvidenceIds].forEach((ref) => references.add(ref));
        if (projection.dnsMappingEvidenceId) references.add(projection.dnsMappingEvidenceId);
      }
      if (!currentClass) return fail("PHYSICAL_ROUTE_UNVERIFIED");
      if (currentClass !== physicalRouteClass) return fail("ROUTE_CLASS_MISMATCH");
      references.add(batch.selectionHash);
    }
  }
  const evidence: ValidatedRouteApplicability = Object.freeze({
    source: "validated-route-applicability",
    evidenceId: hash([
      inputs.sampleId,
      binding,
      target,
      echo,
      conformance.evidenceId,
      physicalRouteClass,
      now,
    ]),
    target: Object.freeze({ ...target }),
    echo: Object.freeze({ ...echo }),
    binding,
    physicalRouteClass,
    conformanceEvidenceId: conformance.evidenceId,
    conformanceObservedAtMono: conformance.observedAtMono,
    sourceEvidenceIds: Object.freeze([...references]),
    checkedAtMono: now,
    expiresAtMono: expires,
  });
  constructed.add(evidence);
  return Object.freeze({ valid: true, evidence });
}

/** A copied artifact is not newly constructed evidence; current bindings and deadline still apply. */
export function validateRouteApplicability(
  evidence: ValidatedRouteApplicability | null,
  binding: RouteApplicabilityBinding,
  target: ProofTarget,
  echo: ProofTarget,
  nowMono: number,
): boolean {
  return (
    !!evidence &&
    constructed.has(evidence) &&
    bindingMatches(evidence.binding, binding) &&
    proofTargetKey(evidence.target) === proofTargetKey(target) &&
    proofTargetKey(evidence.echo) === proofTargetKey(echo) &&
    Number.isFinite(nowMono) &&
    nowMono >= evidence.checkedAtMono &&
    nowMono < evidence.expiresAtMono
  );
}
