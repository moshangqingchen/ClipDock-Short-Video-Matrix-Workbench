// Test-only bundle instrumentation: no control endpoint is included in the product.
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { reviewedOperationBuildOptions } from "./reviewed-operation-build.mjs";
const root = process.cwd();
const data = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-tray-"));
const output = path.join(root, "dist-electron/tray-smoke.mjs");
const reviewed = reviewedOperationBuildOptions(root);
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron", "node:*"],
  alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") },
  define: { ...reviewed.define, "process.env.NODE_ENV": '"production"' },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require=__createRequire(import.meta.url);",
  },
  plugins: [
    ...reviewed.plugins,
    {
      name: "tray-test-only",
      setup(b) {
        b.onLoad({ filter: /window[\\/]tray\.ts$/ }, (a) => ({
          loader: "ts",
          resolveDir: path.dirname(a.path),
          contents: fs
            .readFileSync(a.path, "utf8")
            .replace(
              "  let disposed = false;",
              "  let smokeMenu; const originalSetMenu=tray.setContextMenu.bind(tray); tray.setContextMenu=menu=>{smokeMenu=menu;originalSetMenu(menu);}; let disposed = false;",
            )
            .replace(
              /  return \{\r?\n    show,/,
              `
  setTimeout(async()=>{
    try {
      const delay=ms=>new Promise(r=>setTimeout(r,ms));
      show(); const id=window.id;
      const shell=window.contentView.children[0].webContents;
      await shell.executeJavaScript('window.trayTicks=0; setInterval(()=>window.trayTicks++,100)');
      window.close(); await delay(1200);
      if(window.isDestroyed() || window.isVisible() || window.id!==id) throw Error('close-to-tray failed');
      if(await shell.executeJavaScript('window.trayTicks')<5) throw Error('background execution stopped');
      tray.emit('click'); await delay(400);
      if(!window.isVisible() || window.id!==id) throw Error('tray click restore failed');
      window.close(); app.emit('second-instance',{},[],process.cwd()); await delay(400);
      if(!window.isVisible() || window.id!==id) throw Error('second instance restore failed');
      console.log('PASS actual runtime close, background timer, tray click and second instance');
      smokeMenu.items.find(item=>item.label==='退出软件').click();
    } catch(error) {console.error(error);app.exit(1);}
  },4500);
  return {
    show,`,
            ),
        }));
      },
    },
  ],
});
const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [output], {
  cwd: root,
  windowsHide: true,
  stdio: "inherit",
  env: { ...process.env, SV_WORKBENCH_DATA_DIR: data, SV_WORKBENCH_SMOKE: "1" },
});
const timeout = setTimeout(() => {
  child.kill();
  console.error("FAIL graceful quit timed out");
}, 35000);
const code = await new Promise((resolve) => child.on("exit", resolve));
clearTimeout(timeout);
fs.unlinkSync(output);
if (code !== 0) throw Error("Tray runtime exited " + code);
console.log("PASS explicit tray Quit completed application cleanup and exited");
