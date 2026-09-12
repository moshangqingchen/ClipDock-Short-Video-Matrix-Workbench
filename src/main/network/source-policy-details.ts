import { isIP } from "node:net";

/** Main-only parsed-source projection. Missing/unknown values never acquire kernel defaults. */
export type PolicyScalar<T> =
  Readonly<{ state: "missing" }> | Readonly<{ state: "unknown" }> | Readonly<{ state: "known"; value: T }>;
export interface PolicyList<T> {
  readonly state: "missing" | "present" | "invalid";
  readonly entries: readonly T[];
  readonly complete: boolean;
  readonly unsupportedCount: number;
  readonly truncated: boolean;
}
export interface DomainPattern {
  readonly kind: "exact" | "suffix" | "one-label";
  readonly domain: string;
}
export interface HostPolicyEntry {
  readonly pattern: DomainPattern;
  readonly target:
    Readonly<{ kind: "addresses"; addresses: readonly string[] }> | Readonly<{ kind: "alias"; host: string }>;
}
export interface PolicyPortRange {
  readonly from: number;
  readonly to: number;
}
export interface SnifferProtocolPolicy {
  readonly state: "missing" | "present" | "invalid";
  readonly ports: PolicyList<PolicyPortRange>;
  readonly overrideDestination: PolicyScalar<boolean>;
  /** Only ports and override-destination are modeled; unknown keys are not retained. */
  readonly complete: boolean;
  readonly unsupportedCount: number;
}
export interface SourcePolicyDetails {
  readonly dns: Readonly<{
    fakeIpRange: PolicyScalar<string>;
    fakeIpRange6: PolicyScalar<string>;
    fakeIpFilterMode: PolicyScalar<"blacklist" | "whitelist" | "rule">;
    fakeIpFilter: PolicyList<DomainPattern>;
  }>;
  readonly hosts: PolicyList<HostPolicyEntry>;
  readonly sniffer: Readonly<{
    enable: PolicyScalar<boolean>;
    forceDnsMapping: PolicyScalar<boolean>;
    parsePureIp: PolicyScalar<boolean>;
    overrideDestination: PolicyScalar<boolean>;
    forceDomain: PolicyList<DomainPattern>;
    skipDomain: PolicyList<DomainPattern>;
    skipSrcAddress: PolicyList<string>;
    skipDstAddress: PolicyList<string>;
    protocols: Readonly<Record<"HTTP" | "TLS" | "QUIC", SnifferProtocolPolicy>>;
    protocolsComplete: boolean;
    unsupportedProtocolCount: number;
  }>;
}

const MAX_ENTRIES = 512;
const MISSING = Symbol("missing");
const INVALID = Symbol("invalid");
type Data = Record<string, unknown>;
function record(value: unknown): Data | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Data) : null;
}
// Parsed YAML has data properties. Do not execute accessors supplied to this unknown-input boundary.
function field(value: unknown, key: string): unknown {
  if (value === MISSING) return MISSING;
  const object = record(value);
  if (!object) return INVALID;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return !descriptor ? MISSING : "value" in descriptor ? descriptor.value : INVALID;
}
function scalar<T>(value: unknown, parse: (value: unknown) => T | null): PolicyScalar<T> {
  if (value === MISSING) return Object.freeze({ state: "missing" });
  const parsed = parse(value);
  return parsed === null
    ? Object.freeze({ state: "unknown" })
    : Object.freeze({ state: "known", value: parsed });
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function ip(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || value.includes("%")) return null;
  const family = isIP(value);
  return family === 4 ? value : family === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : null;
}
function cidr(value: unknown, requiredFamily?: 4 | 6): string | null {
  if (typeof value !== "string" || value.length > 72) return null;
  const parts = /^([^/]+)\/(0|[1-9]\d{0,2})$/.exec(value);
  if (!parts) return null;
  const address = ip(parts[1]);
  if (address === null) return null;
  const family = isIP(address);
  if (
    (requiredFamily !== undefined && family !== requiredFamily) ||
    Number(parts[2]) > (family === 4 ? 32 : 128)
  )
    return null;
  // Preserve legitimate host bits: mihomo's examples use 198.18.0.1/16 and ...::1/64.
  return `${address}/${parts[2]}`;
}
function domain(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 253 || isIP(value)) return null;
  if (!value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return value.toLowerCase();
}
function pattern(value: unknown): DomainPattern | null {
  if (typeof value !== "string") return null;
  const kind = value.startsWith("+.") ? "suffix" : value.startsWith("*.") ? "one-label" : "exact";
  const host = domain(kind === "exact" ? value : value.slice(2));
  return host ? Object.freeze({ kind, domain: host }) : null;
}
function list<T>(value: unknown, parse: (value: unknown) => T | null, limit = MAX_ENTRIES): PolicyList<T> {
  if (value === MISSING)
    return Object.freeze({
      state: "missing",
      entries: Object.freeze([]),
      complete: false,
      unsupportedCount: 0,
      truncated: false,
    });
  if (!Array.isArray(value))
    return Object.freeze({
      state: "invalid",
      entries: Object.freeze([]),
      complete: false,
      unsupportedCount: 1,
      truncated: false,
    });
  const entries: T[] = [];
  let unsupportedCount = Math.max(0, value.length - limit);
  for (let index = 0; index < Math.min(value.length, limit); index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const parsed = parse(descriptor && "value" in descriptor ? descriptor.value : INVALID);
    if (parsed === null) unsupportedCount++;
    else entries.push(parsed);
  }
  return Object.freeze({
    state: "present",
    entries: Object.freeze(entries),
    complete: unsupportedCount === 0,
    unsupportedCount,
    truncated: value.length > limit,
  });
}
function hosts(value: unknown): PolicyList<HostPolicyEntry> {
  if (value === MISSING) return list<HostPolicyEntry>(MISSING, () => null);
  const object = record(value);
  if (!object) return list<HostPolicyEntry>(INVALID, () => null);
  const entries: HostPolicyEntry[] = [];
  const keys = Object.keys(object);
  let unsupportedCount = Math.max(0, keys.length - MAX_ENTRIES);
  for (const key of keys.slice(0, MAX_ENTRIES)) {
    const matched = pattern(key),
      target = field(object, key);
    if (!matched) {
      unsupportedCount++;
      continue;
    }
    const address = ip(target);
    if (address !== null) {
      entries.push(
        Object.freeze({
          pattern: matched,
          target: Object.freeze({ kind: "addresses", addresses: Object.freeze([address]) }),
        }),
      );
    } else if (Array.isArray(target)) {
      const addresses = list(target, ip, 32);
      if (!addresses.complete || !addresses.entries.length) {
        unsupportedCount++;
        continue;
      }
      entries.push(
        Object.freeze({
          pattern: matched,
          target: Object.freeze({ kind: "addresses", addresses: addresses.entries }),
        }),
      );
    } else {
      const alias = domain(target);
      if (alias === null) {
        unsupportedCount++;
        continue;
      }
      entries.push(
        Object.freeze({ pattern: matched, target: Object.freeze({ kind: "alias", host: alias }) }),
      );
    }
  }
  return Object.freeze({
    state: "present",
    entries: Object.freeze(entries),
    complete: unsupportedCount === 0,
    unsupportedCount,
    truncated: keys.length > MAX_ENTRIES,
  });
}
function port(value: unknown): PolicyPortRange | null {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 1 && value <= 65535
      ? Object.freeze({ from: value, to: value })
      : null;
  if (typeof value !== "string" || value.length > 11) return null;
  const matched = /^([1-9]\d{0,4})(?:-([1-9]\d{0,4}))?$/.exec(value);
  if (!matched) return null;
  const from = Number(matched[1]),
    to = Number(matched[2] ?? matched[1]);
  return from <= to && to <= 65535 ? Object.freeze({ from, to }) : null;
}
function protocol(value: unknown): SnifferProtocolPolicy {
  const object = record(value);
  const ports = list(field(value, "ports"), port, 128);
  const overrideDestination = scalar(field(value, "override-destination"), bool);
  const unsupportedCount = object
    ? Object.keys(object).filter((key) => key !== "ports" && key !== "override-destination").length
    : value === MISSING
      ? 0
      : 1;
  return Object.freeze({
    state: value === MISSING ? "missing" : object ? "present" : "invalid",
    ports,
    overrideDestination,
    unsupportedCount,
    complete:
      object !== null && ports.complete && overrideDestination.state !== "unknown" && unsupportedCount === 0,
  });
}

/** Finite subset only; this neither resolves aliases/defaults nor attests the running config.
 * Syntax references: https://wiki.metacubex.one/en/config/dns/,
 * /en/config/dns/hosts/, /en/config/sniff/, /en/handbook/syntax/#domain-wildcards.
 * `*.` is ONE label; `+.` includes the root and any depth. Other wildcard/provider/rule forms
 * remain unsupported instead of retaining raw strings that could contain URLs or secrets.
 */
export function projectSourcePolicyDetails(raw: unknown): SourcePolicyDetails {
  const dns = field(raw, "dns"),
    sniffer = field(raw, "sniffer"),
    sniff = field(sniffer, "sniff");
  const mode = scalar(field(dns, "fake-ip-filter-mode"), (value) =>
    value === "blacklist" || value === "whitelist" || value === "rule" ? value : null,
  );
  const sniffRecord = record(sniff);
  const unsupportedProtocolCount = sniffRecord
    ? Object.keys(sniffRecord).filter((key) => !["HTTP", "TLS", "QUIC"].includes(key)).length
    : sniff === MISSING
      ? 0
      : 1;
  const protocols = Object.freeze({
    HTTP: protocol(field(sniff, "HTTP")),
    TLS: protocol(field(sniff, "TLS")),
    QUIC: protocol(field(sniff, "QUIC")),
  });
  return Object.freeze({
    dns: Object.freeze({
      fakeIpRange: scalar(field(dns, "fake-ip-range"), (value) => cidr(value, 4)),
      fakeIpRange6: scalar(field(dns, "fake-ip-range6"), (value) => cidr(value, 6)),
      fakeIpFilterMode: mode,
      // Rule mode uses a different ordered grammar; domain-looking entries cannot bypass that.
      fakeIpFilter: list(
        field(dns, "fake-ip-filter"),
        mode.state === "known" && mode.value === "rule" ? () => null : pattern,
      ),
    }),
    hosts: hosts(field(raw, "hosts")),
    sniffer: Object.freeze({
      enable: scalar(field(sniffer, "enable"), bool),
      forceDnsMapping: scalar(field(sniffer, "force-dns-mapping"), bool),
      parsePureIp: scalar(field(sniffer, "parse-pure-ip"), bool),
      overrideDestination: scalar(field(sniffer, "override-destination"), bool),
      forceDomain: list(field(sniffer, "force-domain"), pattern),
      skipDomain: list(field(sniffer, "skip-domain"), pattern),
      skipSrcAddress: list(field(sniffer, "skip-src-address"), (value) => cidr(value)),
      skipDstAddress: list(field(sniffer, "skip-dst-address"), (value) => cidr(value)),
      protocols,
      protocolsComplete:
        sniffRecord !== null &&
        unsupportedProtocolCount === 0 &&
        Object.values(protocols).every((value) => value.state === "missing" || value.complete),
      unsupportedProtocolCount,
    }),
  });
}

export interface TargetPolicyMatches<T> {
  readonly state: "matched" | "not-matched" | "unknown";
  readonly matches: readonly T[];
  readonly complete: boolean;
}
function matches(pattern: DomainPattern, host: string): boolean {
  if (pattern.kind === "exact") return host === pattern.domain;
  if (pattern.kind === "suffix") return host === pattern.domain || host.endsWith(`.${pattern.domain}`);
  const prefix = host.endsWith(`.${pattern.domain}`) ? host.slice(0, -(pattern.domain.length + 1)) : "";
  return !!prefix && !prefix.includes(".");
}
function query<T>(
  source: PolicyList<T>,
  host: string | null,
  getPattern: (entry: T) => DomainPattern,
): TargetPolicyMatches<T> {
  const found = host === null ? [] : source.entries.filter((entry) => matches(getPattern(entry), host));
  const complete = host !== null && source.state === "present" && source.complete;
  return Object.freeze({
    state: !complete ? "unknown" : found.length ? "matched" : "not-matched",
    matches: Object.freeze(found),
    complete,
  });
}
/** Reports matching candidates only, NOT hosts precedence, alias resolution or fake/real outcome.
 * Any unsupported or omitted list keeps the answer unknown, even if retained entries don't match.
 */
export function querySourcePolicyTarget(details: SourcePolicyDetails, targetHost: string) {
  const host = domain(targetHost);
  const filter = query(details.dns.fakeIpFilter, host, (entry) => entry);
  const filterMode = details.dns.fakeIpFilterMode;
  return Object.freeze({
    hosts: query(details.hosts, host, (entry) => entry.pattern),
    fakeIpFilter:
      filterMode.state === "known" && filterMode.value !== "rule"
        ? filter
        : Object.freeze({ ...filter, state: "unknown" as const, complete: false }),
    forceDomain: query(details.sniffer.forceDomain, host, (entry) => entry),
    skipDomain: query(details.sniffer.skipDomain, host, (entry) => entry),
  });
}
