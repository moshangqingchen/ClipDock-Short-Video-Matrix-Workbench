import { app, BaseWindow } from "electron";
import path from "node:path";
import { IPC } from "@shared/ipc";
import { createStore, type Store } from "./db";
import { ViewPool } from "./browser/view-pool";
import { AccountService } from "./services/account-service";
import { createMainWindow, type MainWindow } from "./window/main-window";
import { createIpcRegistrar, type IpcRegistrar } from "./ipc/register";
import { registerAccountHandlers } from "./ipc/handlers/accounts";
import { registerViewHandlers } from "./ipc/handlers/views";
import { registerSettingsHandlers } from "./ipc/handlers/settings";
import { registerMetricsHandlers } from "./ipc/handlers/metrics";
import { registerAssetHandlers } from "./ipc/handlers/assets";
import { registerPublishHandlers } from "./ipc/handlers/publish";
import { registerBackupHandlers } from "./ipc/handlers/backup";
import { createNotifier } from "./notifications";
import { CollectScheduler } from "./data/scheduler";
import { createCollectorRegistry } from "./data/collectors";
import { AssetService, registerAssetSchemePrivileges } from "./services/asset-service";
import { toChromeUserAgent } from "./browser/user-agent";
import { PublishService } from "./services/publish-service";

const APP_NAME = "短视频矩阵工作台";
const APP_ID = "com.shortvideo.matrix.workbench";

/* ------------------------------------------------------------------ */
/* Process identity & paths (must run before app.ready)                */
/* ------------------------------------------------------------------ */

app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

if (process.env.SV_WORKBENCH_SOFTWARE_RENDERING === "1") app.disableHardwareAcceleration();

// Chinese creator consoles are heavy SPAs; a larger media cache and standard
// Chrome behaviour for autoplay keep them responsive and less "unusual".
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disk-cache-size", String(512 * 1024 * 1024));
app.commandLine.appendSwitch("lang", "zh-CN");

const portableDataDir = process.env.SV_WORKBENCH_DATA_DIR?.trim();
const userDataPath =
  portableDataDir && path.isAbsolute(portableDataDir)
    ? path.resolve(portableDataDir)
    : path.join(app.getPath("appData"), "short-video-matrix-workbench");
app.setPath("userData", userDataPath);
app.setPath("sessionData", path.join(userDataPath, "profiles"));

registerAssetSchemePrivileges();

// Every session (including any created implicitly) presents a plain Chrome UA;
// the per-account session additionally pins Accept-Language.
app.userAgentFallback = toChromeUserAgent(app.userAgentFallback);

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

interface Runtime {
  store: Store;
  mainWindow: MainWindow;
  pool: ViewPool;
  accounts: AccountService;
  ipc: IpcRegistrar;
  scheduler: CollectScheduler;
}

let runtime: Runtime | null = null;
let quitting = false;

async function bootstrap(): Promise<void> {
  const store = createStore(path.join(userDataPath, "workbench.db"));
  const settings = store.settings.get();

  const mainWindow = createMainWindow(userDataPath);
  const ipc = createIpcRegistrar(() =>
    mainWindow.shell.webContents.isDestroyed() ? null : mainWindow.shell.webContents,
  );
  const notify = createNotifier((toast) => ipc.send(IPC.evToast, toast));

  const pool = new ViewPool({
    window: mainWindow.window,
    maxLive: settings.maxLiveViews,
    onActivity: (accountId, reason) => accounts.onActivity(accountId, reason),
  });
  pool.on("state", (state) => ipc.send(IPC.evViewState, state));

  const collectors = createCollectorRegistry();

  const accounts = new AccountService({
    store,
    viewPool: pool,
    notify,
    fetchProfile: async (account) => {
      const collector = collectors.get(account.platformId);
      if (!collector) return null;
      const wc =
        pool.getWebContents(account.id) ??
        pool.ensure({ id: account.id, platformId: account.platformId }).view.webContents;
      return collector.fetchProfile({ webContents: wc, account });
    },
  });
  accounts.on("account-changed", (account) => ipc.send(IPC.evAccountChanged, account));
  accounts.on("accounts-reloaded", () => ipc.send(IPC.evAccountsReloaded, null));

  const scheduler = new CollectScheduler({
    store,
    pool,
    collectors,
    accounts,
    notify,
    onRun: (run) => ipc.send(IPC.evCollectRun, run),
    onMetrics: (accountId) => ipc.send(IPC.evMetricsUpdated, { accountId }),
  });
  accounts.on("account-online", (account) => {
    scheduler.enqueue(account.id, "login");
    void accounts.refreshProfile(account.id).catch(() => undefined);
  });

  const assetService = new AssetService(store, path.join(userDataPath, "thumbnails"));
  assetService.registerProtocol();
  const publishService = new PublishService({ store, pool, accounts, assets: assetService });

  registerAccountHandlers(ipc, accounts);
  registerViewHandlers(ipc, pool, accounts);
  registerSettingsHandlers(ipc, {
    store,
    pool,
    onSettingsChanged: (next) => scheduler.applySettings(next),
  });
  registerMetricsHandlers(ipc, { store, scheduler, accounts });
  registerAssetHandlers(ipc, assetService, mainWindow.window);
  registerPublishHandlers(ipc, publishService);
  registerBackupHandlers(ipc, { store, accounts, window: mainWindow.window, pool });

  runtime = { store, mainWindow, pool, accounts, ipc, scheduler };

  mainWindow.window.on("closed", () => {
    if (!quitting) app.quit();
  });

  await mainWindow.loadShell();
  accounts.startPatrol();
  scheduler.start();
}

app.on("second-instance", () => {
  const win = runtime?.mainWindow.window;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  try {
    await bootstrap();
  } catch (error) {
    console.error("Failed to start application", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BaseWindow.getAllWindows().length === 0 && ownsInstance) void bootstrap();
});

let flushed = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (flushed || !runtime) return;
  // Flush cookie stores before Chromium tears sessions down so a login made
  // seconds before quitting is on disk when the app starts again.
  event.preventDefault();
  flushed = true;
  const rt = runtime;
  void (async () => {
    try {
      rt.mainWindow.flushState();
      rt.scheduler.stop();
      rt.accounts.dispose();
      await Promise.race([rt.pool.flushAll(), new Promise((resolve) => setTimeout(resolve, 2_500))]);
      rt.pool.dispose();
      rt.ipc.dispose();
      rt.store.close();
    } finally {
      runtime = null;
      app.quit();
    }
  })();
});
