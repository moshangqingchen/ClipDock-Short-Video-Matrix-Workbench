const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BaseWindow, WebContentsView, webContents } = require("electron");

const scratch = process.env.SV_HOMEPAGE_VIEWPORT_SCRATCH;
if (!scratch || !path.isAbsolute(scratch) || !path.basename(scratch).startsWith("sv-homepage-viewport-"))
  throw new Error("Run through electron-homepage-viewport-smoke.mjs with an isolated scratch directory");
app.setPath("userData", path.join(scratch, "data"));
const { HomepageCheckHost } = require(path.join(scratch, "homepage-check-host.cjs"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const mainWindow = new BaseWindow({ show: false, width: 1280, height: 800 });
  const host = new HomepageCheckHost();
  const view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const contents = view.webContents;
  contents.setAudioMuted(true);
  view.setVisible(false);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  const html = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<style>@media(max-width:600px){header{display:none}}</style><header>synthetic account control</header>';
  await contents.loadURL("data:text/html," + encodeURIComponent(html));
  const read = () => contents.executeJavaScript(`({width:innerWidth,height:innerHeight,
    visibility:document.visibilityState,header:getComputedStyle(document.querySelector('header')).display})`);
  const before = await read();
  const originalCount = webContents.getAllWebContents().length;
  host.attach(view);
  let hosted;
  const deadline = Date.now() + 3000;
  do {
    await sleep(25);
    hosted = await read();
  } while (hosted.width !== 1280 && Date.now() < deadline);
  assert.equal(hosted.width, 1280);
  assert.equal(hosted.height, 800);
  assert.equal(hosted.header, "block");
  assert.equal(webContents.getAllWebContents().length, originalCount, "host must not create another renderer");
  assert.ok(BaseWindow.getAllWindows().every((window) => !window.isVisible()), "no native window may be shown");
  host.detach(view);
  mainWindow.contentView.addChildView(view);
  view.setVisible(true);
  host.dispose();
  assert.equal(contents.isDestroyed(), false, "moving/destroying the host must not destroy the account page");
  assert.equal(contents.isAudioMuted(), true);
  await sleep(50);
  const restored = await read();
  assert.equal(restored.width, 1280);
  mainWindow.contentView.removeChildView(view);
  await new Promise((resolve) => {
    contents.once("destroyed", resolve);
    contents.close({ waitForBeforeUnload: false });
  });
  mainWindow.destroy();
  console.log(JSON.stringify({ result: "passed", before, hosted, restored, contentsCreated: originalCount }));
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });
