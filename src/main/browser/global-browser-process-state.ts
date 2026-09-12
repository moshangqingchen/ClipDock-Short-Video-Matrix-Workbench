import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { z } from "zod";

export const browserOwnerSchema = z
  .object({
    pid: z.number().int().min(1).max(0xffffffff),
    startedAtTicks: z.string().regex(/^[1-9]\d{15,18}$/),
  })
  .strict();
export type BrowserProfileOwner = z.infer<typeof browserOwnerSchema>;
export interface BrowserProfileProcessState {
  currentOwner: BrowserProfileOwner;
  ownerRunning: boolean;
  profileRunning: boolean;
}
const resultSchema = z
  .object({ currentOwner: browserOwnerSchema, ownerRunning: z.boolean(), profileRunning: z.boolean() })
  .strict();

// Fixed read-only Windows program. Paths and saved owner data are stdin JSON, never shell source.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$clipdockInput = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipdockBrowserArguments {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Parse(string commandLine) {
    int count; IntPtr values = CommandLineToArgvW(commandLine, out count);
    if (values == IntPtr.Zero || count < 1 || count > 2048) throw new Exception("ARGUMENTS_UNAVAILABLE");
    try {
      string[] result = new string[count];
      for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(values, i * IntPtr.Size));
      return result;
    } finally { LocalFree(values); }
  }
}
'@
$clipdockCurrentId = [uint32]$clipdockInput.currentPid
$clipdockCurrent = Get-CimInstance Win32_Process -Filter "ProcessId=$clipdockCurrentId" -ErrorAction Stop
if ($null -eq $clipdockCurrent -or $null -eq $clipdockCurrent.CreationDate) { throw 'PROCESS_UNAVAILABLE' }
$clipdockCurrentOwner = [ordered]@{ pid = [long]$clipdockCurrent.ProcessId; startedAtTicks = $clipdockCurrent.CreationDate.ToUniversalTime().Ticks.ToString() }
$clipdockOwnerRunning = $false
if ($null -ne $clipdockInput.owner) {
  $clipdockOwnerId = [uint32]$clipdockInput.owner.pid
  $clipdockOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$clipdockOwnerId" -ErrorAction Stop
  if ($null -ne $clipdockOwner) {
    if ($null -eq $clipdockOwner.CreationDate) { throw 'PROCESS_UNAVAILABLE' }
    $clipdockOwnerRunning = $clipdockOwner.CreationDate.ToUniversalTime().Ticks.ToString() -ceq [string]$clipdockInput.owner.startedAtTicks
  }
}
$clipdockProfile = [IO.Path]::GetFullPath([string]$clipdockInput.directory).TrimEnd('\')
$clipdockProfileRunning = $false
foreach ($clipdockProcess in @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction Stop)) {
  if ([string]::IsNullOrEmpty($clipdockProcess.CommandLine)) { throw 'PROCESS_UNAVAILABLE' }
  $clipdockArguments = [ClipdockBrowserArguments]::Parse([string]$clipdockProcess.CommandLine)
  for ($clipdockIndex = 0; $clipdockIndex -lt $clipdockArguments.Length; $clipdockIndex++) {
    $clipdockValue = $null
    if ($clipdockArguments[$clipdockIndex].StartsWith('--user-data-dir=', [StringComparison]::Ordinal)) {
      $clipdockValue = $clipdockArguments[$clipdockIndex].Substring(16)
    } elseif ($clipdockArguments[$clipdockIndex] -ceq '--user-data-dir' -and $clipdockIndex + 1 -lt $clipdockArguments.Length) {
      $clipdockValue = $clipdockArguments[$clipdockIndex + 1]
    }
    if ($null -ne $clipdockValue -and [string]::Equals([IO.Path]::GetFullPath($clipdockValue).TrimEnd('\'), $clipdockProfile, [StringComparison]::OrdinalIgnoreCase)) {
      $clipdockProfileRunning = $true
    }
  }
}
[ordered]@{ currentOwner = $clipdockCurrentOwner; ownerRunning = $clipdockOwnerRunning; profileRunning = $clipdockProfileRunning } | ConvertTo-Json -Depth 4 -Compress
`;

/** Returns no other browser's command line, user directory, URL or private state. */
export async function inspectBrowserProfileProcesses(
  directory: string,
  owner: BrowserProfileOwner | null,
): Promise<BrowserProfileProcessState> {
  if (
    process.platform !== "win32" ||
    !win32.isAbsolute(directory) ||
    directory.length > 4096 ||
    /[\0\r\n]/.test(directory)
  )
    throw new Error("GLOBAL_BROWSER_PROCESS_UNAVAILABLE");
  const saved = owner === null ? null : browserOwnerSchema.parse(owner);
  const stdout = await new Promise<string>((resolve, reject) => {
    let result: string | null = null,
      failed = false;
    let cause: unknown;
    const child = execFile(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { windowsHide: true, shell: false, encoding: "utf8", timeout: 6000, maxBuffer: 16_384 },
      (error, value) => {
        failed ||= !!error;
        cause = error ?? cause;
        result = error ? null : value;
      },
    );
    // Resolve only at real child close, including timeout/error cleanup.
    child.once("close", () => {
      if (failed || result === null) reject(new Error("GLOBAL_BROWSER_PROCESS_UNAVAILABLE", { cause }));
      else resolve(result);
    });
    child.once("error", () => {
      failed = true;
    });
    if (!child.stdin) {
      failed = true;
      child.kill();
    } else {
      child.stdin.once("error", () => {
        failed = true;
        child.kill();
      });
      child.stdin.end(JSON.stringify({ currentPid: process.pid, directory, owner: saved }));
    }
  });
  try {
    const value = resultSchema.parse(JSON.parse(stdout.trim().replace(/^\uFEFF/, "")));
    if (value.currentOwner.pid !== process.pid) throw new Error();
    return value;
  } catch {
    throw new Error("GLOBAL_BROWSER_PROCESS_UNAVAILABLE");
  }
}
