# File copying shared by the full-backup entry and fixture tests. No live-data IO
# happens when this file is dot-sourced.
. (Join-Path $PSScriptRoot 'installed-backup-policy.ps1')

function Copy-InstalledBackupSection {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][ValidateSet('user-data', 'program')][string]$Section
  )
  $sourceRoot = Assert-InstalledBackupPlainPath -Path ([IO.Path]::GetFullPath($Source)) -RequireDirectory
  $sourceItem = Get-Item -LiteralPath $sourceRoot -Force -ErrorAction Stop
  if (-not $sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Backup source must be a plain directory.'
  }
  $sourceRoot = $sourceItem.FullName.TrimEnd('\', '/')
  $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
  if ($destinationRoot -ieq $sourceRoot -or
      $destinationRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      $sourceRoot.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup source and destination must not overlap.'
  }
  if (Test-Path -LiteralPath $destinationRoot) { throw 'Backup destination already exists.' }
  $ancestor = [IO.Path]::GetDirectoryName($destinationRoot)
  while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
      if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Linked backup destination refused.'
      }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  New-Item -ItemType Directory -Path $destinationRoot -ErrorAction Stop | Out-Null
  $records = [System.Collections.Generic.List[object]]::new()
  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push('')
  $excluded = 0
  while ($pending.Count) {
    $relativeDirectory = $pending.Pop()
    $directory = if ($relativeDirectory) { Join-Path $sourceRoot $relativeDirectory } else { $sourceRoot }
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked source entry refused.' }
      $relative = $item.FullName.Substring($sourceRoot.Length + 1)
      $output = Join-Path $destinationRoot $relative
      if ($item.PSIsContainer) {
        if ($Section -eq 'user-data' -and (Test-InstalledBackupCacheDirectory -RelativePath $relative)) {
          $excluded++
          continue
        }
        New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
        $pending.Push($relative)
        continue
      }
      Copy-Item -LiteralPath $item.FullName -Destination $output -ErrorAction Stop
      $copy = Get-Item -LiteralPath $output -Force -ErrorAction Stop
      if ($copy.Length -ne $item.Length) { throw 'Backup file size mismatch.' }
      $sourceHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
      $copyHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256 -ErrorAction Stop).Hash
      if ($sourceHash -ne $copyHash) { throw 'Backup file hash mismatch.' }
      $records.Add([pscustomobject]@{ Section = $Section; Path = $relative; Bytes = $copy.Length; SHA256 = $copyHash })
    }
  }
  $copiedCount = @(Get-ChildItem -LiteralPath $destinationRoot -Recurse -Force -File -ErrorAction Stop).Count
  if ($copiedCount -ne $records.Count) { throw 'Backup file count mismatch.' }
  return [pscustomobject]@{ Files = $records; ExcludedCacheDirectories = $excluded }
}

function Remove-IncompleteInstalledBackup {
  param([string]$StagingRoot, [string]$BackupBase)
  $basePath = [IO.Path]::GetFullPath($BackupBase).TrimEnd('\', '/')
  $target = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\', '/')
  if ([IO.Path]::GetDirectoryName($target) -ine $basePath -or -not $target.EndsWith('.partial', [StringComparison]::Ordinal)) {
    throw 'Incomplete backup is outside its expected parent.'
  }
  $null = Assert-InstalledBackupPlainPath -Path $basePath -RequireDirectory
  if (-not (Test-Path -LiteralPath $target)) { return }
  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push($target)
  while ($pending.Count) {
    $directory = $pending.Pop()
    if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Linked incomplete backup refused.'
    }
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked incomplete backup entry refused.' }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
}
