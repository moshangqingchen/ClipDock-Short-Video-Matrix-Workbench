#Requires -Version 5.1
<#
.SYNOPSIS
Starts the installed workbench through the existing Windows desktop, outside the calling terminal's Job.
.EXAMPLE
pwsh -NoProfile -File scripts/start-installed-workbench.ps1 -Probe
.EXAMPLE
pwsh -NoProfile -File scripts/start-installed-workbench.ps1 -ExecutablePath 'D:\SJdownloads\创作平台\短视频矩阵工作台.exe'
#>
[CmdletBinding(DefaultParameterSetName = 'Application')]
param(
  [Parameter(ParameterSetName = 'Application')]
  [string]$ExecutablePath = 'D:\SJdownloads\创作平台\短视频矩阵工作台.exe',
  [Parameter(Mandatory = $true, ParameterSetName = 'Probe')]
  [switch]$Probe,
  [Parameter(Mandatory = $true, ParameterSetName = 'Script')]
  [string]$ScriptPath,
  [Parameter(ParameterSetName = 'Script')]
  [hashtable]$ScriptParameters = @{},
  [Parameter(ParameterSetName = 'Probe')]
  [string[]]$InspectPath = @(),
  [string]$PowerShellPath,
  [ValidateRange(1, 3600)]
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This launcher requires an interactive Windows desktop.'
}
if ($PSCmdlet.ParameterSetName -eq 'Application') {
  $ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath).ProviderPath
  if ([IO.Path]::GetExtension($ExecutablePath) -ine '.exe') { throw 'ExecutablePath must be an .exe file.' }
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -ieq $ExecutablePath -and $_.CommandLine -notmatch '(?:^|\s)--type='
  })
  if ($running.Count) { throw 'The installed workbench is already running. Exit it normally before using this launcher.' }
}
if ($ScriptPath) {
  $ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).ProviderPath
  if ([IO.Path]::GetExtension($ScriptPath) -ine '.ps1') { throw 'ScriptPath must be a local .ps1 file.' }
  if ($ScriptPath.StartsWith('\\')) { throw 'ScriptPath must be local, not a network path.' }
}

# Use the discovered PowerShell 7 binary, including a bundled runtime when that
# is the current host. Do not guess a global installation path. Script mode
# requires PowerShell 7 so UTF-8 without BOM and modern .NET APIs work unchanged.
if (-not $PowerShellPath) {
  $currentHostPath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  if ($PSVersionTable.PSVersion.Major -ge 7 -and [IO.Path]::GetFileName($currentHostPath) -ieq 'pwsh.exe') {
    $PowerShellPath = $currentHostPath
  } else {
    $pwshCommand = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pwshCommand) { $PowerShellPath = $pwshCommand.Source }
    elseif ($PSCmdlet.ParameterSetName -ne 'Script') {
      $PowerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    } else { throw 'Script mode requires PowerShell 7. Pass its existing absolute path with -PowerShellPath.' }
  }
}
$PowerShellPath = (Resolve-Path -LiteralPath $PowerShellPath).ProviderPath
$hostFile = Get-Item -LiteralPath $PowerShellPath
if ($hostFile.PSIsContainer -or $PowerShellPath.StartsWith('\\') -or $hostFile.Name -notin @('pwsh.exe', 'powershell.exe')) {
  throw 'PowerShellPath must identify a local PowerShell executable.'
}
$hostStream = [IO.File]::OpenRead($PowerShellPath)
try {
  if ($hostStream.ReadByte() -ne 77 -or $hostStream.ReadByte() -ne 90) { throw 'PowerShellPath is not a Windows executable.' }
} finally { $hostStream.Dispose() }
if ($hostFile.Name -ieq 'pwsh.exe' -and $hostFile.VersionInfo.FileMajorPart -lt 7) {
  throw 'The selected pwsh executable must be PowerShell 7 or later.'
}
if ($PSCmdlet.ParameterSetName -eq 'Script' -and $hostFile.Name -ine 'pwsh.exe') {
  throw 'Script mode requires PowerShell 7 to preserve UTF-8 source and modern .NET APIs; pass -PowerShellPath with a pwsh.exe path.'
}

# Get the automation object hosted by the *existing desktop Explorer*, not a
# locally instantiated Shell.Application's ShellExecute method.
# https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643
$shell = New-Object -ComObject Shell.Application
$shellWindows = $shell.Windows()
$desktopHandle = 0
$desktop = $shellWindows.FindWindowSW(0, 0, 8, [ref]$desktopHandle, 1) # SWC_DESKTOP, SWFO_NEEDDISPATCH
if (-not $desktop -or -not $desktopHandle) { throw 'The existing Windows desktop Explorer could not be found.' }
$desktopApplication = $desktop.Document.Application

$resultPath = Join-Path ([IO.Path]::GetTempPath()) ('clipdock-independent-' + [guid]::NewGuid().ToString('N') + '.json')
$payload = @{
  ExecutablePath = $ExecutablePath
  ResultPath = $resultPath
  Probe = [bool]$Probe
  Mode = $PSCmdlet.ParameterSetName
  ScriptPath = $ScriptPath
  ScriptParameters = $ScriptParameters
  InspectPath = $InspectPath
} | ConvertTo-Json -Compress -Depth 10
$encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))

# Explorer starts this short-lived helper hidden. The helper verifies its actual
# parent and Job membership before it is allowed to start the installed app.
# Only base64 JSON is substituted into code; paths never become shell syntax.
$helper = @'
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$report = [ordered]@{
  Success = $false; Probe = $payload.Probe; Mode = $payload.Mode; HelperProcessId = $PID
  HelperPowerShellVersion = $PSVersionTable.PSVersion.ToString()
  HelperExecutable = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
}
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClipDockLaunchJob {
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, System.Text.StringBuilder name);
}
"@
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)"
  $report.ParentProcessId = $current.ParentProcessId
  $report.ParentExecutable = $parent.ExecutablePath
  if (-not $parent -or $parent.ExecutablePath -ine (Join-Path $env:WINDIR 'explorer.exe')) {
    throw 'The launch helper was not created by the Windows desktop Explorer.'
  }
  $inJob = $false
  if (-not [ClipDockLaunchJob]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle, [IntPtr]::Zero, [ref]$inJob)) {
    throw 'Could not verify launch helper Job membership.'
  }
  $report.HelperInJob = $inJob
  if ($inJob) { throw 'The desktop launch helper is inside a Job; refusing to start the workbench.' }
  [uint32]$packageNameLength = 0
  $packageResult = [ClipDockLaunchJob]::GetCurrentPackageFullName([ref]$packageNameLength, $null)
  $report.PackageIdentityStatus = $packageResult
  $report.HasPackageIdentity = ($packageResult -ne 15700) # APPMODEL_ERROR_NO_PACKAGE
  if ($packageResult -ne 15700) {
    throw 'The desktop helper does not have verified unpackaged identity. Refusing to access user data or launch the workbench.'
  }
  $report.PackageIdentity = 'APPMODEL_ERROR_NO_PACKAGE'
  $report.RoamingAppData = [Environment]::GetFolderPath('ApplicationData')

  # Do not carry test data paths, smoke mode, development URLs or Node/Electron
  # execution overrides into the normal installed application.
  $removed = @(Get-ChildItem Env: | Where-Object {
    $_.Name -like 'SV_WORKBENCH_*' -or $_.Name -like 'ELECTRON_*' -or
    $_.Name -in @('NODE_OPTIONS', 'NODE_PATH', 'VITE_DEV_SERVER_URL')
  } | ForEach-Object {
    $name = $_.Name
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    $name
  })
  $report.RemovedEnvironmentNames = $removed
  $report.DataDirectoryOverridePresent = [bool]$env:SV_WORKBENCH_DATA_DIR
  $report.ElectronRunAsNodePresent = [bool]$env:ELECTRON_RUN_AS_NODE
  if ($payload.Mode -eq 'Probe') {
    $report.InspectedPaths = @($payload.InspectPath | ForEach-Object {
      $item = Get-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue
      [pscustomobject]@{
        RequestedPath = $_
        Exists = [bool]$item
        FullPath = if ($item) { $item.FullName } else { $null }
        IsDirectory = if ($item) { [bool]$item.PSIsContainer } else { $null }
        Bytes = if ($item -and -not $item.PSIsContainer) { $item.Length } else { $null }
      }
    })
  } elseif ($payload.Mode -eq 'Script') {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Script mode requires PowerShell 7 or later.' }
    $scriptParameters = @{}
    foreach ($property in $payload.ScriptParameters.PSObject.Properties) {
      $scriptParameters[$property.Name] = $property.Value
    }
    $report.ScriptPath = $payload.ScriptPath
    $report.ScriptOutput = @(& $payload.ScriptPath @scriptParameters)
  } elseif ($payload.Mode -eq 'Application') {
    $running = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -ieq $payload.ExecutablePath -and $_.CommandLine -notmatch '(?:^|\s)--type='
    })
    if ($running.Count) { throw 'The installed workbench started while the launcher was preparing. Exit it normally and retry.' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $payload.ExecutablePath
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($payload.ExecutablePath)
    $start.UseShellExecute = $false
    $creatorInJob = $false
    if (-not [ClipDockLaunchJob]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle, [IntPtr]::Zero, [ref]$creatorInJob)) {
      throw 'Could not recheck the direct creator Job membership before startup.'
    }
    $report.HelperInJobBeforeStart = $creatorInJob
    if ($creatorInJob) { throw 'The direct creator entered a Job; refusing to launch the workbench.' }
    $application = [Diagnostics.Process]::Start($start)
    $report.ApplicationProcessId = $application.Id
    $report.ExecutablePath = $payload.ExecutablePath
    Start-Sleep -Milliseconds 1200
    if ($application.HasExited) { throw 'The workbench exited during startup. Check its own logs before retrying.' }
    $appInJob = $false
    if (-not [ClipDockLaunchJob]::IsProcessInJob($application.Handle, [IntPtr]::Zero, [ref]$appInJob)) {
      throw 'The application started, but its Job membership could not be verified. Do not launch another copy.'
    }
    $report.ApplicationInJob = $appInJob
    # Any-Job membership does not identify the caller's Job. Chromium, libuv or
    # the application can establish a separate Job after process creation.
    $applicationInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($application.Id)"
    $report.ApplicationParentProcessId = $applicationInfo.ParentProcessId
    if (-not $applicationInfo -or $applicationInfo.ParentProcessId -ne $PID) {
      throw 'The application started, but its direct parent did not match the verified desktop helper. It has not been stopped.'
    }
    $creatorInJobAfterStart = $false
    if (-not [ClipDockLaunchJob]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle, [IntPtr]::Zero, [ref]$creatorInJobAfterStart)) {
      throw 'The application started, but the creator Job state could not be rechecked. It has not been stopped.'
    }
    $report.HelperInJobAfterStart = $creatorInJobAfterStart
    if ($creatorInJobAfterStart) {
      throw 'The application started, but the creator entered a Job. Independent startup was not verified; the application has not been stopped.'
    }
    $report.IndependentLaunchVerified = $true
    $report.IndependentLaunchEvidence = 'Existing Explorer -> direct creator outside all Jobs -> application with verified direct parent'
  }
  $report.Success = $true
} catch {
  $report.Error = $_.Exception.Message
} finally {
  [IO.File]::WriteAllText($payload.ResultPath + '.tmp', ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath ($payload.ResultPath + '.tmp') -Destination $payload.ResultPath
}
'@
$helper = $helper.Replace('__PAYLOAD__', $encodedPayload)
$encodedHelper = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encodedHelper
$desktopApplication.ShellExecute($PowerShellPath, $arguments, [IO.Path]::GetTempPath(), 'open', 0)

$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
while (-not (Test-Path -LiteralPath $resultPath)) {
  if ([DateTime]::UtcNow -gt $deadline) {
    throw "The desktop helper did not report in time. It may still be running; inspect the report before retrying. Do not repeat a data repair or launch blindly. Report: $resultPath"
  }
  Start-Sleep -Milliseconds 200
}
try {
  $report = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  # A NULL query reports only this caller's immediate Job and its child Jobs;
  # absence is supporting evidence, not proof about every outer Job in a chain.
  try {
    if (-not ('ClipDockCallerJobSnapshot' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipDockCallerJobSnapshot {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
  public static long[] Members() {
    int size = 8 + 8192 * IntPtr.Size;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(IntPtr.Zero, 3, buffer, (uint)size, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      int assigned = Marshal.ReadInt32(buffer, 0), count = Marshal.ReadInt32(buffer, 4);
      if (assigned > count) throw new Exception("Caller Job process list was truncated.");
      long[] ids = new long[count];
      for (int i = 0; i < count; i++) ids[i] = IntPtr.Size == 8 ? Marshal.ReadInt64(buffer, 8 + i * 8) : Marshal.ReadInt32(buffer, 8 + i * 4);
      return ids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
    }
    $callerInJob = $false
    if (-not [ClipDockCallerJobSnapshot]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle, [IntPtr]::Zero, [ref]$callerInJob)) {
      throw 'Could not inspect the caller Job.'
    }
    $callerMembers = @()
    if ($callerInJob) { $callerMembers = @([ClipDockCallerJobSnapshot]::Members()) }
    $report | Add-Member -NotePropertyName CallerJobSnapshot -NotePropertyValue @{
      ProcessId = $PID
      InJob = $callerInJob
      Scope = 'Immediate caller Job and its child Jobs only; excludes unknown outer Jobs'
      Members = $callerMembers
      ContainsApplication = if ($report.ApplicationProcessId) { $callerMembers -contains $report.ApplicationProcessId } else { $null }
    }
    if ($report.ApplicationProcessId -and $callerMembers -contains $report.ApplicationProcessId) {
      $report.Success = $false
      if ($report.PSObject.Properties.Name -contains 'IndependentLaunchVerified') { $report.IndependentLaunchVerified = $false }
      $report | Add-Member -NotePropertyName Error -NotePropertyValue 'The application is in the calling terminal Job. It has not been stopped; independent launch failed.' -Force
    }
  } catch {
    $report | Add-Member -NotePropertyName CallerJobSnapshotError -NotePropertyValue $_.Exception.Message
  }
  $report | ConvertTo-Json -Depth 5
  if (-not $report.Success) { throw $report.Error }
} finally {
  Remove-Item -LiteralPath $resultPath
}
