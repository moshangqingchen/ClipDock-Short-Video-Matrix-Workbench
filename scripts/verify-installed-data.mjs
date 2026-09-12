import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertInstalledDataContext } from './installed-data-context.mjs';

const dataContext = assertInstalledDataContext('C:\\Users\\Administrator\\AppData\\Roaming\\short-video-matrix-workbench');
const backupRoot = process.argv[2];
if (!backupRoot || !fs.existsSync(path.join(backupRoot, 'manifest.json')))
  throw new Error('A verified backup directory is required');
const beforeRoot = path.join(backupRoot, 'user-data');
const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
if (manifest.Verified !== true) throw new Error('Backup manifest is not verified');
const currentRoot = dataContext.Source.PhysicalPath;
function snapshot(root) {
  const db = new DatabaseSync(path.join(root, 'workbench.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=3000; BEGIN;');
    const integrity = db.prepare('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const records = {};
    for (const name of ['accounts', 'global_accounts', 'assets', 'publish_records', 'works', 'metric_snapshots']) {
      if (!tables.has(name)) continue;
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
      const fields = name === 'accounts' ? ['id', 'platform_id', 'display_name', 'partition'] : ['id'];
      if (fields.some(field => !columns.includes(field))) throw new Error(`Unexpected ${name} schema`);
      records[name] = db.prepare(`SELECT ${fields.join(',')} FROM ${name} ORDER BY id`).all();
    }
    const checkInfoColumn = db.prepare('PRAGMA table_info(accounts)').all().some(row => row.name === 'check_info_json');
    return { integrity, records, checkInfoColumn };
  } finally { db.close(); }
}
const before = snapshot(beforeRoot);
const after = snapshot(currentRoot);
const counts = {};
let retained = after.integrity;
for (const [table, rows] of Object.entries(before.records)) {
  const currentRows = after.records[table] ?? [];
  const current = new Map(currentRows.map(row => [row.id, JSON.stringify(row)]));
  const matched = rows.filter(row => current.get(row.id) === JSON.stringify(row)).length;
  counts[table] = { before: rows.length, after: currentRows.length, retained: matched };
  retained &&= matched === rows.length;
}
function directories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
}
const profiles = {};
for (const relative of ['profiles/Partitions', 'global-browser-profiles']) {
  const old = directories(path.join(beforeRoot, relative));
  const current = directories(path.join(currentRoot, relative));
  profiles[relative] = { before: old.length, after: current.length, retained: old.filter(name => current.includes(name)).length };
  retained &&= profiles[relative].retained === old.length;
}
console.log(JSON.stringify({ userDataPath: currentRoot, dataContext, backupDataContext: manifest.DataContext ?? null, backupDatabaseIntegrity: before.integrity, databaseIntegrity: after.integrity, compatibleCheckInfoColumn: after.checkInfoColumn, counts, profiles, retained }, null, 2));
if (!retained) process.exitCode = 1;
