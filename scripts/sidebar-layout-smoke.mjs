/** Isolated production-component/CSS regression. No user profile, app DB or platform network.
 * node scripts/sidebar-layout-smoke.mjs
 * Optional: --baseline-dir=output/sidebar-fix/baseline --output-dir=output/sidebar-fix
 * Baseline files, when present, are exact pre-fix source snapshots, loaded by Vite without modifying the checkout.
 * Without a baseline directory the script verifies the current source only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import electronPath from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = path.resolve(root, option("output-dir", "output/sidebar-fix"));
const baseline = path.resolve(root, option("baseline-dir", "output/sidebar-fix/baseline"));
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(output, ".fixture-"));
const userData = fs.mkdtempSync(path.join(output, ".profile-"));
const sources = [
  "src/renderer/features/layout/AccountSidebar.tsx",
  "src/renderer/features/layout/layout.module.css",
  "src/renderer/components/ui/AccountLoginStatus.tsx",
  "src/renderer/components/ui/ui.module.css",
];
const normalize = (value) => path.resolve(value).replaceAll("\\", "/");
const current = new Map(sources.map((file) => [normalize(path.join(root, file)), fs.readFileSync(path.join(root, file), "utf8")]));
const before = fs.existsSync(baseline)
  ? new Map(sources.map((file) => [normalize(path.join(root, file)), fs.readFileSync(path.join(baseline, path.basename(file)), "utf8")]))
  : null;
const variants = [...(before ? [["baseline", before]] : []), ["current", current]];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sourceHashes = Object.fromEntries(sources.map((file) => [file, {
  baseline: before ? digest(before.get(normalize(path.join(root, file)))) : null, current: digest(current.get(normalize(path.join(root, file)))),
}]));

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AccountSidebar } from "@renderer/features/layout/AccountSidebar";
import { NavRail } from "@renderer/features/layout/NavRail";
import { useAccounts, useUi, useViews } from "@renderer/store";
import { useNetwork } from "@renderer/store/network";
import { api } from "@renderer/lib/api";
import layout from "@renderer/features/layout/layout.module.css";
import "@renderer/styles/globals.css";
const platforms = ["douyin", "kuaishou", "xiaohongshu", "bilibili", "weixin_channels"];
const statuses = ["online", "online", "online", "offline", "expiring"];
const checks = ["unconfirmed", "network_error", "paused", "confirmed", "confirmed"];
const timestamp = "2026-10-12T12:00:00.000Z";
const accounts = platforms.flatMap((platformId, group) => Array.from({length:3}, (_,index) => ({
  id: "00000000-0000-4000-8000-" + String(group * 3 + index + 1).padStart(12, "0"),
  platformId, displayName: index === 0 ? "这是一个需要省略展示的很长昵称·矩阵内容运营账号" + (group+1) :
    index === 1 ? "相邻账号·内容实验室" + (group+1) : "创作者账号" + (group+1),
  handle: "fixture-"+group+"-"+index, avatarUrl: null, partition: "fixture-only",
  status: statuses[(group+index)%statuses.length],
  checkInfo: { state:checks[(group+index)%checks.length], reason:"布局回归合成状态", attemptedAt:timestamp },
  lastCheckedAt:timestamp, lastOnlineAt:timestamp, sortOrder:index, createdAt:timestamp, updatedAt:timestamp,
})));
api.metrics.account = async (id) => ({metrics:{followers:{current:123456+(accounts.findIndex(a=>a.id===id)*123)}}});
useAccounts.setState({accounts,loaded:true,loadError:null});
useUi.setState({route:"creator", creatorMode:"domestic", activeAccountId:accounts[1].id, railCollapsed:false, sidebarHidden:false});
useViews.setState({states:Object.fromEntries(accounts.map((a,index)=>[a.id,{accountId:a.id,lifecycle:"ready",revision:index}]))});
useNetwork.setState(state=>({snapshot:{...state.snapshot,accounts:accounts.map((a,index)=>({
  accountId:a.id,state:"allowed",reason:"READY",generation:1,checkedAt:timestamp,proofExpiresAt:null,
  egressLocation:{state:"ready",route:"direct",ip:"192.0.2."+(index+1),country:"中国",region:"广东",city:index%2?"深圳市":"呼和浩特市",checkedAt:timestamp}
}))}}));
window.__sidebarClasses = layout;
window.__sidebarFixtures = accounts;
createRoot(document.getElementById("root")).render(<div className={layout.shell}>
  <NavRail/><AccountSidebar/><main className={layout.main}><div className={layout.page}>
    <h1>账号侧栏布局回归</h1><p>真实生产组件与样式 · 15个合成账号 · 无平台连接</p>
  </div></main>
</div>);
document.fonts.ready.then(()=>setTimeout(()=>{window.__sidebarReady=true},350));
`;
fs.writeFileSync(path.join(fixture, "entry.tsx"), entry);
fs.writeFileSync(path.join(fixture, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Sidebar regression fixture</title></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
for (const [variant, overrides] of variants) {
  await build({
    configFile: false, root: fixture, base: "./", logLevel: "error",
    plugins: [{ name: "exact-sidebar-source-snapshot", enforce: "pre", load(id) {
      return overrides.get(normalize(id.split("?")[0]));
    } }, react()],
    resolve: { alias: {
      "@renderer": path.join(root, "src/renderer"), "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main"),
    } },
    build: { outDir: path.join(fixture, variant), emptyOutDir: true, target: "chrome140", sourcemap: false },
  });
}

// DOM Range uses actual shaped glyph bounds. Horizontally ellipsized names may
// have a wider raw range; vertical escape/overlap cannot be excused by clipping.
function inspectLayout() {
  const cls = window.__sidebarClasses;
  const pick = (element, name) => element.querySelector("." + cls[name]);
  const box = (rect) => ({left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height});
  const glyphs = (element) => {
    if (!element) return [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const values = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width && rect.height)
        values.push({text:node.textContent, ...box(rect)});
    }
    return values;
  };
  const violations = [];
  const rows = [...document.querySelectorAll("." + cls.accountRow)].map((row,index) => {
    const bounds = box(row.getBoundingClientRect());
    const meta = pick(row,"accountMeta");
    const name = meta?.querySelector("strong");
    const status = meta?.children[1];
    const nameGlyphs = glyphs(name), statusGlyphs = glyphs(status), all = glyphs(meta);
    if (Math.abs(bounds.height - 40) > 0.6) violations.push({index,kind:"row-height",actual:bounds.height});
    for (const value of all) if (value.top < bounds.top - 0.6 || value.bottom > bounds.bottom + 0.6)
      violations.push({index,kind:"glyph-outside-row",text:value.text,top:value.top-bounds.top,bottom:value.bottom-bounds.top,rowHeight:bounds.height});
    if (nameGlyphs.length && statusGlyphs.length && Math.max(...nameGlyphs.map(v=>v.bottom)) > Math.min(...statusGlyphs.map(v=>v.top)) + 0.6)
      violations.push({index,kind:"name-status-overlap"});
    if (!nameGlyphs.length || !statusGlyphs.length) violations.push({index,kind:"missing-name-or-status"});
    return {index,name:name?.textContent,bounds,nameGlyphs,statusGlyphs,allGlyphs:all,
      statusText:status?.textContent, nameBox:name?box(name.getBoundingClientRect()):null};
  });
  for (let index=1;index<rows.length;index++) {
    const previous=rows[index-1], next=rows[index];
    if (Math.max(...previous.allGlyphs.map(v=>v.bottom)) > Math.min(...next.allGlyphs.map(v=>v.top)) + 0.6)
      violations.push({index,kind:"adjacent-row-text-overlap"});
  }
  if (rows.length !== 15) violations.push({kind:"account-count",actual:rows.length});
  const followers = rows.filter(row=>row.statusText?.includes("粉丝")).length;
  const locations = document.querySelectorAll('[aria-label^="直连出口位置："]').length;
  if (followers !== 15 || locations !== 15) violations.push({kind:"fixture-data-missing",followers,locations});
  return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},sidebar:box(document.querySelector('aside[aria-label="国内账号列表"]').getBoundingClientRect()),
    rows,followers,locations,violations,passed:violations.length===0};
}

const config = {
  root: fixture, output, userData, widths: [960,1120,1440,1920], zooms:[1,1.25],
  inspect: `(${inspectLayout.toString()})()`, sourceHashes, variants: variants.map(([variant]) => variant),
};
fs.writeFileSync(path.join(fixture, "config.json"), JSON.stringify(config));
const runner = String.raw`
const {app,BrowserWindow,session} = require("electron");
const fs=require("node:fs"), path=require("node:path");
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,"config.json"),"utf8"));
app.setPath("userData",cfg.userData);
app.setPath("sessionData",path.join(cfg.userData,"profiles"));
app.commandLine.appendSwitch("enable-features","CDPScreenshotNewSurface");
app.commandLine.appendSwitch("lang","zh-CN");
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const blocked=[];
  session.defaultSession.webRequest.onBeforeRequest((request,callback)=>{
    const cancel=!/^(file:|data:|devtools:|chrome-devtools:|about:)/.test(request.url);
    if(cancel)blocked.push(new URL(request.url).origin);
    callback({cancel});
  });
  const win=new BrowserWindow({show:false,width:1440,height:1100,useContentSize:true,backgroundColor:"#ffffff",
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const rows=[],errors=[];
  win.webContents.on("console-message",(_event,_level,message)=>{if(/error/i.test(message))errors.push(message)});
  win.webContents.debugger.attach("1.3");
  const cmd=(method,params={})=>Promise.race([win.webContents.debugger.sendCommand(method,params),
    wait(12000).then(()=>{throw new Error("CDP timeout: "+method)})]);
  try{
    for(const variant of cfg.variants){
      await win.loadFile(path.join(cfg.root,variant,"index.html"));
      await cmd("Emulation.setFocusEmulationEnabled",{enabled:true});
      console.log("loaded "+variant);
      let ready=false;
      for(let n=0;n<100&&!ready;n++){await wait(100);ready=await win.webContents.executeJavaScript("Boolean(window.__sidebarReady)")}
      if(!ready)throw new Error("fixture did not mount: "+variant);
      for(const zoom of cfg.zooms)for(const width of cfg.widths){
        win.setContentSize(width,1100);win.webContents.setZoomFactor(zoom);await wait(180);
        const observed=await win.webContents.executeJavaScript(cfg.inspect);
        console.log(variant+" "+width+" @"+zoom+" violations="+observed.violations.length);
        const key=variant+"-"+width+"-zoom"+String(zoom).replace(".","_");
        for(const [position,scroll] of [["top",0],["bottom",1e6]]){
          await win.webContents.executeJavaScript("document.querySelector('.'+window.__sidebarClasses.tree).scrollTop="+scroll);
          await wait(80);
          const shot=await cmd("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false,optimizeForSpeed:true});
          fs.writeFileSync(path.join(cfg.output,key+"-"+position+".png"),Buffer.from(shot.data,"base64"));
        }
        await win.webContents.executeJavaScript("document.querySelector('.'+window.__sidebarClasses.tree).scrollTop=0");
        rows.push({variant,width,zoom,...observed});
      }
    }
    const report={createdAt:new Date().toISOString(),electron:process.versions.electron,chromium:process.versions.chrome,
      isolation:{userData:cfg.userData,networkBlocked:true,blockedOrigins:[...new Set(blocked)],realComponents:true,fixtureAccounts:15},
      sourceHashes:cfg.sourceHashes,rows,consoleErrors:errors};
    const baselineRows=rows.filter(r=>r.variant==="baseline");
    report.baselineFailed=baselineRows.length?baselineRows.every(r=>!r.passed):null;
    report.currentPassed=rows.filter(r=>r.variant==="current").every(r=>r.passed);
    fs.writeFileSync(path.join(cfg.output,"report.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify({baselineFailed:report.baselineFailed,currentPassed:report.currentPassed,cases:rows.length,
      counts:rows.map(r=>({variant:r.variant,width:r.width,zoom:r.zoom,violations:r.violations.length}))}));
    app.exit(report.baselineFailed!==false&&report.currentPassed?0:1);
  }catch(error){fs.writeFileSync(path.join(cfg.output,"failure.txt"),String(error.stack||error));console.error(error);app.exit(2)}
});
`;
fs.writeFileSync(path.join(fixture, "runner.cjs"), runner);
const environment = {...process.env};
delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(electronPath,[path.join(fixture,"runner.cjs")],{cwd:root,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});
let stderr="";
child.stdout.on("data",data=>process.stdout.write(data));
child.stderr.on("data",data=>{stderr+=String(data);});
const watchdog=setTimeout(()=>child.kill(),120_000);
const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code)=>resolve(code??2));});
clearTimeout(watchdog);
fs.writeFileSync(path.join(output,"electron-stderr.log"),stderr);
console.log(`Sidebar regression report: ${path.join(output,"report.json")}`);
process.exitCode=code;
