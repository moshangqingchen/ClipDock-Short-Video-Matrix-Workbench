#Requires -Version 5.1
<#
.SYNOPSIS
Fixed maintenance entry points for start-installed-workbench.ps1 -ScriptPath.
.EXAMPLE
& ./scripts/start-installed-workbench.ps1 -ScriptPath (Resolve-Path ./scripts/run-installed-maintenance.ps1).Path -ScriptParameters @{ Operation = 'Probe' }
.EXAMPLE
& ./scripts/start-installed-workbench.ps1 -ScriptPath (Resolve-Path ./scripts/run-installed-maintenance.ps1).Path -ScriptParameters @{ Operation = 'Verify'; BackupRoot = 'D:\verified-backup'; NodePath = 'C:\Program Files\nodejs\node.exe' }
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Probe', 'FullBackup', 'DatabaseBackup', 'Verify')]
  [string]$Operation,
  [string]$BackupRoot,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$context = & (Join-Path $PSScriptRoot 'installed-data-context.ps1') -CallerProcessId $PID
if ($Operation -eq 'Probe') { $context | ConvertTo-Json -Compress; return }
if ($Operation -eq 'FullBackup') { & (Join-Path $PSScriptRoot 'backup-installed-workbench.ps1'); return }
if ($Operation -eq 'Verify' -and -not $BackupRoot) { throw 'Verify requires BackupRoot.' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
if ([IO.Path]::GetExtension($NodePath) -ine '.exe') { throw 'NodePath must identify a Node executable.' }
$entry = if ($Operation -eq 'Verify') { 'verify-installed-data.mjs' } else { 'backup-installed-program-database.mjs' }
$arguments = @((Join-Path $PSScriptRoot $entry))
if ($Operation -eq 'Verify') { $arguments += $BackupRoot }
# Start the fixed entry directly under this checked helper. The guard verifies
# that live parent when libuv creates Node's own Job during child-process setup.
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $NodePath
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
if ($start.PSObject.Properties.Name -contains 'ArgumentList') {
  foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
} else {
  # CommandLineToArgvW quoting for .NET Framework; no command shell is involved.
  $quoted = foreach ($argument in $arguments) {
    '"' + (($argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
  }
  $start.Arguments = $quoted -join ' '
}
$process = [Diagnostics.Process]::Start($start)
try {
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $output = $stdout.GetAwaiter().GetResult()
  $errorOutput = $stderr.GetAwaiter().GetResult()
  if ($output) { Write-Output $output }
  if ($process.ExitCode -ne 0) { throw "Maintenance failed with exit code $($process.ExitCode): $errorOutput" }
} finally { $process.Dispose() }
