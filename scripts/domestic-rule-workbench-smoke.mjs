/** Six anonymous official pages through the real workbench request gate.
 * Explicit opt-in; isolated synthetic accounts only; no proxy/settings changes. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import electron from 'electron';

if (!process.argv.includes('--run-once')) throw Error('EXPLICIT_RUN_REQUIRED');
const root = process.cwd();
const requireLocation = process.argv.includes('--require-egress-location');
const packaged = process.argv.find(a => a.startsWith('--packaged-dir='))?.slice(15);
const executable = packaged ? path.resolve(packaged, '短视频矩阵工作台.exe') : electron;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-rule-pages-'));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, SV_WORKBENCH_DATA_DIR: dataDir, SV_WORKBENCH_SMOKE: '1' },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const platforms = {
  douyin: ['www.douyin.com'], kuaishou: ['www.kuaishou.com'],
  xiaohongshu: ['www.xiaohongshu.com'], bilibili: ['www.bilibili.com'],
  baijiahao: ['baijiahao.baidu.com', 'passport.baidu.com'],
  weixin_channels: ['channels.weixin.qq.com'],
};
const report = { startedAt: new Date().toISOString(), isolatedAccounts: true, settingsChanged: false,
  samples: [], pages: [], viewStates: [], passed: false, cleanupComplete: false };
let shellTarget;
async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
}
async function evaluate(target, expression, method = 'Runtime.evaluate') {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('CDP_TIMEOUT')), 30000);
      ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.id === 1) { clearTimeout(timer); resolve(data); }
      };
      ws.onclose = () => { clearTimeout(timer); reject(Error('CDP_CLOSED')); };
      ws.send(JSON.stringify({ id: 1, method, params: method === 'Runtime.evaluate'
        ? { expression, awaitPromise: true, returnByValue: true } : {} }));
    });
    if (response.error || response.result?.exceptionDetails) throw Error('CDP_REJECTED');
    return response.result?.result?.value;
  } finally { ws.close(); }
}
const networkExpression = `(async()=>{ const n=await window.workbench.network.snapshot();
  return {state:n.state,reason:n.reason,generation:n.switching.generation,proxy:n.switching.proxy,
    allowed:n.accounts.filter(a=>a.state==='allowed').length}; })()`;
try {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      shellTarget = (await targets()).find(t => t.type === 'page' && t.url.includes('/dist/index.html'));
      if (shellTarget && await evaluate(shellTarget, '!!window.workbench')) break;
    } catch { /* bounded startup */ }
  }
  if (!shellTarget) throw Error('SHELL_UNAVAILABLE');
  const actualData = await evaluate(shellTarget, '(async()=> (await window.workbench.app.info()).userDataPath)()');
  if (path.resolve(actualData) !== path.resolve(dataDir)) throw Error('ISOLATION_REQUIRED');
  let admitted;
  for (let i = 0; i < 45; i++) {
    admitted = await evaluate(shellTarget, networkExpression);
    if (admitted.state === 'dual') break;
    await sleep(1000);
  }
  if (admitted?.state !== 'dual') throw Error('RULE_ADMISSION_UNAVAILABLE');
  const ids = await evaluate(shellTarget, `(async()=>{
    await window.workbench.settings.set({maxLiveViews:6,collectEnabled:false});
    const result={}; for(const platformId of ${JSON.stringify(Object.keys(platforms))})
      result[platformId]=(await window.workbench.accounts.create({platformId,displayName:'匿名规则测试'})).id;
    return result; })()`);
  for (let i = 0; i < 50; i++) {
    if ((await evaluate(shellTarget, networkExpression)).allowed === 6) break;
    await sleep(200);
  }
  for (const id of Object.values(ids)) {
    await evaluate(shellTarget, `window.workbench.views.show(${JSON.stringify(id)}, {x:440,y:150,width:1100,height:700}, true).then(()=>true,()=>false)`);
    await sleep(750);
  }
  let generation;
  for (let sample = 0; sample < 12; sample++) {
    await sleep(5000);
    const state = await evaluate(shellTarget, networkExpression);
    generation ??= state.generation;
    report.samples.push(state);
  }
  const live = await targets();
  report.viewStates = await evaluate(shellTarget, `(async()=>{ const result=[];
    for(const [platformId,id] of Object.entries(${JSON.stringify(ids)})) {
      const s=await window.workbench.views.state(id);
      result.push({platformId,loading:s?.loading,error:s?.lastError??null,origin:s?.url?new URL(s.url).origin:null});
    } return result; })()`);
  for (const [platformId, hosts] of Object.entries(platforms)) {
    const page = live.find(t => t.type === 'page' && hosts.includes(new URL(t.url).hostname));
    if (!page) { report.pages.push({ platformId, available: false }); continue; }
    const shape = await evaluate(page, `({ready:document.readyState,textLength:document.body?.innerText?.length??0,
      images:document.images.length,loadedImages:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length,
      failedResourceHosts:[...new Set(performance.getEntriesByType('resource').filter(e=>e.responseStatus>=400)
        .map(e=>{try{return new URL(e.name).hostname}catch{return ''}}))]})`);
    report.pages.push({ platformId, available: true, ...shape });
  }
  report.passed = report.samples.every(s => s.state === 'dual' && s.generation === generation && s.allowed === 6)
    && report.pages.every(p => p.available && p.textLength > 40);
  if (requireLocation) {
    report.locations = await evaluate(shellTarget, `(async()=>{const n=await window.workbench.network.snapshot();
      return n.accounts.map(a=>{const l=a.egressLocation;return {state:l?.state??'missing',route:l?.route??null,
        country:l?.country??null,region:l?.region??null,city:l?.city??null,hasIp:!!l?.ip,checkedAt:l?.checkedAt??null}})})()`);
    report.passed &&= report.locations.some(l=>l.state==='ready'&&l.route==='direct'&&l.hasIp&&!!(l.city||l.region||l.country));
  }
} catch (error) {
  report.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'PAGE_TEST_FAILED';
} finally {
  if (shellTarget) await Promise.race([evaluate(shellTarget, '', 'Browser.close').catch(()=>undefined), sleep(3000)]);
  if (child.exitCode === null) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(10000)]);
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);
  }
  const resolved = path.resolve(dataDir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('sv-rule-pages-'))
    throw Error('UNSAFE_CLEANUP_TARGET');
  try { fs.rmSync(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:250}); report.cleanupComplete=true; }
  catch { report.cleanupComplete=false; }
  report.completedAt = new Date().toISOString();
  const resultFile = path.join(root,'output','rule-mode-page-smoke.json');
  if (fs.existsSync(resultFile)) fs.copyFileSync(resultFile, resultFile.replace('.json',`.${Date.now()}.json`));
  fs.writeFileSync(resultFile, JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  process.exit(report.passed && report.cleanupComplete ? 0 : 1);
}
