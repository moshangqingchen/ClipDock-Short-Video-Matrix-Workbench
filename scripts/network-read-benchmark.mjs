// Read-only comparison. No raw network addresses/proxy configuration are retained.
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {build} from 'esbuild';
const programs = ['windows-network-fingerprint.ts', 'windows-proxy-state.ts'].map(file => {
  const text = fs.readFileSync(path.join('src/main/network', file), 'utf8');
  const script = /const READ_SCRIPT = String.raw`([\s\S]*?)`;/.exec(text)?.[1];
  if (!script) throw new Error('fixed program missing');
  return script;
});
const compiled = await build({entryPoints:['src/main/network/windows-read-batch.ts'], bundle:true, platform:'node', format:'esm', write:false});
const {WindowsReadBatch} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
let processes = 0;
const run = (script, signal) => new Promise((resolve, reject) => {
  processes++;
  execFile(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], {windowsHide:true, shell:false, encoding:'utf8', timeout:8000, maxBuffer:768*1024, signal},
    (error, stdout) => error ? reject(new Error('read unavailable')) : resolve(stdout));
});
const measurements = [];
for (let round=0; round<3; round++) {
  for (const kind of ['before-separate', 'after-batched']) {
    const initial = processes, start = performance.now();
    const batch = new WindowsReadBatch(run);
    const outputs = await Promise.allSettled(programs.map(script => kind === 'before-separate' ? run(script) : batch.read(script)));
    measurements.push({round, kind, processCount: processes-initial, durationMs: Math.round(performance.now()-start), successful:outputs.every(x=>x.status==='fulfilled')});
  }
}
console.log(JSON.stringify({observedAt: new Date().toISOString(), measurements}, null, 2));
