import type { WebIdentity } from "@shared/global-workspace";
import type { GlobalPageRead } from "@main/data/global-web-page";
import type { ChromePageState } from "./chrome-cdp";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { GlobalPlatformId } from "@shared/platforms";
import { GLOBAL_WEB_ENTRY_URLS } from "@main/network/global-web-target-policy";
import type { GlobalBrowserProfile } from "./global-browser-profile";
import { assertGlobalBrowserPolicy } from "./global-browser-policy";
import type { ViewBounds } from "@shared/types";
import type { GlobalWebCapability } from "@shared/global-platforms";
import type { GlobalPageText } from "@main/data/global-web-observation";

export interface ManagedGlobalBrowser {
  readIdentity?(): Promise<WebIdentity>;
  readBackground?(url: string): Promise<GlobalPageRead>;
  attachFiles?(files: string[]): Promise<number>;
  navigateOfficial?(url: string): Promise<void>;
  getPageState?(): ChromePageState;
  onPageState?(listener: (state: ChromePageState) => void): () => void;
  openLoginWindow?(): Promise<void>;
  openDevTools?(): Promise<void>;
  readPage?(): Promise<GlobalPageText>;
  readonly engine?: "chrome";
  readonly closed: Promise<void>;
  stop(): Promise<void>;
  show?(bounds: ViewBounds): void;
  hide?(): void;
  go?(capability: GlobalWebCapability): Promise<void>;
  command?(command: "back" | "forward" | "reload"): void | Promise<void>;
}
interface GlobalBrowserLaunchContext {
  readonly platformId: GlobalPlatformId;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export type GlobalBrowserLaunchInput = GlobalBrowserLaunchContext &
  (
    | {
        readonly transport?: "relay";
        readonly profile: GlobalBrowserProfile;
        readonly endpoint: Readonly<{ host: "127.0.0.1"; port: number }>;
      }
    | { readonly transport: "system"; readonly accountId: string }
  );
const fail = () => new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE");

/** Fixed official destinations and application-owned profiles only. No renderer URL,
 * personal profile, remote debugging, certificate exception or direct fallback.
 */
export function globalBrowserArguments(input: GlobalBrowserLaunchInput): string[] {
  // System transport belongs to the in-app session and must never launch an external browser.
  if (input.transport === "system") throw fail();
  if (
    !Object.hasOwn(GLOBAL_WEB_ENTRY_URLS, input.platformId) ||
    !path.isAbsolute(input.profile.directory) ||
    input.endpoint.host !== "127.0.0.1" ||
    !Number.isInteger(input.endpoint.port) ||
    input.endpoint.port < 1 ||
    input.endpoint.port > 65535
  )
    throw fail();
  return [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-quic",
    "--disable-background-mode",
    "--no-pings",
    `--user-data-dir=${input.profile.directory}`,
    "--profile-directory=Default",
    `--proxy-server=http://127.0.0.1:${input.endpoint.port}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--new-window",
    GLOBAL_WEB_ENTRY_URLS[input.platformId],
  ];
}

export async function chromeExecutable(): Promise<string> {
  if (process.platform !== "win32") throw fail();
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
    if (!root || !path.isAbsolute(root)) continue;
    const file = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) return file;
    } catch {
      /* Try the next standard installation location. */
    }
  }
  throw fail();
}

export async function launchGlobalBrowser(input: GlobalBrowserLaunchInput): Promise<ManagedGlobalBrowser> {
  if (input.transport === "system") throw fail();
  const args = globalBrowserArguments(input),
    file = await chromeExecutable();
  await assertGlobalBrowserPolicy();
  await input.profile.assertCurrent();
  input.assertCurrent();
  if (input.signal.aborted) throw fail();
  // Visible because this is the user's explicit "open website" action.
  const child = spawn(file, args, { windowsHide: false, shell: false, stdio: "ignore" });
  let exited = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited = true;
      input.signal.removeEventListener("abort", stopNow);
      resolve();
    }),
  );
  // ChildProcess.kill uses the owned process handle, never a browser-name/PID search.
  // The caller additionally checks the profile has no surviving process before releasing it.
  const stopNow = () => {
    if (!exited) child.kill();
  };
  input.signal.addEventListener("abort", stopNow, { once: true });
  if (input.signal.aborted) stopNow();
  const stop = async () => {
    stopNow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(fail()), 8_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(fail()));
    });
    input.assertCurrent();
    if (input.signal.aborted || exited) throw fail();
    return Object.freeze({ closed, stop });
  } catch {
    await stop();
    throw fail();
  }
}
