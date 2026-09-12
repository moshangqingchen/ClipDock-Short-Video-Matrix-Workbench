import { migrateGlobalBrowserPreferences } from "./browser/global-browser-preferences";
import { GlobalWorkspaceService } from "./services/global-workspace-service";
import { registerGlobalWorkspaceHandlers } from "./ipc/handlers/global-workspace";
import { app, BaseWindow, powerMonitor, shell } from "electron";
import path from "node:path";
import { createHash } from "node:crypto";
import { IPC } from "@shared/ipc";
import { createStore, type Store } from "./db";
import { ViewPool } from "./browser/view-pool";
import { isHomepageContext } from "./browser/homepage-login";
import { AccountService } from "./services/account-service";
import { createMainWindow, type MainWindow } from "./window/main-window";
import { createWorkbenchTray, type WorkbenchTray } from "./window/tray";
import { createIpcRegistrar, type IpcRegistrar } from "./ipc/register";
import { registerAccountHandlers } from "./ipc/handlers/accounts";
import { registerGlobalAccountHandlers } from "./ipc/handlers/global-accounts";
import { GlobalAccountRepository } from "./api/global-account-repository";
import { GlobalWebService } from "./services/global-web-service";
import { GlobalWebObservationRepository } from "./data/global-web-observation-repository";
import { registerGlobalWebHandlers } from "./ipc/handlers/global-web";
import { GlobalAuthorizationStore } from "./api/global-authorization-store";
import { GlobalAppService } from "./api/global-app-service";
import { GlobalOAuthService } from "./api/global-oauth-service";
import { GlobalProxyRuntime } from "./api/global-proxy-runtime";
import { GlobalReadService } from "./api/global-read-service";
import { GlobalJobQueue } from "./api/global-job-queue";
import { GlobalUploadQueue } from "./api/global-upload-queue";
import { TikTokDraftAdapter } from "./api/tiktok-draft-adapter";
import { YouTubeUploadAdapter } from "./api/youtube-upload-adapter";
import { registerGlobalUploadHandlers } from "./ipc/handlers/global-uploads";
import { registerGlobalJobHandlers } from "./ipc/handlers/global-jobs";
import { GlobalReadAdapter } from "./api/global-read-adapter";
import { OAuthTokenRefresher } from "./api/oauth-refresh";
import { registerGlobalReadHandlers } from "./ipc/handlers/global-read";
import { OAuthCodeExchanger } from "./api/oauth-exchange";
import { registerGlobalOAuthHandlers } from "./ipc/handlers/global-oauth";
import { projectGlobalOAuthState } from "@shared/global-oauth";
import { registerGlobalAppHandlers } from "./ipc/handlers/global-apps";
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
import { CredentialVault } from "./security/credential-vault";
import { registerCredentialHandlers } from "./ipc/handlers/credentials";
import { registerNetworkHandlers } from "./ipc/handlers/network";
import { NetworkSettingsRepository } from "./network/settings";
import { NetworkObserver } from "./network/observer";
import { ClashReader } from "./network/clash-reader";
import { AnonymousDiagnostics } from "./network/diagnostics";
import {
  installSessionNetworkPolicy,
  setBlockedRequestSink,
  setNetworkObservationSink,
} from "./network/session-observer";
import { installBusinessNetwork } from "./network/business-access";
import { NetworkRuntime } from "./network/runtime";
import { configureAccountSession, flushAccountSessionCookies } from "./browser/account-session";
import { type ExclusiveAccessSnapshot, type NetworkSnapshot } from "@shared/network";
import { RequestAudit } from "./network/request-audit";
import { WindowsNetworkFingerprintWatcher } from "./network/windows-network-fingerprint";
import { WindowsProxyStateReader } from "./network/windows-proxy-state";
import { ExclusiveNetworkSwitch } from "./network/exclusive-switch";
import { DomesticDirectAccess } from "./network/domestic-direct-access";
import { DomesticRuleTransport } from "./network/domestic-rule-transport";
import { AccountEgressLocationService } from "./network/account-egress-location";
import { projectAccountEgressLocation } from "./network/account-egress-projection";
import { RemoteMediaService } from "./services/remote-media-service";
import { createDomesticMediaAuthorization, normalizeDomesticMediaSource } from "./services/domestic-media-authorization";
import { getConfiguredAccountSession } from "./browser/account-session";
import { clearLegacyMediaReferences, createMediaIntake } from "./services/media-intake";
import { createMediaProjection } from "./services/media-projection";
import { configureChromiumTransport } from "./network/chromium-transport";
import { GlobalEmbeddedBrowser } from "./browser/global-embedded-browser";
import { DockedChromeBrowser } from "./browser/docked-chrome-browser";

configureChromiumTransport(app);

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
  network: NetworkObserver;
  tray?: WorkbenchTray;
  disposeNetwork: () => Promise<void>;
}

let runtime: Runtime | null = null;
let quitting = false;

async function bootstrap(): Promise<void> {
  const store = createStore(path.join(userDataPath, "workbench.db"));
  await migrateGlobalBrowserPreferences(store.db, userDataPath);
  let windowsNetwork: WindowsNetworkFingerprintWatcher | null = null;
  let exclusiveSwitch: ExclusiveNetworkSwitch | null = null;
  let domesticAccess: DomesticDirectAccess | null = null;
  const initialSwitch: ExclusiveAccessSnapshot = {
    state: "checking",
    proxy: "unknown",
    reason: "CHECKING",
    generation: 1,
    checkedAt: null,
    expiresAt: null,
  };
  // Domestic sessions use the normal direct path when the proxy is off, or a
  // verified DIRECT relay in rule mode. Overseas keeps its own source.
  const networkRuntime: NetworkRuntime = new NetworkRuntime({
    enforcement: "strict",
    exclusiveAccess: {
      read: () => domesticAccess?.read() ?? { ...initialSwitch },
      acquire: () => domesticAccess?.acquire() ?? null,
    },
    ruleSplitTransport: {
      configureSession: async (entry) => {
        if (!domesticAccess) throw new Error("DOMESTIC_TRANSPORT_NOT_READY");
        await domesticAccess.configureSession(entry);
      },
      allowUrl: (platformId, url) => domesticAccess?.allowUrl(platformId, url) === true,
      releaseSession: (accountId) => domesticAccess?.releaseSession(accountId),
    },
    networkReadiness: () => windowsNetwork?.getSnapshot().available === true,
    audit: ({ type, accountId, reason }) =>
      store.audit.append({
        action: "network.session",
        accountId,
        details: { type, reason },
      }),
  });
  const disposeBusinessNetwork = installBusinessNetwork(networkRuntime);
  clearLegacyMediaReferences(store);
  const disposeSessionPolicy = installSessionNetworkPolicy(networkRuntime);
  const requestAudit = new RequestAudit(({ accountId, ...details }) =>
    store.audit.append({
      action: "network.blocked-request",
      accountId,
      details,
    }),
  );
  setBlockedRequestSink((request) => requestAudit.record(request));
  const settings = store.settings.get();

  const mainWindow = createMainWindow(userDataPath);
  const embeddedGlobalBrowser = new GlobalEmbeddedBrowser(mainWindow.window);
  const dockedChromeBrowser = new DockedChromeBrowser(mainWindow.window, userDataPath, true);
  const ipc = createIpcRegistrar(() =>
    mainWindow.shell.webContents.isDestroyed() ? null : mainWindow.shell.webContents,
  );
  const notify = createNotifier((toast) => ipc.send(IPC.evToast, toast));
  const remoteMedia: Pick<
    RemoteMediaService,
    "offer" | "preview" | "responseFor" | "forgetAccount" | "suspendAccount" | "resumeAccount" | "dispose"
  > = (() => {
    try {
      return new RemoteMediaService({
        cacheDir: path.join(userDataPath, "remote-media"),
        authorize: createDomesticMediaAuthorization({
          exclusiveMode: () => true,
          getAccount: (id) => store.accounts.get(id),
          getWork: (id) => store.db.get(
            "SELECT id, account_id AS accountId, platform_id AS platformId FROM works WHERE id = ?", [id],
          ),
          getSession: getConfiguredAccountSession,
          network: networkRuntime,
        }),
        onChanged: (subject) => {
          const account = store.accounts.get(subject.accountId);
          if (!account || quitting) return;
          if (subject.kind === "avatar") ipc.send(IPC.evAccountChanged, media.projectAccount(account));
          else ipc.send(IPC.evMetricsUpdated, { accountId: subject.accountId });
        },
      });
    } catch {
      // Optional cache failure leaves local placeholders; it neither prevents startup nor enables HTTP.
      return {
        offer: () => undefined,
        preview: () => ({ url: null, state: "unavailable" }),
        responseFor: async () => new Response(null, { status: 404 }),
        forgetAccount: async () => undefined,
        suspendAccount: () => undefined,
        resumeAccount: () => undefined,
        dispose: async () => undefined,
      };
    }
  })();
  const media = createMediaProjection({
    enforcement: networkRuntime.enforcement,
    preview: (subject) => remoteMedia.preview(subject),
  });
  const mediaIntake = createMediaIntake({
    offer(subject, input) {
      const account = store.accounts.get(subject.accountId);
      if (!account) return;
      const sourceUrl = normalizeDomesticMediaSource(account.platformId, input.sourceUrl);
      if (sourceUrl) remoteMedia.offer(subject, { ...input, sourceUrl });
    },
  });
  const vault = new CredentialVault(store.db);
  const networkSettings = new NetworkSettingsRepository(store.db);
  const network = new NetworkObserver({
    accounts: () => store.accounts.list(),
    settings: () => networkSettings.get(),
    reader: (config) =>
      new ClashReader({
        controllerUrl: config.controllerUrl,
        getSecret: () => vault.get({ kind: "clash_secret", ownerId: "default" }),
      }),
    diagnostics: new AnonymousDiagnostics(),
    audit: (action, details) => store.audit.append({ action, details }),
  });
  const proxyState = new WindowsProxyStateReader();
  exclusiveSwitch = new ExclusiveNetworkSwitch({
    readNetwork: () => windowsNetwork?.getSnapshot() ?? { available: false, hash: null },
    readProxy: (signal) => {
      const snapshot = network.snapshot();
      const age = snapshot.checkedAt ? Date.now() - Date.parse(snapshot.checkedAt) : Infinity;
      // A closed controller is normal when the proxy is off. In that case inspect
      // Windows settings and active tunnel interfaces instead of requiring Clash.
      const controllerFresh =
        snapshot.controller.readable && Number.isFinite(age) && age >= 0 && age < 15_000;
      return proxyState.read(controllerFresh ? { mihomoTun: snapshot.controller.tun === true } : {}, signal);
    },
    whenIdle: async () => {
      await proxyState.whenIdle();
    },
  });
  const proxyOptions = {
    configuration: () => {
      const config = networkSettings.get();
      const credential = store.db.get(
        "SELECT id, ciphertext, encryption_version, updated_at FROM credentials WHERE kind = 'clash_secret' AND owner_id = 'default'",
      );
      return {
        controllerUrl: config.controllerUrl,
        proxyPort: config.diagnosticProxyPort,
        credentialRevision: createHash("sha256")
          .update(JSON.stringify(credential ?? null))
          .digest("hex"),
      };
    },
    readSwitch: () => exclusiveSwitch?.read() ?? { ...initialSwitch },
    readNetwork: () => windowsNetwork?.getSnapshot() ?? { available: false, hash: null },
    getSecret: () => vault.get({ kind: "clash_secret", ownerId: "default" }),
  };
  const globalProxy = new GlobalProxyRuntime(proxyOptions);
  const domesticProxy = new DomesticRuleTransport(proxyOptions);
  domesticAccess = new DomesticDirectAccess({
    source: domesticProxy,
    readSwitch: proxyOptions.readSwitch,
    acquireOff: () => exclusiveSwitch?.acquire() ?? null,
    readController: () => network.snapshot().controller,
  });
  let locationChanged = () => {};
  const accountLocation = new AccountEgressLocationService({
    readContext: () => {
      const switching = domesticAccess?.read();
      const fingerprint = windowsNetwork?.getSnapshot();
      if (!switching || !fingerprint?.available || !fingerprint.hash) return null;
      const mode = switching.state === "domestic" && switching.proxy === "off" ? "direct"
        : switching.state === "dual" && switching.proxy === "on" ? "rule" : null;
      if (!mode) return null;
      const observed = network.snapshot();
      if (mode === "rule" && (!observed.controller.readable || !observed.rulesVersion)) return null;
      return {
        ...proxyOptions.configuration(),
        mode,
        generation: switching.generation,
        networkHash: fingerprint.hash,
        controllerFingerprint: observed.controller.readable ? observed.rulesVersion : null,
      };
    },
    getSecret: proxyOptions.getSecret,
    onChanged: () => locationChanged(),
  });
  const globalWebAccounts = new GlobalAccountRepository(store.db);
  const globalWeb = new GlobalWebService(
    {
      observations: new GlobalWebObservationRepository(store.db),
      dataDirectory: userDataPath,
      transport: "system",
      getAccount: (id) => globalWebAccounts.get(id),
      setBrowserEngine: (id, engine) => globalWebAccounts.setBrowserEngine(id, engine),
      acquireEligibility: async (_platformId, signal) => {
        if (signal.aborted) return null;
        const lease = exclusiveSwitch?.acquire("overseas");
        if (!lease) return null;
        return { ...lease, generation: exclusiveSwitch!.read().generation };
      },
      openTunnel: (input) => globalProxy.openWebTunnel(input),
      onChanged: (state) => ipc.send(IPC.evGlobalWebChanged, state),
      wipeEmbedded: (id) => embeddedGlobalBrowser.wipe(id),
    },
    {
      launch: (input) => embeddedGlobalBrowser.launch(input),
      launchChrome: (input) => dockedChromeBrowser.launch(input),
    },
  );
  const globalWorkspace = new GlobalWorkspaceService({
    store,
    accounts: globalWebAccounts,
    web: globalWeb,
    openExternal: (url) => shell.openExternal(url),
    changed: (id) => ipc.send("global-workspace:changed", id),
  });
  registerGlobalWebHandlers(ipc, globalWeb, (id) => globalWorkspace.cancelAccount(id));
  registerGlobalWorkspaceHandlers(ipc, globalWorkspace);
  const globalExchanger = new OAuthCodeExchanger({
    transport: globalProxy,
    readClientSecret: (config) => vault.get({ kind: "oauth_client_secret", ownerId: config.id }),
  });
  const globalOAuth = new GlobalOAuthService({
    db: store.db,
    acquireEligibility: (platformId, signal) => globalProxy.acquireEligibility(platformId, signal),
    exchangeCode: (input, config) => globalExchanger.exchange(input, config),
    openAuthorizationUrl: (url) => shell.openExternal(url),
    onChanged: (value) => {
      const state = projectGlobalOAuthState(value);
      if (state) ipc.send(IPC.evGlobalOAuthState, state);
    },
  });
  const globalReader = new GlobalReadAdapter({ transport: globalProxy });
  const globalRefresher = new OAuthTokenRefresher({
    transport: globalProxy,
    readClientSecret: (config) => vault.get({ kind: "oauth_client_secret", ownerId: config.id }),
  });
  const globalReads = new GlobalReadService({
    db: store.db,
    acquireEligibility: (platformId, signal) => globalProxy.acquireEligibility(platformId, signal),
    read: (input) => globalReader.read(input),
    refreshToken: (input) => globalRefresher.refresh(input),
  });
  const globalJobs = new GlobalJobQueue({
    db: store.db,
    reads: globalReads,
    canAttempt: () => {
      const state = exclusiveSwitch?.read();
      return state?.state === "overseas" && state.proxy === "on";
    },
    onChanged: (job) => ipc.send(IPC.evGlobalJobChanged, job),
  });
  let networkSequence = 0;
  const globalUploads = new GlobalUploadQueue({
    db: store.db,
    adapter: new TikTokDraftAdapter(globalProxy),
    youtube: new YouTubeUploadAdapter(globalProxy),
    acquireEligibility: (platformId, signal) => globalProxy.acquireEligibility(platformId, signal),
    refreshToken: (input) => globalRefresher.refresh(input),
    canAttempt: () => {
      const state = exclusiveSwitch?.read();
      return state?.state === "overseas" && state.proxy === "on";
    },
    whenTransportIdle: () => globalProxy.whenIdle(),
    onChanged: (job) => ipc.send(IPC.evGlobalUploadChanged, job),
  });
  const projectNetwork = (snapshot: NetworkSnapshot): NetworkSnapshot => {
    const switching = domesticAccess?.read() ?? { ...initialSwitch };
    const location = accountLocation.read();
    return {
      ...snapshot,
      sequence: ++networkSequence,
      enforcement: "strict",
      policy: "rule-split",
      switching,
      state: switching.state,
      reason: switching.reason,
      checkedAt: switching.checkedAt,
      direct: snapshot.direct,
      accounts: networkRuntime.getAccountStates().map((account) => projectAccountEgressLocation(
        account, switching, location, domesticProxy.readAccountRoute(account.accountId) !== null,
      )),
    };
  };
  locationChanged = () => ipc.send(IPC.evNetworkState, projectNetwork(network.snapshot()));
  let lastSwitchAudit = "";
  domesticAccess.on("state", (state: ExclusiveAccessSnapshot) => {
    networkRuntime.syncExclusiveAccess();
    accountLocation.sync();
    const key = `${state.state}:${state.proxy}:${state.reason}:${state.generation}`;
    if (key !== lastSwitchAudit) {
      lastSwitchAudit = key;
      store.audit.append({
        action: "network.switch",
        details: {
          state: state.state,
          proxy: state.proxy,
          reason: state.reason,
          generation: state.generation,
        },
      });
    }
    ipc.send(IPC.evNetworkState, projectNetwork(network.snapshot()));
  });
  exclusiveSwitch.on("state", (state: ExclusiveAccessSnapshot) => {
    globalProxy.sync();
    if (state.state !== "overseas" || state.proxy !== "on") globalWeb.invalidate();
    globalJobs.sync();
    globalUploads.sync();
    domesticAccess?.sync();
  });
  network.on("snapshot", (snapshot: NetworkSnapshot) => {
    globalProxy.observeController(snapshot.controller.readable ? snapshot.rulesVersion : null);
    domesticProxy.observeController(snapshot.controller.readable ? snapshot.rulesVersion : null);
    if (snapshot.controller.readable && snapshot.controller.tun === true && snapshot.checkedAt)
      exclusiveSwitch?.observeProxyEnabled(Date.now() - Date.parse(snapshot.checkedAt));
    domesticAccess?.sync();
    networkRuntime.onObservation(snapshot);
    ipc.send(IPC.evNetworkState, projectNetwork(snapshot));
  });
  setNetworkObservationSink((platformId, host) => network.record(platformId, host));
  const invalidateNetwork = () => {
    globalOAuth.invalidate();
    globalJobs.invalidateNetwork();
    globalUploads.invalidateNetwork();
    globalProxy.invalidate();
    globalWeb.invalidate();
    exclusiveSwitch?.networkChanged();
    network.invalidate();
    domesticAccess?.invalidate();
    accountLocation.sync();
  };
  windowsNetwork = new WindowsNetworkFingerprintWatcher({ onChange: invalidateNetwork });
  const suspendNetwork = () => {
    globalOAuth.invalidate();
    globalJobs.stop();
    globalUploads.stop();
    globalProxy.invalidate();
    globalWeb.invalidate();
    exclusiveSwitch?.stop();
    network.invalidate();
    domesticAccess?.stop();
    accountLocation.sync();
    windowsNetwork?.stop();
  };
  const resumeNetwork = () => {
    windowsNetwork?.start();
    exclusiveSwitch?.start();
    network.invalidate();
    domesticAccess?.start();
    globalJobs.start();
    globalWorkspace.start();
    globalUploads.start();
  };
  powerMonitor.on("suspend", suspendNetwork);
  powerMonitor.on("resume", resumeNetwork);

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
    mediaIntake,
    onSessionChange: async (accountId, kind) => {
      const retired =
        kind === "reset" ? networkRuntime.resetAccount(accountId) : networkRuntime.removeAccount(accountId);
      scheduler.suspendForAccountChange(accountId);
      const closed = pool.suspendNetworkAccount(accountId);
      await Promise.all([retired, closed, remoteMedia.forgetAccount(accountId)]);
    },
    fetchProfile: async (account) => {
      const collector = collectors.get(account.platformId);
      if (!collector) return null;
      const wc =
        pool.getWebContents(account.id) ??
        pool.ensure({ id: account.id, platformId: account.platformId }).view.webContents;
      return collector.fetchProfile({ webContents: wc, account, identityProfile: pool.getIdentityEvidence(account.id)?.profile });
    },
  });
  accounts.on("account-changed", (account) => {
    configureAccountSession(account.id, account.platformId);
    ipc.send(IPC.evAccountChanged, media.projectAccount(account));
  });
  accounts.on("accounts-reloaded", () => {
    for (const account of accounts.list()) {
      const version = accounts.sessionChangeVersion(account.id);
      void configureAccountSession(account.id, account.platformId)
        .ready.then(() => {
          if (!accounts.finishSessionChange(account.id, version)) return;
          scheduler.resumeNetworkAccount(account.id);
        })
        .catch(() => undefined);
    }
    ipc.send(IPC.evAccountsReloaded, null);
  });

  const scheduler = new CollectScheduler({
    store,
    pool,
    collectors,
    accounts,
    notify,
    onRun: (run) => ipc.send(IPC.evCollectRun, run),
    onMetrics: (accountId) => ipc.send(IPC.evMetricsUpdated, { accountId }),
    mediaIntake,
    needsMediaRefresh: (accountId) => {
      if (remoteMedia.preview({ accountId, kind: "avatar" }).state === "unavailable") return true;
      return store.metrics.listWorks(accountId, 100).some((work) =>
        remoteMedia.preview({ accountId, kind: "cover", workId: work.id }).state === "unavailable",
      );
    },
  });
  networkRuntime.setSuspendHandler(async (accountId) => {
    let failed = false;
    try {
      remoteMedia.suspendAccount(accountId);
    } catch {
      failed = true;
    }
    try {
      accounts.suspendNetworkAccount(accountId);
    } catch {
      failed = true;
    }
    try {
      scheduler.suspendNetworkAccount(accountId);
    } catch {
      failed = true;
    }
    try {
      await pool.suspendNetworkAccount(accountId);
    } catch {
      failed = true;
    }
    if (failed) throw new Error("ACCOUNT_NETWORK_SUSPENSION_FAILED");
  });
  networkRuntime.on("state", () => {
    if (networkRuntime.enforcement !== "strict") return;
    for (const state of networkRuntime.getAccountStates()) {
      if (state.state === "allowed") {
        scheduler.resumeNetworkAccount(state.accountId);
        const account = store.accounts.get(state.accountId);
        if (account?.status === "online" || account?.status === "expiring")
          remoteMedia.resumeAccount(state.accountId);
      }
    }
    ipc.send(IPC.evNetworkState, projectNetwork(network.snapshot()));
  });
  // Register every account, including accounts without a view, before startup patrol or queue work.
  await Promise.all(
    accounts.list().map((account) => configureAccountSession(account.id, account.platformId).ready),
  );
  accounts.on("account-online", (account) => {
    // A public-site login is sufficient on its own. Do not start creator-console
    // work or request its network scope as a side effect of that confirmation.
    if (isHomepageContext(account.platformId, pool.getState(account.id)?.url ?? "")) return;
    scheduler.resumeNetworkAccount(account.id);
    scheduler.enqueue(account.id, "login");
    void accounts.refreshProfile(account.id).catch(() => undefined);
  });

  const assetService = new AssetService(store, path.join(userDataPath, "thumbnails"));
  assetService.registerProtocol(remoteMedia);
  const publishService = new PublishService({ store, pool, accounts, assets: assetService });

  registerAccountHandlers(ipc, accounts, media);
  registerGlobalAccountHandlers(
    ipc,
    new GlobalAccountRepository(store.db),
    new GlobalAuthorizationStore(store.db),
    (id) => {
      globalOAuth.invalidateAccount(id);
      globalJobs.invalidateAccount(id);
      globalUploads.invalidateAccount(id);
    },
    (id) => globalWeb.beforeDelete(id),
  );
  registerGlobalAppHandlers(ipc, new GlobalAppService(store.db), (platformId) => {
    globalOAuth.invalidatePlatform(platformId);
    globalJobs.invalidatePlatform(platformId);
    globalUploads.invalidatePlatform(platformId);
  });
  registerGlobalOAuthHandlers(ipc, {
    state: (id) => globalOAuth.state(id),
    start: (id) => {
      globalJobs.invalidateAccount(id);
      globalUploads.invalidateAccount(id);
      return globalOAuth.start(id);
    },
    startDraft: (id) => {
      globalJobs.invalidateAccount(id);
      globalUploads.invalidateAccount(id);
      return globalOAuth.startDraft(id);
    },
    startUpload: (id) => {
      globalJobs.invalidateAccount(id);
      globalUploads.invalidateAccount(id);
      return globalOAuth.startUpload(id);
    },
    cancel: (id) => globalOAuth.cancel(id),
  });
  registerGlobalReadHandlers(ipc, globalReads);
  registerGlobalJobHandlers(ipc, globalJobs);
  registerGlobalUploadHandlers(ipc, globalUploads);
  registerNetworkHandlers(
    ipc,
    network,
    networkSettings,
    projectNetwork,
    () => {
      invalidateNetwork();
    },
    async () => {
      await exclusiveSwitch?.refresh();
    },
  );
  registerCredentialHandlers(ipc, vault, () => {
    invalidateNetwork();
  });
  registerViewHandlers(ipc, pool, accounts);
  registerSettingsHandlers(ipc, {
    store,
    pool,
    onSettingsChanged: (next) => scheduler.applySettings(next),
  });
  registerMetricsHandlers(ipc, { store, scheduler, accounts, media });
  registerAssetHandlers(ipc, assetService, mainWindow.window);
  registerPublishHandlers(ipc, publishService);
  registerBackupHandlers(ipc, {
    store,
    accounts,
    window: mainWindow.window,
    pool,
    validateAccountIdentities: (rows) => networkRuntime.assertAccountIdentities(rows),
    beforeGlobalRestore: async () => {
      globalWorkspace.stop();
      globalJobs.stop();
      globalOAuth.invalidate();
      globalUploads.stop();
      for (const account of globalWebAccounts.list()) await globalWeb.close(account.id);
    },
    afterGlobalRestore: () => {
      globalWorkspace.start();
      globalJobs.start();
      globalUploads.start();
      for (const account of globalWebAccounts.list()) ipc.send("global-workspace:changed", account.id);
    },
  });

  const bootRuntime: Runtime = {
    store,
    mainWindow,
    pool,
    accounts,
    ipc,
    scheduler,
    network,
    disposeNetwork: async () => {
      globalOAuth.invalidate();
      globalJobs.stop();
      globalWorkspace.stop();
      globalUploads.stop();
      globalProxy.invalidate();
      exclusiveSwitch?.stop();
      domesticAccess?.stop();
      windowsNetwork?.stop();
      powerMonitor.removeListener("suspend", suspendNetwork);
      powerMonitor.removeListener("resume", resumeNetwork);
      setNetworkObservationSink(() => undefined);
      setBlockedRequestSink(() => undefined);
      const globalCleanup = await Promise.allSettled([
        accountLocation.dispose(),
        globalWeb.dispose(),
        globalOAuth.dispose(),
        globalJobs.dispose(),
        globalUploads.dispose(),
        globalReads.dispose(),
        globalProxy.dispose(),
      ]);
      // A failing stage must not strand another session, native reader or cache.
      // Keep the dependency order: stop account traffic before retiring relays.
      const cleanup = [...globalCleanup];
      for (const dispose of [
        () => exclusiveSwitch?.dispose(),
        () => proxyState.dispose(),
        () => networkRuntime.dispose(),
        () => domesticAccess?.dispose(),
        () => remoteMedia.dispose(),
        () => disposeSessionPolicy(),
        () => disposeBusinessNetwork(),
      ]) cleanup.push(...await Promise.allSettled([Promise.resolve().then(dispose)]));
      if (cleanup.some((result) => result.status === "rejected"))
        throw new Error("NETWORK_CLEANUP_FAILED");
    },
  };
  runtime = bootRuntime;

  if (process.platform === "win32") {
    try {
      bootRuntime.tray = createWorkbenchTray(mainWindow.window, {
        isQuitting: () => quitting,
        quit: () => app.quit(),
      });
    } catch {
      // If Windows cannot create a tray icon, keep normal close-to-exit behavior
      // instead of hiding the only window with no way to bring it back.
      console.error("System tray unavailable; closing the window will exit");
    }
  }

  mainWindow.window.on("closed", () => {
    if (!quitting) app.quit();
  });

  await mainWindow.loadShell();
  // Loading may finish after before-quit has stopped/disposed this bootstrap instance.
  if (quitting || runtime !== bootRuntime || mainWindow.window.isDestroyed()) return;
  windowsNetwork.start();
  network.start();
  exclusiveSwitch.start();
  domesticAccess.start();
  globalJobs.start();
  globalWorkspace.start();
  globalUploads.start();
  accounts.startPatrol();
  scheduler.start();
  accountLocation.start();
}

app.on("second-instance", () => {
  if (quitting) return;
  if (runtime?.tray) {
    runtime.tray.show();
    return;
  }
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
  if (!quitting && runtime?.tray) {
    runtime.tray.show();
    return;
  }
  if (!quitting && BaseWindow.getAllWindows().length === 0 && ownsInstance) void bootstrap();
});

let shutdownStarted = false;
let shutdownComplete = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownComplete || !runtime) return;
  // Flush cookie stores before Chromium tears sessions down so a login made
  // seconds before quitting is on disk when the app starts again.
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  const rt = runtime;
  void (async () => {
    try {
      // Each stage must run even if a native close fails. In particular, network
      // cleanup failure must not skip login persistence or closing the database.
      const steps: Array<[string, () => void | Promise<unknown>]> = [
        ["window state", () => rt.mainWindow.flushState()],
        ["system tray", () => rt.tray?.dispose()],
        ["network observer", () => rt.network.stop()],
        ["scheduler", () => rt.scheduler.stop()],
        ["account tasks", () => rt.accounts.dispose()],
        ["network sessions", () => rt.disposeNetwork()],
        [
          "account cookies",
          () =>
            Promise.race([
              flushAccountSessionCookies(),
              new Promise((resolve) => setTimeout(resolve, 2_500)),
            ]),
        ],
        ["account views", () => rt.pool.dispose()],
        ["IPC", () => rt.ipc.dispose()],
        ["database", () => rt.store.close()],
      ];
      for (const [name, close] of steps) {
        try {
          await close();
        } catch {
          // Native errors can include account URLs; log only the failed stage.
          console.error(`Application shutdown step failed: ${name}`);
        }
      }
    } finally {
      runtime = null;
      shutdownComplete = true;
      app.quit();
    }
  })().catch(() => {
    console.error("Final application shutdown failed");
  });
});
