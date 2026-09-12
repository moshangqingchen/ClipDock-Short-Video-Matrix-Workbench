// Compile loopback allowances into a separate fixture helper/bundle only.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { buildChromeDock } from "./build-chrome-dock.mjs";
const root = process.cwd(),
  output = path.join(root, "docs/.compare/web-observation");
const native = path.join(output, "src/main/browser/native/chrome-dock.cs");
fs.mkdirSync(path.dirname(native), { recursive: true });
let source = fs.readFileSync(path.join(root, "src/main/browser/native/chrome-dock.cs"), "utf8");
source = source.replace(
  'return value.StartsWith("https://") ? value : "https://"+value;',
  'return value.StartsWith("http://") ? value : value.StartsWith("127.0.0.1:") ? "http://"+value : value.StartsWith("https://") ? value : "https://"+value;',
);
source = source.replace(
  "static bool ObservationUrl(string value) {",
  'static bool ObservationUrl(string value) { Uri fixture; if (Uri.TryCreate(value,UriKind.Absolute,out fixture) && fixture.Scheme == "http" && fixture.Host == "127.0.0.1") return true;',
);
source = source.replace('if (document == null || !document.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return null;', 'if (document == null || !document.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) { Console.Error.WriteLine("fixture: missing document or URL pattern"); return null; }');
source = source.replace('string documentUrl = ((ValuePattern)pattern).Current.Value;', 'string documentUrl = ((ValuePattern)pattern).Current.Value; Console.Error.WriteLine("fixture document: "+documentUrl+" rootPid="+root.Current.ProcessId+" documentPid="+document.Current.ProcessId);');
source = source.replace('object page=null; try { page=Page(window); } catch { }', 'object page=null; try { page=Page(window); } catch(Exception e) { Console.Error.WriteLine("fixture: "+e.Message); }');
fs.writeFileSync(native, source);
buildChromeDock(output, output);
const contents = `
import {app,BaseWindow,WebContentsView} from 'electron';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createServer} from 'node:http'; import assert from 'node:assert/strict';
import {DockedChromeBrowser} from './src/main/browser/docked-chrome-browser.ts';
import {parseWebObservation} from './src/main/data/global-web-observation.ts';
async function run() {
const data=fs.mkdtempSync(path.join(os.tmpdir(),'clipdock-web-observation-'));
app.setPath('userData',data);
await app.whenReady();
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>网页数据读取验证</title><main><h1>Channel analytics</h1><p>Last 28 days</p><section><p>Views</p><strong>321</strong></section><section><p>Current subscribers</p><strong>88</strong></section><input type="password" value="SECRET_PASSWORD"><textarea>SECRET_DRAFT</textarea><div hidden>Views 999</div></main>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.FIXTURE_URL='http://127.0.0.1:'+server.address().port+'/';
const window=new BaseWindow({title:'网页数据读取验证',width:1080,height:750,show:true});
const shell=new WebContentsView(); window.contentView.addChildView(shell); shell.setBounds({x:0,y:0,width:1080,height:700});
await shell.webContents.loadURL('data:text/html,<h2>网页数据读取验证</h2>');
const controller=new AbortController(); let browser;
try {
  const manager=new DockedChromeBrowser(window,data);
  const id='11a31cb1-8dda-488f-a3fa-718eaec9ed13';
  browser=await manager.launch({transport:'system',accountId:id,platformId:'youtube',signal:controller.signal,assertCurrent:()=>{if(controller.signal.aborted)throw Error('revoked');}});
  window.show(); browser.show({x:10,y:60,width:1040,height:620});
  let raw, failure;
  for(let n=0;n<8;n++){
    await new Promise(resolve=>setTimeout(resolve,600));
    try {raw=await browser.readPage(); if(raw?.text.includes('321'))break;}catch(error){failure=error.message;}
  }
  assert.ok(raw?.text.includes('321'),'Chrome text was unavailable: '+failure);
  assert.ok(!raw.text.includes('SECRET_'),'editable content leaked into read-only extraction');
  assert.ok(!raw.text.includes('999'),'hidden content leaked');
  const snapshot=parseWebObservation(id,'youtube','chrome',{...raw,url:'https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/analytics'});
  assert.deepEqual(snapshot.metrics.map(m=>m.value),['321','88']);
  const evidence={passed:true,engine:'installed Chrome',metrics:snapshot.metrics,fixtureOnly:true,credentialsExcluded:true,profile:data};
  fs.writeFileSync(${JSON.stringify(path.join(output, "results.json"))},JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
} catch(error){console.error(error);process.exitCode=1;}
finally {controller.abort();if(browser)await browser.stop();shell.webContents.close();window.close();server.close();app.exit(process.exitCode??0);}
}
void run().catch(error=>{console.error(error);app.exit(1);});
`;
await build({
  tsconfig: "tsconfig.electron.json",
  stdin: { contents, resolveDir: root, sourcefile: "web-observation-smoke.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  outfile: path.join(output, "probe.mjs"),
  plugins: [
    {
      name: "fixture-only-browser",
      setup(build) {
        build.onLoad({ filter: /docked-chrome-browser\.ts$/ }, (args) => ({
          contents: fs
            .readFileSync(args.path, "utf8")
            .replace('stdio: ["pipe", "pipe", "ignore"]', 'stdio: ["pipe", "pipe", "inherit"]')
            .replace("entry: GLOBAL_WEB_ENTRY_URLS[input.platformId],", "entry: process.env.FIXTURE_URL!,")
            .replace(
              "if (!observationPage(input.platformId, page.url))",
              "if (!observationPage(input.platformId, page.url) && page.url !== process.env.FIXTURE_URL)",
            ),
          loader: "ts",
        }));
      },
    },
  ],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  path.join(root, "node_modules/electron/dist/electron.exe"),
  [path.join(output, "probe.mjs")],
  { env, windowsHide: true, stdio: "inherit" },
);
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 60000);
child.on("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});
