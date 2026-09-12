import { z } from "zod";
import { globalAccountIdSchema } from "../shared/global-accounts";
import {
  webIdentitySchema,
  globalWorkSchema,
  webCollectJobSchema,
  globalPublishRecordSchema,
  GLOBAL_WORKSPACE_CHANNEL,
} from "../shared/global-workspace";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { WorkbenchApi } from "../shared/ipc";
import { globalOAuthErrorCode, projectGlobalOAuthState } from "../shared/global-oauth";
import { globalReadErrorCode, globalReadSnapshotSchema } from "../shared/global-read";
import { globalJobSchema, globalJobsSchema } from "../shared/global-jobs";
import { globalWebErrorCode, globalWebStateSchema } from "../shared/global-web";
import {
  webObservationSchema,
  webObservationHistorySchema,
  webObserveErrorCode,
} from "../shared/global-web-observation";
import {
  globalUploadJobSchema,
  globalUploadJobsSchema,
  globalUploadErrorCode,
  globalUploadSubmitSchema,
} from "../shared/global-uploads";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

async function invokeWeb(channel: string, accountId: string) {
  try {
    const state = globalWebStateSchema.parse(await invoke(channel, accountId));
    if (state.accountId !== accountId) throw new Error("GLOBAL_WEB_UNAVAILABLE");
    return state;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Never expose native browser paths or private causes.
    throw new Error(globalWebErrorCode(error));
  }
}

async function invokeRead(channel: string, accountId: string) {
  try {
    const raw = await invoke(channel, accountId);
    if (channel === IPC.globalReadGet && raw === null) return null;
    const result = globalReadSnapshotSchema.safeParse(raw);
    if (!result.success || result.data.accountId !== accountId) throw new Error("GLOBAL_READ_UNAVAILABLE");
    return result.data;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Never relay private causes or responses to the renderer.
    throw new Error(globalReadErrorCode(error));
  }
}

async function invokeOAuth(channel: string, accountId: string) {
  try {
    const state = projectGlobalOAuthState(await invoke(channel, accountId));
    if (!state || state.accountId !== accountId) throw new Error("GLOBAL_OAUTH_UNAVAILABLE");
    return state;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- The renderer must not receive private error causes from main.
    throw new Error(globalOAuthErrorCode(error));
  }
}

async function invokeJob(channel: string, id: string) {
  try {
    const raw = await invoke(channel, id);
    if (channel === IPC.globalJobsCancel && raw === null) return null;
    const result = globalJobSchema.safeParse(raw);
    if (!result.success || (channel === IPC.globalJobsCancel ? result.data.id : result.data.accountId) !== id)
      throw new Error("GLOBAL_READ_UNAVAILABLE");
    return result.data;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Private main data must stay behind the bridge.
    throw new Error(globalReadErrorCode(error));
  }
}

const EVENT_CHANNELS = {
  "account-changed": IPC.evAccountChanged,
  "accounts-reloaded": IPC.evAccountsReloaded,
  "view-state": IPC.evViewState,
  "metrics-updated": IPC.evMetricsUpdated,
  "collect-run": IPC.evCollectRun,
  "collect-job": IPC.evCollectJob,
  toast: IPC.evToast,
  "network-state": IPC.evNetworkState,
} as const;

async function invokeUpload(channel: string, id: string, payload: unknown = id) {
  try {
    const raw = await invoke(channel, payload);
    if (channel === IPC.globalUploadsCancel && raw === null) return null;
    const parsed = globalUploadJobSchema.safeParse(raw);
    if (
      !parsed.success ||
      (channel === IPC.globalUploadsSubmit ? parsed.data.accountId : parsed.data.id) !== id
    )
      throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
    return parsed.data;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Upload secrets and private errors remain in main.
    throw new Error(globalUploadErrorCode(error));
  }
}

function scopedRows<T extends { accountId: string }>(rows: T[], id?: string): T[] {
  if (id && rows.some((row) => row.accountId !== id)) throw new Error("国外账号数据不匹配");
  return rows;
}
const api: WorkbenchApi = {
  globalWorkspace: {
    openLoginWindow: (id) => ipcRenderer.invoke(GLOBAL_WORKSPACE_CHANNEL + "openLoginWindow", id),
    identity: async (id) =>
      webIdentitySchema.nullable().parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "identity", id)),
    checkLogin: async (id) =>
      webIdentitySchema.parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "checkLogin", id)),
    resetEnvironment: (id) => invoke(GLOBAL_WORKSPACE_CHANNEL + "resetEnvironment", id),
    openDevTools: (id) => invoke(GLOBAL_WORKSPACE_CHANNEL + "openDevTools", id),
    openSystemBrowser: (id) => invoke(GLOBAL_WORKSPACE_CHANNEL + "openSystemBrowser", id),
    works: async (id) =>
      scopedRows(
        z
          .array(globalWorkSchema)
          .max(30)
          .parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "works", id)),
        id,
      ),
    collect: async (id) =>
      scopedRows([webCollectJobSchema.parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "collect", id))], id)[0],
    jobs: async (id) =>
      scopedRows(
        z
          .array(webCollectJobSchema)
          .max(200)
          .parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "jobs", id)),
        id,
      ),
    cancelJob: (id) => invoke(GLOBAL_WORKSPACE_CHANNEL + "cancelJob", id),
    publishList: async (id) =>
      scopedRows(
        z
          .array(globalPublishRecordSchema)
          .max(100000)
          .parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "publishList", id)),
        id,
      ),
    publishDelete: (id) => invoke(GLOBAL_WORKSPACE_CHANNEL + "publishDelete", id),
    openUpload: (id) => invoke(GLOBAL_WORKSPACE_CHANNEL + "openUpload", id),
    publishSave: async (input) =>
      scopedRows(
        [globalPublishRecordSchema.parse(await invoke(GLOBAL_WORKSPACE_CHANNEL + "publishSave", input))],
        input.accountId,
      )[0],
    attachFiles: (id, assetIds) => invoke(GLOBAL_WORKSPACE_CHANNEL + "attachFiles", { id, assetIds }),
    openWork: (id, remoteId) => invoke(GLOBAL_WORKSPACE_CHANNEL + "openWork", { id, remoteId }),
    useBrowser: (id, engine) => invoke(GLOBAL_WORKSPACE_CHANNEL + "useBrowser", { id, engine }),
    onChanged: (listener) => {
      const handler = (_event: IpcRendererEvent, id: unknown) => {
        if (globalAccountIdSchema.safeParse(id).success) listener(id as string);
      };
      ipcRenderer.on(GLOBAL_WORKSPACE_CHANNEL + "changed", handler);
      return () => ipcRenderer.removeListener(GLOBAL_WORKSPACE_CHANNEL + "changed", handler);
    },
  },
  globalWeb: {
    observationHistory: async (id) => {
      try {
        const values = webObservationHistorySchema.parse(await invoke(IPC.globalWebObservationHistory, id));
        if (values.some((value) => value.accountId !== id)) throw new Error("WEB_OBSERVE_UNAVAILABLE");
        return values;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Only fixed errors cross the bridge.
        throw new Error(webObserveErrorCode(error));
      }
    },
    observation: async (id) => {
      try {
        const raw = await invoke(IPC.globalWebObservation, id);
        if (raw === null) return null;
        const value = webObservationSchema.parse(raw);
        if (value.accountId !== id) throw new Error("WEB_OBSERVE_UNAVAILABLE");
        return value;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Public error codes only.
        throw new Error(webObserveErrorCode(error));
      }
    },
    readPage: async (id) => {
      try {
        const value = webObservationSchema.parse(await invoke(IPC.globalWebReadPage, id));
        if (value.accountId !== id) throw new Error("WEB_OBSERVE_UNAVAILABLE");
        return value;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Public error codes only.
        throw new Error(webObserveErrorCode(error));
      }
    },
    state: (id) => invokeWeb(IPC.globalWebState, id),
    open: (id) => invokeWeb(IPC.globalWebOpen, id),
    openChrome: (id) => invokeWeb(IPC.globalWebOpenChrome, id),
    openExternal: (id) => invokeWeb(IPC.globalWebOpenExternal, id),
    close: (id) => invokeWeb(IPC.globalWebClose, id),
    show: (id, bounds) => invoke(IPC.globalWebShow, id, bounds),
    hide: (id) => invoke(IPC.globalWebHide, id),
    go: (id, capability) => invoke(IPC.globalWebGo, id, capability),
    command: (id, command) => invoke(IPC.globalWebCommand, id, command),
    onChanged(listener) {
      const handler = (_event: IpcRendererEvent, raw: unknown) => {
        const parsed = globalWebStateSchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC.evGlobalWebChanged, handler);
      return () => ipcRenderer.removeListener(IPC.evGlobalWebChanged, handler);
    },
  },
  globalUploads: {
    submit: async (input) => {
      const parsed = globalUploadSubmitSchema.safeParse(input);
      if (!parsed.success) throw new Error("GLOBAL_UPLOAD_INVALID");
      const job = await invokeUpload(IPC.globalUploadsSubmit, parsed.data.accountId, parsed.data);
      if (
        !job ||
        job.assetId !== parsed.data.assetId ||
        JSON.stringify(job.youtube ?? null) !== JSON.stringify(parsed.data.youtube ?? null)
      )
        throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
      return job;
    },
    cancel: (id) => invokeUpload(IPC.globalUploadsCancel, id),
    check: async (id) => {
      const job = await invokeUpload(IPC.globalUploadsCheck, id);
      if (!job) throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
      return job;
    },
    list: async (id) => {
      try {
        const parsed = globalUploadJobsSchema.safeParse(await invoke(IPC.globalUploadsList, id));
        if (!parsed.success || parsed.data.some((job) => job.accountId !== id))
          throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
        return parsed.data;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Return only known public error codes.
        throw new Error(globalUploadErrorCode(error));
      }
    },
    onChanged: (handler) => {
      let active = true;
      const listener = (_event: IpcRendererEvent, raw: unknown) => {
        const parsed = globalUploadJobSchema.safeParse(raw);
        if (active && parsed.success) handler(parsed.data);
      };
      ipcRenderer.on(IPC.evGlobalUploadChanged, listener);
      return () => {
        active = false;
        ipcRenderer.removeListener(IPC.evGlobalUploadChanged, listener);
      };
    },
  },
  globalRead: {
    get: (id) => invokeRead(IPC.globalReadGet, id),
  },
  globalJobs: {
    submit: async (id) => {
      const result = await invokeJob(IPC.globalJobsSubmit, id);
      if (!result) throw new Error("GLOBAL_READ_UNAVAILABLE");
      return result;
    },
    cancel: (id) => invokeJob(IPC.globalJobsCancel, id),
    list: async (id) => {
      try {
        const result = globalJobsSchema.safeParse(await invoke(IPC.globalJobsList, id));
        if (!result.success || result.data.some((job) => job.accountId !== id))
          throw new Error("GLOBAL_READ_UNAVAILABLE");
        return result.data;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Only fixed public errors cross the bridge.
        throw new Error(globalReadErrorCode(error));
      }
    },
    onChanged: (handler) => {
      let active = true;
      const listener = (_event: IpcRendererEvent, raw: unknown) => {
        const result = globalJobSchema.safeParse(raw);
        if (active && result.success) handler(result.data);
      };
      ipcRenderer.on(IPC.evGlobalJobChanged, listener);
      return () => {
        active = false;
        ipcRenderer.removeListener(IPC.evGlobalJobChanged, listener);
      };
    },
  },
  globalOAuth: {
    state: (id) => invokeOAuth(IPC.globalOAuthState, id),
    start: (id) => invokeOAuth(IPC.globalOAuthStart, id),
    startDraft: (id) => invokeOAuth(IPC.globalOAuthStartDraft, id),
    startUpload: (id) => invokeOAuth(IPC.globalOAuthStartUpload, id),
    cancel: (id) => invokeOAuth(IPC.globalOAuthCancel, id),
    onState: (handler) => {
      let active = true;
      const listener = (_event: IpcRendererEvent, raw: unknown) => {
        if (!active) return;
        const state = projectGlobalOAuthState(raw);
        if (state) handler(state);
      };
      ipcRenderer.on(IPC.evGlobalOAuthState, listener);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(IPC.evGlobalOAuthState, listener);
      };
    },
  },
  globalApps: {
    list: () => invoke(IPC.globalAppsList),
    configure: (input) => invoke(IPC.globalAppsConfigure, input),
    clearSecret: (platformId) => invoke(IPC.globalAppsClearSecret, platformId),
  },
  globalAccounts: {
    update: (id, input) => invoke(IPC.globalAccountUpdate, { id, input }),
    list: () => invoke(IPC.globalAccountList),
    create: (input) => invoke(IPC.globalAccountCreate, input),
    delete: (id) => invoke(IPC.globalAccountDelete, id),
    disconnect: (id) => invoke(IPC.globalAccountDisconnect, id),
  },
  network: {
    snapshot: () => invoke(IPC.networkSnapshot),
    settings: () => invoke(IPC.networkSettings),
    configure: (input) => invoke(IPC.networkConfigure, input),
    refresh: () => invoke(IPC.networkRefresh),
    directRules: () => invoke(IPC.networkDirectRules),
  },
  credentials: {
    meta: (ref) => invoke(IPC.credentialMeta, ref),
    set: (input) => invoke(IPC.credentialSet, input),
    delete: (ref) => invoke(IPC.credentialDelete, ref),
  },
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
    show: (id, bounds, enterHomepage) => invoke(IPC.viewShow, id, bounds, enterHomepage),
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
    jobs: (id) => invoke(IPC.metricsJobs, id),
    cancelJob: (id) => invoke(IPC.metricsCancelJob, id),
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
