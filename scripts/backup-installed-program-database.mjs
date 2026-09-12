import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { assertInstalledDataContext } from './installed-data-context.mjs';

// This update replaces program files only. Snapshot SQLite consistently without
// depending on disposable Chromium cache files being unlocked.
const program='D:\\SJdownloads\\创作平台';
const dataContext = assertInstalledDataContext('C:\\Users\\Administrator\\AppData\\Roaming\\short-video-matrix-workbench');
const data = dataContext.Source.PhysicalPath;
const previousFull='D:\\SJdownloads\\创作平台备份\\20260912-191125-d7cf22';
if(!fs.existsSync(path.join(previousFull,'manifest.json')))throw Error('Verified full backup missing');
const prior=JSON.parse(fs.readFileSync(path.join(previousFull,'manifest.json'),'utf8').replace(/^\uFEFF/,''));
if(!prior.Verified)throw Error('Prior backup not verified');
const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'');
const target=path.join('D:\\SJdownloads\\创作平台备份',`account-location-${stamp}-${randomUUID().slice(0,6)}`);
fs.mkdirSync(target);
const records=[];
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const file=path.join(dir,entry.name);
  if(entry.isSymbolicLink())throw Error('Linked program entry refused');
  return entry.isDirectory()?walk(file):[file];
});
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const file of walk(program)){
  const relative=path.relative(program,file);
  const output=path.resolve(target,'program',relative);
  if(!output.startsWith(path.join(target,'program')+path.sep))throw Error('Backup path outside target');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(file,output);
  const sourceHash=hash(file);
  if(hash(output)!==sourceHash)throw Error('Program backup mismatch');
  records.push({path:relative,sha256:sourceHash});
}
fs.mkdirSync(path.join(target,'user-data'));
const database=new DatabaseSync(path.join(data,'workbench.db'),{readOnly:true});
try{await backup(database,path.join(target,'user-data','workbench.db'))}finally{database.close()}
const saved=new DatabaseSync(path.join(target,'user-data','workbench.db'),{readOnly:true});
try{if(!saved.prepare('PRAGMA quick_check').all().every(r=>Object.values(r)[0]==='ok'))throw Error('Snapshot integrity failure')}finally{saved.close()}
const report={Kind:'program-and-database',BackupRoot:target,PreviousFullBackup:previousFull,PreviousBackupDataContext:prior.DataContext ?? null,DataContext:dataContext,Verified:true,ProgramFiles:records.length,CreatedAt:new Date().toISOString()};
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({...report,Files:records},null,2));
console.log(JSON.stringify(report));
