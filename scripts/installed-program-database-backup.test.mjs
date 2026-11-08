import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProgramDatabaseBackup, getInstalledBackupSettings } from './installed-program-database-backup.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryBase = path.join(projectRoot, 'output', 'temp');
const policy = { managedBy: 'installed-backup-v1', keepPerKind: 3, backupDirectory: 'backups' };
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function assertUnlinkedAncestors(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `Linked fixture ancestor: ${current}`);
    if (current === path.dirname(current)) break;
  }
}

function checkedFixturePath(fixtureRoot, file) {
  const absolute = path.resolve(file);
  const relative = path.relative(fixtureRoot, absolute);
  assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'Fixture operation escaped its root');
  return absolute;
}

function removeFixtureTree(fixtureRoot, file = fixtureRoot) {
  const absolute = checkedFixturePath(fixtureRoot, file);
  // The containing directories must be plain paths before inspecting a child.
  assertUnlinkedAncestors(path.dirname(absolute));
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) {
    // unlink removes only the junction/link, without following its target.
    fs.unlinkSync(absolute);
  } else if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) removeFixtureTree(fixtureRoot, path.join(absolute, name));
    fs.rmdirSync(absolute);
  } else {
    fs.unlinkSync(absolute);
  }
}

async function withFixture(run) {
  assertUnlinkedAncestors(temporaryBase);
  fs.mkdirSync(temporaryBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryBase, 'installed-program-database-test-'));
  assert.equal(path.dirname(root), temporaryBase);
  const fixture = { root, program: path.join(root, 'program'), data: path.join(root, 'data'), backupBase: path.join(root, 'backups') };
  for (const directory of [fixture.program, fixture.data, fixture.backupBase]) fs.mkdirSync(directory);
  try { return await run(fixture); }
  finally { removeFixtureTree(root); }
}

function writeFile(file, contents = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function initializeDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try { database.exec('CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture_rows VALUES (1, \'initial\');'); }
  finally { database.close(); }
}

function createFull(fixture, name, { legacy = false, createdAt = '2026-01-01T00:00:00Z', overrides = {}, missingDatabase = false } = {}) {
  const directory = path.join(fixture.backupBase, name);
  fs.mkdirSync(directory);
  writeFile(path.join(directory, 'program', 'fixture.exe'));
  if (!missingDatabase) initializeDatabase(path.join(directory, 'user-data', 'workbench.db'));
  const manifest = {
    ...(legacy ? {} : { ManagedBy: policy.managedBy, Kind: 'full' }),
    BackupRoot: directory,
    CreatedAt: createdAt,
    Verified: true,
    Files: [{ Section: 'program', Path: 'fixture.exe' }, { Section: 'user-data', Path: 'workbench.db' }],
    ...overrides,
  };
  writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

function backupOptions(fixture) {
  return { ...fixture, policy, dataContext: { fixture: true, Source: { PhysicalPath: fixture.data } } };
}

function readManifest(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
}

function prepareSource(fixture) {
  writeFile(path.join(fixture.program, 'workbench.exe'), 'fixture program');
  initializeDatabase(path.join(fixture.data, 'workbench.db'));
}

test('online SQLite snapshot includes committed WAL rows and copies only program plus the database', async () => withFixture(async fixture => {
  const previous = createFull(fixture, 'full-before-update');
  writeFile(path.join(fixture.program, 'workbench.exe'), Buffer.from([0, 1, 2, 255]));
  writeFile(path.join(fixture.program, 'resources', 'app.asar'), 'program archive');
  writeFile(path.join(fixture.program, 'resources', 'empty.file'), '');
  writeFile(path.join(fixture.data, 'profiles', 'Partitions', 'fixture', 'Cookies'), 'fixture cookie');
  writeFile(path.join(fixture.data, 'global-browser-profiles', 'fixture', 'Local Storage', 'fixture'), 'fixture local storage');
  writeFile(path.join(fixture.data, 'Cache', 'fixture'), 'disposable cache');
  const writer = new DatabaseSync(path.join(fixture.data, 'workbench.db'));
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, value TEXT); BEGIN; INSERT INTO fixture_rows VALUES (1, 'committed in WAL'); COMMIT;");
    assert.ok(fs.statSync(path.join(fixture.data, 'workbench.db-wal')).size > 0);
    const report = await createProgramDatabaseBackup(backupOptions(fixture));
    assert.equal(report.PreviousFullBackup, previous);
    assert.equal(report.ProgramFiles, 3);
    assert.equal(report.FileCount, 4);
    assert.equal(report.Verified, true);
    assert.equal(report.DatabaseIntegrity, true);
    assert.equal(report.ManagedBy, policy.managedBy);
    assert.deepEqual(fs.readdirSync(path.join(report.BackupRoot, 'user-data')), ['workbench.db']);
    assert.deepEqual(fs.readdirSync(report.BackupRoot).sort(), ['manifest.json', 'program', 'user-data']);
    const snapshot = new DatabaseSync(path.join(report.BackupRoot, 'user-data', 'workbench.db'), { readOnly: true });
    try {
      assert.equal(snapshot.prepare('SELECT value FROM fixture_rows WHERE id = 1').get().value, 'committed in WAL');
      assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally { snapshot.close(); }
    // The writer remains open and usable throughout the copy and verification.
    assert.equal(writer.prepare('SELECT COUNT(*) AS total FROM fixture_rows').get().total, 1);
    assert.equal(writer.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    writer.exec("BEGIN; INSERT INTO fixture_rows VALUES (2, 'committed after snapshot'); COMMIT;");
    assert.equal(writer.prepare('SELECT COUNT(*) AS total FROM fixture_rows').get().total, 2);
    const manifest = readManifest(report.BackupRoot);
    const programRecords = manifest.Files.filter(record => record.Section === 'program');
    assert.equal(programRecords.length, 3);
    for (const record of manifest.Files) {
      const saved = path.join(report.BackupRoot, record.Section, record.Path);
      assert.equal(record.SHA256, sha256(saved));
      assert.equal(record.Bytes, fs.statSync(saved).size);
      if (record.Section === 'program') assert.equal(record.SHA256, sha256(path.join(fixture.program, record.Path)));
    }
    assert.equal(manifest.TotalBytes, manifest.Files.reduce((total, record) => total + record.Bytes, 0));
    assert.equal(fs.existsSync(path.join(fixture.data, 'profiles', 'Partitions', 'fixture', 'Cookies')), true);
    assert.equal(fs.readdirSync(fixture.backupBase).some(name => name.endsWith('.partial')), false);
  } finally { writer.close(); }
}));

test('latest eligible full restore point supports managed and legacy manifests and ignores invalid candidates', async () => withFixture(async fixture => {
  prepareSource(fixture);
  const legacy = createFull(fixture, 'legacy-full', { legacy: true, createdAt: '2026-01-01T00:00:00Z' });
  const managed = createFull(fixture, 'managed-full', { createdAt: '2026-02-01T00:00:00Z' });
  createFull(fixture, 'unverified-full', { createdAt: '2026-12-01T00:00:00Z', overrides: { Verified: false } });
  createFull(fixture, 'unfinished.partial', { createdAt: '2026-12-02T00:00:00Z' });
  createFull(fixture, 'raw-database-diagnostic', { createdAt: '2026-12-03T00:00:00Z', overrides: { Kind: 'program-and-raw-database', DatabaseIntegrity: false } });
  createFull(fixture, 'known-unhealthy-full', { createdAt: '2026-12-03T12:00:00Z', overrides: { DatabaseIntegrity: false } });
  createFull(fixture, 'missing-database-full', { createdAt: '2026-12-04T00:00:00Z', missingDatabase: true });
  const malformed = createFull(fixture, 'broken-manifest', { createdAt: '2026-12-05T00:00:00Z' });
  writeFile(path.join(malformed, 'manifest.json'), '{broken JSON');
  createFull(fixture, 'invalid-date-full', { createdAt: 'invalid date' });
  const report = await createProgramDatabaseBackup(backupOptions(fixture));
  assert.equal(report.PreviousFullBackup, managed);
  // Legacy full backups remain eligible when their recorded time is newer.
  const legacyManifest = readManifest(legacy);
  legacyManifest.CreatedAt = '2026-03-01T00:00:00Z';
  writeFile(path.join(legacy, 'manifest.json'), JSON.stringify(legacyManifest));
  const laterReport = await createProgramDatabaseBackup(backupOptions(fixture));
  assert.equal(laterReport.PreviousFullBackup, legacy);
}));

test('a failed database snapshot retains existing backups and removes only its own partial directory', async () => withFixture(async fixture => {
  createFull(fixture, 'existing-full');
  writeFile(path.join(fixture.program, 'workbench.exe'), 'fixture program');
  writeFile(path.join(fixture.data, 'workbench.db'), 'not a SQLite database');
  for (let index = 0; index < 5; index++) {
    const old = path.join(fixture.backupBase, `old-program-database-${index}`);
    writeFile(path.join(old, 'manifest.json'), JSON.stringify({ ManagedBy: policy.managedBy, Kind: 'program-and-database', Verified: true, CreatedAt: `2026-01-0${index + 1}T00:00:00Z` }));
    writeFile(path.join(old, 'retain.fixture'), `older backup ${index}`);
  }
  const priorPartial = path.join(fixture.backupBase, 'pre-existing.partial');
  writeFile(path.join(priorPartial, 'retain.fixture'), 'unrelated incomplete backup');
  const before = fs.readdirSync(fixture.backupBase).sort();
  await assert.rejects(createProgramDatabaseBackup({ ...backupOptions(fixture), policy: { ...policy, keepPerKind: 1 } }));
  assert.deepEqual(fs.readdirSync(fixture.backupBase).sort(), before);
  for (let index = 0; index < 5; index++) assert.equal(fs.readFileSync(path.join(fixture.backupBase, `old-program-database-${index}`, 'retain.fixture'), 'utf8'), `older backup ${index}`);
  assert.equal(fs.readFileSync(path.join(priorPartial, 'retain.fixture'), 'utf8'), 'unrelated incomplete backup');
}));

test('source program junction is refused without copying or following its contents', async () => withFixture(async fixture => {
  prepareSource(fixture);
  createFull(fixture, 'existing-full');
  const target = path.join(fixture.root, 'linked-program-target');
  writeFile(path.join(target, 'retain.fixture'), 'linked target must survive');
  fs.symlinkSync(target, path.join(fixture.program, 'linked-resources'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.readdirSync(fixture.backupBase).sort();
  await assert.rejects(createProgramDatabaseBackup(backupOptions(fixture)), /Linked backup entry refused/);
  assert.deepEqual(fs.readdirSync(fixture.backupBase).sort(), before);
  assert.equal(fs.readFileSync(path.join(target, 'retain.fixture'), 'utf8'), 'linked target must survive');
}));

test('program-and-database backup requires a preceding full backup', async () => withFixture(async fixture => {
  prepareSource(fixture);
  await assert.rejects(createProgramDatabaseBackup(backupOptions(fixture)), /Create a full backup/);
  assert.deepEqual(fs.readdirSync(fixture.backupBase), []);
}));

test('settings confine backupDirectory to a plain directory inside the configured project', async () => withFixture(async fixture => {
  const fixtureProject = path.join(fixture.root, 'project');
  const policyFile = path.join(fixtureProject, 'scripts', 'installed-backup-policy.json');
  writeFile(policyFile, JSON.stringify(policy));
  const settings = getInstalledBackupSettings(fixtureProject);
  assert.equal(settings.backupBase, path.join(fixtureProject, 'backups'));
  assert.deepEqual(settings.policy, policy);
  for (const backupDirectory of ['.', '..', '../outside-project', path.join(fixture.root, 'absolute-outside-project')]) {
    writeFile(policyFile, JSON.stringify({ ...policy, backupDirectory }));
    assert.throws(() => getInstalledBackupSettings(fixtureProject), /Backup base must stay inside the project|Invalid installed backup policy/);
  }
  const target = path.join(fixture.root, 'linked-backup-target');
  writeFile(path.join(target, 'retain.fixture'), 'linked target');
  fs.symlinkSync(target, path.join(fixtureProject, 'linked-backups'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFile(policyFile, JSON.stringify({ ...policy, backupDirectory: 'linked-backups' }));
  assert.throws(() => getInstalledBackupSettings(fixtureProject), /Linked backup path refused/);
}));

test('Node manifest integrates with PowerShell retention using the actual Unicode policy path', { skip: process.platform !== 'win32' }, async () => withFixture(async fixture => {
  const fixtureProject = path.join(fixture.root, 'project');
  const fixtureScripts = path.join(fixtureProject, 'scripts');
  fs.mkdirSync(fixtureScripts, { recursive: true });
  for (const name of ['installed-backup-policy.json', 'installed-backup-policy.ps1', 'prune-installed-backups.ps1']) {
    fs.copyFileSync(path.join(projectRoot, 'scripts', name), path.join(fixtureScripts, name), fs.constants.COPYFILE_EXCL);
  }
  const settings = getInstalledBackupSettings(fixtureProject);
  assert.match(settings.policy.backupDirectory, /历史资料/);
  fs.mkdirSync(settings.backupBase, { recursive: true });
  const integratedFixture = { ...fixture, backupBase: settings.backupBase };
  prepareSource(integratedFixture);
  const full = createFull(integratedFixture, 'retained-login-data-full', { createdAt: '2025-01-01T00:00:00Z' });
  const older = [];
  for (let index = 0; index < 3; index++) {
    const directory = path.join(settings.backupBase, `older-program-database-${index}`);
    writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      ManagedBy: settings.policy.managedBy,
      Kind: 'program-and-database',
      BackupRoot: directory,
      CreatedAt: `2025-02-0${index + 1}T00:00:00Z`,
      Verified: true,
      PreviousFullBackup: full,
    }));
    writeFile(path.join(directory, 'retained.fixture'), `program database ${index}`);
    older.push(directory);
  }
  const report = await createProgramDatabaseBackup({ ...backupOptions(integratedFixture), policy: settings.policy });
  assert.equal(report.PreviousFullBackup, full);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(fixtureScripts, 'prune-installed-backups.ps1'), '-BackupRoot', report.BackupRoot], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const retention = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(retention.BackupBase, settings.backupBase);
  assert.equal(retention.DeletedCount, 1);
  const databaseKind = retention.ByKind.find(entry => entry.Kind === 'program-and-database');
  assert.equal(databaseKind.DeletedCount, 1);
  assert.equal(databaseKind.KeptCount, 3);
  assert.deepEqual(retention.Deleted.map(entry => entry.BackupRoot), [older[0]]);
  assert.equal(fs.existsSync(older[0]), false);
  assert.equal(fs.existsSync(older[1]), true);
  assert.equal(fs.existsSync(older[2]), true);
  assert.equal(fs.existsSync(report.BackupRoot), true);
  assert.equal(fs.existsSync(path.join(full, 'user-data', 'workbench.db')), true);
  assert.ok(retention.Kept.some(entry => entry.BackupRoot === full && entry.Reason === 'referenced-full'));
}));
