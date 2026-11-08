import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertInstalledDataContext } from './installed-data-context.mjs';
import { createProgramDatabaseBackup, getInstalledBackupSettings } from './installed-program-database-backup.mjs';

// This update replaces program files only. Snapshot SQLite consistently without
// depending on disposable Chromium cache files being unlocked.
const program = 'D:\\SJdownloads\\创作平台';
const dataContext = assertInstalledDataContext('C:\\Users\\Administrator\\AppData\\Roaming\\short-video-matrix-workbench');
const data = dataContext.Source.PhysicalPath;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const { policy, backupBase } = getInstalledBackupSettings(projectRoot);
const report = await createProgramDatabaseBackup({ program, data, backupBase, policy, dataContext });
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const retention = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File',
  fileURLToPath(new URL('./prune-installed-backups.ps1', import.meta.url)), '-BackupRoot', report.BackupRoot],
{ encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
try {
  if (retention.error || retention.status !== 0) throw retention.error || new Error(retention.stderr.trim() || 'Retention failed');
  report.Retention = JSON.parse(retention.stdout.replace(/^\uFEFF/, '').trim());
} catch (error) {
  report.Retention = { Status: 'deferred', Error: error.message };
  console.error(`Backup verified; retention deferred: ${error.message}`);
}
console.log(JSON.stringify(report));
