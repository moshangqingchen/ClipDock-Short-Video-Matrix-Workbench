#Requires -Version 5.1
<#
.SYNOPSIS
Read-only guard for installed data maintenance. Refuses packaged process views
before resolving or opening a data path.
.EXAMPLE
& ./scripts/start-installed-workbench.ps1 -ScriptPath (Resolve-Path ./scripts/installed-data-context.ps1).Path
#>
[CmdletBinding()]
param(
  [int]$CallerProcessId = 0,
  [string]$DataRoot,
  [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$guidance = 'Run scripts/start-installed-workbench.ps1 in -ScriptPath mode with scripts/run-installed-maintenance.ps1. Do not access the default Roaming data from Codex directly.'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Installed data maintenance requires an unpackaged Windows desktop process. $guidance"
}
if (-not ('ClipDockInstalledDataContext' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class ClipDockInstalledDataContext {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  public static int PackageStatus(int processId) {
    IntPtr handle = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { uint length = 0; return GetPackageFullName(handle, ref length, null); }
    finally { CloseHandle(handle); }
  }
  public static bool InJob(int processId) {
    IntPtr handle = OpenProcess(0x1000, false, processId);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      bool result;
      if (!IsProcessInJob(handle, IntPtr.Zero, out result)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return result;
    } finally { CloseHandle(handle); }
  }
  public static string PhysicalPath(string path) {
    // Read attributes only; share with existing readers/writers; never create.
    using (SafeFileHandle handle = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder result = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
      if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (length >= result.Capacity) throw new InvalidOperationException("Resolved data directory is too long.");
      string value = result.ToString();
      if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
      return value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value.Substring(4) : value;
    }
  }
}
'@
}

[uint32]$packageLength = 0
$guardStatus = [ClipDockInstalledDataContext]::GetCurrentPackageFullName([ref]$packageLength, $null)
$callerStatus = if ($CallerProcessId -gt 0) { [ClipDockInstalledDataContext]::PackageStatus($CallerProcessId) } else { $guardStatus }
$guardInJob = [ClipDockInstalledDataContext]::InJob($PID)
$callerInJob = if ($CallerProcessId -gt 0) { [ClipDockInstalledDataContext]::InJob($CallerProcessId) } else { $guardInJob }
if ($guardStatus -ne 15700 -or $callerStatus -ne 15700) {
  throw "Refusing installed data access: package identity is present or unverified (guard=$guardStatus; caller=$callerStatus). MSIX can redirect the same Roaming path to different data. $guidance"
}
# Codex tool workers can lack package identity while retaining the caller's
# virtualized filesystem view. Identity alone is therefore insufficient.
$desktopParent = $null
if ($guardInJob -or $callerInJob) {
  # Node/libuv creates its own Job on the first spawn (including this guard).
  # Accept that only when its live, unpackaged, unjobbed parent is a PowerShell
  # helper directly created by the actual Windows desktop Explorer.
  $callerId = if ($CallerProcessId -gt 0) { $CallerProcessId } else { $PID }
  $caller = Get-CimInstance Win32_Process -Filter "ProcessId = $callerId"
  $parent = if ($caller) { Get-CimInstance Win32_Process -Filter "ProcessId = $($caller.ParentProcessId)" }
  $desktop = if ($parent) { Get-CimInstance Win32_Process -Filter "ProcessId = $($parent.ParentProcessId)" }
  $parentIsDesktopHelper = $caller -and $parent -and $desktop -and
    ([IO.Path]::GetFileName($caller.ExecutablePath) -ieq 'node.exe') -and
    ([IO.Path]::GetFileName($parent.ExecutablePath) -in @('pwsh.exe', 'powershell.exe')) -and
    ($desktop.ExecutablePath -ieq (Join-Path $env:WINDIR 'explorer.exe')) -and
    ($caller.SessionId -eq $parent.SessionId) -and ($parent.SessionId -eq $desktop.SessionId) -and
    ($parent.CreationDate -le $caller.CreationDate) -and ($desktop.CreationDate -le $parent.CreationDate) -and
    (-not [ClipDockInstalledDataContext]::InJob($parent.ProcessId)) -and
    ([ClipDockInstalledDataContext]::PackageStatus($parent.ProcessId) -eq 15700)
  if (-not $parentIsDesktopHelper) {
    throw "Refusing installed data access from an unverified Job-bound process (guard=$guardInJob; caller=$callerInJob). An inherited tool environment can expose a different Roaming view. $guidance"
  }
  $desktopParent = [pscustomobject]@{
    Verified = $true
    ProcessId = $parent.ProcessId
    ExecutablePath = $parent.ExecutablePath
    InJob = $false
    PackageStatus = 15700
    ExplorerProcessId = $desktop.ProcessId
    ExplorerExecutablePath = $desktop.ExecutablePath
  }
}

$source = $null
if ($DataRoot) {
  if (-not [IO.Path]::IsPathRooted($DataRoot)) { throw 'DataRoot must be an absolute existing directory.' }
  $item = Get-Item -LiteralPath $DataRoot -Force
  if (-not $item.PSIsContainer) { throw 'DataRoot must be an existing directory.' }
  $requestedRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
  $physicalRoot = [ClipDockInstalledDataContext]::PhysicalPath($DataRoot).TrimEnd('\')
  $databasePath = Join-Path $requestedRoot 'workbench.db'
  $physicalDatabase = [ClipDockInstalledDataContext]::PhysicalPath($databasePath)
  if (-not $requestedRoot.Equals($physicalRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not $databasePath.Equals($physicalDatabase, [StringComparison]::OrdinalIgnoreCase) -or
      $physicalRoot -match '(?i)\\AppData\\Local\\Packages\\') {
    throw "Refusing redirected installed data paths. $guidance"
  }
  $source = [pscustomobject]@{
    RequestedPath = $requestedRoot
    PhysicalPath = $physicalRoot
    DatabaseRequestedPath = $databasePath
    DatabasePhysicalPath = $physicalDatabase
    Resolution = 'GetFinalPathNameByHandle'
  }
}
$report = [pscustomobject]@{
  Version = 1
  PackageIdentity = 'APPMODEL_ERROR_NO_PACKAGE'
  GuardProcessId = $PID
  CallerProcessId = if ($CallerProcessId -gt 0) { $CallerProcessId } else { $PID }
  GuardPackageStatus = $guardStatus
  CallerPackageStatus = $callerStatus
  GuardInJob = $guardInJob
  CallerInJob = $callerInJob
  DesktopParent = $desktopParent
  Source = $source
}
if ($AsJson) { $report | ConvertTo-Json -Depth 4 -Compress } else { $report }
