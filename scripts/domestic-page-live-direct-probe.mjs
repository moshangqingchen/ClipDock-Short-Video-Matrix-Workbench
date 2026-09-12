/** Anonymous HEADs through the production website pool and real Windows/mihomo readers.
 * No account, Cookie, OAuth token, system proxy change, TLS exception or direct retry.
 */
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
if (!process.versions.electron) {
  const { default: executable } = await import("electron");
  const code = await new Promise((resolve) => {
    const child = spawn(executable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { windowsHide: true, stdio: "inherit" });
    const deadline = setTimeout(() => { child.kill(); resolve(1); }, 100000);
    child.once("error", () => { clearTimeout(deadline); resolve(1); }); child.once("close", (value) => { clearTimeout(deadline); resolve(value ?? 1); });
  });
  process.exit(code);
}
if (process.platform !== "win32" || process.argv.slice(2).join(" ") !== "--run-once") throw new Error("EXPLICIT_WINDOWS_RUN_REQUIRED");
const root = process.cwd(), stamp = new Date().toISOString().replace(/[-:.]/g, ""),
  folder = fs.mkdtempSync(path.join(root, "docs", ".compare", "domestic-page-live-")), bundle = path.join(folder, "production.mjs");
const { app } = await import("electron");
app.setPath("userData", path.join(folder, "userData"));
app.setPath("sessionData", path.join(folder, "sessionData"));
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-quic");
app.disableHardwareAcceleration(); app.on("window-all-closed", () => undefined);
void run().catch(() => app.exit(1));
async function run() {
await app.whenReady();
await build({ stdin: { contents: [
  ['GlobalProxyRuntime', 'src/main/api/global-proxy-runtime.ts'],
  ['GlobalWebRelay', 'src/main/network/global-web-relay.ts'],
  ['isDomesticWebHost', 'src/main/network/domestic-web-target-policy.ts'],
  ['WindowsProxyStateReader', 'src/main/network/windows-proxy-state.ts'],
  ['WindowsNetworkFingerprintReader', 'src/main/network/windows-network-fingerprint.ts'],
  ['ClashReader', 'src/main/network/clash-reader.ts'],
].map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(root, file))};`).join('\n'), resolveDir: root },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node24", external: ["node:*"], alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") } });
const { GlobalWebRelay, isDomesticWebHost, GlobalProxyRuntime, WindowsProxyStateReader, WindowsNetworkFingerprintReader, ClashReader } = await import(pathToFileURL(bundle).href);
const proxyReader = new WindowsProxyStateReader(), networkReader = new WindowsNetworkFingerprintReader();
const controllerReader = new ClashReader({ controllerUrl: "http://127.0.0.1:9790", getSecret: () => null });
let proxyState = null, network = { available: false, hash: null }, observed = 0, generation = 1, stopped = false, timer, reading;
const result = { startedAt: new Date().toISOString(), runtime: process.versions.node, anonymousOnly: true,
  actualWindowsSource: true, actualMihomoSource: true, systemProxyChanged: false, realAccountUsed: false,
  browserPageCompatibilityTested: false, osReads: 0, targets: [], passed: false };
result.electron = process.versions.electron;
const checkpoint = () => fs.writeFileSync(path.join(folder, "checkpoint.json"), JSON.stringify(result, null, 2));
checkpoint();
const runtime = new GlobalProxyRuntime({
  domesticDirect: true,
  configuration: () => ({ controllerUrl: "http://127.0.0.1:9790", proxyPort: 10090, credentialRevision: createHash("sha256").update("null").digest("hex") }),
  readSwitch: () => ({ proxy: performance.now() - observed < 10_000 && proxyState?.state === "active" ? "on" : "unknown", generation }),
  readNetwork: () => performance.now() - observed < 10_000 ? network : { available: false, hash: null },
  getSecret: () => null,
});
async function refresh() {
  reading = (async () => {
    const controller = await controllerReader.read().catch(() => null);
    const [nextProxy, nextNetwork] = await Promise.all([proxyReader.read(controller?.tun === true ? { mihomoTun: true } : {}), networkReader.read()]);
    if (stopped) return;
    if (proxyState && (proxyState.state !== nextProxy.state || network.hash !== nextNetwork.hash)) generation++;
    proxyState = nextProxy; network = nextNetwork; observed = performance.now(); result.osReads++;
    result.controllerReadable = controller !== null; result.controllerTun = controller?.tun ?? null;
    result.proxyReasons = nextProxy.reasons;
    runtime.observeController(controller?.fingerprint ?? null);
    runtime.sync();
  })();
  await reading;
  if (!stopped) timer = setTimeout(() => void refresh(), 2000);
}
const abort = new AbortController(); let eligibility;
try {
  await refresh(); result.proxyActivity = proxyState.state; result.networkAvailable = network.available;
  eligibility = await runtime.acquireEligibility("douyin", abort.signal);
  if (!eligibility?.isCurrent()) throw new Error("LIVE_PROXY_QUALIFICATION_UNAVAILABLE");
  checkpoint();
  const qualifiedAt = performance.now();
  result.qualificationDurationMs = Math.round(qualifiedAt - observed);
  eligibility.signal.addEventListener("abort", () => {
    result.eligibilityRevokedAfterMs = Math.round(performance.now() - qualifiedAt);
  }, { once: true });

  const { BrowserWindow, session } = await import("electron");
  const failures = new Map(); let window, relay;
  try {
    const platformId="xiaohongshu", signal=AbortSignal.any([abort.signal,eligibility.signal]);
    const assertCurrent=()=>{if(signal.aborted||!eligibility.isCurrent())throw Error("LIVE_DIRECT_REVOKED");};
    relay = new GlobalWebRelay({ platformId, signal, maxConnections:64, requestTimeoutMs:15000, assertCurrent, allowTarget:isDomesticWebHost, openTunnel:input=>runtime.openWebTunnel(input).catch(error=>{result.tunnelErrors??=[];if(result.tunnelErrors.length<100)result.tunnelErrors.push({host:input.host,code:error.code??"UNKNOWN"});throw error;}) });
    const endpoint=await relay.start();
    const ses=session.fromPartition("persist:isolated-cn-page");
    await ses.setProxy({ mode:"fixed_servers",proxyRules:"http="+endpoint.host+":"+endpoint.port+";https="+endpoint.host+":"+endpoint.port,proxyBypassRules:"<-loopback>" });
    ses.setUserAgent(app.userAgentFallback.replace(/\sElectron\/[^\s]+/g,"").replace(/\sClipDock[^\s]*/g,""));
    ses.setPermissionRequestHandler((_c,_p,cb)=>cb(false)); ses.setPermissionCheckHandler(()=>false);
    ses.webRequest.onBeforeRequest((details,cb)=> { let allow=false; try { const u=new URL(details.url); allow=eligibility.isCurrent()&&u.protocol==="https:"&&isDomesticWebHost(platformId,u.hostname); }catch{} cb({cancel:!allow}); });
    ses.webRequest.onErrorOccurred(details=>{let h;try{h=new URL(details.url).hostname}catch{return} const k=h+":"+details.error;failures.set(k,(failures.get(k)||0)+1);});
    window=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");window.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    window.webContents.on("will-navigate",(e,url)=>{if(!isDomesticWebHost(platformId,new URL(url).hostname))e.preventDefault();});
    let loadError=null;const loading=window.loadURL("https://creator.xiaohongshu.com/login").catch(()=>{loadError="PAGE_LOAD_FAILED"});
    await Promise.race([loading,new Promise(resolve=>setTimeout(resolve,40000))]);
    await new Promise(resolve=>setTimeout(resolve,12000));
    result.page=await window.webContents.executeJavaScript('({ready:document.readyState,textLength:document.body?.innerText?.length??0,images:document.images.length,loadedImages:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length})');
    result.page.loadError=loadError;result.page.eligibilityCurrent=eligibility.isCurrent();result.page.failedRequests=Object.fromEntries(failures);
    fs.writeFileSync(path.join(folder,"page.png"),(await window.webContents.capturePage()).toPNG());
    result.screenshot=path.join(folder,"page.png");result.browserPageCompatibilityTested=true;
    result.passed=result.page.textLength>80&&result.page.eligibilityCurrent;
  } finally { window?.destroy();await relay?.dispose(); }

} catch (error) { result.error = /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "LIVE_PROBE_UNAVAILABLE"; }
finally {
  stopped = true; clearTimeout(timer); abort.abort(); eligibility?.release(); runtime.invalidate();
  await reading;
  const cleanup = await Promise.allSettled([runtime.dispose(), proxyReader.dispose(), controllerReader.whenIdle()]);
  result.cleanupComplete = cleanup.every((item) => item.status === "fulfilled");
  result.completedAt = new Date().toISOString();
  const output = path.join(root, "docs", ".compare", `domestic-page-live-${stamp}.results.json`);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: result.passed, error: result.error, result: output }) + "\n");
  if (!result.passed || !result.cleanupComplete) process.exitCode = 1;
  app.exit(process.exitCode ?? 0);
}

}
