#Requires -Version 5.1
<#
.SYNOPSIS
Exercise backup retention and copying against disposable project-local fixtures.
.EXAMPLE
powershell -NoProfile -File ./scripts/installed-backup-policy.test.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$temporaryBase = Join-Path $projectRoot 'output\temp'
$fixtureName = 'installed-backup-policy-test-' + [guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path $temporaryBase $fixtureName
$fixtureProject = Join-Path $fixtureRoot 'project'
$fixtureScripts = Join-Path $fixtureProject 'scripts'
$passed = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Message)
  $didThrow = $false
  try { & $Action | Out-Null } catch { $didThrow = $true }
  Assert-True $didThrow $Message
}

function Test-Case {
  param([string]$Name, [scriptblock]$Action)
  & $Action
  $script:passed++
  Write-Host "PASS: $Name"
}

function Assert-FixturePath {
  param([string]$Path)
  $absolute = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $fixtureAbsolute = [IO.Path]::GetFullPath($script:fixtureRoot).TrimEnd('\', '/')
  Assert-True ($absolute -eq $fixtureAbsolute -or $absolute.StartsWith($fixtureAbsolute + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) "path must stay inside this test fixture: $absolute"
  return $absolute
}

function Remove-FixtureTree {
  param([string]$Path)
  $absolute = Assert-FixturePath $Path
  if (-not (Test-Path -LiteralPath $absolute)) { return }
  $item = Get-Item -LiteralPath $absolute -Force
  # Delete a junction itself; never recurse through its target.
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($item.PSIsContainer) { [IO.Directory]::Delete($absolute) }
    else { [IO.File]::Delete($absolute) }
    return
  }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $absolute -Force)) {
      Remove-FixtureTree $child.FullName
    }
    [IO.Directory]::Delete($absolute)
  } else { [IO.File]::Delete($absolute) }
}

function New-FixtureFile {
  param([string]$Path, [string]$Content = 'fixture')
  $absolute = Assert-FixturePath $Path
  [IO.Directory]::CreateDirectory((Split-Path -Parent $absolute)) | Out-Null
  [IO.File]::WriteAllText($absolute, $Content, [Text.UTF8Encoding]::new($false))
}

function Reset-FixtureBackups {
  Remove-FixtureTree $script:backupBase
  [IO.Directory]::CreateDirectory($script:backupBase) | Out-Null
}

function New-FixtureBackup {
  param(
    [string]$Name,
    [string]$Kind = 'full',
    [string]$CreatedAt = '2026-01-01T00:00:00Z',
    [object]$Verified = $true,
    [string]$PreviousFullBackup,
    [switch]$Unmanaged,
    [switch]$NoManifest,
    [switch]$Malformed,
    [switch]$Keep
  )
  $root = Join-Path $script:backupBase $Name
  [IO.Directory]::CreateDirectory($root) | Out-Null
  New-FixtureFile (Join-Path $root 'payload.txt') $Name
  if (-not $NoManifest) {
    $manifest = [ordered]@{ Kind = $Kind; CreatedAt = $CreatedAt; Verified = $Verified; BackupRoot = $root }
    if (-not $Unmanaged) { $manifest.ManagedBy = 'installed-backup-v1' }
    if ($PreviousFullBackup) { $manifest.PreviousFullBackup = $PreviousFullBackup }
    $json = if ($Malformed) { '{broken-json' } else { $manifest | ConvertTo-Json -Depth 6 }
    New-FixtureFile (Join-Path $root 'manifest.json') $json
  }
  if ($Keep) { New-FixtureFile (Join-Path $root '.keep') 'retained by operator' }
  return $root
}

try {
  [IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
  foreach ($name in @('installed-backup-policy.ps1', 'installed-backup-policy.json', 'installed-backup-copy.ps1')) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required backup helper is missing: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $fixtureScripts $name)
  }
  . (Join-Path $fixtureScripts 'installed-backup-policy.ps1')
  . (Join-Path $fixtureScripts 'installed-backup-copy.ps1')
  $backupBase = Get-InstalledBackupBase
  Assert-FixturePath $backupBase | Out-Null

  Test-Case 'policy resolves into the copied fixture project' {
    $policy = Get-InstalledBackupPolicy
    Assert-True ($null -ne $policy) 'policy should load'
    Assert-True ([IO.Path]::GetFullPath($backupBase).StartsWith($fixtureProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) 'backup base should use fixture project root'
  }

  Test-Case 'cache classifier preserves account state and ordinary business Cache directories' {
    foreach ($relative in @('Cache', 'Code Cache', 'GPUCache', 'profiles\Partitions\sv-account-1\Cache', 'profiles\Partitions\sv-account-1\Code Cache', 'global-browser-profiles\account-1\Default\GPUCache')) {
      Assert-True (Test-InstalledBackupCacheDirectory -RelativePath $relative) "cache should be excluded: $relative"
    }
    foreach ($relative in @('business\Cache', 'Default\Cache', 'Cookies', 'Local State', 'profiles\Partitions\sv-account-1\Cookies', 'profiles\Partitions\sv-account-1\Local Storage', 'profiles\Partitions\sv-account-1\Local Storage\Cache', 'profiles\Partitions\sv-account-1\IndexedDB', 'profiles\Partitions\sv-account-1\Service Worker', 'profiles\Partitions\sv-account-1\Service Worker\CacheStorage', 'global-browser-profiles\account-1\Default\Service Worker\CacheStorage')) {
      Assert-True (-not (Test-InstalledBackupCacheDirectory -RelativePath $relative)) "account or business state should be preserved: $relative"
    }
  }

  Test-Case 'unverified and string-true new backups cannot trigger pruning' {
    Reset-FixtureBackups
    $oldest = New-FixtureBackup 'oldest'
    foreach ($index in 2..4) { New-FixtureBackup "full-$index" -CreatedAt "2026-01-0${index}T00:00:00Z" | Out-Null }
    foreach ($value in @($false, 'true')) {
      $invalid = New-FixtureBackup ('unverified-' + [guid]::NewGuid().ToString('N')) -Verified $value
      Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $invalid } 'only a strict verified boolean should allow cleanup'
      Assert-True (Test-Path -LiteralPath $oldest) 'failed verification must not remove any old backup'
    }
  }

  Test-Case 'only a managed, recognized new backup can authorize retention' {
    Reset-FixtureBackups
    $oldest = New-FixtureBackup 'oldest-managed'
    foreach ($index in 2..4) { New-FixtureBackup "managed-$index" -CreatedAt "2026-01-0${index}T00:00:00Z" | Out-Null }
    $invalidRoots = @(
      (New-FixtureBackup 'legacy-current' -Unmanaged),
      (New-FixtureBackup 'unknown-kind-current' -Kind 'unknown-kind'),
      (New-FixtureBackup 'no-manifest-current' -NoManifest),
      (New-FixtureBackup 'bad-manifest-current' -Malformed)
    )
    foreach ($invalid in $invalidRoots) {
      Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $invalid } 'unmanaged, unsupported, or unreadable current backup should be rejected'
      Assert-True (Test-Path -LiteralPath $oldest) 'invalid current manifest must not authorize deleting an old backup'
    }
  }

  Test-Case 'verified partial staging backups cannot trigger cleanup or displace complete backups' {
    Reset-FixtureBackups
    $complete = @()
    foreach ($index in 1..4) {
      $complete += New-FixtureBackup "complete-$index" -CreatedAt "2026-04-0${index}T00:00:00Z"
    }
    $partial = New-FixtureBackup 'interrupted-verified.partial' -CreatedAt '2099-01-01T00:00:00Z'
    Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $partial } 'a verified staging manifest must not authorize retention'
    foreach ($path in $complete) { Assert-True (Test-Path -LiteralPath $path) 'rejected partial backup must not delete any complete backup' }
    $report = Remove-ExpiredInstalledBackups -BackupRoot $complete[-1]
    Assert-True (-not (Test-Path -LiteralPath $complete[0])) 'only the oldest complete backup should expire'
    foreach ($path in $complete[1..3]) { Assert-True (Test-Path -LiteralPath $path) 'all newest three complete backups must remain despite a newer partial manifest' }
    Assert-True (Test-Path -LiteralPath $partial) 'interrupted staging directory should remain outside automatic retention'
    Assert-True ($report.DeletedCount -eq 1) 'partial staging directory must not cause an additional complete backup deletion'
    Assert-True ($report.ManagedCount -eq 4) 'partial staging directory must not count as a managed complete backup'
  }

  Test-Case 'each kind keeps its newest three by CreatedAt plus pinned and referenced full backups' {
    Reset-FixtureBackups
    $oldFull = New-FixtureBackup 'zzzz-newest-looking-full' -CreatedAt '2026-01-01T00:00:00Z'
    $pinned = New-FixtureBackup 'pinned-full' -CreatedAt '2026-01-02T00:00:00Z' -Keep
    $dependency = New-FixtureBackup 'referenced-full' -CreatedAt '2026-01-03T00:00:00Z'
    $middleFull = New-FixtureBackup 'middle-full' -CreatedAt '2026-01-04T00:00:00Z'
    $recentFull1 = New-FixtureBackup 'recent-full-1' -CreatedAt '2026-01-05T00:00:00Z'
    $recentFull2 = New-FixtureBackup 'recent-full-2' -CreatedAt '2026-01-06T00:00:00Z'
    $current = New-FixtureBackup 'aaaa-oldest-looking-full' -CreatedAt '2026-01-07T00:00:00Z'
    $oldPartial = New-FixtureBackup 'zzzz-newest-looking-partial' -Kind 'program-and-database' -CreatedAt '2026-01-01T00:00:00Z'
    $recentPartials = @()
    foreach ($index in 2..4) {
      $recentPartials += New-FixtureBackup "partial-$index" -Kind 'program-and-database' -CreatedAt "2026-01-0${index}T00:00:00Z" -PreviousFullBackup $dependency
    }
    # Equal filesystem timestamps ensure a filename or creation-time fallback
    # cannot accidentally satisfy the CreatedAt ordering assertions.
    foreach ($directory in @(Get-ChildItem -LiteralPath $backupBase -Directory -Force)) {
      [IO.Directory]::SetCreationTimeUtc($directory.FullName, [DateTime]::SpecifyKind([DateTime]'2020-01-01T00:00:00', [DateTimeKind]::Utc))
    }
    $report = Remove-ExpiredInstalledBackups -BackupRoot $current
    foreach ($removed in @($oldFull, $middleFull, $oldPartial)) {
      Assert-True (-not (Test-Path -LiteralPath $removed)) "expired backup should be deleted: $removed"
    }
    foreach ($kept in @($pinned, $dependency, $recentFull1, $recentFull2, $current) + $recentPartials) {
      Assert-True (Test-Path -LiteralPath $kept) "required backup should be kept: $kept"
    }
    Assert-True ($report.DeletedCount -eq 3) 'retention report should account for all three deleted fixtures'
  }

  Test-Case 'legacy, missing, malformed, and unverified manifests stay untouched' {
    Reset-FixtureBackups
    $protected = @(
      (New-FixtureBackup 'legacy' -Unmanaged),
      (New-FixtureBackup 'without-manifest' -NoManifest),
      (New-FixtureBackup 'broken-manifest' -Malformed),
      (New-FixtureBackup 'unverified-existing' -Verified $false)
    )
    $current = $null
    foreach ($index in 1..4) { $current = New-FixtureBackup "managed-partial-$index" -Kind 'program-and-database' -CreatedAt "2026-02-0${index}T00:00:00Z" }
    Remove-ExpiredInstalledBackups -BackupRoot $current | Out-Null
    foreach ($path in $protected) { Assert-True (Test-Path -LiteralPath $path) "unmanaged or unreadable backup should remain: $path" }
  }

  Test-Case 'cleanup refuses paths outside the configured base and nested backup roots' {
    Reset-FixtureBackups
    $outside = Join-Path $fixtureRoot 'outside-backup'
    New-FixtureFile (Join-Path $outside 'sentinel') 'do not delete'
    Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $outside } 'outside root should be rejected'
    $container = New-FixtureBackup 'container'
    $nested = Join-Path $container 'nested'
    [IO.Directory]::CreateDirectory($nested) | Out-Null
    Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $nested } 'nested backup root should be rejected'
    Assert-True (Test-Path -LiteralPath (Join-Path $outside 'sentinel')) 'outside sentinel should remain'
  }

  Test-Case 'cleanup rejects junctions before any expired backup is deleted' {
    Reset-FixtureBackups
    $target = Join-Path $fixtureRoot 'junction-target'
    New-FixtureFile (Join-Path $target 'sentinel') 'do not follow links'
    $linkedRoot = Join-Path $backupBase 'linked-current'
    New-Item -ItemType Junction -Path $linkedRoot -Target $target | Out-Null
    Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $linkedRoot } 'linked current backup should be rejected'
    Remove-FixtureTree $linkedRoot
    $ordinaryOld = New-FixtureBackup 'ordinary-old' -CreatedAt '2025-01-01T00:00:00Z'
    $linkedOld = New-FixtureBackup 'linked-old' -CreatedAt '2025-02-01T00:00:00Z'
    New-Item -ItemType Junction -Path (Join-Path $linkedOld 'external') -Target $target | Out-Null
    $current = $null
    foreach ($index in 1..3) { $current = New-FixtureBackup "recent-$index" -CreatedAt "2026-03-0${index}T00:00:00Z" }
    Assert-Throws { Remove-ExpiredInstalledBackups -BackupRoot $current } 'linked expired backup should fail the cleanup preflight'
    Assert-True (Test-Path -LiteralPath $ordinaryOld) 'cleanup should fail before deleting any ordinary candidate'
    Assert-True (Test-Path -LiteralPath (Join-Path $target 'sentinel')) 'junction target must remain untouched'
  }

  Test-Case 'copy excludes only browser caches and hashes every retained account file' {
    $source = Join-Path $fixtureRoot 'copy-user-source'
    $destination = Join-Path $fixtureRoot 'copy-user-destination'
    $retained = @('Cookies', 'Local State', 'accounts.db', 'accounts.db-wal', 'accounts.db-shm', 'business\Cache\business.txt', 'Default\Cache\ordinary.txt', 'profiles\Partitions\sv-account-1\Cookies', 'profiles\Partitions\sv-account-1\Local Storage\leveldb\CURRENT', 'profiles\Partitions\sv-account-1\Local Storage\Cache\important.txt', 'profiles\Partitions\sv-account-1\IndexedDB\database', 'profiles\Partitions\sv-account-1\Service Worker\CacheStorage\entry', 'global-browser-profiles\account-1\Default\Cookies', 'global-browser-profiles\account-1\Default\Service Worker\CacheStorage\entry')
    $excluded = @('Cache\entry', 'Code Cache\js\entry', 'GPUCache\entry', 'profiles\Partitions\sv-account-1\Cache\entry', 'global-browser-profiles\account-1\Default\GPUCache\entry')
    foreach ($relative in $retained + $excluded) { New-FixtureFile (Join-Path $source $relative) "content for $relative" }
    $emptyProfile = 'profiles\Partitions\empty-account'
    [IO.Directory]::CreateDirectory((Join-Path $source $emptyProfile)) | Out-Null
    $result = Copy-InstalledBackupSection -Source $source -Destination $destination -Section 'user-data'
    foreach ($relative in $retained) { Assert-True (Test-Path -LiteralPath (Join-Path $destination $relative) -PathType Leaf) "account file should be copied: $relative" }
    foreach ($relative in $excluded) { Assert-True (-not (Test-Path -LiteralPath (Join-Path $destination $relative))) "cache file must not be copied: $relative" }
    Assert-True (Test-Path -LiteralPath (Join-Path $destination $emptyProfile) -PathType Container) 'empty account directory should survive copying'
    Assert-True (@($result.Files).Count -eq $retained.Count) 'manifest must contain exactly the retained file count'
    Assert-True (@(Get-ChildItem -LiteralPath $destination -File -Recurse -Force).Count -eq $retained.Count) 'destination must contain exactly the retained file count'
    Assert-True ($result.ExcludedCacheDirectories -eq $excluded.Count) 'excluded directory count should describe actual pruned cache roots'
    foreach ($record in @($result.Files)) {
      $copy = Get-Item -LiteralPath (Join-Path $destination $record.Path)
      Assert-True ($record.Section -eq 'user-data') 'manifest section should match copied section'
      Assert-True ($record.Bytes -eq $copy.Length) "manifest byte count should match: $($record.Path)"
      Assert-True ($record.SHA256 -eq (Get-FileHash -LiteralPath $copy.FullName -Algorithm SHA256).Hash) "manifest SHA256 should match: $($record.Path)"
    }
  }

  Test-Case 'program files named Cache are retained' {
    $source = Join-Path $fixtureRoot 'copy-program-source'
    $destination = Join-Path $fixtureRoot 'copy-program-destination'
    foreach ($relative in @('Cache\required.bin', 'Code Cache\required.bin', 'GPUCache\required.bin')) { New-FixtureFile (Join-Path $source $relative) $relative }
    $result = Copy-InstalledBackupSection -Source $source -Destination $destination -Section 'program'
    Assert-True (@($result.Files).Count -eq 3) 'all three program Cache directories should be copied'
    Assert-True ($result.ExcludedCacheDirectories -eq 0) 'program copying must not apply browser cache exclusions'
  }

  Test-Case 'copy refuses source and destination junctions' {
    $source = Join-Path $fixtureRoot 'copy-links-source'
    $target = Join-Path $fixtureRoot 'copy-links-target'
    New-FixtureFile (Join-Path $source 'ordinary.txt') 'source data'
    New-FixtureFile (Join-Path $target 'sentinel') 'target data'
    $sourceLink = Join-Path $source 'link'
    New-Item -ItemType Junction -Path $sourceLink -Target $target | Out-Null
    Assert-Throws { Copy-InstalledBackupSection -Source $source -Destination (Join-Path $fixtureRoot 'copy-links-refused') -Section 'user-data' } 'nested source junction should be rejected'
    Remove-FixtureTree $sourceLink
    $destinationLink = Join-Path $fixtureRoot 'copy-destination-link'
    New-Item -ItemType Junction -Path $destinationLink -Target $target | Out-Null
    Assert-Throws { Copy-InstalledBackupSection -Source $source -Destination $destinationLink -Section 'program' } 'destination junction should be rejected'
    $sourceParentTarget = Join-Path $fixtureRoot 'copy-source-parent-target'
    New-FixtureFile (Join-Path $sourceParentTarget 'child\account.db') 'account data'
    $sourceParentLink = Join-Path $fixtureRoot 'copy-source-parent-link'
    New-Item -ItemType Junction -Path $sourceParentLink -Target $sourceParentTarget | Out-Null
    Assert-Throws { Copy-InstalledBackupSection -Source (Join-Path $sourceParentLink 'child') -Destination (Join-Path $fixtureRoot 'copy-source-parent-refused') -Section 'user-data' } 'source ancestor junction should be rejected'
    Assert-Throws { Copy-InstalledBackupSection -Source $source -Destination (Join-Path $destinationLink 'new-directory') -Section 'program' } 'destination ancestor junction should be rejected'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $target 'ordinary.txt'))) 'copy must not write through a destination junction'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $target 'new-directory'))) 'copy must not create a directory through a destination ancestor junction'
    Assert-True ((Get-Content -LiteralPath (Join-Path $target 'sentinel') -Raw) -eq 'target data') 'junction target sentinel should stay unchanged'
  }

  Test-Case 'incomplete cleanup removes only a direct partial fixture and preserves its source' {
    Reset-FixtureBackups
    $source = Join-Path $fixtureRoot 'incomplete-source'
    New-FixtureFile (Join-Path $source 'accounts.db') 'account source must remain'
    $partial = Join-Path $backupBase 'new-backup.partial'
    New-FixtureFile (Join-Path $partial 'user-data\accounts.db') 'copied staging content'
    Remove-IncompleteInstalledBackup -StagingRoot $partial -BackupBase $backupBase
    Assert-True (-not (Test-Path -LiteralPath $partial)) 'failed staging backup should be removed'
    Assert-True ((Get-Content -LiteralPath (Join-Path $source 'accounts.db') -Raw) -eq 'account source must remain') 'source must not be modified by staging cleanup'
    $outside = Join-Path $fixtureRoot 'outside-backup.partial'
    New-FixtureFile (Join-Path $outside 'sentinel') 'outside'
    Assert-Throws { Remove-IncompleteInstalledBackup -StagingRoot $outside -BackupBase $backupBase } 'outside staging path should be rejected'
    $finalBackup = Join-Path $backupBase 'finished-backup'
    New-FixtureFile (Join-Path $finalBackup 'sentinel') 'verified backup'
    Assert-Throws { Remove-IncompleteInstalledBackup -StagingRoot $finalBackup -BackupBase $backupBase } 'a final backup directory must not be cleaned as staging'
    $nested = Join-Path $finalBackup 'nested.partial'
    New-FixtureFile (Join-Path $nested 'sentinel') 'nested'
    Assert-Throws { Remove-IncompleteInstalledBackup -StagingRoot $nested -BackupBase $backupBase } 'nested staging path should be rejected'
    foreach ($path in @($outside, $finalBackup, $nested)) { Assert-True (Test-Path -LiteralPath $path) "refused staging cleanup must preserve: $path" }
  }

  Test-Case 'incomplete cleanup rejects linked staging roots and descendants' {
    Reset-FixtureBackups
    $target = Join-Path $fixtureRoot 'incomplete-link-target'
    New-FixtureFile (Join-Path $target 'sentinel') 'source stays unchanged'
    $linkedRoot = Join-Path $backupBase 'linked-root.partial'
    New-Item -ItemType Junction -Path $linkedRoot -Target $target | Out-Null
    Assert-Throws { Remove-IncompleteInstalledBackup -StagingRoot $linkedRoot -BackupBase $backupBase } 'linked staging root should be rejected'
    $partial = Join-Path $backupBase 'linked-child.partial'
    New-FixtureFile (Join-Path $partial 'ordinary.txt') 'incomplete copy'
    New-Item -ItemType Junction -Path (Join-Path $partial 'linked-child') -Target $target | Out-Null
    Assert-Throws { Remove-IncompleteInstalledBackup -StagingRoot $partial -BackupBase $backupBase } 'linked staging descendant should be rejected'
    Assert-True (Test-Path -LiteralPath (Join-Path $partial 'ordinary.txt')) 'linked staging cleanup should fail before deleting any files'
    Assert-True ((Get-Content -LiteralPath (Join-Path $target 'sentinel') -Raw) -eq 'source stays unchanged') 'linked staging target must stay unchanged'
  }

  Write-Host "Installed backup fixture tests passed: $passed"
} finally {
  # The checked GUID path is the only cleanup target. Existing project backups
  # and installed application/account data are never inspected or modified.
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-FixtureTree $fixtureRoot }
}
