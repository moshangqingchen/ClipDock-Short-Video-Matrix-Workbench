import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { CORE_SCHEMA, Type, load, type LoadOptions } from "js-yaml";
import type { ClashReadResult, DirectPolicyObservation } from "./clash-reader";
import { normalizeKernelRule, type KernelRule } from "./rules";
import { projectSourcePolicyDetails, type SourcePolicyDetails } from "./source-policy-details";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_YAML_BYTES = 4 * 1024 * 1024;
const MAX_RULES = 20_000;
const MAX_GRAPH_NODES = 200_000;
const SHA256 = /^[a-f0-9]{64}$/;
const YAML_SCHEMA = CORE_SCHEMA.extend({
  // Support normal config anchors/merges without timestamp, binary or custom object types.
  implicit: [
    new Type("tag:yaml.org,2002:merge", {
      kind: "scalar",
      resolve: (value) => value === "<<" || value === null,
    }),
  ],
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
export type SourceField<T> = Readonly<{ present: false }> | Readonly<{ present: true; value: T }>;
export type SourceFieldDigest =
  | Readonly<{ present: false }>
  | Readonly<{
      present: true;
      kind: "null" | "boolean" | "number" | "string" | "array" | "object";
      fingerprint: string;
      count?: number;
    }>;

/** Main-only policy projection; resolver URLs, node credentials and raw config stay private. */
export interface EffectiveSourcePolicy {
  readonly fingerprint: string;
  /** Finite parsed policy facts. Missing legacy projections remain unknown, never defaults. */
  readonly details?: SourcePolicyDetails;
  readonly dns: SourceFieldDigest;
  readonly hosts: SourceFieldDigest;
  readonly sniffer: SourceFieldDigest;
  readonly tun: SourceFieldDigest;
  readonly ipv6: SourceField<boolean>;
  readonly dnsFlags: Readonly<
    Record<"enable" | "ipv6" | "use-hosts" | "use-system-hosts" | "respect-rules", SourceField<boolean>>
  >;
  readonly dnsMode: SourceField<string>;
  readonly snifferFlags: Readonly<
    Record<"enable" | "force-dns-mapping" | "override-destination" | "parse-pure-ip", SourceField<boolean>>
  >;
  readonly tunEnabled: SourceField<boolean>;
  readonly directOutbounds: Readonly<{
    count: number;
    fingerprint: string;
    builtinNameConfigured: boolean;
    entries: readonly Readonly<{
      nameIdentity: string;
      type: string;
      interface: SourceFieldDigest;
      ipVersion: SourceField<string>;
      dialer: "absent" | "none" | "configured";
    }>[];
  }>;
}

/** Main-process candidate only. Never a loaded-runtime attestation, IPC DTO or permission. */
export interface EffectiveConfigCandidate {
  readonly kind: "local-config-candidate";
  readonly runtimeConfigurationProven: false;
  readonly sourceGeneration: number;
  readonly sourcePathIdentity: string;
  readonly fileFingerprint: string;
  readonly decoderIdentity: string;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
  readonly expiresAtMono: number;
  readonly controllerFingerprint: string;
  readonly controllerStartedAtMono: number;
  readonly controllerCompletedAtMono: number;
  readonly comparedConfigFields: readonly string[];
  readonly comparedRuleCount: number;
  readonly orderedRulesFingerprint: string;
  readonly sourceRuleOptionsFingerprint: string;
  readonly rules: readonly KernelRule[];
  /** Actual source modifiers aligned with rules. Main-only; missing legacy input is not [].
   * Requires a current configuration association before use as running-kernel parameters.
   */
  readonly ruleParameters?: readonly (readonly string[])[];
  readonly policy: EffectiveSourcePolicy;
  readonly currentDirectPolicy: Readonly<DirectPolicyObservation>;
}

export type EffectiveConfigSourceReason =
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_CHANGED"
  | "SOURCE_LIMIT_EXCEEDED"
  | "SOURCE_PARSE_INVALID"
  | "SOURCE_POLICY_INVALID"
  | "RULES_MISMATCH"
  | "CONFIG_MISMATCH"
  | "CONTROLLER_COMPARISON_UNAVAILABLE"
  | "READ_TIMEOUT"
  | "INVALIDATED"
  | "EXPIRED"
  | "DISPOSED";
export type EffectiveConfigSourceSnapshot =
  | Readonly<{ state: "checking"; generation: number }>
  | Readonly<{ state: "unavailable"; generation: number; reason: EffectiveConfigSourceReason }>
  | Readonly<{ state: "candidate"; generation: number; candidate: EffectiveConfigCandidate }>;

export interface EffectiveConfigSourceOptions {
  path: string;
  /** Explicit choice; ciphertext is never tried as YAML or decoded with guessed credentials. */
  format: "yaml" | "decoded-yaml";
  /** Required with decoded-yaml; identifies this caller-owned decoding implementation/version. */
  decoderIdentity?: string;
  decode?: (bytes: Uint8Array, signal: AbortSignal) => string | Promise<string>;
  /** Called inside the file read window, not supplied as a historical report/object. */
  readController: (signal: AbortSignal) => Promise<ClashReadResult>;
  onChange?: (snapshot: EffectiveConfigSourceSnapshot) => void;
  timeoutMs?: number;
  ttlMs?: number;
  maxFileBytes?: number;
  maxYamlBytes?: number;
}

class SourceError extends Error {
  constructor(readonly code: EffectiveConfigSourceReason) {
    super(code);
  }
}
function fail(code: EffectiveConfigSourceReason): never {
  throw new SourceError(code);
}
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function bytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SOURCE_POLICY_INVALID");
  return value;
}
function optionalRecord(object: JsonObject, key: string): JsonObject {
  return Object.hasOwn(object, key) && object[key] !== null ? record(object[key]) : {};
}
function fieldDigest(object: JsonObject, key: string): SourceFieldDigest {
  if (!Object.hasOwn(object, key)) return Object.freeze({ present: false });
  const value = object[key];
  const kind =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : (typeof value as "boolean" | "number" | "string" | "object");
  const count = Array.isArray(value)
    ? value.length
    : value && typeof value === "object"
      ? Object.keys(value).length
      : undefined;
  return Object.freeze({
    present: true,
    kind,
    fingerprint: digest(value),
    ...(count === undefined ? {} : { count }),
  });
}
function scalar<T extends boolean | string>(
  object: JsonObject,
  key: string,
  type: "boolean" | "string",
): SourceField<T> {
  if (!Object.hasOwn(object, key)) return Object.freeze({ present: false });
  const value = object[key];
  if (typeof value !== type || (typeof value === "string" && (value.length > 256 || /[\r\n\0]/.test(value))))
    fail("SOURCE_POLICY_INVALID");
  return Object.freeze({ present: true, value: value as T });
}
function flags<K extends string>(
  object: JsonObject,
  keys: readonly K[],
): Readonly<Record<K, SourceField<boolean>>> {
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, scalar<boolean>(object, key, "boolean")])) as Record<
      K,
      SourceField<boolean>
    >,
  );
}

function projectPolicy(source: JsonObject): EffectiveSourcePolicy {
  const dns = optionalRecord(source, "dns"),
    sniffer = optionalRecord(source, "sniffer"),
    tun = optionalRecord(source, "tun");
  if (Object.hasOwn(source, "hosts") && source.hosts !== null) record(source.hosts);
  const proxies = source.proxies ?? [];
  if (!Array.isArray(proxies) || proxies.length > 20_000) fail("SOURCE_POLICY_INVALID");
  const selected = proxies.map(record).filter((proxy) => proxy.type === "direct" || proxy.name === "DIRECT");
  const entries = selected.map((proxy) => {
    if (
      typeof proxy.name !== "string" ||
      !proxy.name ||
      typeof proxy.type !== "string" ||
      !proxy.type ||
      proxy.type.length > 64
    )
      fail("SOURCE_POLICY_INVALID");
    if (Object.hasOwn(proxy, "interface-name") && typeof proxy["interface-name"] !== "string")
      fail("SOURCE_POLICY_INVALID");
    if (Object.hasOwn(proxy, "dialer-proxy") && typeof proxy["dialer-proxy"] !== "string")
      fail("SOURCE_POLICY_INVALID");
    return Object.freeze({
      nameIdentity: bytesDigest(Buffer.from(proxy.name)),
      type: proxy.type,
      interface: fieldDigest(proxy, "interface-name"),
      ipVersion: scalar<string>(proxy, "ip-version", "string"),
      dialer: !Object.hasOwn(proxy, "dialer-proxy")
        ? ("absent" as const)
        : proxy["dialer-proxy"] === ""
          ? ("none" as const)
          : ("configured" as const),
    });
  });
  const relevantFields = [
    "dns",
    "hosts",
    "sniffer",
    "ipv6",
    "tun",
    "interface-name",
    "routing-mark",
    "tcp-concurrent",
    "listeners",
    "tunnels",
  ];
  const relevant: JsonObject = {};
  for (const key of relevantFields)
    relevant[key] = Object.hasOwn(source, key) ? { present: true, value: source[key] } : { present: false };
  return Object.freeze({
    fingerprint: digest({ fields: relevant, directOutbounds: selected }),
    details: projectSourcePolicyDetails(source),
    dns: fieldDigest(source, "dns"),
    hosts: fieldDigest(source, "hosts"),
    sniffer: fieldDigest(source, "sniffer"),
    tun: fieldDigest(source, "tun"),
    ipv6: scalar<boolean>(source, "ipv6", "boolean"),
    dnsFlags: flags(dns, ["enable", "ipv6", "use-hosts", "use-system-hosts", "respect-rules"]),
    dnsMode: scalar<string>(dns, "enhanced-mode", "string"),
    snifferFlags: flags(sniffer, ["enable", "force-dns-mapping", "override-destination", "parse-pure-ip"]),
    tunEnabled: scalar<boolean>(tun, "enable", "boolean"),
    directOutbounds: Object.freeze({
      count: selected.length,
      fingerprint: digest(selected),
      builtinNameConfigured: selected.some((proxy) => proxy.name === "DIRECT"),
      entries: Object.freeze(entries),
    }),
  });
}

function splitRule(rule: string): string[] {
  const fields: string[] = [];
  let depth = 0,
    start = 0;
  for (let index = 0; index < rule.length; index++) {
    if (rule[index] === "(") depth++;
    else if (rule[index] === ")" && --depth < 0) fail("SOURCE_PARSE_INVALID");
    else if (rule[index] === "," && depth === 0) {
      fields.push(rule.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) fail("SOURCE_PARSE_INVALID");
  fields.push(rule.slice(start).trim());
  return fields;
}
function parseRules(source: JsonObject): { rules: KernelRule[]; options: string[][] } {
  if (!Array.isArray(source.rules) || !source.rules.length || source.rules.length > MAX_RULES)
    fail("SOURCE_PARSE_INVALID");
  const options: string[][] = [];
  const rules = source.rules.map((raw) => {
    if (typeof raw !== "string" || !raw || raw.length > 16_384 || /[\r\n\0]/.test(raw))
      fail("SOURCE_PARSE_INVALID");
    const fields = splitRule(raw),
      match = fields[0].toLowerCase() === "match",
      needed = match ? 2 : 3;
    if (fields.length < needed || fields.some((field) => !field) || !/^[a-z][a-z0-9_-]*$/i.test(fields[0]))
      fail("SOURCE_PARSE_INVALID");
    options.push(fields.slice(needed));
    return normalizeKernelRule({
      type: fields[0],
      payload: match ? "" : fields[1],
      proxy: fields[needed - 1],
    });
  });
  return { rules, options };
}

function parseSource(text: string, check: () => void): JsonObject {
  let parseEvents = 0;
  const options: LoadOptions & { maxDepth: number; maxTotalMergeKeys: number } = {
    schema: YAML_SCHEMA,
    maxDepth: 40,
    maxTotalMergeKeys: 20_000,
    listener: () => {
      if (++parseEvents > MAX_GRAPH_NODES) fail("SOURCE_LIMIT_EXCEEDED");
      check();
    },
    onWarning: () => fail("SOURCE_PARSE_INVALID"),
  };
  const value = load(text, options);
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): JsonValue => {
    check();
    if (++nodes > MAX_GRAPH_NODES || depth > 40) fail("SOURCE_LIMIT_EXCEEDED");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) fail("SOURCE_PARSE_INVALID");
    ancestors.add(item);
    let result: JsonValue;
    if (Array.isArray(item)) result = item.map((child) => visit(child, depth + 1));
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        fail("SOURCE_PARSE_INVALID");
      result = Object.fromEntries(
        Object.entries(item).map(([key, child]) => {
          if (["__proto__", "prototype", "constructor"].includes(key)) fail("SOURCE_PARSE_INVALID");
          return [key, visit(child, depth + 1)];
        }),
      );
    }
    ancestors.delete(item);
    return result;
  };
  return record(visit(value, 0));
}

/** Compare only shared explicit leaves; /configs may add defaults to nested objects. */
function comparisonPaths(
  source: JsonObject,
  available: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const parents = new Set(
    Object.keys(available).map((pointer) => pointer.slice(0, pointer.lastIndexOf("/"))),
  );
  const visit = (value: JsonValue, pointer: string): void => {
    if (!Object.hasOwn(available, pointer)) return;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length &&
      parents.has(pointer)
    ) {
      for (const [key, child] of Object.entries(value))
        visit(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
    } else result[pointer] = digest(value);
  };
  for (const [key, value] of Object.entries(source))
    visit(value, `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  return result;
}

function localPath(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\r\n\0]/.test(value) &&
    (process.platform === "win32"
      ? /^[a-z]:[\\/]/i.test(value)
      : path.isAbsolute(value) && !value.startsWith("//"))
  );
}

interface FileSample {
  bytes: Buffer;
  contentHash: string;
  identity: string;
  pathIdentity: string;
}
async function readFileSample(selectedPath: string, maximum: number, check: () => void): Promise<FileSample> {
  check();
  const resolved = await realpath(selectedPath);
  if (!localPath(resolved)) fail("SOURCE_UNAVAILABLE");
  check();
  const file = await open(resolved, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximum)) fail("SOURCE_LIMIT_EXCEEDED");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      check();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    check();
    const identity = (entry: typeof before) =>
      [resolved, entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].map(String).join("\0");
    if (offset !== Number(before.size) || identity(before) !== identity(after)) fail("SOURCE_CHANGED");
    const bytes = buffer.subarray(0, offset);
    return {
      bytes,
      contentHash: bytesDigest(bytes),
      identity: bytesDigest(Buffer.from(identity(after))),
      pathIdentity: bytesDigest(
        Buffer.from(process.platform === "win32" ? resolved.toLowerCase() : resolved),
      ),
    };
  } finally {
    await file.close();
  }
}

export class EffectiveConfigSource {
  private readonly options: Readonly<EffectiveConfigSourceOptions>;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly maxFileBytes: number;
  private readonly maxYamlBytes: number;
  private readonly decoderIdentity: string;
  private generation = 0;
  private snapshot: EffectiveConfigSourceSnapshot = Object.freeze({ state: "checking", generation: 0 });
  private lastFileIdentity: string | null = null;
  private pending: Promise<EffectiveConfigSourceSnapshot> | null = null;
  private readonly draining = new Set<Promise<void>>();
  private controller: AbortController | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: EffectiveConfigSourceOptions) {
    this.options = Object.freeze({ ...options });
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.ttlMs = options.ttlMs ?? 15_000;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxYamlBytes = options.maxYamlBytes ?? MAX_YAML_BYTES;
    this.decoderIdentity = options.format === "yaml" ? "plaintext-yaml-v1" : (options.decoderIdentity ?? "");
    if (
      !localPath(options.path) ||
      typeof options.readController !== "function" ||
      ![this.timeoutMs, this.ttlMs, this.maxFileBytes, this.maxYamlBytes].every(
        (value) => Number.isInteger(value) && value > 0,
      ) ||
      this.timeoutMs > 15_000 ||
      this.ttlMs > 60_000 ||
      this.maxFileBytes > MAX_FILE_BYTES ||
      this.maxYamlBytes > MAX_YAML_BYTES ||
      (options.format !== "yaml" && options.format !== "decoded-yaml") ||
      (options.format === "yaml" &&
        (options.decode !== undefined || options.decoderIdentity !== undefined)) ||
      (options.format === "decoded-yaml" &&
        (typeof options.decode !== "function" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(this.decoderIdentity)))
    )
      throw new Error("EFFECTIVE_CONFIG_SOURCE_OPTIONS_INVALID");
  }

  getSnapshot(): EffectiveConfigSourceSnapshot {
    if (this.snapshot.state === "candidate" && performance.now() >= this.snapshot.candidate.expiresAtMono)
      this.invalidate("EXPIRED");
    return this.snapshot;
  }

  invalidate(reason: EffectiveConfigSourceReason = "INVALIDATED"): void {
    this.generation++;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.controller?.abort(new SourceError(reason));
    this.publish(Object.freeze({ state: "unavailable", generation: this.generation, reason }));
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate("DISPOSED");
  }

  /** Cancellation settles read() early; decoder/file/controller work still belongs to this instance. */
  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.draining]).then(() => undefined);
  }

  read(): Promise<EffectiveConfigSourceSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.pending) return this.pending;
    const generation = this.generation,
      controller = new AbortController();
    this.controller = controller;
    let timeout!: ReturnType<typeof setTimeout>;
    const stopped = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      timeout = setTimeout(() => controller.abort(new SourceError("READ_TIMEOUT")), this.timeoutMs);
    });
    const work = this.readCandidate(controller.signal, generation);
    let workFinished = false;
    void work.then(
      () => {
        workFinished = true;
      },
      () => {
        workFinished = true;
      },
    );
    const result = Promise.race([work, stopped])
      .then(
        (candidate) => {
          if (this.disposed || generation !== this.generation) return this.snapshot;
          const identity = [
            candidate.sourcePathIdentity,
            candidate.fileFingerprint,
            candidate.policy.fingerprint,
            candidate.orderedRulesFingerprint,
            candidate.sourceRuleOptionsFingerprint,
          ].join(":");
          if (this.lastFileIdentity !== null && identity !== this.lastFileIdentity) {
            this.lastFileIdentity = identity;
            this.invalidate("SOURCE_CHANGED");
            return this.snapshot;
          }
          this.lastFileIdentity = identity;
          this.publish(Object.freeze({ state: "candidate", generation, candidate }));
          if (this.expiry) clearTimeout(this.expiry);
          this.expiry = setTimeout(
            () => {
              if (this.snapshot.state === "candidate" && this.snapshot.candidate === candidate)
                this.invalidate("EXPIRED");
            },
            Math.max(1, candidate.expiresAtMono - performance.now()),
          );
          this.expiry.unref?.();
          return this.snapshot;
        },
        (error: unknown) => {
          if (generation === this.generation && !this.disposed)
            this.invalidate(error instanceof SourceError ? error.code : "SOURCE_UNAVAILABLE");
          return this.snapshot;
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        if (workFinished) {
          if (this.pending === result) this.pending = null;
          if (this.controller === controller) this.controller = null;
        }
      });
    this.pending = result;
    // A deadline can return early, but a slow injected decoder/read must never start overlapping work.
    const draining = Promise.allSettled([work, result]).then(() => {
      if (this.pending === result) this.pending = null;
      if (this.controller === controller) this.controller = null;
    });
    this.draining.add(draining);
    void draining.then(() => this.draining.delete(draining));
    return result;
  }

  private async readCandidate(
    signal: AbortSignal,
    sourceGeneration: number,
  ): Promise<EffectiveConfigCandidate> {
    const startedAtMono = performance.now(),
      deadline = startedAtMono + this.timeoutMs;
    const check = () => {
      if (signal.aborted) throw signal.reason;
      if (performance.now() >= deadline) fail("READ_TIMEOUT");
    };
    const before = await readFileSample(this.options.path, this.maxFileBytes, check);
    check();
    let text: string;
    if (this.options.format === "decoded-yaml")
      text = await this.options.decode!(Uint8Array.from(before.bytes), signal);
    else text = new TextDecoder("utf-8", { fatal: true }).decode(before.bytes);
    check();
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > this.maxYamlBytes)
      fail("SOURCE_LIMIT_EXCEEDED");
    let source: JsonObject;
    try {
      source = parseSource(text, check);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      fail("SOURCE_PARSE_INVALID");
    }
    const policy = projectPolicy(source),
      parsed = parseRules(source);
    const controller = await this.options.readController(signal);
    check();
    const fieldHashes = controller.configFieldHashes;
    const pathHashes = controller.configPathHashes;
    const direct = controller.directPolicy;
    if (
      !fieldHashes ||
      !pathHashes ||
      !direct ||
      !SHA256.test(controller.fingerprint) ||
      !SHA256.test(direct.policyFingerprint) ||
      !Number.isFinite(controller.startedAtMono) ||
      !Number.isFinite(controller.completedAtMono) ||
      controller.startedAtMono! < startedAtMono ||
      controller.completedAtMono! < controller.startedAtMono! ||
      controller.completedAtMono! > performance.now() ||
      Object.keys(fieldHashes).length > 256 ||
      !Object.entries(fieldHashes).every(([key, value]) => key.length <= 128 && SHA256.test(value)) ||
      !Object.entries(fieldHashes).every(
        ([key, value]) => pathHashes[`/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`] === value,
      ) ||
      Object.keys(pathHashes).length > 4096 ||
      !Object.entries(pathHashes).every(([key, value]) => key.length <= 4096 && SHA256.test(value)) ||
      !["direct", "other", "unknown"].includes(direct.kind) ||
      !["none", "configured", "unknown"].includes(direct.dialer) ||
      ![direct.interfaceName, direct.ipVersion].every(
        (value) =>
          value === null || (typeof value === "string" && value.length <= 256 && !/[\r\n\0]/.test(value)),
      ) ||
      !Number.isFinite(direct.startedAtMono) ||
      !Number.isFinite(direct.completedAtMono) ||
      direct.startedAtMono < controller.startedAtMono! ||
      direct.completedAtMono < direct.startedAtMono ||
      direct.completedAtMono > controller.completedAtMono!
    )
      fail("CONTROLLER_COMPARISON_UNAVAILABLE");
    const expected = comparisonPaths(source, pathHashes);
    const compared = Object.keys(expected).sort();
    if (!compared.length) fail("CONTROLLER_COMPARISON_UNAVAILABLE");
    if (compared.some((key) => expected[key] !== pathHashes[key])) fail("CONFIG_MISMATCH");
    if (
      !Array.isArray(controller.rules) ||
      controller.rules.length > MAX_RULES ||
      controller.rules.some(
        (rule) =>
          !rule ||
          typeof rule.type !== "string" ||
          typeof rule.payload !== "string" ||
          typeof rule.proxy !== "string",
      )
    )
      fail("CONTROLLER_COMPARISON_UNAVAILABLE");
    const currentRules = controller.rules.map(normalizeKernelRule);
    if (digest(parsed.rules as unknown as JsonValue) !== digest(currentRules as unknown as JsonValue))
      fail("RULES_MISMATCH");
    const controllerFingerprint = controller.fingerprint,
      controllerStartedAtMono = controller.startedAtMono!,
      controllerCompletedAtMono = controller.completedAtMono!;
    const currentDirectPolicy = Object.freeze({
      kind: direct.kind,
      interfaceName: direct.interfaceName,
      dialer: direct.dialer,
      ipVersion: direct.ipVersion,
      policyFingerprint: direct.policyFingerprint,
      startedAtMono: direct.startedAtMono,
      completedAtMono: direct.completedAtMono,
    });
    const after = await readFileSample(this.options.path, this.maxFileBytes, check);
    check();
    if (
      before.identity !== after.identity ||
      before.contentHash !== after.contentHash ||
      before.pathIdentity !== after.pathIdentity
    )
      fail("SOURCE_CHANGED");
    const completedAtMono = performance.now();
    return Object.freeze({
      kind: "local-config-candidate",
      runtimeConfigurationProven: false,
      sourceGeneration,
      sourcePathIdentity: before.pathIdentity,
      fileFingerprint: before.contentHash,
      decoderIdentity: this.decoderIdentity,
      startedAtMono,
      completedAtMono,
      expiresAtMono: completedAtMono + this.ttlMs,
      controllerFingerprint,
      controllerStartedAtMono,
      controllerCompletedAtMono,
      comparedConfigFields: Object.freeze(compared),
      comparedRuleCount: parsed.rules.length,
      orderedRulesFingerprint: digest(parsed.rules as unknown as JsonValue),
      sourceRuleOptionsFingerprint: digest(parsed.options),
      rules: Object.freeze(parsed.rules.map((rule) => Object.freeze(rule))),
      ruleParameters: Object.freeze(parsed.options.map((parameters) => Object.freeze(parameters))),
      policy,
      currentDirectPolicy,
    });
  }

  private publish(snapshot: EffectiveConfigSourceSnapshot): void {
    this.snapshot = snapshot;
    this.options.onChange?.(snapshot);
  }
}
