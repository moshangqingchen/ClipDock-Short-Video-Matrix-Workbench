import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const root = process.cwd();
const output = path.join(root, "docs/.compare/chrome-dock/probe.mjs");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(path.join(root, "dist-electron/chrome-dock.exe"), path.join(path.dirname(output), "chrome-dock.exe"));
await build({ stdin: { contents: `
import { app, BaseWindow, WebContentsView } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DockedChromeBrowser } from './src/main/browser/docked-chrome-browser.ts';
import { inspectBrowserProfileProcesses } from './src/main/browser/global-browser-process-state.ts';
async function run() {
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-chrome-dock-'));
app.setPath('userData', data);
const first = '11a31cb1-8dda-488f-a3fa-718eaec9ed13';
const second = '22a31cb1-8dda-488f-a3fa-718eaec9ed13';
await app.whenReady();
const server = createServer((req,res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<title>Chrome 输入验证</title><h1>Chrome 输入验证</h1><p>仅使用隔离的测试账号目录</p><label>测试输入 <input aria-label="测试输入" autofocus></label><p id="result"></p><script>document.querySelector("input").oninput=e=>document.querySelector("#result").textContent=e.target.value</script>'); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
process.env.PROBE_CHROME_ENTRY = 'http://127.0.0.1:'+server.address().port;
const window = new BaseWindow({title:'Chrome 嵌入适配验证', width:1280, height:860, show:true});
const shell = new WebContentsView(); window.contentView.addChildView(shell);
function fit() { const {width,height}=window.getContentBounds(); shell.setBounds({x:0,y:0,width,height}); }
fit(); window.on('resize',fit);
await shell.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="margin:0;background:#edf2fb;font:16px Arial;color:#17233c"><aside style="width:220px;height:100vh;background:#14213a;color:white;padding:20px;box-sizing:border-box"><h2>适配验证</h2><p>Chrome 独立环境</p><p>账号切换 · 弹窗 · 缩放</p></aside><strong style="position:absolute;left:245px;top:36px">真实 Chrome / 保留原生地址栏</strong>'));
const manager = new DockedChromeBrowser(window,data);
let current, abort = new AbortController(), another;
const input = id => ({transport:'system', accountId:id, platformId:'youtube',signal:abort.signal,assertCurrent:()=>{if(abort.signal.aborted) throw Error('revoked');}});
const bounds = () => { const size=window.getContentBounds(); return {x:240,y:90,width:size.width-260,height:size.height-110}; };
try {
 current=await manager.launch(input(first)); current.show(bounds()); window.show();
 window.on('resize',()=>current?.show(bounds()));
 const info={data,command:path.join(data,'command'),localPage:'http://127.0.0.1:'+server.address().port,profile:path.join(data,'global-browser-profiles',first)};
 console.log(JSON.stringify(info));
 fs.mkdirSync('docs/.compare/chrome-dock',{recursive:true});
 fs.writeFileSync('docs/.compare/chrome-dock/run.json',JSON.stringify(info,null,2));
 const poll=setInterval(async()=>{
  if(!fs.existsSync(info.command)) return;
  const command=fs.readFileSync(info.command,'utf8').trim(); fs.unlinkSync(info.command);
  try {
   if(command==='hide') current.hide();
   if(command==='show') current.show(bounds());
   if(command==='narrow') window.setSize(1080,740);
   if(command==='wide') window.setSize(1440,900);
   if(command==='second') { another=await manager.launch(input(second)); current=another; current.show(bounds()); }
   if(command==='revoke') { abort.abort(); await current.stop(); if(another) await another.stop(); console.log('revoked and closed'); }
   if(command==='quit') {
    clearInterval(poll); abort.abort(); await current.stop(); if(another) await another.stop();
    for(const id of [first,second]) { const state=await inspectBrowserProfileProcesses(path.join(data,'global-browser-profiles',id),null); if(state.profileRunning) throw Error('profile survived'); }
    console.log('PASS: Chrome profiles stopped, locks released, data retained'); server.close(); window.destroy(); app.exit(0);
   }
  } catch(error) { console.error(error); }
 },200);
} catch(error) { console.error(error); abort.abort(); server.close(); app.exit(1); }
}
void run().catch(error => { console.error(error); app.exit(1); });
`, resolveDir: root, sourcefile: "chrome-dock-probe.ts" }, outfile: output, bundle: true, platform: "node", target: "node22", format: "esm", external: ["electron", "node:*"], alias: { "@shared": path.join(root,"src/shared"), "@main":path.join(root,"src/main") },
plugins: [{name:"local-fixture-only",setup(builder){builder.onLoad({filter:/docked-chrome-browser\.ts$/},args=>({contents:fs.readFileSync(args.path,"utf8").replace('entry: GLOBAL_WEB_ENTRY_URLS[input.platformId]', 'entry: process.env.PROBE_CHROME_ENTRY'),loader:"ts",resolveDir:path.dirname(args.path)}));}}]
});
const child = spawn(path.join(root,"node_modules/electron/dist/electron.exe"),[output],{cwd:root,windowsHide:true,stdio:"inherit"});
child.on("exit",code=>process.exitCode=code??1);
