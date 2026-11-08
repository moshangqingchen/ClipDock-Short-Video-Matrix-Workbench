$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installed-backup-copy.ps1')
$policy = Get-InstalledBackupPolicy
$installRoot = 'D:\SJdownloads\创作平台'
$dataRoot = 'C:\Users\Administrator\AppData\Roaming\short-video-matrix-workbench'
$backupBase = Get-InstalledBackupBase
$dataContext = & (Join-Path $PSScriptRoot 'installed-data-context.ps1') -CallerProcessId $PID -DataRoot $dataRoot
$dataRoot = $dataContext.Source.PhysicalPath

function Assert-AppClosed {
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq "$installRoot\短视频矩阵工作台.exe" -or
    ($_.Name -match '^(chrome|msedge|electron|短视频矩阵工作台)\.exe$' -and $_.CommandLine -like "*$dataRoot*")
  })
  if ($running.Count) { throw '软件或账号浏览器仍在运行；请正常退出后重试。' }
}

Assert-AppClosed
New-Item -ItemType Directory -Path $backupBase -Force | Out-Null
$backupRoot = Join-Path $backupBase ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$stagingRoot = $backupRoot + '.partial'
if ((Test-Path -LiteralPath $backupRoot) -or (Test-Path -LiteralPath $stagingRoot)) { throw '拒绝覆盖已有备份目录。' }
New-Item -ItemType Directory -Path $stagingRoot | Out-Null
$records = [System.Collections.Generic.List[object]]::new()
$excluded = 0
try {
  foreach ($entry in @(@{ Source = $dataRoot; Name = 'user-data' }, @{ Source = $installRoot; Name = 'program' })) {
    $copied = Copy-InstalledBackupSection -Source $entry.Source -Destination (Join-Path $stagingRoot $entry.Name) -Section $entry.Name
    foreach ($record in $copied.Files) { $records.Add($record) }
    $excluded += $copied.ExcludedCacheDirectories
    Assert-AppClosed
    Write-Output "$($entry.Name): verified $($copied.Files.Count) files"
  }
  Assert-AppClosed
  $report = [pscustomobject]@{
    ManagedBy = $policy.managedBy
    Kind = 'full'
    CreatedAt = [DateTimeOffset]::Now.ToString('o')
    BackupRoot = $backupRoot
    FileCount = $records.Count
    TotalBytes = ($records | Measure-Object -Property Bytes -Sum).Sum
    ExcludedUserDataDirectories = $policy.excludedUserDataDirectories
    ExcludedCacheDirectories = $excluded
    Verified = $true
    DataContext = $dataContext
    Files = $records
  }
  [IO.File]::WriteAllText((Join-Path $stagingRoot 'manifest.json'), ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  [IO.Directory]::Move($stagingRoot, $backupRoot)
} catch {
  $failure = $_
  try { Remove-IncompleteInstalledBackup -StagingRoot $stagingRoot -BackupBase $backupBase }
  catch { Write-Warning "Incomplete backup cleanup failed: $_" }
  throw $failure
}
# Retention failure must not invalidate a successfully verified backup.
try { $retention = Remove-ExpiredInstalledBackups -BackupRoot $backupRoot }
catch { $retention = [pscustomobject]@{ Status = 'deferred'; Error = $_.Exception.Message }; Write-Warning "Backup retention deferred: $_" }
$report | Select-Object CreatedAt, BackupRoot, FileCount, TotalBytes, ExcludedCacheDirectories, Verified, DataContext, @{ Name = 'Retention'; Expression = { $retention } } | ConvertTo-Json -Depth 6 -Compress
