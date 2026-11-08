import type { WorkbenchApi } from "@shared/ipc";

export const BRIDGE_UNAVAILABLE_MESSAGE = "桌面连接不可用，请重新启动应用后重试";

/** No data, mutation, or events may be fabricated when the desktop bridge is missing. */
export function createUnavailableApi(): WorkbenchApi {
  const reject = (): Promise<never> => Promise.reject(new Error(BRIDGE_UNAVAILABLE_MESSAGE));
  const subscribe = () => () => undefined;
  return {
    accounts: {
      list: reject, create: reject, update: reject, delete: reject, reorder: reject,
      resetEnvironment: reject, checkStatus: reject, refreshProfile: reject,
    },
    views: {
      openMessages: reject, show: reject, hide: reject, hideAll: reject, setBounds: reject,
      navigate: reject, go: reject, reload: reject, reconnect: reject, back: reject,
      forward: reject, stop: reject, state: reject, states: reject, openDevTools: reject,
    },
    metrics: {
      account: reject, platform: reject, overview: reject, collectNow: reject, jobs: reject,
      cancelJob: reject, collectHistory: reject, pauseJob: reject, retryJob: reject, runs: reject,
    },
    analytics: { get: reject, setEnabled: reject, readCurrentPage: reject },
    works: { list: reject },
    assets: { list: reject, import: reject, remove: reject, reveal: reject, thumbnail: reject },
    publish: { list: reject, save: reject, delete: reject, openUpload: reject, attachFiles: reject },
    settings: { get: reject, set: reject },
    audit: { list: reject },
    backup: { export: reject, import: reject },
    app: { info: reject, openExternal: reject },
    network: { snapshot: reject, settings: reject, configure: reject, refresh: reject, directRules: reject },
    credentials: { meta: reject, set: reject, delete: reject },
    globalAccounts: { list: reject, create: reject, update: reject, delete: reject, disconnect: reject },
    globalApps: { list: reject, configure: reject, clearSecret: reject },
    globalOAuth: {
      state: reject, start: reject, startDraft: reject, startUpload: reject, cancel: reject,
      onState: subscribe,
    },
    globalRead: { get: reject },
    globalJobs: { submit: reject, list: reject, cancel: reject, onChanged: subscribe },
    globalUploads: { submit: reject, list: reject, cancel: reject, check: reject, onChanged: subscribe },
    globalWeb: {
      observation: reject, observationHistory: reject, readPage: reject, state: reject,
      open: reject, openChrome: reject, close: reject, openExternal: reject,
      show: reject, hide: reject, go: reject, command: reject, onChanged: subscribe,
    },
    globalWorkspace: {
      openLoginWindow: reject, useBrowser: reject, onChanged: subscribe, identity: reject,
      checkLogin: reject, resetEnvironment: reject, openDevTools: reject, openSystemBrowser: reject,
      works: reject, collect: reject, jobs: reject, cancelJob: reject, publishList: reject,
      publishSave: reject, publishDelete: reject, openUpload: reject, attachFiles: reject,
      openWork: reject,
    },
    on: subscribe,
  };
}
