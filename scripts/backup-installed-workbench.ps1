$ErrorActionPreference = 'Stop'
$installRoot = 'D:\SJdownloads\创作平台'
$dataRoot = 'C:\Users\Administrator\AppData\Roaming\short-video-matrix-workbench'
$backupBase = 'D:\SJdownloads\创作平台备份'

function Assert-AppClosed {
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq "$installRoot\短视频矩阵工作台.exe" -or
    ($_.Name -match '^(chrome|msedge|electron|短视频矩阵工作台)\.exe$' -and $_.CommandLine -like "*$dataRoot*")
  })
  if ($running.Count) { throw '软件或账号浏览器仍在运行；请正常退出后重试。' }
}

Assert-AppClosed
$backupRoot = Join-Path $backupBase ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
if (Test-Path -LiteralPath $backupRoot) { throw '拒绝覆盖已有备份目录。' }
New-Item -ItemType Directory -Path $backupRoot | Out-Null
$records = [System.Collections.Generic.List[object]]::new()
foreach ($entry in @(@{ Source = $dataRoot; Name = 'user-data' }, @{ Source = $installRoot; Name = 'program' })) {
  $source = (Resolve-Path -LiteralPath $entry.Source).Path
  $items = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
  if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
    throw '源目录包含链接，需要先核实目标；未覆盖安装。'
  }
  $files = @($items | Where-Object { -not $_.PSIsContainer })
  $destination = Join-Path $backupRoot $entry.Name
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
  Assert-AppClosed
  $copied = @(Get-ChildItem -LiteralPath $destination -Recurse -Force -File)
  if ($files.Count -ne $copied.Count) { throw '备份文件数量不匹配。' }
  $index = 0
  foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
    $copy = Join-Path $destination $relative
    if ($file.Length -ne (Get-Item -LiteralPath $copy).Length) { throw '备份文件大小不匹配。' }
    $beforeHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $copyHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
    if ($beforeHash -ne $copyHash) { throw '备份内容校验失败，未覆盖安装。' }
    $records.Add([pscustomobject]@{ Section = $entry.Name; Path = $relative; Bytes = $file.Length; SHA256 = $copyHash })
    $index++
    if ($index % 4000 -eq 0) { Write-Output "$($entry.Name): verified $index / $($files.Count) files" }
  }
  Write-Output "$($entry.Name): verified $($files.Count) files"
}
Assert-AppClosed
$report = [pscustomobject]@{
  CreatedAt = [DateTimeOffset]::Now.ToString('o')
  BackupRoot = $backupRoot
  FileCount = $records.Count
  TotalBytes = ($records | Measure-Object -Property Bytes -Sum).Sum
  Verified = $true
  Files = $records
}
[IO.File]::WriteAllText((Join-Path $backupRoot 'manifest.json'), ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$report | Select-Object CreatedAt, BackupRoot, FileCount, TotalBytes, Verified | ConvertTo-Json -Compress
