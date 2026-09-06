import { app, dialog, session as electronSession, type Session } from "electron";
import path from "node:path";
import type { PlatformId } from "@shared/platforms";
import { toChromeUserAgent } from "./user-agent";
import { partitionForAccount } from "./partition";

export { partitionForAccount };

let cachedUserAgent: string | null = null;

export function chromeUserAgent(): string {
  if (!cachedUserAgent) cachedUserAgent = toChromeUserAgent(app.userAgentFallback);
  return cachedUserAgent;
}

const ALLOWED_PERMISSIONS = new Set<string>([
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
  "fullscreen",
  "pointerLock",
  "keyboardLock",
  "window-management",
  "background-sync",
  "persistent-storage",
  "storage-access",
  "top-level-storage-access",
  "idle-detection",
]);

const configured = new WeakSet<Session>();

export interface ConfiguredSession {
  session: Session;
  partition: string;
  dispose(): void;
}

/**
 * Resolve and harden the isolated session for one account.
 *
 * The goal is "indistinguishable from a normal Chrome profile": same UA and
 * client hints, normal permission behaviour for benign capabilities, downloads
 * go through a save dialog. Camera / microphone / screen capture stay denied
 * because no creator console needs them and they would expose the operator.
 */
export function configureAccountSession(accountId: string, _platformId: PlatformId): ConfiguredSession {
  const partition = partitionForAccount(accountId);
  const ses = electronSession.fromPartition(partition, { cache: true });
  const disposers: Array<() => void> = [];

  if (!configured.has(ses)) {
    configured.add(ses);
    ses.setUserAgent(chromeUserAgent(), "zh-CN,zh;q=0.9,en;q=0.8");

    ses.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      callback({});
    });
    ses.setDevicePermissionHandler(() => false);

    ses.on("will-download", (_event, item) => {
      const downloads = app.getPath("downloads");
      const target = path.join(downloads, item.getFilename() || "download");
      item.setSaveDialogOptions({ defaultPath: target, title: "保存文件" });
      item.once("done", (_e, state) => {
        if (state === "interrupted") {
          void dialog.showMessageBox({ type: "warning", message: "下载已中断", detail: item.getFilename() });
        }
      });
    });

    ses.setSpellCheckerEnabled(false);
  }

  return {
    session: ses,
    partition,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

/**
 * Wipe everything for one account. Only reachable from the explicit
 * "reset login environment" action; every other code path must keep the
 * partition intact so sessions survive restarts and account switches.
 */
export async function wipeAccountSession(accountId: string): Promise<void> {
  const ses = electronSession.fromPartition(partitionForAccount(accountId), { cache: true });
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  await ses.clearHostResolverCache();
  try {
    await ses.cookies.flushStore();
  } catch {
    // flush is best-effort
  }
}
