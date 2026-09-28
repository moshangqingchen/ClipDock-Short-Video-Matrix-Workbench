const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BaseWindow, WebContentsView, session } = require("electron");
const scratch = process.env.SV_KUAISHOU_LOGIN_SCRATCH;
if (!scratch || !path.isAbsolute(scratch) || !path.basename(scratch).startsWith("sv-kuaishou-login-"))
  throw new Error("Use electron-kuaishou-login-smoke.mjs with isolated data");
app.setPath("userData", path.join(scratch, "data"));
const { buildHomepageLoginScript } = require(path.join(scratch, "homepage-login.cjs"));
app.whenReady().then(async () => {
  const ses = session.fromPartition("kuaishou-login-fixture");
  let requests = 0;
  await ses.protocol.handle("https", () => {
    requests++;
    return new Response('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
      '<div class="workbench"><main><div class="wb-left"><div class="sidebar"><button>立即登录</button></div></div></main></div>',
      { headers: { "Content-Type": "text/html;charset=utf-8" } });
  });
  const window = new BaseWindow({ show: false, width: 1280, height: 800 });
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  const wc = view.webContents;
  let navigations = 0;
  wc.on("did-navigate", () => { navigations++; });
  await wc.loadURL("https://www.kuaishou.com/new-reco");
  await wc.executeJavaScript('window.INIT_STATE = {"tusjoh.0sftu0w0qspgjmf0hfu-pckfdu.": {result:109}}; true');
  const read = () => wc.executeJavaScript(buildHomepageLoginScript("kuaishou"));
  assert.equal((await read()).kind, "offline");
  const signedIn = '<div class="down"><div class="down-box login"><div class="user item"><img class="image" src="https://p66.a.kwimgs.com/self.jpg"><div class="text">Fixture account</div></div></div></div>';
  await wc.executeJavaScript(`document.querySelector('.sidebar').innerHTML = ${JSON.stringify(signedIn)}; true`);
  assert.deepEqual(await read(), { kind: "online", source: "homepage", reason: "主页已显示当前登录账号", avatarUrl: "https://p66.a.kwimgs.com/self.jpg", displayName: "Fixture account" });
  assert.equal(await wc.executeJavaScript('window.INIT_STATE["tusjoh.0sftu0w0qspgjmf0hfu-pckfdu."].result'), 109);
  await wc.executeJavaScript(`document.querySelector('.sidebar').insertAdjacentHTML('beforeend','<button>立即登录</button>'); true`);
  assert.equal((await read()).kind, "unconfirmed");
  await wc.executeJavaScript(`document.querySelector('.sidebar').innerHTML = '<button>立即登录</button>'; true`);
  assert.equal((await read()).kind, "offline");
  assert.equal(navigations, 1, "login observation must not reload the page");
  assert.equal(requests, 1, "the fixture must issue no profile or QR requests");
  assert.equal(window.isVisible(), false);
  wc.close({ waitForBeforeUnload: false }); window.destroy();
  console.log(JSON.stringify({ result: "passed", states: ["offline", "online", "unconfirmed", "offline"], navigations, fixtureRequests: requests }));
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
