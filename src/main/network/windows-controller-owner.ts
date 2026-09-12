import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { win32 } from "node:path";
import { z } from "zod";
import { executablePathIdentity } from "./connection-evidence";
import { WindowsFixedReadWorker } from "./windows-fixed-read-worker";
import { WINDOWS_NATIVE_TCP_TABLE_CSHARP } from "./windows-native-tcp-table";

const MAX_BYTES = 96 * 1024;
const MAX_LISTENERS = 64;
const TIMEOUT_MS = 6_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pidSchema = z.number().int().min(1).max(0xffff_ffff);
const portSchema = z.number().int().min(1).max(65_535);
const ownerSchema = z.strictObject({
  pid: pidSchema,
  createdAtTicks: z
    .string()
    .regex(/^[1-9]\d{15,18}$/)
    .refine((value) => BigInt(value) <= 3_155_378_975_999_999_999n),
  executablePath: z
    .string()
    .min(4)
    .max(4096)
    .regex(/^[a-z]:[\\/]/i)
    .nullable(),
});
const listenerSchema = z.strictObject({
  ownerPid: pidSchema,
  address: z
    .string()
    .max(64)
    .refine((value) => isIP(value) !== 0 && !value.includes("%")),
  port: portSchema,
  state: z.literal("Listen"),
});
const passSchema = z.strictObject({
  listeners: z.array(listenerSchema).min(1).max(MAX_LISTENERS),
  owners: z.array(ownerSchema).min(1).max(MAX_LISTENERS),
});
const responseSchema = z.strictObject({ before: passSchema, after: passSchema });

export interface WindowsControllerOwnerScope {
  /** Same literal loopback HTTP origin accepted by ClashReader; no DNS, credentials or path. */
  readonly controllerUrl: string;
}
export interface WindowsControllerListener {
  readonly address: string;
  readonly addressFamily: "ipv4" | "ipv6";
  readonly port: number;
  /** A :: listener alone never establishes coverage of an IPv4 endpoint. */
  readonly coverage: "exact" | "same-family-wildcard" | "cross-family-unverified";
}
export interface WindowsControllerProcessIdentity {
  readonly pid: number;
  readonly createdAtTicks: string;
  /** Normalized executable path hash, not a binary hash/signature; null means unreadable, not inferred. */
  readonly executablePathIdentity: string | null;
}
export type WindowsControllerOwnerSnapshot =
  | Readonly<{
      available: true;
      basis: "windows-controller-listener";
      startedAtMono: number;
      completedAtMono: number;
      scopeHash: string;
      owner: WindowsControllerProcessIdentity;
      listeners: readonly WindowsControllerListener[];
      /** Observed PID/start/path/listener generation; not a claim about binary or HTTP server content. */
      kernelEpoch: string;
    }>
  | Readonly<{
      available: false;
      startedAtMono: number;
      completedAtMono: number;
      reason: "READ_UNAVAILABLE" | "READ_CANCELLED" | "READ_TIMEOUT" | "DISPOSED";
    }>;
type UnavailableReason = Extract<WindowsControllerOwnerSnapshot, { available: false }>["reason"];

// Fixed read-only program. Caller data is stdin JSON, never PowerShell code or arguments.
// IPv4 candidates also include :: to detect a conflicting possible dual-stack owner. No dual-stack inference.
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
public sealed class ClipdockControllerIdentity {
  public uint Pid;
  public string CreatedAtTicks;
  public string ExecutablePath;
}
public static class ClipdockControllerProcess {
  [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static ClipdockControllerIdentity Read(uint pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION only.
    if (handle == IntPtr.Zero) throw new InvalidOperationException("CONTROLLER_OWNER_UNAVAILABLE");
    try {
      uint status;
      FileTime created, exited, kernel, user;
      if (!GetExitCodeProcess(handle, out status) || status != 259 ||
          !GetProcessTimes(handle, out created, out exited, out kernel, out user))
        throw new InvalidOperationException("CONTROLLER_OWNER_UNAVAILABLE");
      var buffer = new StringBuilder(4096); uint length = 4096;
      string executable = QueryFullProcessImageNameW(handle, 0, buffer, ref length) && length > 0 && length < 4096
        ? buffer.ToString() : null;
      if (!GetExitCodeProcess(handle, out status) || status != 259)
        throw new InvalidOperationException("CONTROLLER_OWNER_UNAVAILABLE");
      long fileTime = ((long)created.High << 32) | created.Low;
      return new ClipdockControllerIdentity {
        Pid = pid,
        CreatedAtTicks = DateTime.FromFileTimeUtc(fileTime).Ticks.ToString(CultureInfo.InvariantCulture),
        ExecutablePath = executable
      };
    } finally { CloseHandle(handle); }
  }
}
'@
function Read-ClipdockController {
  $clipdockRows = @([ClipdockNativeTcpTable]::ReadListeners([int]$clipdockScope.port) | Where-Object {
    $clipdockAddress = [Net.IPAddress]::Parse([string]$_.LocalAddress)
    $clipdockAddress.Equals([Net.IPAddress]::Parse([string]$clipdockScope.address)) -or
      $clipdockAddress.Equals([Net.IPAddress]::IPv6Any) -or
      ($clipdockScope.address -eq '127.0.0.1' -and $clipdockAddress.Equals([Net.IPAddress]::Any))
  })
  if ($clipdockRows.Count -lt 1 -or $clipdockRows.Count -gt 64) { throw 'CONTROLLER_LISTENER_UNAVAILABLE' }
  $clipdockOwnerIds = @($clipdockRows | ForEach-Object {
    if ($null -eq $_.OwningProcess -or $null -eq $_.LocalAddress -or $null -eq $_.LocalPort -or $null -eq $_.State) { throw 'CONTROLLER_LISTENER_UNAVAILABLE' }
    [long]$_.OwningProcess
  } | Sort-Object -Unique)
  if ($clipdockOwnerIds.Count -ne 1) { throw 'CONTROLLER_OWNER_AMBIGUOUS' }
  $clipdockOwners = @($clipdockOwnerIds | ForEach-Object {
    $clipdockIdentity = [ClipdockControllerProcess]::Read([uint32]$_)
    [ordered]@{
      pid = [long]$clipdockIdentity.Pid
      createdAtTicks = $clipdockIdentity.CreatedAtTicks
      executablePath = $(if ($null -eq $clipdockIdentity.ExecutablePath) { $null } else { [string]$clipdockIdentity.ExecutablePath })
    }
  })
  [ordered]@{
    listeners = @($clipdockRows | ForEach-Object {
      [ordered]@{ ownerPid = [long]$_.OwningProcess; address = [string]$_.LocalAddress; port = [int]$_.LocalPort; state = [string]$_.State }
    })
    owners = $clipdockOwners
  }
}
$clipdockBefore = Read-ClipdockController
$clipdockAfter = Read-ClipdockController
[ordered]@{ before = $clipdockBefore; after = $clipdockAfter } | ConvertTo-Json -Depth 6 -Compress
`;

function runFixedRead(input: string, signal: AbortSignal): Promise<string> {
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
      {
        windowsHide: true,
        shell: false,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BYTES,
        signal,
      },
      (error, stdout) => {
        if (error || inputFailed) reject(new Error("WINDOWS_CONTROLLER_READ_UNAVAILABLE"));
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
      child.kill();
    });
    child.stdin.end(input);
  });
}
export function createControllerOwnerWorker(): WindowsFixedReadWorker {
  return new WindowsFixedReadWorker(READ_SCRIPT, MAX_BYTES);
}

export interface WindowsControllerOwnerReaderOptions {
  /** Tests only. Default transport always runs the fixed bounded read-only PowerShell program. */
  runner?: (input: string, signal: AbortSignal) => Promise<string>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/** Main-process input only. Missing/ambiguous/changed ownership cannot produce a lifecycle epoch. */
export class WindowsControllerOwnerReader {
  private readonly input: string;
  private readonly address: string;
  private readonly port: number;
  private readonly scopeHash: string;
  private readonly options: Readonly<WindowsControllerOwnerReaderOptions>;
  private readonly timeoutMs: number;
  private pending: Promise<WindowsControllerOwnerSnapshot> | null = null;
  private readonly draining = new Set<Promise<void>>();
  private controller: AbortController | null = null;
  private disposed = false;
  private readonly subscriptions = new Map<AbortSignal, () => void>();

  constructor(scope: WindowsControllerOwnerScope, options: WindowsControllerOwnerReaderOptions = {}) {
    this.options = Object.freeze({ ...options });
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    try {
      const { controllerUrl } = z.strictObject({ controllerUrl: z.string().max(128) }).parse(scope);
      // Validate the literal form before URL normalization (127.1, integer IP, encoded hosts are refused).
      if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/.test(controllerUrl)) throw new Error();
      const url = new URL(controllerUrl);
      this.address = url.hostname === "[::1]" ? "::1" : url.hostname;
      this.port = portSchema.parse(Number(url.port || 80));
      if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > TIMEOUT_MS)
        throw new Error();
      this.input = JSON.stringify({ address: this.address, port: this.port });
      this.scopeHash = digest(this.input);
    } catch {
      throw new Error("WINDOWS_CONTROLLER_SCOPE_INVALID");
    }
  }

  /** All joining callers share a batch. A joined caller's cancellation cancels the whole batch. */
  read(signal?: AbortSignal): Promise<WindowsControllerOwnerSnapshot> {
    const startedAtMono = performance.now();
    if (this.disposed || signal?.aborted)
      return Promise.resolve(this.unavailable(startedAtMono, this.disposed ? "DISPOSED" : "READ_CANCELLED"));
    if (this.pending) {
      this.subscribe(signal);
      return this.pending;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.subscribe(signal);
    const timeout = setTimeout(() => controller.abort("READ_TIMEOUT"), this.timeoutMs);
    const cancelled = new Promise<WindowsControllerOwnerSnapshot>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          resolve(
            this.unavailable(
              startedAtMono,
              controller.signal.reason === "READ_TIMEOUT"
                ? "READ_TIMEOUT"
                : this.disposed
                  ? "DISPOSED"
                  : "READ_CANCELLED",
            ),
          ),
        { once: true },
      );
    });
    let finished = false;
    const work = this.readOnce(startedAtMono, controller.signal);
    void work.then(() => {
      finished = true;
    });
    const result = Promise.race([work, cancelled]).finally(() => {
      clearTimeout(timeout);
      if (finished) this.clear(result, controller);
    });
    this.pending = result;
    // A late/uncooperative adapter remains single-flight and cannot publish after cancellation.
    const draining = Promise.allSettled([work, result]).then(() => this.clear(result, controller));
    this.draining.add(draining);
    void draining.then(() => this.draining.delete(draining));
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort("DISPOSED");
    this.clearSubscriptions();
  }
  /** The public cancellation result does not mean the underlying Windows command has exited. */
  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.draining]).then(() => undefined);
  }
  private subscribe(signal?: AbortSignal): void {
    if (!signal || this.subscriptions.has(signal)) return;
    const abort = () => this.controller?.abort("READ_CANCELLED");
    this.subscriptions.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }
  private clearSubscriptions(): void {
    for (const [signal, callback] of this.subscriptions) signal.removeEventListener("abort", callback);
    this.subscriptions.clear();
  }
  private clear(result: Promise<WindowsControllerOwnerSnapshot>, controller: AbortController): void {
    if (this.pending !== result) return;
    this.pending = null;
    if (this.controller === controller) this.controller = null;
    this.clearSubscriptions();
  }
  private unavailable(startedAtMono: number, reason: UnavailableReason): WindowsControllerOwnerSnapshot {
    return Object.freeze({ available: false, startedAtMono, completedAtMono: performance.now(), reason });
  }
  private project(pass: z.infer<typeof passSchema>): {
    owner: WindowsControllerProcessIdentity;
    listeners: readonly WindowsControllerListener[];
  } {
    if (pass.owners.length !== 1) throw new Error();
    const rawOwner = pass.owners[0];
    const pathIdentity =
      rawOwner.executablePath === null ? null : executablePathIdentity(rawOwner.executablePath);
    if (rawOwner.executablePath !== null && !pathIdentity) throw new Error();
    const listeners = pass.listeners
      .map((row): WindowsControllerListener => {
        const family = isIP(row.address);
        const address =
          family === 6 ? new URL(`http://[${row.address}]/`).hostname.slice(1, -1) : row.address;
        if (row.ownerPid !== rawOwner.pid || row.port !== this.port) throw new Error();
        let coverage: WindowsControllerListener["coverage"];
        if (address === this.address) coverage = "exact";
        else if (
          (this.address === "::1" && address === "::") ||
          (this.address === "127.0.0.1" && address === "0.0.0.0")
        )
          coverage = "same-family-wildcard";
        else if (this.address === "127.0.0.1" && address === "::") coverage = "cross-family-unverified";
        else throw new Error();
        return Object.freeze({
          address,
          addressFamily: family === 4 ? "ipv4" : "ipv6",
          port: row.port,
          coverage,
        });
      })
      .sort((a, b) => a.address.localeCompare(b.address, "en"));
    if (
      !listeners.some((row) => row.coverage !== "cross-family-unverified") ||
      new Set(listeners.map((row) => row.address)).size !== listeners.length
    )
      throw new Error();
    return {
      owner: Object.freeze({
        pid: rawOwner.pid,
        createdAtTicks: rawOwner.createdAtTicks,
        executablePathIdentity: pathIdentity,
      }),
      listeners: Object.freeze(listeners),
    };
  }
  private async readOnce(
    startedAtMono: number,
    signal: AbortSignal,
  ): Promise<WindowsControllerOwnerSnapshot> {
    try {
      if ((this.options.platform ?? process.platform) !== "win32" || signal.aborted) throw new Error();
      const raw = await (this.options.runner ?? runFixedRead)(this.input, signal);
      if (signal.aborted || this.disposed || Buffer.byteLength(raw) > MAX_BYTES) throw new Error();
      const response = responseSchema.parse(JSON.parse(raw));
      const before = this.project(response.before),
        after = this.project(response.after);
      const serialized = JSON.stringify(after);
      if (JSON.stringify(before) !== serialized || signal.aborted || this.disposed) throw new Error();
      return Object.freeze({
        available: true,
        basis: "windows-controller-listener",
        startedAtMono,
        completedAtMono: performance.now(),
        scopeHash: this.scopeHash,
        owner: after.owner,
        listeners: after.listeners,
        kernelEpoch: digest(JSON.stringify({ scopeHash: this.scopeHash, ...after })),
      });
    } catch {
      return this.unavailable(
        startedAtMono,
        this.disposed
          ? "DISPOSED"
          : signal.aborted
            ? signal.reason === "READ_TIMEOUT"
              ? "READ_TIMEOUT"
              : "READ_CANCELLED"
            : "READ_UNAVAILABLE",
      );
    }
  }
}
