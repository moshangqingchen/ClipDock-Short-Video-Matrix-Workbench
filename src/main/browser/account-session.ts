import { app, dialog, session as electronSession, type Session } from "electron";
import path from "node:path";
import { isCnPlatformId, type PlatformId } from "@shared/platforms";
import { ensureSessionObservation, initializeAccountSessionNetwork } from "@main/network/session-observer";
import { canUseBusinessNetwork, isStrictBusinessNetwork } from "@main/network/business-access";
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
const accountSessions = new Set<Session>();
const configuredAccountSessions = new Map<string, Session>();

/** Read the registered account session without creating a view or a new partition. */
export function getConfiguredAccountSession(accountId: string): Session | undefined {
  return configuredAccountSessions.get(accountId);
}
const permits = (permission: string) =>
  ALLOWED_PERMISSIONS.has(permission) && !(isStrictBusinessNetwork() && permission === "background-sync");

export interface ConfiguredSession {
  session: Session;
  partition: string;
  ready: Promise<void>;
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
  if (!isCnPlatformId(_platformId)) throw new Error("国内账号分区不接受国际平台");
  const partition = partitionForAccount(accountId);
  const ses = electronSession.fromPartition(partition, { cache: true });
  accountSessions.add(ses);
  configuredAccountSessions.set(accountId, ses);
  ensureSessionObservation(ses, _platformId, accountId);
  const ready = initializeAccountSessionNetwork(ses, accountId, _platformId);
  const disposers: Array<() => void> = [];

  if (!configured.has(ses)) {
    configured.add(ses);
    ses.setUserAgent(chromeUserAgent(), "zh-CN,zh;q=0.9,en;q=0.8");

    ses.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permits(permission));
    });
    ses.setPermissionCheckHandler((_contents, permission) => permits(permission));
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      callback({});
    });
    ses.setDevicePermissionHandler(() => false);

    ses.on("will-download", (_event, item) => {
      if (!canUseBusinessNetwork(accountId)) {
        _event.preventDefault();
        item.cancel();
        return;
      }
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
    ready,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

/** Session lifetime, independent of views already destroyed during a strict shutdown. */
export async function flushAccountSessionCookies(): Promise<void> {
  await Promise.allSettled([...accountSessions].map((ses) => ses.cookies.flushStore()));
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
