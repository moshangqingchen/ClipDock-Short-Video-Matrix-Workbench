/** IPC channel names. Kept dependency-free so the sandboxed preload stays tiny. */
export const IPC = {
  // accounts
  accountList: "accounts:list",
  accountCreate: "accounts:create",
  accountUpdate: "accounts:update",
  accountDelete: "accounts:delete",
  accountReorder: "accounts:reorder",
  accountResetEnvironment: "accounts:reset-environment",
  accountCheckStatus: "accounts:check-status",
  accountRefreshProfile: "accounts:refresh-profile",
  // browser views
  viewShow: "views:show",
  viewHide: "views:hide",
  viewHideAll: "views:hide-all",
  viewSetBounds: "views:set-bounds",
  viewNavigate: "views:navigate",
  viewGo: "views:go",
  viewReload: "views:reload",
  viewBack: "views:back",
  viewForward: "views:forward",
  viewStop: "views:stop",
  viewState: "views:state",
  viewStates: "views:states",
  viewOpenDevTools: "views:devtools",
  // metrics
  metricsAccount: "metrics:account",
  metricsPlatform: "metrics:platform",
  metricsOverview: "metrics:overview",
  metricsCollectNow: "metrics:collect-now",
  metricsRuns: "metrics:runs",
  worksList: "works:list",
  // assets
  assetList: "assets:list",
  assetImport: "assets:import",
  assetRemove: "assets:remove",
  assetReveal: "assets:reveal",
  assetThumbnail: "assets:thumbnail",
  // publish
  publishList: "publish:list",
  publishSave: "publish:save",
  publishDelete: "publish:delete",
  publishOpenUpload: "publish:open-upload",
  publishAttachFiles: "publish:attach-files",
  // settings / misc
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  auditList: "audit:list",
  backupExport: "backup:export",
  backupImport: "backup:import",
  appInfo: "app:info",
  openExternal: "app:open-external",
  // events (main -> renderer)
  evAccountChanged: "ev:account-changed",
  evAccountsReloaded: "ev:accounts-reloaded",
  evViewState: "ev:view-state",
  evMetricsUpdated: "ev:metrics-updated",
  evCollectRun: "ev:collect-run",
  evToast: "ev:toast",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
