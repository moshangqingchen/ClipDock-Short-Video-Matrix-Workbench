# Keep this helper ASCII-only so Windows PowerShell 5.1 can dot-source it.
$script:InstalledBackupPolicyScriptRoot = $PSScriptRoot

function Get-InstalledBackupCanonicalPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not [IO.Path]::IsPathRooted($Path)) { throw 'An absolute filesystem path is required.' }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char[]]@('\', '/')) }
  return $full
}

function Assert-InstalledBackupPlainPath {
  param([Parameter(Mandatory = $true)][string]$Path, [switch]$RequireDirectory)
  $full = Get-InstalledBackupCanonicalPath -Path $Path
  $cursor = $full
  $first = $true
  while ($cursor) {
    $item = $null
    try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { }
    if ($item) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked filesystem path refused: $cursor" }
      if (-not $item.PSIsContainer) { throw "A directory path is required: $cursor" }
    } elseif ($first -and $RequireDirectory) {
      throw "Backup directory does not exist: $full"
    }
    $first = $false
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
  }
  return $full
}

function Get-InstalledBackupPolicy {
  $policyFile = Join-Path $script:InstalledBackupPolicyScriptRoot 'installed-backup-policy.json'
  $policyInfo = Get-Item -LiteralPath $policyFile -Force -ErrorAction Stop
  if ($policyInfo.PSIsContainer -or ($policyInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Backup policy must be a plain JSON file.'
  }
  $policy = [IO.File]::ReadAllText($policyFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
  if ($policy -isnot [pscustomobject] -or $policy.managedBy -isnot [string] -or $policy.managedBy -cne 'installed-backup-v1') { throw 'Unsupported installed backup policy.' }
  if (($policy.keepPerKind -isnot [int] -and $policy.keepPerKind -isnot [long]) -or $policy.keepPerKind -lt 1 -or $policy.keepPerKind -gt 100) {
    throw 'keepPerKind must be an integer from 1 through 100.'
  }
  if ($policy.backupDirectory -isnot [string] -or [string]::IsNullOrWhiteSpace($policy.backupDirectory) -or [IO.Path]::IsPathRooted($policy.backupDirectory)) {
    throw 'backupDirectory must be relative to the project.'
  }
  $parts = @($policy.backupDirectory -split '[\\/]')
  if (@($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_.Contains(':') }).Count) {
    throw 'backupDirectory contains an unsafe path component.'
  }
  $allowed = @('Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache')
  if ($policy.excludedUserDataDirectories -isnot [array] -or $policy.excludedUserDataDirectories.Count -eq 0) {
    throw 'excludedUserDataDirectories must be a nonempty array.'
  }
  $seen = @{}
  foreach ($name in $policy.excludedUserDataDirectories) {
    if ($name -isnot [string] -or $allowed -cnotcontains $name -or $seen.ContainsKey($name)) {
      throw 'Only explicit disposable Chromium cache directory names are permitted.'
    }
    $seen[$name] = $true
  }
  return $policy
}

function Get-InstalledBackupBase {
  $policy = Get-InstalledBackupPolicy
  $projectRoot = Get-InstalledBackupCanonicalPath -Path (Split-Path -Parent $script:InstalledBackupPolicyScriptRoot)
  $relative = $policy.backupDirectory.Replace('/', [IO.Path]::DirectorySeparatorChar)
  $base = Get-InstalledBackupCanonicalPath -Path (Join-Path $projectRoot $relative)
  $prefix = $projectRoot.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  if (-not $base.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup base is outside the project.' }
  return (Assert-InstalledBackupPlainPath -Path $base)
}

function Test-InstalledBackupCacheDirectory {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$RelativePath)
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.Contains(':')) { return $false }
  $parts = @($RelativePath -split '[\\/]')
  if (@($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count) { return $false }
  $policy = Get-InstalledBackupPolicy
  if ($policy.excludedUserDataDirectories -notcontains $parts[-1]) { return $false }
  if ($parts.Count -eq 1) { return $true }
  if (@('profiles', 'global-browser-profiles', 'Partitions') -notcontains $parts[0]) { return $false }
  # A same-named folder inside persistent storage is still persistent data.
  $persistent = @('Service Worker', 'CacheStorage', 'Local Storage', 'IndexedDB', 'Cookies', 'Session Storage', 'File System', 'databases', 'blob_storage', 'Network')
  foreach ($part in $parts[0..($parts.Count - 2)]) {
    if ($persistent -contains $part) { return $false }
  }
  return $true
}

function Get-InstalledBackupPlainManifest {
  param([Parameter(Mandatory = $true)][string]$BackupRoot)
  $manifestPath = Join-Path $BackupRoot 'manifest.json'
  $info = $null
  try { $info = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return $null }
  if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Backup manifest must be a plain file: $manifestPath"
  }
  try {
    return ([IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop)
  } catch { return $null }
}

function Test-InstalledBackupManagedManifest {
  param($Manifest, [Parameter(Mandatory = $true)]$Policy)
  return ($Manifest -is [pscustomobject] -and $Manifest.ManagedBy -is [string] -and $Manifest.ManagedBy -ceq $Policy.managedBy -and
    $Manifest.Verified -is [bool] -and $Manifest.Verified -eq $true -and
    $Manifest.Kind -is [string] -and
    @('full', 'program-and-database') -ccontains $Manifest.Kind)
}

function Assert-InstalledBackupPlainTree {
  param([Parameter(Mandatory = $true)][string]$BackupRoot)
  $root = Assert-InstalledBackupPlainPath -Path $BackupRoot -RequireDirectory
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($root)
  while ($stack.Count) {
    $directory = $stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked backup descendant refused: $($item.FullName)" }
      if ($item.PSIsContainer) { $stack.Push($item.FullName) }
    }
  }
}

function Remove-ExpiredInstalledBackups {
  param([Parameter(Mandatory = $true)][string]$BackupRoot)
  $policy = Get-InstalledBackupPolicy
  $base = Get-InstalledBackupBase
  $current = Get-InstalledBackupCanonicalPath -Path $BackupRoot
  if ($current.EndsWith('.partial', [StringComparison]::OrdinalIgnoreCase)) { throw 'An incomplete staging directory cannot trigger retention.' }
  $parent = [IO.Directory]::GetParent($current)
  if ($null -eq $parent -or -not $parent.FullName.Equals($base, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The new backup must be a direct child of the configured backup base.'
  }
  $null = Assert-InstalledBackupPlainPath -Path $current -RequireDirectory
  $currentManifest = Get-InstalledBackupPlainManifest -BackupRoot $current
  if (-not (Test-InstalledBackupManagedManifest -Manifest $currentManifest -Policy $policy)) {
    throw 'Retention requires a verified new backup managed by the current policy.'
  }
  Assert-InstalledBackupPlainTree -BackupRoot $current
  $lockPath = Join-Path $base '.installed-backup-retention.lock'
  if (Test-Path -LiteralPath $lockPath) {
    $lockInfo = Get-Item -LiteralPath $lockPath -Force -ErrorAction Stop
    if ($lockInfo.PSIsContainer -or ($lockInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe backup retention lock.' }
  }
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    # Recheck after taking the lock before making any retention decision.
    $checkedBase = Get-InstalledBackupBase
    if (-not $checkedBase.Equals($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup base changed during retention.' }
    Assert-InstalledBackupPlainTree -BackupRoot $current
    $currentManifest = Get-InstalledBackupPlainManifest -BackupRoot $current
    if (-not (Test-InstalledBackupManagedManifest -Manifest $currentManifest -Policy $policy)) { throw 'The new backup is no longer verified.' }
    $entries = New-Object 'System.Collections.Generic.List[object]'
    $referenced = @{}
    foreach ($directory in @(Get-ChildItem -LiteralPath $base -Directory -Force -ErrorAction Stop)) {
      $full = Get-InstalledBackupCanonicalPath -Path $directory.FullName
      $manifest = $null
      $reason = $null
      if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { $reason = 'linked-directory' }
      else { $manifest = Get-InstalledBackupPlainManifest -BackupRoot $full }
      if (-not $reason -and $directory.Name.EndsWith('.partial', [StringComparison]::OrdinalIgnoreCase)) { $reason = 'incomplete-directory' }
      if ($manifest -and $manifest.PreviousFullBackup -is [string] -and -not [string]::IsNullOrWhiteSpace($manifest.PreviousFullBackup)) {
        # Absolute references are written by both backup entry points. Resolve
        # relative references conservatively against both plausible roots.
        $references = @($manifest.PreviousFullBackup)
        if (-not [IO.Path]::IsPathRooted($manifest.PreviousFullBackup)) {
          $references = @((Join-Path $base $manifest.PreviousFullBackup), (Join-Path $full $manifest.PreviousFullBackup))
        }
        foreach ($reference in $references) {
          try { $referenced[(Get-InstalledBackupCanonicalPath -Path $reference)] = $true }
          catch { throw "Unsafe PreviousFullBackup path in: $full" }
        }
      }
      $managed = (-not $reason) -and (Test-InstalledBackupManagedManifest -Manifest $manifest -Policy $policy)
      if (-not $reason -and -not $managed) { $reason = 'unmanaged-or-unverified' }
      $created = $directory.CreationTimeUtc
      $parsed = [DateTimeOffset]::MinValue
      if ($managed) {
        if ($manifest.CreatedAt -is [DateTimeOffset]) { $created = $manifest.CreatedAt.UtcDateTime }
        elseif ($manifest.CreatedAt -is [DateTime]) { $created = $manifest.CreatedAt.ToUniversalTime() }
        elseif ($manifest.CreatedAt -is [string] -and [DateTimeOffset]::TryParse($manifest.CreatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
          $created = $parsed.UtcDateTime
        }
      }
      $pinned = $false
      if ($reason -ne 'linked-directory') { $pinned = Test-Path -LiteralPath (Join-Path $full '.keep') }
      $entries.Add([pscustomobject]@{ BackupRoot = $full; Kind = $(if ($manifest) { $manifest.Kind } else { $null }); Managed = $managed; CreatedAt = $created; Reason = $reason; Pinned = $pinned })
    }
    $latest = @{}
    foreach ($kind in @('full', 'program-and-database')) {
      $newest = @($entries | Where-Object { $_.Managed -and $_.Kind -ceq $kind } | Sort-Object @{ Expression = { $_.CreatedAt }; Descending = $true }, @{ Expression = { $_.BackupRoot }; Descending = $true } | Select-Object -First $policy.keepPerKind)
      foreach ($entry in $newest) { $latest[$entry.BackupRoot] = $true }
    }
    $deleted = New-Object 'System.Collections.Generic.List[object]'
    $kept = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.List[object]'
    foreach ($entry in $entries) {
      $reason = $entry.Reason
      if ($entry.BackupRoot.Equals($current, [StringComparison]::OrdinalIgnoreCase)) { $reason = 'current' }
      elseif ($entry.Pinned) { $reason = 'keep-marker' }
      elseif ($entry.Kind -ceq 'full' -and $referenced.ContainsKey($entry.BackupRoot)) { $reason = 'referenced-full' }
      elseif ($latest.ContainsKey($entry.BackupRoot)) { $reason = 'latest-per-kind' }
      if ($reason) { $kept.Add([pscustomobject]@{ BackupRoot = $entry.BackupRoot; Kind = $entry.Kind; Reason = $reason }) }
      else { $pending.Add($entry) }
    }
    # Fully preflight every removal before deleting the first expired backup.
    foreach ($entry in $pending) {
      $target = Get-InstalledBackupCanonicalPath -Path $entry.BackupRoot
      $targetParent = [IO.Directory]::GetParent($target)
      if ($null -eq $targetParent -or -not $targetParent.FullName.Equals($base, [StringComparison]::OrdinalIgnoreCase) -or $target.Equals($current, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unsafe retention target.'
      }
      Assert-InstalledBackupPlainTree -BackupRoot $target
      $manifest = Get-InstalledBackupPlainManifest -BackupRoot $target
      if (-not (Test-InstalledBackupManagedManifest -Manifest $manifest -Policy $policy)) { throw 'Retention target is no longer a verified managed backup.' }
    }
    foreach ($entry in $pending) {
      # Check again immediately before the native PowerShell removal.
      $null = Assert-InstalledBackupPlainPath -Path $base -RequireDirectory
      Assert-InstalledBackupPlainTree -BackupRoot $entry.BackupRoot
      if (Test-Path -LiteralPath (Join-Path $entry.BackupRoot '.keep')) { throw 'A retention target became pinned.' }
      $manifest = Get-InstalledBackupPlainManifest -BackupRoot $entry.BackupRoot
      if (-not (Test-InstalledBackupManagedManifest -Manifest $manifest -Policy $policy)) { throw 'Retention target changed.' }
      Remove-Item -LiteralPath $entry.BackupRoot -Recurse -Force -ErrorAction Stop
      $deleted.Add([pscustomobject]@{ BackupRoot = $entry.BackupRoot; Kind = $entry.Kind })
    }
    $byKind = @()
    foreach ($kind in @('full', 'program-and-database')) {
      $byKind += [pscustomobject]@{ Kind = $kind; DeletedCount = @($deleted | Where-Object { $_.Kind -ceq $kind }).Count; KeptCount = @($kept | Where-Object { $_.Kind -ceq $kind }).Count }
    }
    return [pscustomobject]@{ ManagedBy = $policy.managedBy; BackupBase = $base; CurrentBackupRoot = $current; KeepPerKind = $policy.keepPerKind; TotalDirectories = $entries.Count; ManagedCount = @($entries | Where-Object { $_.Managed }).Count; DeletedCount = $deleted.Count; KeptCount = $kept.Count; ByKind = $byKind; Deleted = @($deleted.ToArray()); Kept = @($kept.ToArray()) }
  } finally { $lock.Dispose() }
}
