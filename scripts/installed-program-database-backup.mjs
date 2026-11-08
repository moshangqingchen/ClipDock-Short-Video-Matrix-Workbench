import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

function assertPlainPath(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked backup path refused');
    if (path.dirname(current) === current) break;
  }
}

export function getInstalledBackupSettings(projectRoot) {
  const policy = JSON.parse(fs.readFileSync(path.join(projectRoot, 'scripts/installed-backup-policy.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!policy || Array.isArray(policy) || policy.managedBy !== 'installed-backup-v1' ||
      !Number.isInteger(policy.keepPerKind) || policy.keepPerKind < 1 || policy.keepPerKind > 100 ||
      typeof policy.backupDirectory !== 'string' || path.isAbsolute(policy.backupDirectory) ||
      policy.backupDirectory.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('Invalid installed backup policy');
  }
  const backupBase = path.resolve(projectRoot, policy.backupDirectory);
  const relative = path.relative(path.resolve(projectRoot), backupBase);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Backup base must stay inside the project');
  assertPlainPath(backupBase);
  return { policy, backupBase };
}

function filesIn(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Linked backup entry refused');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error('Unsupported backup entry');
    }
  };
  assertPlainPath(root);
  visit(root);
  return files;
}

function previousFullBackup(backupBase) {
  const candidates = [];
  for (const entry of fs.readdirSync(backupBase, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.partial')) continue;
    const directory = path.join(backupBase, entry.name);
    const manifestPath = path.join(directory, 'manifest.json');
    try {
      assertPlainPath(directory);
      assertPlainPath(manifestPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      const full = manifest.Kind === 'full' || (!manifest.Kind && Array.isArray(manifest.Files) &&
        manifest.Files.some(file => file.Section === 'user-data') && manifest.Files.some(file => file.Section === 'program'));
      if (manifest.Verified !== true || manifest.DatabaseIntegrity === false || !full || !Number.isFinite(Date.parse(manifest.CreatedAt))) continue;
      const database = path.join(directory, 'user-data/workbench.db');
      assertPlainPath(database);
      if (!fs.statSync(database).isFile()) continue;
      candidates.push({ directory, manifest });
    } catch { /* Unrecognized, incomplete and historical diagnostic backups stay untouched. */ }
  }
  candidates.sort((a, b) => Date.parse(b.manifest.CreatedAt) - Date.parse(a.manifest.CreatedAt));
  if (!candidates.length) throw new Error('Create a full backup before using program-and-database backup');
  return candidates[0];
}

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Kept separate from the live-data guard so verification can use disposable
// program and SQLite fixtures without accessing the installed application.
export async function createProgramDatabaseBackup({ program, data, backupBase, policy, dataContext }) {
  assertPlainPath(backupBase);
  assertPlainPath(program);
  assertPlainPath(data);
  const dataFile = path.join(data, 'workbench.db');
  assertPlainPath(dataFile);
  if (!fs.statSync(dataFile).isFile()) throw new Error('Source database is missing');
  for (const source of [program, data]) {
    const relative = path.relative(path.resolve(source), path.resolve(backupBase));
    const reverse = path.relative(path.resolve(backupBase), path.resolve(source));
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)) ||
        !reverse || (!reverse.startsWith('..') && !path.isAbsolute(reverse))) throw new Error('Backup source and destination overlap');
  }
  fs.mkdirSync(backupBase, { recursive: true });
  const previous = previousFullBackup(backupBase);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const target = path.join(backupBase, `program-database-${stamp}-${randomUUID().slice(0, 6)}`);
  const staging = `${target}.partial`;
  fs.mkdirSync(staging);
  try {
    const records = [];
    const programFiles = filesIn(program);
    for (const file of programFiles) {
      const relative = path.relative(program, file);
      const output = path.join(staging, 'program', relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(file, output, fs.constants.COPYFILE_EXCL);
      const sourceHash = hash(file);
      if (hash(output) !== sourceHash) throw new Error('Program backup mismatch');
      records.push({ Section: 'program', Path: relative, Bytes: fs.statSync(output).size, SHA256: sourceHash });
    }
    fs.mkdirSync(path.join(staging, 'user-data'));
    const output = path.join(staging, 'user-data/workbench.db');
    const database = new DatabaseSync(dataFile, { readOnly: true });
    try { await backup(database, output); } finally { database.close(); }
    // A backup of a WAL database inherits its journal mode. Finalize only the
    // destination as a standalone DB before hashing, without touching the writer.
    const saved = new DatabaseSync(output);
    try {
      const mode = saved.prepare('PRAGMA journal_mode=DELETE').get();
      if (String(Object.values(mode)[0]).toLowerCase() !== 'delete') throw new Error('Snapshot journal finalization failed');
      if (!saved.prepare('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok')) throw new Error('Snapshot integrity failure');
    } finally { saved.close(); }
    records.push({ Section: 'user-data', Path: 'workbench.db', Bytes: fs.statSync(output).size, SHA256: hash(output) });
    // This reference identifies a separate login-data restore point. Historical
    // manifests record creation-time verification, not a fresh integrity check.
    assertPlainPath(previous.directory);
    if (!fs.existsSync(path.join(previous.directory, 'manifest.json'))) throw new Error('Full backup disappeared during snapshot');
    const report = {
      ManagedBy: policy.managedBy,
      Kind: 'program-and-database',
      BackupRoot: target,
      PreviousFullBackup: previous.directory,
      PreviousBackupDataContext: previous.manifest.DataContext ?? null,
      DataContext: dataContext,
      Verified: true,
      DatabaseIntegrity: true,
      ProgramFiles: programFiles.length,
      FileCount: records.length,
      TotalBytes: records.reduce((total, record) => total + record.Bytes, 0),
      CreatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ ...report, Files: records }, null, 2), { flag: 'wx' });
    fs.renameSync(staging, target);
    return report;
  } catch (error) {
    // Only remove this invocation's direct staging child after checking links.
    if (path.dirname(path.resolve(staging)) !== path.resolve(backupBase) || !staging.endsWith('.partial')) throw error;
    try { filesIn(staging); fs.rmSync(staging, { recursive: true }); }
    catch (cleanupError) { error.message += `; incomplete backup cleanup failed: ${cleanupError.message}`; }
    throw error;
  }
}
