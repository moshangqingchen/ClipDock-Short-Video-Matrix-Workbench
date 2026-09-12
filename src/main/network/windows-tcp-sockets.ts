import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { win32 } from "node:path";
import { z } from "zod";
import { executablePathIdentity } from "./connection-evidence";
import { WindowsFixedReadWorker } from "./windows-fixed-read-worker";
import { WINDOWS_NATIVE_TCP_TABLE_CSHARP } from "./windows-native-tcp-table";

const MAX_BYTES = 384 * 1024;
const MAX_ROWS = 1_024;
const TIMEOUT_MS = 6_000;
const pidSchema = z.number().int().min(1).max(0xffff_ffff);
const portSchema = z.number().int().min(1).max(65_535);
const ticksSchema = z
  .string()
  .regex(/^[1-9]\d{15,18}$/)
  .refine((value) => BigInt(value) <= 3_155_378_975_999_999_999n);

function normalizeIp(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  return new URL(`http://[${value}]`).hostname.slice(1, -1);
}

const ipSchema = z
  .string()
  .max(64)
  .refine((value) => normalizeIp(value) !== null);
const remoteSchema = z.strictObject({ address: ipSchema, port: portSchema });
const querySchema = z.strictObject({
  ownerPids: z.array(pidSchema).min(1).max(32),
  remotes: z.array(remoteSchema).min(1).max(32),
});

export interface WindowsTcpSocketScope {
  ownerPids: readonly number[];
  remotes: readonly Readonly<{ address: string; port: number }>[];
}

/** Path identity is a normalized-path hash, never a binary digest or code signature. */
export interface WindowsTcpOwnerIdentity {
  readonly pid: number;
  readonly createdAtTicks: string;
  readonly executablePathIdentity: string;
}

/** Main-process memory only. Never send socket tuples, PID or executable identities to renderer. */
export interface WindowsTcpSocketRow {
  readonly ownerPid: number;
  readonly sourceAddress: string;
  readonly sourcePort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: string;
}

export type WindowsTcpSocketSnapshot =
  | Readonly<{
      available: true;
      startedAtMono: number;
      completedAtMono: number;
      scopeHash: string;
      owners: readonly WindowsTcpOwnerIdentity[];
      sockets: readonly WindowsTcpSocketRow[];
    }>
  | Readonly<{ available: false; startedAtMono: number; completedAtMono: number }>;

// stdin is JSON data, not PowerShell source. No PID, address, port or user input is interpolated.
const READ_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$clipdockScope = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;
${WINDOWS_NATIVE_TCP_TABLE_CSHARP}
public sealed class ClipdockTcpIdentity {
  public uint Pid;
  public string CreatedAtTicks;
  public string ExecutablePath;
}
public static class ClipdockTcpProcess {
  [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static ClipdockTcpIdentity Read(uint pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION only.
    if (handle == IntPtr.Zero) throw new InvalidOperationException("TCP_OWNER_UNAVAILABLE");
    try {
      uint status;
      FileTime created, exited, kernel, user;
      if (!GetExitCodeProcess(handle, out status) || status != 259 ||
          !GetProcessTimes(handle, out created, out exited, out kernel, out user))
        throw new InvalidOperationException("TCP_OWNER_UNAVAILABLE");
      var buffer = new StringBuilder(4096); uint length = 4096;
      if (!QueryFullProcessImageNameW(handle, 0, buffer, ref length) || length == 0 || length >= 4096 ||
          !GetExitCodeProcess(handle, out status) || status != 259)
        throw new InvalidOperationException("TCP_OWNER_UNAVAILABLE");
      long fileTime = ((long)created.High << 32) | created.Low;
      return new ClipdockTcpIdentity {
        Pid = pid,
        CreatedAtTicks = DateTime.FromFileTimeUtc(fileTime).Ticks.ToString(CultureInfo.InvariantCulture),
        ExecutablePath = buffer.ToString()
      };
    } finally { CloseHandle(handle); }
  }
}
'@
function Read-ClipdockOwners {
  @($clipdockScope.ownerPids | ForEach-Object {
    $clipdockIdentity = [ClipdockTcpProcess]::Read([uint32]$_)
    [ordered]@{
      pid = [long]$clipdockIdentity.Pid
      createdAtTicks = $clipdockIdentity.CreatedAtTicks
      executablePath = [string]$clipdockIdentity.ExecutablePath
    }
  })
}
$clipdockOwnersBefore = @(Read-ClipdockOwners)
$clipdockSockets = @([ClipdockNativeTcpTable]::ReadForOwners([uint32[]]$clipdockScope.ownerPids) | Where-Object {
  $clipdockConnection = $_
  if ($clipdockScope.ownerPids -notcontains [long]$clipdockConnection.OwningProcess) { return $false }
  foreach ($clipdockRemote in $clipdockScope.remotes) {
    if ([int]$clipdockRemote.port -eq [int]$clipdockConnection.RemotePort -and
        [Net.IPAddress]::Parse([string]$clipdockRemote.address).Equals([Net.IPAddress]::Parse([string]$clipdockConnection.RemoteAddress))) {
      return $true
    }
  }
  return $false
} | ForEach-Object {
  [ordered]@{
    ownerPid = [long]$_.OwningProcess
    sourceAddress = [string]$_.LocalAddress; sourcePort = [int]$_.LocalPort
    remoteAddress = [string]$_.RemoteAddress; remotePort = [int]$_.RemotePort
    state = [string]$_.State
  }
})
$clipdockOwnersAfter = @(Read-ClipdockOwners)
[ordered]@{ before = $clipdockOwnersBefore; sockets = $clipdockSockets; after = $clipdockOwnersAfter } |
  ConvertTo-Json -Depth 6 -Compress
`;

function runFixedRead(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let inputFailed = false;
    const child = execFile(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT],
      { windowsHide: true, shell: false, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES },
      (error, stdout) => {
        if (error || inputFailed) reject(new Error("WINDOWS_TCP_READ_UNAVAILABLE"));
        else resolve(stdout);
      },
    );
    if (!child.stdin) {
      inputFailed = true;
      child.kill();
      return;
    }
    child.stdin.once("error", () => {
      inputFailed = true;
    });
    child.stdin.end(input);
  });
}

export function createTcpSocketWorker(): WindowsFixedReadWorker {
  return new WindowsFixedReadWorker(READ_SCRIPT, MAX_BYTES);
}

const ownerSchema = z.strictObject({
  pid: pidSchema,
  createdAtTicks: ticksSchema,
  executablePath: z
    .string()
    .min(4)
    .max(4_096)
    .regex(/^[a-z]:[\\/]/i),
});
const socketSchema = z.strictObject({
  ownerPid: pidSchema,
  sourceAddress: ipSchema,
  sourcePort: portSchema,
  remoteAddress: ipSchema,
  remotePort: portSchema,
  state: z.enum([
    "Closed",
    "Listen",
    "SynSent",
    "SynReceived",
    "Established",
    "FinWait1",
    "FinWait2",
    "CloseWait",
    "Closing",
    "LastAck",
    "TimeWait",
    "DeleteTCB",
    "Bound",
  ]),
});
const responseSchema = z.strictObject({
  before: z.array(ownerSchema).min(1).max(32),
  sockets: z.array(socketSchema).max(MAX_ROWS),
  after: z.array(ownerSchema).min(1).max(32),
});

function tuple(row: WindowsTcpSocketRow): string {
  return JSON.stringify([row.ownerPid, row.sourceAddress, row.sourcePort, row.remoteAddress, row.remotePort]);
}

function ownersKey(owners: readonly WindowsTcpOwnerIdentity[]): string {
  return JSON.stringify([...owners].sort((a, b) => a.pid - b.pid));
}

export interface WindowsTcpSocketReaderOptions {
  /** Tests only. The default transport always runs the fixed bounded command. */
  runner?: (input: string) => Promise<string>;
  platform?: NodeJS.Platform;
}

/** One controlled probe window per reader. Any failed read permanently invalidates this reader. */
export class WindowsTcpSocketReader {
  private readonly input: string;
  private readonly scopeHash: string;
  private readonly ownerPids: ReadonlySet<number>;
  private readonly remotes: ReadonlySet<string>;
  private identityKey: string | null = null;
  private invalidated = false;
  private pending: Promise<WindowsTcpSocketSnapshot> | null = null;

  constructor(
    scope: WindowsTcpSocketScope,
    private readonly options: WindowsTcpSocketReaderOptions = {},
  ) {
    try {
      const parsed = querySchema.parse(scope);
      const ownerPids = [...parsed.ownerPids].sort((a, b) => a - b);
      const remotes = parsed.remotes
        .map((remote) => ({ address: normalizeIp(remote.address)!, port: remote.port }))
        .sort((a, b) => a.address.localeCompare(b.address, "en") || a.port - b.port);
      this.ownerPids = new Set(ownerPids);
      this.remotes = new Set(remotes.map((remote) => JSON.stringify([remote.address, remote.port])));
      if (
        this.ownerPids.size !== ownerPids.length ||
        this.remotes.size !== remotes.length ||
        remotes.some((remote) => ["0.0.0.0", "::"].includes(remote.address))
      )
        throw new Error();
      this.input = JSON.stringify({ ownerPids, remotes });
      this.scopeHash = createHash("sha256").update(this.input).digest("hex");
    } catch {
      throw new Error("WINDOWS_TCP_SCOPE_INVALID");
    }
  }

  read(): Promise<WindowsTcpSocketSnapshot> {
    if (this.pending) return this.pending;
    const pending = this.readOnce();
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    return pending;
  }

  private async readOnce(): Promise<WindowsTcpSocketSnapshot> {
    const startedAtMono = performance.now();
    try {
      if (this.invalidated || (this.options.platform ?? process.platform) !== "win32") throw new Error();
      const raw = await (this.options.runner ?? runFixedRead)(this.input);
      if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error();
      const response = responseSchema.parse(JSON.parse(raw));
      const projectOwners = (rows: z.infer<typeof ownerSchema>[]): readonly WindowsTcpOwnerIdentity[] => {
        if (rows.length !== this.ownerPids.size || new Set(rows.map((row) => row.pid)).size !== rows.length)
          throw new Error();
        return Object.freeze(
          rows
            .map((row) => {
              if (!this.ownerPids.has(row.pid)) throw new Error();
              const pathIdentity = executablePathIdentity(row.executablePath);
              if (!pathIdentity) throw new Error();
              return Object.freeze({
                pid: row.pid,
                createdAtTicks: row.createdAtTicks,
                executablePathIdentity: pathIdentity,
              });
            })
            .sort((a, b) => a.pid - b.pid),
        );
      };
      const before = projectOwners(response.before);
      const after = projectOwners(response.after);
      const identityKey = ownersKey(before);
      if (identityKey !== ownersKey(after) || (this.identityKey !== null && identityKey !== this.identityKey))
        throw new Error();
      const sockets = response.sockets.map((row) => {
        const sourceAddress = normalizeIp(row.sourceAddress)!;
        const remoteAddress = normalizeIp(row.remoteAddress)!;
        if (
          !this.ownerPids.has(row.ownerPid) ||
          !this.remotes.has(JSON.stringify([remoteAddress, row.remotePort])) ||
          isIP(sourceAddress) !== isIP(remoteAddress)
        )
          throw new Error();
        return Object.freeze({ ...row, sourceAddress, remoteAddress });
      });
      if (new Set(sockets.map(tuple)).size !== sockets.length) throw new Error();
      this.identityKey = identityKey;
      return Object.freeze({
        available: true,
        startedAtMono,
        completedAtMono: performance.now(),
        scopeHash: this.scopeHash,
        owners: after,
        sockets: Object.freeze(sockets),
      });
    } catch {
      this.invalidated = true;
      return Object.freeze({ available: false, startedAtMono, completedAtMono: performance.now() });
    }
  }
}

export interface ControlledTcpProbeWindow {
  contextId: string;
  generation: number;
  startedAtMono: number;
  completedAtMono: number;
  /** Caller must enforce these across every process in the scope, not just one Session. */
  completeOwnerScope: boolean;
  ownerTrafficExclusive: boolean;
  connectionPoolsDrainedBeforeBaseline: boolean;
  singleRequestWithoutPreconnect: boolean;
}

export interface CdpTcpResponse {
  remoteIPAddress: string;
  remotePort: number;
  protocol: string;
  connectionReused: boolean;
  fromDiskCache: boolean;
  fromServiceWorker: boolean;
  fromPrefetchCache: boolean;
  requestServedFromCache: boolean;
  requestStartedAtMono: number;
  responseReceivedAtMono: number;
}

export type ControlledTcpCorrelation =
  | {
      matched: false;
      reason:
        | "CONTROL_WINDOW_UNPROVEN"
        | "READ_UNAVAILABLE"
        | "CONTEXT_MISMATCH"
        | "STALE_WINDOW"
        | "UNSUITABLE_RESPONSE"
        | "EXISTING_SOCKET"
        | "NO_MATCH"
        | "AMBIGUOUS_MATCH";
    }
  | {
      matched: true;
      basis: "caller-controlled-cold-window";
      /** TCP table uniqueness never independently proves Chromium Session ownership. */
      sessionOwnershipProven: false;
      contextId: string;
      generation: number;
      owner: WindowsTcpOwnerIdentity;
      socket: WindowsTcpSocketRow;
    };

/** Pure correlation only. No controller chains, Session grant, egress or TLS claim is produced. */
export function correlateControlledTcpSocket(
  window: ControlledTcpProbeWindow,
  response: CdpTcpResponse,
  before: WindowsTcpSocketSnapshot,
  after: WindowsTcpSocketSnapshot,
  nowMono: number,
  maxWindowMs = 15_000,
): ControlledTcpCorrelation {
  if (
    window.completeOwnerScope !== true ||
    window.ownerTrafficExclusive !== true ||
    window.connectionPoolsDrainedBeforeBaseline !== true ||
    window.singleRequestWithoutPreconnect !== true ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(window.contextId) ||
    !Number.isSafeInteger(window.generation) ||
    window.generation < 0
  )
    return { matched: false, reason: "CONTROL_WINDOW_UNPROVEN" };
  if (!before.available || !after.available) return { matched: false, reason: "READ_UNAVAILABLE" };
  if (before.scopeHash !== after.scopeHash || ownersKey(before.owners) !== ownersKey(after.owners))
    return { matched: false, reason: "CONTEXT_MISMATCH" };
  const times = [
    window.startedAtMono,
    before.startedAtMono,
    before.completedAtMono,
    response.requestStartedAtMono,
    response.responseReceivedAtMono,
    after.startedAtMono,
    after.completedAtMono,
    window.completedAtMono,
    nowMono,
  ];
  if (
    !times.every((value) => Number.isFinite(value) && value >= 0) ||
    times.some((value, index) => index > 0 && value < times[index - 1]) ||
    !Number.isFinite(maxWindowMs) ||
    maxWindowMs <= 0 ||
    maxWindowMs > 30_000 ||
    nowMono - window.startedAtMono >= maxWindowMs
  )
    return { matched: false, reason: "STALE_WINDOW" };
  const remoteAddress = normalizeIp(response.remoteIPAddress);
  if (
    !remoteAddress ||
    !portSchema.safeParse(response.remotePort).success ||
    !["http/1.0", "http/1.1", "h2"].includes(response.protocol) ||
    response.connectionReused !== false ||
    response.fromDiskCache !== false ||
    response.fromServiceWorker !== false ||
    response.fromPrefetchCache !== false ||
    response.requestServedFromCache !== false
  )
    return { matched: false, reason: "UNSUITABLE_RESPONSE" };
  const matchesRemote = (row: WindowsTcpSocketRow) =>
    row.remoteAddress === remoteAddress && row.remotePort === response.remotePort;
  // Even a second new tuple cannot rescue a dirty baseline: pools were not actually cold.
  if (before.sockets.some(matchesRemote)) return { matched: false, reason: "EXISTING_SOCKET" };
  const candidates = after.sockets.filter(matchesRemote);
  if (!candidates.length) return { matched: false, reason: "NO_MATCH" };
  if (candidates.length !== 1) return { matched: false, reason: "AMBIGUOUS_MATCH" };
  const socket = candidates[0];
  const owner = after.owners.find((entry) => entry.pid === socket.ownerPid);
  if (!owner || socket.state !== "Established" || before.sockets.some((row) => tuple(row) === tuple(socket)))
    return { matched: false, reason: "NO_MATCH" };
  return {
    matched: true,
    basis: "caller-controlled-cold-window",
    sessionOwnershipProven: false,
    contextId: window.contextId,
    generation: window.generation,
    owner,
    socket,
  };
}
