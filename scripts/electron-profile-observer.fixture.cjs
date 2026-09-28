const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BaseWindow, WebContentsView, session } = require("electron");
const scratch = process.env.SV_PROFILE_OBSERVER_SCRATCH;
if (!scratch || !path.isAbsolute(scratch) || !path.basename(scratch).startsWith("sv-profile-observer-"))
  throw new Error("Use the isolated profile observer smoke launcher");
app.setPath("userData", path.join(scratch, "data"));
const { IdentityObserver, installBusinessNetwork } = require(path.join(scratch, "observer.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const uninstall = installBusinessNetwork({ enforcement: "observe", check: () => ({ allowed: false, reason: "CHECKING" }), acquire: () => null });
  const ses = session.fromPartition("profile-observer-fixture");
  let revision = 1, requests = 0, observations = 0;
  // Every HTTPS request is answered locally. No platform or account network is used.
  await ses.protocol.handle("https", request => {
    const url = new URL(request.url);
    if (url.hostname === "www.bilibili.com") return new Response('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src https://api.bilibili.com">fixture', { headers: { "Content-Type": "text/html" } });
    if (url.hostname !== "api.bilibili.com") return new Response(null, { status: 403 });
    requests++;
    return Response.json({ code: 0, data: { isLogin: true, mid: 1234, uname: `Fixture ${revision}`, face: `https://i0.hdslb.com/${revision}.jpg`, token: "never-export" } },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  });
  const window = new BaseWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  const wc = view.webContents;
  const observer = new IdentityObserver(wc, "fixture-account", "bilibili", () => { observations++; });
  await wc.loadURL("https://www.bilibili.com/");
  for (revision = 1; revision <= 2; revision++) {
    await wc.executeJavaScript('fetch("https://api.bilibili.com/x/web-interface/nav", {cache:"no-store"}).then(r=>r.json()).then(()=>true)');
    const deadline = Date.now() + 3000;
    while (observer.read()?.profile?.displayName !== `Fixture ${revision}` && Date.now() < deadline) await sleep(25);
    assert.equal(observer.read()?.profile?.displayName, `Fixture ${revision}`);
    assert.equal(observer.read()?.profile?.avatarUrl, `https://i0.hdslb.com/${revision}.jpg`);
    assert.equal(JSON.stringify(observer.read()).includes("never-export"), false);
  }
  await wc.executeJavaScript('fetch("https://api.bilibili.com/x/space/wbi/acc/info?mid=999").then(()=>true)');
  await sleep(50);
  assert.equal(observations, 2, "author profiles are not current-account evidence");
  assert.equal(requests, 3, "observation must never create/replay requests");
  assert.equal(window.isVisible(), false);
  observer.dispose(); uninstall();
  wc.close({ waitForBeforeUnload: false }); window.destroy();
  console.log(JSON.stringify({ result: "passed", profileUpdates: observations, fixtureRequests: requests, publicNetworkRequests: 0 }));
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
