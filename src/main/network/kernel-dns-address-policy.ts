import { isIP } from "node:net";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { KernelDnsAddressClass } from "./kernel-dns";
import { hasCurrentMissingIpv6FakePoolCompatibility } from "./kernel-compatibility";

export interface CurrentKernelDnsAddressPolicy {
  readonly candidate: EffectiveConfigCandidate | null;
  readonly loader: KnownSelectedLoaderContract | null;
}

interface Address {
  readonly bits: 32 | 128;
  readonly value: bigint;
}
interface Range extends Address {
  readonly prefix: number;
}
const SHA256 = /^[a-f0-9]{64}$/;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);

function parseAddress(input: string): Address | null {
  if (typeof input !== "string" || input.length > 64 || input.includes("%")) return null;
  const family = isIP(input);
  if (family === 4) {
    return { bits: 32, value: input.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n) };
  }
  if (family !== 6) return null;
  // Canonicalization expands mixed dotted notation to hextets before mapped-address rejection.
  const canonical = new URL(`http://[${input}]`).hostname.slice(1, -1);
  const [head, tail] = canonical.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const words =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const value = words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n);
  // Neither spelling of ::ffff:a.b.c.d may acquire an IPv6 or IPv4 candidate classification.
  return value >> 32n === 0xffffn ? null : { bits: 128, value };
}

function parseRange(input: string, bits: Address["bits"]): Range | null {
  if (typeof input !== "string" || input.length > 72) return null;
  const parts = /^([^/]+)\/(0|[1-9]\d{0,2})$/.exec(input);
  if (!parts) return null;
  const address = parseAddress(parts[1]);
  const prefix = Number(parts[2]);
  return address?.bits === bits && prefix <= bits ? { ...address, prefix } : null;
}
function contains(range: Range, address: Address): boolean {
  const shift = BigInt(range.bits - range.prefix);
  return address.bits === range.bits && range.value >> shift === address.value >> shift;
}
function ranges(values: readonly string[], bits: Address["bits"]): readonly Range[] {
  return values.map((value) => {
    const range = parseRange(value, bits);
    if (!range) throw new Error("INVALID_STATIC_ADDRESS_RANGE");
    return range;
  });
}

// Conservative special-purpose exclusion, including reachable protocol-service exceptions.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const SPECIAL_V4 = ranges(
  [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.31.196.0/24",
    "192.52.193.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "192.175.48.0/24",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ],
  32,
);
const SPECIAL_V6 = ranges(["2001::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20"], 128);
const GLOBAL_V6 = ranges(["2000::/3"], 128)[0];

function currentSource(
  { candidate, loader }: CurrentKernelDnsAddressPolicy,
  controllerVersion: string,
  now: number,
): boolean {
  return (
    !!candidate &&
    !!loader &&
    candidate.kind === "local-config-candidate" &&
    candidate.runtimeConfigurationProven === false &&
    Number.isSafeInteger(candidate.sourceGeneration) &&
    candidate.sourceGeneration >= 0 &&
    loader.source === "main-process-selected-loader-contract" &&
    text(loader.selectionId) &&
    text(loader.loaderProfileId) &&
    /^[a-zA-Z0-9_.-]{1,128}$/.test(loader.decoderIdentity) &&
    Array.isArray(loader.qualificationEvidenceIds) &&
    loader.qualificationEvidenceIds.length > 0 &&
    loader.qualificationEvidenceIds.length <= 32 &&
    loader.qualificationEvidenceIds.every(text) &&
    new Set(loader.qualificationEvidenceIds).size === loader.qualificationEvidenceIds.length &&
    [
      candidate.sourcePathIdentity,
      candidate.fileFingerprint,
      candidate.policy.fingerprint,
      candidate.controllerFingerprint,
      controllerVersion,
    ].every((value) => SHA256.test(value)) &&
    candidate.sourcePathIdentity === loader.sourcePathIdentity &&
    candidate.decoderIdentity === loader.decoderIdentity &&
    candidate.controllerFingerprint === controllerVersion &&
    [
      now,
      loader.selectedAtMono,
      candidate.startedAtMono,
      candidate.completedAtMono,
      candidate.expiresAtMono,
      candidate.controllerStartedAtMono,
      candidate.controllerCompletedAtMono,
    ].every(Number.isFinite) &&
    loader.selectedAtMono >= 0 &&
    loader.selectedAtMono <= candidate.startedAtMono &&
    candidate.startedAtMono <= candidate.controllerStartedAtMono &&
    candidate.controllerStartedAtMono <= candidate.controllerCompletedAtMono &&
    candidate.controllerCompletedAtMono <= candidate.completedAtMono &&
    candidate.completedAtMono <= now &&
    now < candidate.expiresAtMono
  );
}

/** Classify a DNS candidate under the selected-loader observation model, never a loaded-runtime
 * attestation. `real` means only an ordinary address outside this family's explicit fake allocation,
 * or the exact selected binary's observed absence of a default IPv6 pool when range6 is omitted.
 * No socket family, resolver-path equivalence, geography, DIRECT route or permission is established.
 * The caller supplies the current candidate/selection/version on every call; nothing is cached.
 */
export function classifyCurrentKernelDnsAddress(
  address: string,
  controllerVersion: string,
  input: CurrentKernelDnsAddressPolicy,
  nowMono: number,
): KernelDnsAddressClass {
  try {
    if (!currentSource(input, controllerVersion, nowMono)) return "unknown";
    const candidate = input.candidate!;
    const policy = candidate.policy;
    // Initial support is explicit, enabled fake-IP mode. redir-host and omitted kernel defaults
    // do not provide enough allocation evidence here, even when a public address is returned.
    if (
      !policy.dns.present ||
      policy.dns.kind !== "object" ||
      !policy.dnsFlags.enable.present ||
      policy.dnsFlags.enable.value !== true ||
      !policy.dnsMode.present ||
      policy.dnsMode.value !== "fake-ip"
    )
      return "unknown";
    const parsed = parseAddress(address);
    if (!parsed) return "unknown";
    const field = parsed.bits === 32 ? policy.details?.dns.fakeIpRange : policy.details?.dns.fakeIpRange6;
    if (field?.state === "known") {
      const range = parseRange(field.value, parsed.bits);
      if (!range) return "unknown";
      // Known fake allocations (often benchmark/ULA) take precedence over special-use exclusions.
      if (contains(range, parsed)) return "fake-ip";
    } else if (
      parsed.bits !== 128 ||
      field?.state !== "missing" ||
      !hasCurrentMissingIpv6FakePoolCompatibility(
        input.loader!.kernelCompatibility,
        { loader: input.loader!, candidate },
        controllerVersion,
        nowMono,
      )
    )
      return "unknown";
    const special = parsed.bits === 32 ? SPECIAL_V4 : SPECIAL_V6;
    if (
      special.some((value) => contains(value, parsed)) ||
      (parsed.bits === 128 && !contains(GLOBAL_V6, parsed))
    )
      return "unknown";
    // Deliberately never infer address-family restrictions from either dns.ipv6 or global ipv6.
    return "real";
  } catch {
    return "unknown";
  }
}
