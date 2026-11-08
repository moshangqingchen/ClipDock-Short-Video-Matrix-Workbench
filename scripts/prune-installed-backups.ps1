param([Parameter(Mandatory = $true)][string]$BackupRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'installed-backup-policy.ps1')
$result = Remove-ExpiredInstalledBackups -BackupRoot $BackupRoot
$result | ConvertTo-Json -Depth 6 -Compress
