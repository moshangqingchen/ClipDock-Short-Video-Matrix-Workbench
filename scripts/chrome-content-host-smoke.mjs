import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const root = process.cwd();
const output = path.join(root, "docs/.compare/chrome-content-host/probe.mjs");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(
  path.join(root, "dist-electron/chrome-content-host.exe"),
  path.join(path.dirname(output), "chrome-content-host.exe"),
);
await build({
  stdin: {
    contents: `
import { app, BaseWindow, WebContentsView } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DockedChromeBrowser } from './src/main/browser/docked-chrome-browser.ts';
import { createWorkbenchTray } from './src/main/window/tray.ts';
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
const window = new BaseWindow({title:'Chrome 嵌入适配验证', width:1280, height:860, show:true, autoHideMenuBar:true});
window.setMenuBarVisibility(false);
const shell = new WebContentsView(); window.contentView.addChildView(shell);
function fit() { const {width,height}=window.getContentBounds(); shell.setBounds({x:0,y:0,width,height}); }
fit(); window.on('resize',fit);
await shell.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="margin:0;background:#edf2fb;font:16px Arial;color:#17233c"><aside style="width:220px;height:100vh;background:#14213a;color:white;padding:20px;box-sizing:border-box"><h2>适配验证</h2><p>Chrome 独立环境</p><p>账号切换 · 弹窗 · 缩放</p></aside><strong style="position:absolute;left:245px;top:36px">Chrome 内容宿主 / 软件统一工具栏</strong>'));
const manager = new DockedChromeBrowser(window,data,true);
let quitting=false;
const tray=createWorkbenchTray(window,{isQuitting:()=>quitting,quit:()=>app.quit()});
app.on('before-quit',()=>{quitting=true;tray.dispose();});
let current, abort = new AbortController(), another;
const input = id => ({transport:'system', accountId:id, platformId:'youtube',signal:abort.signal,assertCurrent:()=>{if(abort.signal.aborted) throw Error('revoked');}});
const bounds = () => { const size=window.getContentBounds(); return {x:240,y:90,width:size.width-260,height:size.height-110}; };
try {
 current=await manager.launch(input(first)); current.show(bounds()); window.show();
 window.on('resize',()=>current?.show(bounds()));
 const info={data,command:path.join(data,'command'),localPage:'http://127.0.0.1:'+server.address().port,profile:path.join(data,'global-browser-profiles',first)};
 console.log(JSON.stringify(info));
 fs.mkdirSync('docs/.compare/chrome-content-host',{recursive:true});
 fs.writeFileSync('docs/.compare/chrome-content-host/run.json',JSON.stringify(info,null,2));
 await new Promise(resolve=>setTimeout(resolve,1800));
 console.log('STATE '+JSON.stringify(current.getPageState()));
 await current.go('manage'); await new Promise(resolve=>setTimeout(resolve,1300));
 console.log('NAVIGATED '+JSON.stringify(current.getPageState()));
 if(!current.getPageState().url.includes('/two') || !current.getPageState().canGoBack) throw Error('navigation mismatch');
 current.command('back'); await new Promise(resolve=>setTimeout(resolve,1000));
 console.log('BACK '+JSON.stringify(current.getPageState()));
 if(!current.getPageState().canGoForward) throw Error('history mismatch');
 if(${process.argv.includes("--auto")}) {
  for(const size of [[2048,1124],[1080,740],[1440,900]]) {
   window.setSize(...size); await new Promise(resolve=>setTimeout(resolve,350)); current.show(bounds());
   await new Promise(resolve=>setTimeout(resolve,11000));
   await current.readIdentity();
   const viewport=await current.readViewport(), wanted=bounds();
   if(Math.abs(viewport.width-wanted.width)>1 || Math.abs(viewport.height-wanted.height)>1) throw Error('viewport clipped: '+JSON.stringify({viewport,wanted}));
   const host=await current.inspectHost(), scale=host.dpi/96;
   if(!host.attached || !host.hostVisible || !host.cropMatches ||
      Math.abs(host.hostX-wanted.x*scale)>1 || Math.abs(host.hostY-wanted.y*scale)>1 ||
      Math.abs(host.hostWidth-wanted.width*scale)>1 || Math.abs(host.hostHeight-wanted.height*scale)>1)
     throw Error('native clipping viewport mismatch: '+JSON.stringify({host,wanted}));
   console.log('NATIVE '+JSON.stringify(host));
   if(fs.existsSync(path.join(info.profile,'clipdock-host-error.json'))) throw Error('host calibration failed after resize');
   console.log('PASS live Chrome after resize '+size.join('x'));
  }
  current.hide(); await new Promise(resolve=>setTimeout(resolve,700));
  if((await current.inspectHost()).hostVisible) throw Error('viewport survives hide');
  current.show(bounds());
  await new Promise(resolve=>setTimeout(resolve,1500)); await current.readIdentity();
  window.minimize(); await new Promise(resolve=>setTimeout(resolve,700));
  if((await current.inspectHost()).hostVisible) throw Error('viewport survives minimize');
  window.restore(); current.show(bounds()); await new Promise(resolve=>setTimeout(resolve,1500));
  if(!(await current.inspectHost()).hostVisible) throw Error('viewport missing after restore');
  const popup=await current.openFixtureWindow(); await new Promise(resolve=>setTimeout(resolve,1800));
  const popupHost=await current.inspectHost();
  if(popupHost.windows!==2 || !popupHost.attached) throw Error('popup was not independently owned: '+JSON.stringify(popupHost));
  window.close(); await new Promise(resolve=>setTimeout(resolve,1200));
  if(window.isDestroyed() || window.isVisible()) throw Error('close did not preserve hidden window');
  const backgroundHost=await current.inspectHost();
  if(backgroundHost.hostVisible || backgroundHost.popupsVisible) throw Error('Chrome visible in background: '+JSON.stringify(backgroundHost));
  await current.readIdentity();
  await shell.webContents.executeJavaScript('window.backgroundProbe=123');
  const latePopup=await current.openFixtureWindow(); await new Promise(resolve=>setTimeout(resolve,1200));
  if((await current.inspectHost()).popupsVisible) throw Error('new popup escaped background');
  tray.show(); await new Promise(resolve=>setTimeout(resolve,1500));
  const restoredHost=await current.inspectHost();
  if(!window.isVisible() || !restoredHost.hostVisible || restoredHost.popupsVisible!==2) throw Error('tray restore failed: '+JSON.stringify(restoredHost));
  if(await shell.webContents.executeJavaScript('window.backgroundProbe')!==123) throw Error('renderer state lost in background');
  await current.closeFixtureWindow(latePopup);
  console.log('PASS real tray close/restore, background page execution and popup hide/restore');
  await current.closeFixtureWindow(popup); await new Promise(resolve=>setTimeout(resolve,700));
  if((await current.inspectHost()).windows!==1) throw Error('popup survived close');
  console.log('PASS minimize/restore and independent native popup');
  another=await manager.launch(input(second)); another.show(bounds());
  await new Promise(resolve=>setTimeout(resolve,1200)); await another.readIdentity();
  abort.abort(); await current.stop(); await another.stop();
  for(const id of [first,second]) { const state=await inspectBrowserProfileProcesses(path.join(data,'global-browser-profiles',id),null); if(state.profileRunning) throw Error('profile survived'); }
  console.log('PASS: resize, hide/restore, multi-account, process and lock cleanup'); server.close(); tray.dispose(); window.destroy(); app.exit(0); return;
 }
 console.log('PASS navigation / history. Awaiting visual inspection.');
 const poll=setInterval(async()=>{
  if(!fs.existsSync(info.command)) return;
  const command=fs.readFileSync(info.command,'utf8').trim(); fs.unlinkSync(info.command);
  try {
   if(command==='hide') current.hide();
   if(command==='show') current.show(bounds());
   if(command==='narrow') window.setSize(1080,740);
   if(command==='wide') window.setSize(1440,900);
   if(command==='inspect') { const result={host:await current.inspectHost(),page:await current.readViewport()}; fs.writeFileSync(path.join(data,'inspect.json'),JSON.stringify(result,null,2)); console.log('INSPECT '+JSON.stringify(result)); }
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
`,
    resolveDir: root,
    sourcefile: "chrome-dock-probe.ts",
  },
  outfile: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["electron", "node:*"],
  alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") },
  plugins: [
    {
      name: "local-fixture-only",
      setup(builder) {
        builder.onLoad({ filter: /docked-chrome-browser\.ts$/ }, (args) => ({
          contents: fs
            .readFileSync(args.path, "utf8")
            .replace(
              "entry: GLOBAL_WEB_ENTRY_URLS[input.platformId]",
              "entry: process.env.PROBE_CHROME_ENTRY",
            )
            .replace(
              "if (this.contentHost) await controller.navigate(url);",
              'if (this.contentHost) await controller.navigate(process.env.PROBE_CHROME_ENTRY + \"/two\");',
            )
            .replace(
              "getPageState: () => controller.getState(),",
              `getPageState: () => controller.getState(),
              readViewport: () => controller.evaluate("({width:innerWidth,height:innerHeight,scale:devicePixelRatio,focus:document.activeElement?.tagName,value:document.querySelector('input')?.value})"),
              openFixtureWindow: async () => (await controller.pipe.request('Target.createTarget',{url:process.env.PROBE_CHROME_ENTRY+'/popup',newWindow:true})).targetId,
              closeFixtureWindow: (targetId) => controller.pipe.request('Target.closeTarget',{targetId}),
              inspectHost: () => new Promise((resolve,reject) => {
                const request=++sequence;
                const receive=(line) => { const message=JSON.parse(line); if(message.kind==='inspect' && message.request===request) {clearTimeout(timer); lines.off('line',receive); resolve(message);} };
                const timer=setTimeout(()=>{lines.off('line',receive);reject(Error('native inspect timeout'));},3000);
                lines.on('line',receive); send({kind:'inspect',request});
              }),`,
            ),
          loader: "ts",
          resolveDir: path.dirname(args.path),
        }));
      },
    },
  ],
});
const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [output], {
  cwd: root,
  windowsHide: true,
  stdio: "inherit",
});
child.on("exit", (code) => (process.exitCode = code ?? 1));
