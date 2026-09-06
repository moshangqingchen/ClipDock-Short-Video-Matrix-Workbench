import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { WorkbenchApi } from "../shared/ipc";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const EVENT_CHANNELS = {
  "account-changed": IPC.evAccountChanged,
  "accounts-reloaded": IPC.evAccountsReloaded,
  "view-state": IPC.evViewState,
  "metrics-updated": IPC.evMetricsUpdated,
  "collect-run": IPC.evCollectRun,
  toast: IPC.evToast,
} as const;

const api: WorkbenchApi = {
  accounts: {
    list: () => invoke(IPC.accountList),
    create: (input) => invoke(IPC.accountCreate, input),
    update: (id, patch) => invoke(IPC.accountUpdate, id, patch),
    delete: (id) => invoke(IPC.accountDelete, id),
    reorder: (ids) => invoke(IPC.accountReorder, ids),
    resetEnvironment: (id) => invoke(IPC.accountResetEnvironment, id),
    checkStatus: (id) => invoke(IPC.accountCheckStatus, id),
    refreshProfile: (id) => invoke(IPC.accountRefreshProfile, id),
  },
  views: {
    show: (id, bounds) => invoke(IPC.viewShow, id, bounds),
    hide: (id) => invoke(IPC.viewHide, id),
    hideAll: () => invoke(IPC.viewHideAll),
    setBounds: (id, bounds) => invoke(IPC.viewSetBounds, id, bounds),
    navigate: (id, url) => invoke(IPC.viewNavigate, id, url),
    go: (id, route) => invoke(IPC.viewGo, id, route),
    reload: (id) => invoke(IPC.viewReload, id),
    back: (id) => invoke(IPC.viewBack, id),
    forward: (id) => invoke(IPC.viewForward, id),
    stop: (id) => invoke(IPC.viewStop, id),
    state: (id) => invoke(IPC.viewState, id),
    states: () => invoke(IPC.viewStates),
    openDevTools: (id) => invoke(IPC.viewOpenDevTools, id),
  },
  metrics: {
    account: (id, days) => invoke(IPC.metricsAccount, id, days),
    platform: (platformId, days) => invoke(IPC.metricsPlatform, platformId, days),
    overview: (days) => invoke(IPC.metricsOverview, days),
    collectNow: (id) => invoke(IPC.metricsCollectNow, id),
    runs: (id, limit) => invoke(IPC.metricsRuns, id, limit),
  },
  works: {
    list: (id, limit) => invoke(IPC.worksList, id, limit),
  },
  assets: {
    list: () => invoke(IPC.assetList),
    import: () => invoke(IPC.assetImport),
    remove: (id) => invoke(IPC.assetRemove, id),
    reveal: (id) => invoke(IPC.assetReveal, id),
    thumbnail: (id) => invoke(IPC.assetThumbnail, id),
  },
  publish: {
    list: (accountId) => invoke(IPC.publishList, accountId),
    save: (input) => invoke(IPC.publishSave, input),
    delete: (id) => invoke(IPC.publishDelete, id),
    openUpload: (accountId) => invoke(IPC.publishOpenUpload, accountId),
    attachFiles: (accountId, assetIds) => invoke(IPC.publishAttachFiles, accountId, assetIds),
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch),
  },
  audit: {
    list: (limit) => invoke(IPC.auditList, limit),
  },
  backup: {
    export: (options) => invoke(IPC.backupExport, options),
    import: (options) => invoke(IPC.backupImport, options),
  },
  app: {
    info: () => invoke(IPC.appInfo),
    openExternal: (url) => invoke(IPC.openExternal, url),
  },
  on(event: keyof typeof EVENT_CHANNELS, handler: (...args: any[]) => void) {
    const channel = EVENT_CHANNELS[event];
    const listener = (_e: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("workbench", api);
