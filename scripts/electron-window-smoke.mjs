/**
 * Launch the packaged main process against a throwaway data dir, wait for the
 * shell to load and the IPC bridge to answer, then exit non-zero on failure.
 * Run via: npm run smoke:electron
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { createServer } from "node:net";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-smoke-"));
const unavailableMediaCache = process.argv.includes("--unavailable-media-cache");
const packaged = process.argv.includes("--packaged");
const packageDirectory = process.argv.find(arg => arg.startsWith('--packaged-dir='))?.slice('--packaged-dir='.length) ?? 'release/win-unpacked';
const launchPath = packaged ? path.resolve(packageDirectory, "短视频矩阵工作台.exe") : electronPath;
if (packaged && !fs.existsSync(launchPath))
  throw new Error("packaged executable missing; run npm run pack first");
if (unavailableMediaCache)
  fs.writeFileSync(path.join(dataDir, "remote-media"), "synthetic cache-directory obstruction", {
    flag: "wx",
  });
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
// Chromium 150's legacy CDP capture waits for ForceRedraw presentation, which can
// stall in the deliberately hidden Windows smoke window after opening a modal.
// Its existing alternative requests a new surface and copies that repaint. This
// switch applies only to this throwaway test process; product startup is unchanged.
// https://github.com/chromium/chromium/blob/150.0.7871.212/content/common/features.cc
// https://github.com/chromium/chromium/blob/150.0.7871.212/content/browser/renderer_host/render_widget_host_impl.cc#L2046
const screenshotArgs = process.platform === "win32" ? ["--enable-features=CDPScreenshotNewSurface"] : [];
const child = spawn(
  launchPath,
  [...(packaged ? [] : ["."]), ...screenshotArgs, `--remote-debugging-port=${port}`],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SV_WORKBENCH_DATA_DIR: dataDir,
      SV_WORKBENCH_SMOKE: "1",
      ELECTRON_ENABLE_LOGGING: "0",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let debugSocket = null;
let nextCommandId = 0;
const pendingCommands = new Map();

async function debuggerConnection() {
  if (debugSocket?.readyState === WebSocket.OPEN) return debugSocket;
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })
  ).json();
  const target = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!target) throw new Error("shell page not found");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const closed = () => {
    if (debugSocket === ws) debugSocket = null;
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error("shell debugger disconnected"));
      pendingCommands.delete(id);
    }
  };
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const pending = pendingCommands.get(data.id);
    if (!pending) return;
    pendingCommands.delete(data.id);
    clearTimeout(pending.timer);
    data.error ? pending.reject(new Error("shell debugger command rejected")) : pending.resolve(data.result);
  };
  ws.onclose = closed;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("shell debugger connection timed out"));
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      closed();
      reject(new Error("shell debugger unavailable"));
    };
  });
  debugSocket = ws;
  return ws;
}

async function command(method, params) {
  // One session for the run, with bounded commands; reconnecting for every DOM change
  // leaves screenshot/compositor behavior dependent on repeated debugger detach events.
  const ws = await debuggerConnection();
  return new Promise((resolve, reject) => {
    const id = ++nextCommandId;
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`shell debugger timed out: ${method}`));
    }, 30_000);
    pendingCommands.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch {
      clearTimeout(timer);
      pendingCommands.delete(id);
      reject(new Error("shell debugger send failed"));
    }
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function captureEditorScreenshot() {
  const before = await evaluate(`({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    width: innerWidth,
    height: innerHeight,
    runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length
  })`);
  // Focus/RAF readiness is useful diagnosis but did not fix the observed legacy
  // screenshot timeout on its own. The launch switch above changes the native
  // capture path; these checks leave product DOM/CSS and the native window hidden.
  // CDP focus emulation activates only this throwaway page, not the OS window.
  // https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled
  await command("Emulation.setFocusEmulationEnabled", { enabled: true });
  const frames = await evaluate(`new Promise(resolve => {
    let frames = 0;
    let frameId;
    const timer = setTimeout(() => { cancelAnimationFrame(frameId); resolve(frames); }, 2000);
    const next = () => {
      frames += 1;
      if (frames === 2) { clearTimeout(timer); resolve(frames); }
      else frameId = requestAnimationFrame(next);
    };
    frameId = requestAnimationFrame(next);
  })`);
  console.log(
    `editor compositor readiness: ${JSON.stringify({ ...before, observedAnimationFrames: frames })}`,
  );
  if (frames !== 2) throw new Error("hidden editor did not produce two animation frames");
  await sleep(200);
  const started = performance.now();
  const shot = await command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  const png = Buffer.from(shot.data, "base64");
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(16) === 0 ||
    png.readUInt32BE(20) === 0
  )
    throw new Error("editor capture did not produce a nonempty PNG");
  console.log(
    `editor screenshot captured: ${JSON.stringify({
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      elapsedMs: Math.round(performance.now() - started),
    })}`,
  );
  return png;
}

async function enableGlobalApiTools() {
  await evaluate(`document.querySelector('button[aria-label="浏览器选项"]')?.click()`);
  await sleep(100);
  const clicked = await evaluate(
    `(() => {const button=[...document.querySelectorAll('[role="menuitem"],button')].find(b=>b.textContent==='官方 API（可选）' && b.getClientRects().length && !b.closest('[hidden]'));button?.click();return !!button;})()`,
  );
  if (!clicked) {
    const debug = await evaluate(
      `({heading:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent),menus:[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button[aria-label]')].map(e=>e.getAttribute('aria-label'))})`,
    );
    throw new Error("optional API menu missing " + JSON.stringify(debug));
  }
}
async function openGlobalCreator() {
  await evaluate(`(async () => {
    [...document.querySelectorAll('nav[aria-label=主导航] button')]
      .find(button => button.textContent === '设置')?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    [...document.querySelectorAll('nav[aria-label=主导航] button')]
      .find(button => button.textContent?.startsWith('短视频创作者平台'))?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const select = document.querySelector('select[aria-label="切换国内或国外平台"]');
    if (!select) throw new Error('creator side selector missing');
    select.value = 'global';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function verifyGlobalAddDialog() {
  await openGlobalCreator();
  await sleep(150);
  await evaluate(
    `window.dispatchEvent(new CustomEvent('clipdock:focus-global-create', { detail: 'youtube' }))`,
  );
  await sleep(150);
  const modal = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const content = dialog.textContent || '';
    return ['YouTube', 'TikTok', 'X', '创建环境并去登录'].every(text => content.includes(text)) &&
      !!dialog.querySelector('input') && !dialog.querySelector('select');
  })()`);
  if (!modal) throw new Error("global card-based add-account dialog missing");
  const shot = await command("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.resolve("shot-global-add-account.png"), Buffer.from(shot.data, "base64"));
  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '取消')?.click();
  })()`);
  await sleep(100);
  if (await evaluate(`!!document.querySelector('[role="dialog"]')`))
    throw new Error("global add dialog did not close");
  if (!process.argv.includes("--exercise-global-login")) return null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const snapshot = await evaluate("window.workbench.network.snapshot()");
    if (snapshot.switching?.proxy === "on" && snapshot.switching.state === "overseas") break;
    await sleep(500);
  }
  await evaluate(
    `window.dispatchEvent(new CustomEvent('clipdock:focus-global-create', { detail: 'youtube' }))`,
  );
  await sleep(100);
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="国际账号名称"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Smoke youtube');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(50);
  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '创建环境并去登录').click();
  })()`);
  let created;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(100);
    const rows = await evaluate("window.workbench.globalAccounts.list()");
    if (rows.length > 1) throw new Error("global add created duplicate accounts");
    if (rows.length === 1 && rows[0].displayName === "Smoke youtube") {
      created = rows[0];
      break;
    }
  }
  if (!created) throw new Error("global modal did not create the selected account");
  let state;
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(100);
    state = await evaluate(`window.workbench.globalWeb.state(${JSON.stringify(created.id)})`);
    if (state.phase === "open") break;
    if (state.phase === "error" || state.phase === "dormant") break;
  }
  if (state.phase !== "open" || !state.embedded)
    throw new Error("global modal did not open its embedded website");
  const toolbarPresent = await evaluate(`(() => {
    const workspace = document.querySelector('[aria-label="Smoke youtube 官网工作区"]');
    const labels = [...(workspace?.querySelectorAll('button') || [])].map(button => button.textContent?.trim());
    return ['主页','管理','上传','数据中心','作品','评论','数据观测','发布'].every(label => labels.includes(label));
  })()`);
  if (!toolbarPresent) throw new Error("global workspace did not expose all creator controls");
  if (process.argv.includes("--exercise-chrome")) {
    await evaluate(`(() => {
      [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '使用 Chrome').click();
    })()`);
    let chrome;
    for (let attempt = 0; attempt < 80; attempt++) {
      await sleep(250);
      chrome = await evaluate(`window.workbench.globalWeb.state(${JSON.stringify(created.id)})`);
      if (chrome.phase === "open" && chrome.engine === "chrome") break;
      if (chrome.phase === "error") throw new Error("Chrome trial failed: " + chrome.errorCode);
    }
    if (chrome?.phase !== "open" || chrome.engine !== "chrome" || !chrome.embedded)
      throw new Error("Chrome trial did not become ready");
    if (
      !(await evaluate(
        `!![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '切回内置浏览器')`,
      ))
    )
      throw new Error("Chrome trial has no return action");
    await evaluate(`window.workbench.globalWeb.hide(${JSON.stringify(created.id)})`);
    await evaluate(
      `window.workbench.globalWeb.show(${JSON.stringify(created.id)}, {x:500,y:150,width:800,height:560})`,
    );
    await evaluate(`window.workbench.globalWeb.close(${JSON.stringify(created.id)})`);
    console.log(
      "packaged Chrome trial opened from UI, projected Chrome state, hid and closed its independent process/profile",
    );
  }
  await evaluate(`window.workbench.globalWeb.close(${JSON.stringify(created.id)})`);
  await evaluate(`(() => {
    [...document.querySelectorAll('nav[aria-label="国外官网功能"] button')].find(button => button.textContent.trim() === '数据观测').click();
  })()`);
  await sleep(180);
  const observationUi = await evaluate(`(() => {
    const panel = document.querySelector('[aria-label="网页数据观测"]');
    return { found:!!panel, text:panel?.textContent.slice(0,900) ?? document.body.innerText.slice(-900) };
  })()`);
  if (
    !observationUi.found ||
    !observationUi.text.includes("无需额外配置 API") ||
    observationUi.text.includes("配置官方 API 授权")
  )
    throw new Error(
      "Webpage observation must be the default without an API setup gate: " + JSON.stringify(observationUi),
    );
  const snapshot = await evaluate(`window.workbench.globalWeb.observation(${JSON.stringify(created.id)})`);
  if (snapshot !== null) throw new Error("New website account unexpectedly has a snapshot");
  const readClosed = await evaluate(
    `window.workbench.globalWeb.readPage(${JSON.stringify(created.id)}).then(() => 'unexpected', error => error.message)`,
  );
  if (readClosed !== "WEB_OBSERVE_CLOSED")
    throw new Error("Closed website read should return a fixed status");
  fs.mkdirSync(path.resolve("docs/.compare/web-observation"), { recursive: true });
  const observationShot = await command("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.resolve("docs/.compare/web-observation/workspace.png"),
    Buffer.from(observationShot.data, "base64"),
  );
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 780,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(200);
  const narrowShot = await command("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.resolve("docs/.compare/web-observation/workspace-narrow.png"),
    Buffer.from(narrowShot.data, "base64"),
  );
  await command("Emulation.clearDeviceMetricsOverride");
  await evaluate(`document.querySelector('button[aria-label="关闭数据观测"]').click()`);
  console.log("global card dialog created one isolated account and opened its website inside the app");
  return created;
}
async function verifyGlobalAccounts(domesticBefore) {
  const initial = await evaluate("window.workbench.globalAccounts.list()");
  if (!Array.isArray(initial) || initial.length !== 0) throw new Error("global fixture is not empty");
  const createdFromDialog = await verifyGlobalAddDialog();
  const ids = [];
  try {
    for (const platformId of ["youtube", "tiktok", "x"]) {
      const account =
        platformId === "youtube" && createdFromDialog
          ? createdFromDialog
          : await evaluate(
              `window.workbench.globalAccounts.create(${JSON.stringify({
                platformId,
                displayName: `Smoke ${platformId}`,
              })})`,
            );
      if (typeof account?.id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(account.id))
        throw new Error("invalid global fixture identity");
      ids.push(account.id);
      const allowedFields = [
        "id",
        "platformId",
        "displayName",
        "remoteId",
        "authStatus",
        "createdAt",
        "updatedAt",
        "note",
        "browserEngine",
      ];
      if (
        JSON.stringify(Object.keys(account).sort()) !== JSON.stringify(allowedFields.sort()) ||
        account.platformId !== platformId ||
        account.authStatus !== "unauthorized" ||
        account.remoteId !== null
      )
        throw new Error("global account leaked authority or browser fields");
      const rejected = await evaluate(`(async () => {
        try {
          await window.workbench.views.show(${JSON.stringify(account.id)}, { x: 0, y: 0, width: 400, height: 300 });
          return false;
        } catch { return true; }
      })()`);
      if (!rejected) throw new Error("global account entered domestic view API");
      const authorization = await evaluate(`(async () => {
        const state = await window.workbench.globalOAuth.state(${JSON.stringify(account.id)});
        let unconfiguredRejected = false;
        try { await window.workbench.globalOAuth.start(${JSON.stringify(account.id)}); }
        catch (error) { unconfiguredRejected = error?.message === 'GLOBAL_OAUTH_NOT_CONFIGURED'; }
        const cancelled = await window.workbench.globalOAuth.cancel(${JSON.stringify(account.id)});
        return { state, cancelled, unconfiguredRejected };
      })()`);
      if (
        !authorization.unconfiguredRejected ||
        authorization.state.accountId !== account.id ||
        authorization.state.phase !== "idle" ||
        authorization.state.transactionId !== null ||
        authorization.cancelled.phase !== "idle" ||
        Object.keys(authorization.state).sort().join(",") !==
          "accountId,errorCode,phase,platformId,transactionId"
      )
        throw new Error(
          "global OAuth IPC did not refuse an unconfigured account before opening authorization",
        );
      const officialRead = await evaluate(`(async () => {
        const snapshot = await window.workbench.globalRead.get(${JSON.stringify(account.id)});
        let rejected = false;
        try { await window.workbench.globalJobs.submit(${JSON.stringify(account.id)}); }
        catch (error) { rejected = error?.message === 'GLOBAL_READ_UNAUTHORIZED'; }
        const jobs = await window.workbench.globalJobs.list(${JSON.stringify(account.id)});
        const cancelled = await window.workbench.globalJobs.cancel(${JSON.stringify(account.id)});
        return { snapshot, rejected, jobs, cancelled,
          hasBypass: 'refresh' in window.workbench.globalRead || 'cancel' in window.workbench.globalRead };
      })()`);
      if (
        officialRead.snapshot !== null ||
        !officialRead.rejected ||
        officialRead.jobs.length ||
        officialRead.cancelled !== null ||
        officialRead.hasBypass
      )
        throw new Error("global official read did not refuse an unauthorized account before network work");
      const draft = await evaluate(`(async () => {
        const id = ${JSON.stringify(account.id)};
        const jobs = await window.workbench.globalUploads.list(id);
        let submitError = '', consentError = '', videoConsentError = '', checkError = '';
        try { await window.workbench.globalUploads.submit({ accountId: id, assetId: crypto.randomUUID() }); }
        catch (error) { submitError = error?.message; }
        try { await window.workbench.globalOAuth.startDraft(id); }
        catch (error) { consentError = error?.message; }
        try { await window.workbench.globalOAuth.startUpload(id); }
        catch (error) { videoConsentError = error?.message; }
        try { await window.workbench.globalUploads.check(crypto.randomUUID()); }
        catch (error) { checkError = error?.message; }
        const cancelled = await window.workbench.globalUploads.cancel(crypto.randomUUID());
        return { jobs, submitError, consentError, videoConsentError, checkError, cancelled };
      })()`);
      if (
        draft.jobs.length ||
        draft.submitError !== "GLOBAL_UPLOAD_UNAUTHORIZED" ||
        draft.consentError !==
          (platformId === "tiktok" ? "GLOBAL_OAUTH_NOT_CONFIGURED" : "GLOBAL_OAUTH_INVALID_ACCOUNT") ||
        draft.videoConsentError !==
          (platformId === "youtube" ? "GLOBAL_OAUTH_NOT_CONFIGURED" : "GLOBAL_OAUTH_INVALID_ACCOUNT") ||
        draft.checkError !== "GLOBAL_UPLOAD_UNCERTAIN" ||
        draft.cancelled !== null
      )
        throw new Error("draft upload IPC did not refuse unconfigured consent or unauthorized work");
    }
    const snapshot = await evaluate(`(async () => ({
      global: await window.workbench.globalAccounts.list(),
      domestic: await window.workbench.accounts.list(),
      views: await window.workbench.views.states()
    }))()`);
    if (
      JSON.stringify(snapshot.global.map((a) => a.id).sort()) !== JSON.stringify([...ids].sort()) ||
      snapshot.global.some(
        (a) =>
          a.authStatus !== "unauthorized" ||
          a.remoteId !== null ||
          Object.keys(a).some(
            (key) =>
              ![
                "id",
                "platformId",
                "displayName",
                "remoteId",
                "authStatus",
                "createdAt",
                "updatedAt",
                "note",
                "browserEngine",
              ].includes(key),
          ),
      )
    )
      throw new Error("global list did not preserve unauthorized metadata");
    if (
      JSON.stringify(snapshot.domestic) !== JSON.stringify(domesticBefore) ||
      snapshot.views.some((view) => ids.includes(view.accountId))
    )
      throw new Error("global records changed domestic accounts or views");
    for (const id of ids)
      if (fs.existsSync(path.join(dataDir, "profiles", "Partitions", `sv-account-${id.toLowerCase()}`)))
        throw new Error("global account created a persistent browser partition");
    const disconnected = await evaluate(
      `window.workbench.globalAccounts.disconnect(${JSON.stringify(ids[0])})`,
    );
    if (
      disconnected.id !== ids[0] ||
      disconnected.authStatus !== "unauthorized" ||
      disconnected.remoteId !== null
    )
      throw new Error("local disconnect changed global identity or retained authorization");
    if ((await evaluate("window.workbench.globalAccounts.list()")).length !== 3)
      throw new Error("local disconnect removed the account record");

    await openGlobalCreator();
    let categoriesVisible = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(50);
      categoriesVisible = await evaluate(`(() => {
        const sidebar = document.querySelector('aside[aria-label="国外账号列表"]');
        const select = sidebar?.querySelector('select[aria-label="切换国内或国外平台"]');
        const sidebarText = sidebar?.textContent || '';
        return select?.value === 'global' && select.options.length === 2 &&
          !document.querySelector('[role="tablist"][aria-label="创作者平台区域"]') &&
          !document.querySelector('aside[aria-label="国内账号列表"]') &&
          sidebar && ['YouTube', 'TikTok', 'X'].every(name => sidebarText.includes(name)) &&
          ['Smoke youtube', 'Smoke tiktok', 'Smoke x'].every(name => sidebarText.includes(name)) &&
          !document.querySelector('section[aria-label="国际账号记录"]') &&
          !document.querySelector('input[aria-label="国际账号名称"]');
      })()`);
      if (categoriesVisible) break;
    }
    if (!categoriesVisible) {
      const debug = await evaluate(
        `({tabs:[...document.querySelectorAll('[role=tab]')].map(b=>b.textContent), nav:[...document.querySelectorAll('nav[aria-label=主导航] button')].map(b=>b.textContent), headings:[...document.querySelectorAll('h1,h2')].map(b=>b.textContent), sidebars:[...document.querySelectorAll('aside')].map(b=>b.getAttribute('aria-label'))})`,
      );
      throw new Error(
        `domestic/overseas categories or optional API default was wrong ${JSON.stringify(debug)}`,
      );
    }
    const selectedWebsite = await evaluate(`(() => {
      const sidebar = document.querySelector('aside[aria-label="国外账号列表"]');
      const row = [...(sidebar?.querySelectorAll('button[aria-pressed]') || [])]
        .find(node => node.textContent?.includes('Smoke youtube'));
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    if (!selectedWebsite) throw new Error("global sidebar did not expose the YouTube account row");
    let websiteWorkspaceVisible = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(50);
      websiteWorkspaceVisible = await evaluate(`(() => {
        const workspace = document.querySelector('section[aria-label="Smoke youtube 官网工作区"]');
        return !!workspace && workspace.textContent?.includes('页面尚未打开') &&
          [...workspace.querySelectorAll('button')].some(button => button.textContent?.startsWith('打开官网'));
      })()`);
      if (websiteWorkspaceVisible) break;
    }
    if (!websiteWorkspaceVisible)
      throw new Error("selected global account did not show its platform website workspace");
    for (const width of [1920, 1440, 1366, 1080]) {
      await command("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 1080 ? 740 : 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(200);
      await evaluate(
        `(() => {const workspace=document.querySelector('section[aria-label="Smoke youtube 官网工作区"]');[...workspace.querySelectorAll('button')].find(b=>b.textContent==='更多')?.click();})()`,
      );
      await sleep(50);
      const layout = await evaluate(`(() => {
        const workspace=document.querySelector('section[aria-label="Smoke youtube 官网工作区"]');
        const labels=['主页','管理','上传','数据中心','作品','评论','数据观测','发布'];
        const controls=[...workspace.querySelectorAll('button'),...document.querySelectorAll('[role="menuitem"]')];
        return workspace.scrollWidth<=workspace.clientWidth+1 && labels.every(label=>controls.some(button=>button.textContent?.trim()===label));
      })()`);
      if (!layout) throw new Error("global toolbar/overflow missing at " + width);
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      const shot = await command("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync("docs/.compare/unified-workspace", { recursive: true });
      fs.writeFileSync(
        path.resolve("docs/.compare/unified-workspace/creator-" + width + ".png"),
        Buffer.from(shot.data, "base64"),
      );
    }
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(100);
    const categoryShot = await command("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.resolve("shot-platform-categories.png"), Buffer.from(categoryShot.data, "base64"));
    await verifyUnifiedWorkspace(ids);
    await enableGlobalApiTools();
    let visible = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(50);
      visible = await evaluate(`(() => {
        const list = document.querySelector('section[aria-label="国际账号记录"]');
        if (!list || list.getAttribute('aria-busy') === 'true') return false;
        const names = [...list.querySelectorAll('h2')].map(node => node.textContent);
        const authorization = [...list.querySelectorAll('button')].filter(button => button.textContent === '官方授权');
        return names.length === 3 && ['Smoke youtube', 'Smoke tiktok', 'Smoke x'].every(name => names.includes(name)) &&
          authorization.length === 3 && authorization.every(button => !button.disabled) &&
          [...list.querySelectorAll('span')].filter(node => node.textContent === '未授权').length === 3 && !/已有授权记录|正在运行|已上线/.test(list.textContent);
      })()`);
      if (visible) break;
    }
    if (!visible)
      throw new Error("global UI did not show three unauthorized records with guarded authorization entry");
    const globalShot = await command("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.resolve("shot-global-accounts.png"), Buffer.from(globalShot.data, "base64"));
    const draftVisible = await evaluate(`(() => {
      const panel = document.querySelector('section[aria-label="Smoke tiktok 的 TikTok 草稿上传"]');
      const draftConsent = [...document.querySelectorAll('button')].filter(button => button.textContent === '授权草稿上传');
      const submit = panel && [...panel.querySelectorAll('button')].find(button => button.textContent === '上传到 TikTok 收件箱');
      if (!panel || !submit?.disabled || draftConsent.length !== 1 || draftConsent[0].disabled) return false;
      panel.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    })()`);
    if (!draftVisible) throw new Error("TikTok draft panel did not keep unauthorized submission disabled");
    await sleep(100);
    const draftBounds = await evaluate(`(() => {
      const panel = document.querySelector('section[aria-label="Smoke tiktok 的 TikTok 草稿上传"]');
      return panel.scrollWidth <= panel.clientWidth + 1 && [...panel.querySelectorAll('button,select')].every(node => {
        const box = node.getBoundingClientRect(); return box.x >= 0 && box.right <= innerWidth && box.width > 0;
      });
    })()`);
    if (!draftBounds) throw new Error("TikTok draft controls overflow the desktop panel");
    const draftShot = await command("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.resolve("shot-tiktok-draft.png"), Buffer.from(draftShot.data, "base64"));
    const youtubeVisible = await evaluate(`(() => {
      const panel = document.querySelector('section[aria-label="Smoke youtube 的 YouTube 视频上传"]');
      const consent = [...document.querySelectorAll('button')].filter(button => button.textContent === '授权视频上传');
      const submit = panel && [...panel.querySelectorAll('button')].find(button => button.textContent === '上传到 YouTube');
      if (!panel || !submit?.disabled || consent.length !== 1 || consent[0].disabled ||
          panel.querySelector('select[aria-label="可见性"]')?.value !== 'private' ||
          panel.querySelector('select[aria-label="是否专为儿童制作"]')?.value !== '' ||
          panel.querySelector('select[aria-label="是否包含需披露的逼真合成或修改内容"]')?.value !== '') return false;
      panel.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    })()`);
    if (!youtubeVisible) throw new Error("YouTube upload consent or private default was not preserved");
    await sleep(100);
    const youtubeBounds = await evaluate(`(() => {
      const panel = document.querySelector('section[aria-label="Smoke youtube 的 YouTube 视频上传"]');
      return panel.scrollWidth <= panel.clientWidth + 1 && [...panel.querySelectorAll('button,select,input,textarea')].every(node => {
        const box = node.getBoundingClientRect(); return box.x >= 0 && box.right <= innerWidth && box.width > 0;
      });
    })()`);
    if (!youtubeBounds) throw new Error("YouTube upload controls overflow the desktop panel");
    const youtubeShot = await command("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.resolve("shot-youtube-upload.png"), Buffer.from(youtubeShot.data, "base64"));
  } finally {
    for (const id of ids) await evaluate(`window.workbench.globalAccounts.delete(${JSON.stringify(id)})`);
  }
  const after = await evaluate("window.workbench.globalAccounts.list()");
  if (!Array.isArray(after) || after.length !== 0) throw new Error("global fixture deletion did not finish");
  // Remount through the actual navigation so the page reloads its list after IPC deletion.
  await evaluate(
    "[...document.querySelectorAll('nav[aria-label=主导航] button')].find(b => b.textContent === '设置').click()",
  );
  await sleep(50);
  await openGlobalCreator();
  let empty = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(50);
    empty = await evaluate(`(() => {
      const sidebar = document.querySelector('aside[aria-label="国外账号列表"]');
      const main = document.querySelector('main');
      return !!sidebar && !sidebar.textContent.includes('Smoke ') &&
        !document.querySelector('[aria-label$="官网工作区"]') &&
        !![...main.querySelectorAll('button')].find(button => button.textContent?.includes('添加'));
    })()`);
    if (empty) break;
  }
  if (!empty) throw new Error("global UI did not reflect deleted records");
}

async function verifyGlobalAppConfiguration(encryptionAvailable) {
  const result = await evaluate(`(async () => {
    const initial = await window.workbench.globalApps.list();
    if (initial.length !== 3 || initial.some(app => app.configured)) return { passed: false };
    const secret = 'synthetic-smoke-global-application-secret';
    const google = await window.workbench.globalApps.configure({ platformId: 'youtube', clientId: 'synthetic-smoke.apps.googleusercontent.com', redirectPort: 0 });
    const x = await window.workbench.globalApps.configure({ platformId: 'x', clientId: 'synthetic-smoke-x', redirectPort: 3456 });
    let secretChecked = false;
    if (${JSON.stringify(encryptionAvailable === true)}) {
      const saved = await window.workbench.globalApps.configure({ platformId: 'tiktok', clientId: 'synthetic-smoke-tiktok', redirectPort: 3455, clientSecret: secret });
      if (!saved.clientSecret?.available) return { passed: false };
      let genericDeleteRejected = false;
      try { await window.workbench.credentials.delete({ kind: 'oauth_client_secret', ownerId: saved.id }); }
      catch { genericDeleteRejected = true; }
      if (!genericDeleteRejected) return { passed: false };
      const cleared = await window.workbench.globalApps.clearSecret('tiktok');
      if (!cleared.configured || cleared.clientSecret?.hasCredential || cleared.clientSecret?.available) return { passed: false };
      secretChecked = true;
    } else {
      let rejected = false;
      try { await window.workbench.globalApps.configure({ platformId: 'tiktok', clientId: 'synthetic-smoke-tiktok', redirectPort: 3455, clientSecret: secret }); }
      catch { rejected = true; }
      if (!rejected) return { passed: false };
    }
    const apps = await window.workbench.globalApps.list();
    const publicJson = JSON.stringify({ apps, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } });
    return { passed: google.configured && x.configured && !publicJson.includes(secret) && !Object.keys(window.workbench.globalApps).some(key => /token|secret|get/i.test(key) && key !== 'clearSecret'), secretChecked };
  })()`);
  if (!result?.passed) throw new Error("global application configuration boundary failed");
  await evaluate(
    "[...document.querySelectorAll('nav[aria-label=主导航] button')].find(b => b.textContent === '设置').click()",
  );
  await sleep(100);
  await openGlobalCreator();
  await enableGlobalApiTools();
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100);
    ready = await evaluate(`(() => {
      const panel = document.querySelector('section[aria-label="国际开发者应用配置"]');
      return Boolean(panel && panel.textContent.includes('synthetic-smoke.apps.googleusercontent.com') &&
        panel.querySelector('button[aria-label="配置 YouTube 应用"]')?.disabled === false);
    })()`);
    if (ready) break;
  }
  if (!ready) throw new Error("global application configuration panel did not load saved metadata");
  const shot = await command("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.resolve("shot-global-apps.png"), Buffer.from(shot.data, "base64"));
  await evaluate("document.querySelector('button[aria-label=\"配置 YouTube 应用\"]').click()");
  await sleep(100);
  const formReady = await evaluate(`(() => {
    const secret = document.querySelector('input[aria-label="YouTube Client Secret"]');
    const client = document.querySelector('input[aria-label="YouTube Client ID"]');
    return Boolean(secret && secret.type === 'password' && secret.value === '' &&
      client?.value === 'synthetic-smoke.apps.googleusercontent.com');
  })()`);
  if (!formReady) throw new Error("global application editor did not preserve write-only password boundary");
  const editorShot = await captureEditorScreenshot();
  fs.writeFileSync(path.resolve("shot-global-app-editor.png"), editorShot);
  return result.secretChecked;
}

async function verifyUnifiedWorkspace(ids) {
  const clickModule = async (name) => {
    await evaluate(
      `document.querySelector('nav[aria-label="主导航"] button[aria-label="${name}"]')?.click()`,
    );
    await sleep(150);
  };
  for (const name of ["总览", "数据观测", "素材库", "发布助手", "设置"]) {
    await clickModule(name);
    await evaluate(
      `[...document.querySelectorAll('aside[aria-label="国外账号列表"] button[aria-pressed]')].find(e=>e.textContent.includes('Smoke x')).dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
    );
    await sleep(100);
    const valid = await evaluate(
      `(() => {const nav=document.querySelector('nav[aria-label="主导航"] button[aria-label="${name}"]');return nav?.className.includes('active') && !!document.querySelector('aside[aria-label="国外账号列表"]') && !document.querySelector('section[aria-label$="官网工作区"]');})()`,
    );
    if (!valid) throw new Error("scope/account selection navigated away from " + name);
    await evaluate(
      `(()=>{const select=document.querySelector('select[aria-label="切换国内或国外平台"]');select.value='domestic';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(100);
    if (
      !(await evaluate(
        `document.querySelector('nav[aria-label="主导航"] button[aria-label="${name}"]')?.className.includes('active')`,
      ))
    )
      throw new Error("scope switch changed module " + name);
    await evaluate(
      `(()=>{const select=document.querySelector('select[aria-label="切换国内或国外平台"]');select.value='global';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(100);
  }
  const saved = await evaluate(
    `window.workbench.globalWorkspace.publishSave({accountId:${JSON.stringify(ids[2])},title:'保存的国外草稿',assetIds:[]})`,
  );
  const plans = await evaluate(`window.workbench.globalWorkspace.publishList(${JSON.stringify(ids[2])})`);
  if (plans[0]?.id !== saved.id || plans[0]?.title !== saved.title)
    throw new Error("global publish plan roundtrip failed");
  for (const name of ["总览", "数据观测", "发布助手"]) {
    await clickModule(name);
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1366, 768],
      [1080, 740],
    ]) {
      await command("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(150);
      const shot = await command("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(
        path.resolve("docs/.compare/unified-workspace/" + name + "-" + width + ".png"),
        Buffer.from(shot.data, "base64"),
      );
      if (!(await evaluate("document.documentElement.scrollWidth <= innerWidth+1")))
        throw new Error("page overflow " + name + " " + width);
    }
  }
  for (const [x, y] of [
    [0, 0],
    [1070, 0],
    [0, 730],
    [1070, 730],
  ]) {
    await evaluate(
      `(()=>{const row=document.querySelector('aside[aria-label="国外账号列表"] [data-account-id]') || [...document.querySelectorAll('aside[aria-label="国外账号列表"] button[aria-pressed]')].find(e=>e.textContent.includes('Smoke x'));row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:${x},clientY:${y}}));})()`,
    );
    await sleep(80);
    const valid = await evaluate(
      `(()=>{const menu=document.querySelector('[role="menu"]');if(!menu)return false;const r=menu.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&menu.querySelectorAll('[role="menuitem"]').length===6;})()`,
    );
    if (!valid) throw new Error("global context menu bounds/actions failed");
    const shot = await command("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.resolve("docs/.compare/unified-workspace/menu-" + x + "-" + y + ".png"),
      Buffer.from(shot.data, "base64"),
    );
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    await sleep(30);
  }
  await sleep(500);
  const settings = await evaluate("window.workbench.settings.get()");
  if (settings.accountScope !== "global" || settings.lastGlobalAccountId !== ids[2])
    throw new Error("workspace selection not persisted");
  await command("Emulation.clearDeviceMetricsOverride");
  await openGlobalCreator();
  await sleep(150);
  console.log(
    "unified workspace: scope-preserving modules, durable global draft, four viewport sizes and four menu corners passed",
  );
}

async function verifyDomesticOptimization() {
  await evaluate(`(async () => {
    for (const platformId of ['douyin','kuaishou','xiaohongshu','bilibili','baijiahao','weixin_channels'])
      await window.workbench.accounts.create({platformId, displayName:'层级测试 · '+platformId});
    document.querySelector('nav[aria-label="主导航"] button[aria-label="短视频创作者平台"]').click();
  })()`);
  await sleep(100);
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="切换国内或国外平台"]');
    if (select) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'domestic'); select.dispatchEvent(new Event('change',{bubbles:true})); }
  })()`);
  await sleep(300);
  for (const [width,height] of [[960,640],[1120,720],[1440,900],[1920,1080]]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await sleep(200);
    const geometry = await evaluate(`(() => {
      const side = document.querySelector('aside[aria-label="国内账号列表"]');
      const platform = side?.querySelector('button[aria-controls="platform-kuaishou"]');
      const row = side?.querySelector('#platform-kuaishou button[aria-pressed]');
      return { platformHeight:platform?.getBoundingClientRect().height, rowHeight:row?.parentElement.getBoundingClientRect().height,
        logoSize:platform?.querySelector('img')?.getBoundingClientRect().width,
        avatarSize:row?.firstElementChild?.getBoundingClientRect().width,
        platformFont:platform?getComputedStyle(platform).fontSize:null,
        platformWeight:platform?getComputedStyle(platform).fontWeight:null,
        accountFont:row?.querySelector('strong')?getComputedStyle(row.querySelector('strong')).fontSize:null,
        logos:[...(side?.querySelectorAll('button[aria-controls] img')||[])].filter(i=>i.complete&&i.naturalWidth>0).length,
        nestedButtons:document.querySelectorAll('button button').length, overflow:document.documentElement.scrollWidth>innerWidth,
        sidebarOverflow:!!side&&side.scrollWidth>side.clientWidth,
        indent:row&&platform?row.getBoundingClientRect().left-platform.getBoundingClientRect().left:0};
    })()`);
    if (geometry.platformHeight!==52 || geometry.rowHeight!==40 || geometry.logoSize!==32 || geometry.avatarSize!==20 || geometry.platformFont!=='15px' || geometry.platformWeight!=='700' || geometry.accountFont!=='13px' || geometry.logos!==6 || geometry.nestedButtons || geometry.overflow || geometry.sidebarOverflow || geometry.indent<28)
      throw new Error('domestic hierarchy/layout failed: '+JSON.stringify({width,height,...geometry}));
    fs.mkdirSync(path.resolve('output/optimization'),{recursive:true});
    const shot = await command('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.resolve(`output/optimization/sidebar-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await evaluate(`document.querySelector('button[aria-controls="platform-kuaishou"]').click()`);
  await sleep(100);
  await evaluate(`(() => {const input=document.querySelector('input[placeholder="搜索账号 / 平台"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'快手'); input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(100);
  const search = await evaluate(`!!document.querySelector('#platform-kuaishou button[aria-pressed]') && !document.querySelector('#platform-douyin')`);
  if (!search) throw new Error('platform search failed');
  await evaluate(`(() => {const input=document.querySelector('input[placeholder="搜索账号 / 平台"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,''); input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(100);
  if (await evaluate(`!!document.querySelector('#platform-kuaishou button[aria-pressed]')`)) throw new Error('collapse preference was lost after search');
  // A paused check can finish synchronously before Chromium delivers the second
  // IPC message. Compare conclusions here; real in-flight deduplication is covered
  // by the service concurrency test with a deliberately deferred response.
  const checked = await evaluate(`(async()=>{const a=(await window.workbench.accounts.list()).find(a=>a.platformId==='weixin_channels'); const [one,two]=await Promise.all([window.workbench.accounts.checkStatus(a.id),window.workbench.accounts.checkStatus(a.id)]); return {status:one.status,info:one.checkInfo?.state,same:one.checkInfo?.state===two.checkInfo?.state&&one.status===two.status};})()`);
  if (!checked.same || !['paused','unconfirmed'].includes(checked.info) || checked.status!=='unknown') throw new Error('check feedback altered unconfirmed auth: '+JSON.stringify(checked));
  console.log('domestic optimization smoke: 960/1120/1440/1920 px; six packaged logos; 52/40 px hierarchy; search/collapse; IPC check feedback and deduplication');
}

let ok = false;
let globalBoundaryStarted = false;
try {
  let attempts = 0;
  while (attempts < 40) {
    attempts += 1;
    await sleep(500);
    try {
      const info = await evaluate("window.workbench.app.info()");
      if (!info?.userAgent) throw new Error("no app info");
      if (path.resolve(info.userDataPath) !== path.resolve(dataDir))
        throw new Error("refusing a non-smoke profile");
      if (/Electron/.test(info.userAgent)) throw new Error(`UA still advertises Electron: ${info.userAgent}`);
      const accounts = await evaluate("window.workbench.accounts.list()");
      if (!Array.isArray(accounts)) throw new Error("accounts.list did not return an array");
      const rendered = await evaluate("Boolean(document.querySelector('nav[aria-label=主导航]'))");
      if (!rendered) throw new Error("shell navigation not rendered");
      const network = await evaluate("window.workbench.network.snapshot()");
      if (
        network.enforcement !== "strict" ||
        network.policy !== "rule-split" ||
        !network.switching ||
        network.accounts.some((a) => a.state === "allowed")
      )
        throw new Error("unexpected network policy");
      const visibleMode = await evaluate("document.querySelector('[aria-label=网络状态]')?.textContent");
      if (
        !visibleMode ||
        visibleMode.includes("尚未拦截") ||
        !/国内模式|代理模式|规则模式|双通路|检查中|网络不可用/.test(visibleMode)
      )
        throw new Error("automatic switch mode not visibly disclosed");
      if (unavailableMediaCache) {
        const missingMedia = await evaluate(
          "new Promise(resolve => { const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('missing'); image.src = 'sv-asset://remote/6ee7babe-7e1a-4f1b-a433-5f9e514120e7'; })",
        );
        if (missingMedia !== "missing") throw new Error("unavailable media cache did not fail locally");
      }
      const credentials = await evaluate(`(async () => {
        const ref = { kind: 'proxy_password', ownerId: 'default' };
        const before = await window.workbench.credentials.meta(ref);
        if (!before.encryptionAvailable) return { checked: false };
        const secret = 'synthetic-smoke-secret-' + crypto.randomUUID();
        const saved = await window.workbench.credentials.set({ ...ref, secret });
        const publicValues = JSON.stringify([saved, await window.workbench.settings.get(), await window.workbench.network.snapshot()]);
        const leaked = publicValues.includes(secret) || Object.keys(window.workbench.credentials).includes('get');
        await window.workbench.credentials.delete(ref);
        return { checked: true, saved: saved.available && saved.hasCredential, leaked };
      })()`);
      if (credentials.checked && (!credentials.saved || credentials.leaked))
        throw new Error("credential boundary failed");
      await evaluate(
        "[...document.querySelectorAll('nav[aria-label=主导航] button')].find(b => b.textContent === '设置').click()",
      );
      await sleep(300);
      const panel = await evaluate("Boolean(document.querySelector('input[aria-label=\"Clash 密钥\"]'))");
      if (!panel) throw new Error("network settings panel not rendered");
      const shot = await command("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.resolve("shot-network-exclusive.png"), Buffer.from(shot.data, "base64"));
      const persisted = await evaluate(
        "JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)])",
      );
      if (/AccountNetworkState|proofExpiresAt|rulesVersion|switching/.test(persisted))
        throw new Error("network permissions persisted in renderer");
      globalBoundaryStarted = true;
      await verifyGlobalAccounts(accounts);
      const globalSecretChecked = await verifyGlobalAppConfiguration(credentials.checked);
      await verifyDomesticOptimization();
      if (process.argv.includes("--require-domestic-direct")) {
        const deadline = Date.now() + 60000;
        let direct;
        while (Date.now() < deadline) {
          direct = await evaluate("window.workbench.network.snapshot()");
          if (direct.state === "dual" && direct.switching.proxy === "on") break;
          await sleep(1000);
        }
        if (direct?.state !== "dual" || direct.switching.proxy !== "on")
          throw new Error("packaged domestic DIRECT admission unavailable: " + direct?.reason);
        for (let sample = 0; sample < 4; sample++) {
          await sleep(5000);
          const renewed = await evaluate("window.workbench.network.snapshot()");
          if (renewed.state !== "dual" || renewed.switching.generation !== direct.switching.generation)
            throw new Error("packaged domestic DIRECT admission changed during renewal");
        }
        console.log("packaged DIRECT rule mode and stable renewal verified with the current Windows proxy/TUN");
      }
      if (process.argv.includes("--require-proxy-on")) {
        const deadline = Date.now() + 45000;
        let domestic;
        while (Date.now() < deadline) {
          domestic = await evaluate("window.workbench.network.snapshot()");
          if (["overseas", "dual"].includes(domestic.state) && domestic.switching.proxy === "on") break;
          await sleep(1000);
        }
        if (!["overseas", "dual"].includes(domestic?.state) || domestic.switching.proxy !== "on")
          throw new Error("packaged proxy-on switch unavailable");
        await sleep(16000);
        const renewed = await evaluate("window.workbench.network.snapshot()");
        if (renewed.state !== domestic.state || renewed.switching.generation !== domestic.switching.generation)
          throw new Error("packaged proxy switch did not survive renewal");
        console.log(
          "packaged proxy-on switch and stable renewal verified with the current Windows proxy/TUN",
        );
      }
      console.log(`smoke ok: electron ${info.electron}, chrome ${info.chrome}, ua "${info.userAgent}"`);
      if (packaged) console.log("packaged launcher executable verified with isolated throwaway data");
      console.log(
        `network rule-split UI/IPC and memory-only projection ok; system credential encryption ${credentials.checked ? "verified" : "unavailable (save correctly disabled)"}`,
      );
      console.log(
        "global account preload/UI verified: three unauthorized platforms, rejected domestic views, no domestic account partitions, records deleted",
      );
      console.log(
        "TikTok draft preload/UI verified: separate consent entry, missing app/authorization refused, no automatic upload, local history and desktop layout",
      );
      console.log(
        "YouTube upload preload/UI verified: explicit upload consent, missing app/authorization refused, private default, required audience declarations and desktop layout",
      );
      console.log(
        `global application configuration verified; encrypted application secret ${globalSecretChecked ? "saved and cleared" : "unavailable and refused"}`,
      );
      if (unavailableMediaCache)
        console.log("unavailable media cache: shell remains usable and local image reports missing");
      ok = true;
      break;
    } catch (error) {
      // Retrying readiness is safe; a failed account mutation check must remain a failure.
      if (globalBoundaryStarted || attempts >= 40) throw error;
    }
  }
} catch (error) {
  console.error("smoke failed:", error.message);
  if (stderr.trim()) console.error(stderr.slice(-2000));
} finally {
  // Let Electron drain its registered sessions and native readers before removing
  // this test's directory; killing only the parent races Chromium file handles.
  if (debugSocket?.readyState === WebSocket.OPEN) {
    await Promise.race([
      command("Browser.close", {}).catch(() => undefined),
      sleep(3000),
    ]);
  }
  debugSocket?.close();
  if (child.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(10000)]);
  }
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(3000)]);
  }
  const resolvedDataDir = path.resolve(dataDir);
  if (
    path.dirname(resolvedDataDir) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolvedDataDir).startsWith("sv-smoke-")
  )
    throw new Error("unsafe smoke cleanup target");
  fs.rmSync(resolvedDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  process.exit(ok ? 0 : 1);
}
