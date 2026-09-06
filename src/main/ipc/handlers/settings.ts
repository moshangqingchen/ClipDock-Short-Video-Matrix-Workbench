import { app, shell } from "electron";
import { z } from "zod";
import { IPC, settingsPatchSchema, type AppInfo } from "@shared/ipc";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import { chromeUserAgent } from "@main/browser/account-session";
import type { IpcRegistrar } from "../register";

export interface SettingsHandlerDeps {
  store: Store;
  pool: ViewPool;
  onSettingsChanged?: (settings: ReturnType<Store["settings"]["get"]>) => void;
}

export function registerSettingsHandlers(ipc: IpcRegistrar, deps: SettingsHandlerDeps): void {
  ipc.handle(IPC.settingsGet, () => deps.store.settings.get());
  ipc.handleValidated(IPC.settingsSet, settingsPatchSchema, (_e, patch) => {
    const next = deps.store.settings.patch(patch);
    if (patch.maxLiveViews) deps.pool.setMaxLive(next.maxLiveViews);
    deps.onSettingsChanged?.(next);
    return next;
  });
  ipc.handleValidated(IPC.auditList, z.number().int().min(1).max(2000).optional(), (_e, limit) =>
    deps.store.audit.list(limit ?? 200),
  );
  ipc.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    userDataPath: app.getPath("userData"),
    userAgent: chromeUserAgent(),
  }));
  ipc.handle(IPC.openExternal, async (_e, url: unknown) => {
    if (typeof url !== "string") return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") await shell.openExternal(parsed.href);
    } catch {
      // ignore malformed urls
    }
  });
}
