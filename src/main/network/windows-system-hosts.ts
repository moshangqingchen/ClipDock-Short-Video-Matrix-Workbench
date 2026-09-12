import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path, { win32 } from "node:path";
import { domainToASCII } from "node:url";

const MAX_HOSTS = 64;
const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 32768;
const MAX_LINE_BYTES = 8192;
const MAX_ADDRESSES = 128;
const TIMEOUT_MS = 5000;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export interface WindowsSystemHostsTarget {
  readonly host: string;
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
}
export type WindowsSystemHostsReason =
  | "INPUT_INVALID"
  | "UNSUPPORTED_PLATFORM"
  | "PATH_UNAVAILABLE"
  | "FILE_UNAVAILABLE"
  | "FILE_CHANGED"
  | "FILE_TOO_LARGE"
  | "SYNTAX_UNVERIFIED"
  | "READ_BUSY"
  | "READ_TIMEOUT"
  | "READ_CANCELLED"
  | "INVALIDATED"
  | "DISPOSED";
export type WindowsSystemHostsSnapshot =
  | Readonly<{
      available: true;
      kind: "windows-system-hosts-targets";
      source: "windows-system-hosts-file" | "explicit-test-hosts-file";
      /** File contents only. This is not evidence that Chromium/mihomo consults this file. */
      resolutionProven: false;
      parserProfile: "windows-hosts-ascii-aliases-v1";
      scopeHash: string;
      fileHash: string;
      fileIdentity: string;
      startedAtMono: number;
      completedAtMono: number;
      hosts: readonly WindowsSystemHostsTarget[];
    }>
  | Readonly<{
      available: false;
      reason: WindowsSystemHostsReason;
      startedAtMono: number;
      completedAtMono: number;
    }>;
export type WindowsSystemHostsObservation = Extract<WindowsSystemHostsSnapshot, { available: true }>;
export interface WindowsSystemHostsReaderOptions {
  /** Explicit synthetic test file only; results retain a distinct source tag. Never set from IPC. */
  hostsPath?: string;
  /** Test seam. Production uses the actual platform. */
  platform?: NodeJS.Platform;
  /** Tests may shorten the deadline; cannot exceed the production bound. */
  timeoutMs?: number;
}
class HostsError extends Error {
  constructor(readonly reason: WindowsSystemHostsReason) {
    super(reason);
  }
}
const fail = (reason: WindowsSystemHostsReason): never => {
  throw new HostsError(reason);
};

function hostname(raw: string, target: boolean): string {
  if (typeof raw !== "string" || raw.length > 1024 || /[\s\\/:@?#*%]/u.test(raw))
    return fail(target ? "INPUT_INVALID" : "SYNTAX_UNVERIFIED");
  // File aliases are an explicitly reviewed ASCII subset. Unsupported Unicode data remains unknown.
  if (!target && [...raw].some((character) => character.charCodeAt(0) > 127))
    return fail("SYNTAX_UNVERIFIED");
  const value = domainToASCII(raw.endsWith(".") ? raw.slice(0, -1) : raw).toLowerCase();
  const labels = value.split(".");
  if (
    !value ||
    value.length > 253 ||
    isIP(value) ||
    (target && labels.length < 2) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^\d+$/.test(labels.at(-1)!)
  )
    return fail(target ? "INPUT_INVALID" : "SYNTAX_UNVERIFIED");
  return value;
}
function localPath(value: string, testFile: boolean): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return fail("PATH_UNAVAILABLE");
  if (/^[a-z]:[\\/]/i.test(value)) {
    if (value.slice(2).includes(":") || /[<>"|?*]/.test(value)) return fail("PATH_UNAVAILABLE");
    const normalized = win32.normalize(value);
    if (normalized.split("\\").some((part) => /[. ]$/.test(part))) return fail("PATH_UNAVAILABLE");
    return normalized;
  }
  if (testFile && process.platform !== "win32" && path.isAbsolute(value) && !value.startsWith("//"))
    return path.normalize(value);
  return fail("PATH_UNAVAILABLE");
}
const pathKey = (value: string) => (/^[a-z]:[\\/]/i.test(value) ? value.toLowerCase() : value);
type IdentityStat = Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;
function identity(value: IdentityStat, canonical: string): string {
  const record = value as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  if (
    ![record.dev, record.ino, record.size, record.mtimeNs, record.ctimeNs].every(
      (field) => typeof field === "bigint",
    )
  )
    return fail("FILE_UNAVAILABLE");
  return hash(
    [pathKey(canonical), record.dev, record.ino, record.size, record.mtimeNs, record.ctimeNs]
      .map(String)
      .join("\0"),
  );
}
interface FileSample {
  bytes: Buffer;
  fileHash: string;
  fileIdentity: string;
}
async function readSample(filePath: string, testFile: boolean, check: () => void): Promise<FileSample> {
  check();
  const resolved = localPath(await realpath(filePath), testFile);
  check();
  if (pathKey(filePath) !== pathKey(resolved)) return fail("PATH_UNAVAILABLE");
  const entry = await lstat(filePath, { bigint: true });
  check();
  if (!entry.isFile() || entry.isSymbolicLink()) return fail("PATH_UNAVAILABLE");
  const file = await open(filePath, "r");
  let buffer: Buffer | null = null;
  try {
    check();
    const before = await file.stat({ bigint: true });
    check();
    if (!before.isFile() || before.size < 0n) return fail("FILE_UNAVAILABLE");
    if (before.size > BigInt(MAX_BYTES)) return fail("FILE_TOO_LARGE");
    if (identity(entry, resolved) !== identity(before, resolved)) return fail("FILE_CHANGED");
    buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      check();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      check();
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    check();
    if (offset !== Number(before.size) || identity(before, resolved) !== identity(after, resolved))
      return fail("FILE_CHANGED");
    const bytes = Buffer.from(buffer.subarray(0, offset));
    return { bytes, fileHash: hash(bytes), fileIdentity: identity(after, resolved) };
  } finally {
    buffer?.fill(0);
    await file.close();
  }
}
function parse(
  bytes: Buffer,
  targets: readonly string[],
  check: () => void,
): readonly WindowsSystemHostsTarget[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("SYNTAX_UNVERIFIED");
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > MAX_LINES) return fail("FILE_TOO_LARGE");
  const values = new Map(targets.map((host) => [host, { ipv4: new Set<string>(), ipv6: new Set<string>() }]));
  for (const line of lines) {
    check();
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return fail("FILE_TOO_LARGE");
    const data = line.split("#", 1)[0];
    if (
      [...data].some((character) => {
        const code = character.charCodeAt(0);
        return code !== 9 && (code < 32 || code > 126);
      })
    )
      return fail("SYNTAX_UNVERIFIED");
    const fields = data.trim().split(/[ \t]+/);
    if (fields.length === 1 && fields[0] === "") continue;
    if (fields.length < 2 || fields.length > 257) return fail("SYNTAX_UNVERIFIED");
    const [rawAddress, ...rawAliases] = fields;
    const family = isIP(rawAddress);
    if (!family || rawAddress.includes("%")) return fail("SYNTAX_UNVERIFIED");
    const address = family === 6 ? new URL(`http://[${rawAddress}]`).hostname.slice(1, -1) : rawAddress;
    // Validate every data token, even on unrelated lines. Unknown syntax cannot prove target absence.
    const aliases = rawAliases.map((alias) => hostname(alias, false));
    for (const alias of aliases) {
      const target = values.get(alias);
      if (!target) continue;
      target[family === 4 ? "ipv4" : "ipv6"].add(address);
      if (target.ipv4.size + target.ipv6.size > MAX_ADDRESSES) return fail("FILE_TOO_LARGE");
    }
  }
  return Object.freeze(
    targets.map((host) =>
      Object.freeze({
        host,
        ipv4: Object.freeze([...values.get(host)!.ipv4].sort()),
        ipv6: Object.freeze([...values.get(host)!.ipv6].sort()),
      }),
    ),
  );
}

/** Exact-target file observation. No DNS/HTTP/Session, effective resolver assertion or persisted cache. */
export class WindowsSystemHostsReader {
  private readonly timeoutMs: number;
  private active: AbortController | null = null;
  private pending: Promise<WindowsSystemHostsSnapshot> | null = null;
  private pendingKey: string | null = null;
  private readonly draining = new Set<Promise<void>>();
  private disposed = false;
  constructor(private readonly options: WindowsSystemHostsReaderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > TIMEOUT_MS)
      throw Error("WINDOWS_SYSTEM_HOSTS_OPTIONS_INVALID");
  }
  read(hosts: readonly string[], signal?: AbortSignal): Promise<WindowsSystemHostsSnapshot> {
    const startedAtMono = performance.now();
    const unavailable = (reason: WindowsSystemHostsReason): WindowsSystemHostsSnapshot =>
      Object.freeze({
        available: false,
        reason,
        startedAtMono,
        completedAtMono: performance.now(),
      });
    if (this.disposed || signal?.aborted)
      return Promise.resolve(unavailable(this.disposed ? "DISPOSED" : "READ_CANCELLED"));
    let targets: string[];
    try {
      if (!Array.isArray(hosts) || !hosts.length || hosts.length > MAX_HOSTS)
        return Promise.resolve(unavailable("INPUT_INVALID"));
      targets = [...new Set(hosts.map((host) => hostname(host, true)))].sort();
    } catch {
      return Promise.resolve(unavailable("INPUT_INVALID"));
    }
    const scopeHash = hash(JSON.stringify(targets));
    if (this.pending) {
      if (scopeHash !== this.pendingKey) return Promise.resolve(unavailable("READ_BUSY"));
      this.join(signal, this.active!, this.pending);
      return this.pending;
    }
    const abort = new AbortController();
    this.active = abort;
    this.pendingKey = scopeHash;
    const deadline = startedAtMono + this.timeoutMs;
    const check = () => {
      if (this.disposed) return fail("DISPOSED");
      if (abort.signal.aborted) throw abort.signal.reason;
      if (performance.now() >= deadline) return fail("READ_TIMEOUT");
    };
    const timer = setTimeout(() => abort.abort(new HostsError("READ_TIMEOUT")), this.timeoutMs);
    const work = (async (): Promise<WindowsSystemHostsSnapshot> => {
      check();
      if ((this.options.platform ?? process.platform) !== "win32") return fail("UNSUPPORTED_PLATFORM");
      const testFile = this.options.hostsPath !== undefined;
      const filePath = testFile
        ? localPath(this.options.hostsPath!, true)
        : win32.join(localPath(process.env.SystemRoot ?? "", false), "System32", "drivers", "etc", "hosts");
      const before = await readSample(filePath, testFile, check);
      let after: FileSample | null = null;
      try {
        check();
        const scoped = parse(before.bytes, targets, check);
        after = await readSample(filePath, testFile, check);
        check();
        if (before.fileHash !== after.fileHash || before.fileIdentity !== after.fileIdentity)
          return fail("FILE_CHANGED");
        return Object.freeze({
          available: true,
          kind: "windows-system-hosts-targets",
          source: testFile ? "explicit-test-hosts-file" : "windows-system-hosts-file",
          resolutionProven: false,
          parserProfile: "windows-hosts-ascii-aliases-v1",
          scopeHash,
          fileHash: after.fileHash,
          fileIdentity: after.fileIdentity,
          startedAtMono,
          completedAtMono: performance.now(),
          hosts: scoped,
        });
      } finally {
        before.bytes.fill(0);
        after?.bytes.fill(0);
      }
    })();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    const result = Promise.race([work, cancelled]).catch((error: unknown) =>
      unavailable(error instanceof HostsError ? error.reason : "FILE_UNAVAILABLE"),
    );
    this.pending = result;
    this.join(signal, abort, result);
    const draining = Promise.allSettled([work, result]).then(() => {
      clearTimeout(timer);
      if (this.pending === result) {
        this.pending = null;
        this.pendingKey = null;
        this.active = null;
      }
    });
    this.draining.add(draining);
    void draining.then(() => this.draining.delete(draining));
    return result;
  }
  invalidate(): void {
    this.active?.abort(new HostsError("INVALIDATED"));
  }
  dispose(): void {
    this.disposed = true;
    this.active?.abort(new HostsError("DISPOSED"));
  }
  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.draining]).then(() => undefined);
  }
  private join(signal: AbortSignal | undefined, abort: AbortController, result: Promise<unknown>): void {
    if (!signal) return;
    const cancel = () => abort.abort(new HostsError("READ_CANCELLED"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void result.finally(() => signal.removeEventListener("abort", cancel));
  }
}
