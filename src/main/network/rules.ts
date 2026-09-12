import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { NetworkReason } from "@shared/network";

export interface KernelRule {
  type: string;
  payload: string;
  proxy: string;
}
/** metadata.DstIP when ordered matching starts, after hosts/mapping/sniffer processing.
 * DNS answers, OS route destinations and an earlier socket's peer do not establish this stage.
 */
export type RuleDestination =
  | Readonly<{ stage: "resolved"; address: string }>
  | Readonly<{ stage: "unresolved" }>
  | Readonly<{ stage: "unknown" }>;

/** Parameters from the caller's currently associated config source, in exact live-rule order.
 * Triple equality checks alignment only; it does not attest that a file is the running config.
 */
export interface RuleSourceParameters {
  readonly rules: readonly KernelRule[];
  readonly parameters: readonly (readonly string[])[];
  /** Existing candidate.sourceRuleOptionsFingerprint, checked against this parameter snapshot. */
  readonly parametersFingerprint: string;
}
export interface RuleContext {
  host: string;
  port: number;
  network: "tcp" | "udp";
  processName?: string;
  processPath?: string;
  destination?: RuleDestination;
}
export interface RuleDecision {
  route: "direct" | "proxy" | "unknown";
  reason: NetworkReason;
  ruleType: string | null;
  ruleIndex: number | null;
}

export function rulesVersion(
  mode: string,
  tun: boolean,
  rules: readonly KernelRule[],
  configDigest = "",
): string {
  return createHash("sha256")
    .update(JSON.stringify([mode, tun, configDigest, rules]))
    .digest("hex");
}

export function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

export function domainMatches(host: string, suffix: string): boolean {
  const h = normalizeHost(host),
    s = normalizeHost(suffix);
  return h === s || h.endsWith(`.${s}`);
}

/** Normalize only controller/source spelling differences, without changing rule semantics. */
export function normalizeKernelRule(rule: KernelRule): KernelRule {
  const type = rule.type
    .replace(/[-_]/g, "")
    .toLowerCase()
    .replace(/^ipcidr6$/, "ipcidr");
  return {
    type,
    payload: type === "match" ? "" : type === "geoip" ? rule.payload.toLowerCase() : rule.payload,
    proxy: rule.proxy,
  };
}

function parametersAlign(rules: readonly KernelRule[], source: RuleSourceParameters): boolean {
  if (
    !Array.isArray(source.rules) ||
    !Array.isArray(source.parameters) ||
    !/^[a-f0-9]{64}$/.test(source.parametersFingerprint) ||
    source.rules.length !== rules.length ||
    source.parameters.length !== rules.length
  )
    return false;
  for (const [index, rule] of rules.entries()) {
    const original = source.rules[index],
      parameters = source.parameters[index];
    if (
      !original ||
      ![original.type, original.payload, original.proxy].every((value) => typeof value === "string") ||
      !Array.isArray(parameters) ||
      parameters.length > 16 ||
      parameters.some((value) => typeof value !== "string" || !value || value.length > 16_384)
    )
      return false;
    const left = normalizeKernelRule(rule),
      right = normalizeKernelRule(original);
    if (left.type !== right.type || left.payload !== right.payload || left.proxy !== right.proxy)
      return false;
  }
  // Nested arrays of strings have the same canonical representation as the source parser's digest.
  // This is content integrity; the caller's current association supplies the provenance.
  return (
    createHash("sha256").update(JSON.stringify(source.parameters)).digest("hex") ===
    source.parametersFingerprint
  );
}

function parsedAddress(value: string): { family: 4 | 6; bits: bigint } | null {
  // Scoped addresses need a separately specified zone contract. Do not silently guess it here.
  if (typeof value !== "string" || value.length > 128 || value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4)
    return { family, bits: value.split(".").reduce((bits, part) => (bits << 8n) | BigInt(part), 0n) };
  if (family !== 6) return null;
  // WHATWG canonicalization also expands an IPv4-mapped tail into hexadecimal words.
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const start = left ? left.split(":") : [],
    end = right ? right.split(":") : [];
  const words = [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
  return { family, bits: words.reduce((bits, word) => (bits << 16n) | BigInt(`0x${word}`), 0n) };
}

function parsedPrefix(value: string): { family: 4 | 6; bits: bigint; hostBits: bigint } | null {
  const match = /^([^/%]+)\/(0|[1-9]\d{0,2})$/.exec(value);
  if (!match) return null;
  const base = parsedAddress(match[1]),
    length = Number(match[2]);
  if (!base || length > (base.family === 4 ? 32 : 128)) return null;
  return { ...base, hostBits: BigInt((base.family === 4 ? 32 : 128) - length) };
}

/** Ordered live-kernel subset. Unknown preceding rules are NEVER skipped. */
export function evaluateRules(
  mode: string,
  rules: readonly KernelRule[],
  context: RuleContext,
  sourceParameters?: RuleSourceParameters,
): RuleDecision {
  const unknown = (ruleType: string | null = null, ruleIndex: number | null = null): RuleDecision => ({
    route: "unknown",
    reason: "RULE_UNVERIFIABLE",
    ruleType,
    ruleIndex,
  });
  if (mode === "global") return { ...unknown(), reason: "GLOBAL_MODE" };
  if (mode !== "rule") return unknown();
  if (!context.host || isIP(context.host) || !Number.isInteger(context.port)) return unknown();
  if (sourceParameters && !parametersAlign(rules, sourceParameters)) return unknown();
  const host = normalizeHost(context.host);
  for (const [index, rule] of rules.entries()) {
    let matches: boolean;
    const type = normalizeKernelRule(rule).type;
    const payload = rule.payload.toLowerCase();
    if (type !== "ipcidr" && sourceParameters?.parameters[index].length) return unknown(rule.type, index);
    switch (type) {
      case "domain":
        matches = host === normalizeHost(payload);
        break;
      case "domainsuffix":
        matches = domainMatches(host, payload);
        break;
      case "domainkeyword":
        matches = host.includes(payload);
        break;
      case "network":
        matches = context.network === payload;
        break;
      case "dstport":
        if (!/^\d+$/.test(payload)) return unknown(rule.type, index);
        matches = context.port === Number(payload);
        break;
      case "processname":
        if (!context.processName) return unknown(rule.type, index);
        matches = context.processName.toLowerCase() === payload;
        break;
      case "processpath":
        if (!context.processPath) return unknown(rule.type, index);
        matches = context.processPath.toLowerCase() === payload;
        break;
      case "ipcidr": {
        const parameters = sourceParameters?.parameters[index];
        // /rules omits these modifiers. Missing is not equivalent to a verified empty list.
        // src, duplicate no-resolve and future modifiers are deliberately outside this subset.
        if (
          !parameters ||
          parameters.length > 1 ||
          (parameters.length === 1 && parameters[0] !== "no-resolve")
        )
          return unknown(rule.type, index);
        const prefix = parsedPrefix(rule.payload);
        if (!prefix) return unknown(rule.type, index);
        if (context.destination?.stage === "unresolved" && parameters[0] === "no-resolve") {
          matches = false;
          break;
        }
        // A resolving rule may change metadata.DstIP. No resolver is invoked or simulated here.
        if (context.destination?.stage !== "resolved") return unknown(rule.type, index);
        const address = parsedAddress(context.destination.address);
        if (!address) return unknown(rule.type, index);
        matches =
          address.family === prefix.family &&
          address.bits >> prefix.hostBits === prefix.bits >> prefix.hostBits;
        break;
      }
      case "match":
        matches = true;
        break;
      default:
        return unknown(rule.type, index);
    }
    if (!matches) continue;
    // Only the kernel's built-in DIRECT is accepted; groups with aliases are not resolved by guessing.
    return rule.proxy === "DIRECT"
      ? { route: "direct", reason: "READY", ruleType: rule.type, ruleIndex: index }
      : { route: "proxy", reason: "NOT_DIRECT", ruleType: rule.type, ruleIndex: index };
  }
  return unknown();
}
