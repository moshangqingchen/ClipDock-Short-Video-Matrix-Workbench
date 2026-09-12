import { globalPageScript, type GlobalPageRead } from "@main/data/global-web-page";
import { allowGlobalUrl } from "./global-embedded-browser";
import { globalUploadInput } from "./global-upload-input";
import { ChromePipe, ChromePage } from "./chrome-cdp";
import { GLOBAL_PAGE_TEXT_SCRIPT } from "@main/data/global-web-observation";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { BaseWindow } from "electron";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { globalWebRoute } from "@shared/global-platforms";
import { GLOBAL_WEB_ENTRY_URLS } from "@main/network/global-web-target-policy";
import { observationPage, type GlobalPageText } from "@main/data/global-web-observation";
import { claimGlobalBrowserProfile, configureGlobalBrowserProfile } from "./global-browser-profile";
import {
  chromeExecutable,
  type GlobalBrowserLaunchInput,
  type ManagedGlobalBrowser,
} from "./global-browser-launcher";

const unavailable = () => new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Experimental Windows docking. Chrome owns its rendering, authentication and profile.
 * The helper's job owns only Chrome processes started with our account profile.
 */
export class DockedChromeBrowser {
  private readonly active = new Map<string, ManagedGlobalBrowser>();
  private readonly opening = new Set<string>();
  constructor(
    private readonly window: BaseWindow,
    private readonly dataDirectory: string,
    private readonly contentHost = false,
  ) {}

  async launch(input: GlobalBrowserLaunchInput): Promise<ManagedGlobalBrowser> {
    if (process.platform !== "win32" || input.transport !== "system" || this.window.isDestroyed())
      throw unavailable();
    const id = globalAccountIdSchema.parse(input.accountId);
    if (this.opening.has(id)) throw new Error("GLOBAL_WEB_PROFILE_BUSY");
    this.opening.add(id);
    try {
      // A failed cleanup remains owned and can be retried, never silently adopted.
      await this.active.get(id)?.stop();
      input.assertCurrent();
      const executable = await chromeExecutable();
      const profile = await claimGlobalBrowserProfile({
        dataDirectory: this.dataDirectory,
        accountId: id,
        platformId: input.platformId,
      });
      try {
        await configureGlobalBrowserProfile(profile);
        input.assertCurrent();
      } catch (error) {
        await profile.release();
        throw error;
      }
      const helper = path
        .join(
          path.dirname(fileURLToPath(import.meta.url)),
          this.contentHost ? "chrome-content-host.exe" : "chrome-dock.exe",
        )
        .replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
      const child = spawn(helper, [], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] });
      let exited = false,
        stopping = false,
        ready = false;
      let exitCode: number | null = null;
      let sequence = 0;
      const pending = new Map<number, (channel: string | null) => void>();
      const pageRequests = new Map<number, (page: GlobalPageText | null) => void>();
      let resolveReady!: () => void, rejectReady!: (error: Error) => void;
      const whenReady = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void whenReady.catch(() => undefined);
      const exit = new Promise<void>((resolve) => {
        child.once("close", (code) => {
          exited = true;
          exitCode = code;
          rejectReady(unavailable());
          resolve();
        });
      });
      child.once("error", () => rejectReady(unavailable()));
      child.stdin.on("error", () => {
        rejectReady(unavailable());
        if (!exited) child.kill();
      });
      const send = (value: object) => {
        if (exited || child.stdin.destroyed) return;
        child.stdin.write(JSON.stringify(value) + "\n");
      };
      const pipe = new ChromePipe((payload) => send({ kind: "cdp", payload }));
      const controller = new ChromePage(pipe, (url) => send({ kind: "document", url }));
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line) as {
            kind?: string;
            payload?: string;
            request?: number;
            channel?: unknown;
            page?: GlobalPageText;
          };
          if (message.kind === "cdp" && typeof message.payload === "string") pipe.receive(message.payload);
          if (message.kind === "page" && typeof message.request === "number") {
            const page = message.page;
            pageRequests.get(message.request)?.(
              page &&
                typeof page.url === "string" &&
                typeof page.text === "string" &&
                page.text.length <= 60000
                ? page
                : null,
            );
            pageRequests.delete(message.request);
          }
          if (message.kind === "ready") {
            ready = true;
            resolveReady();
          }
          if (message.kind === "error") rejectReady(unavailable());
          if (message.kind === "channel" && typeof message.request === "number") {
            pending.get(message.request)?.(
              typeof message.channel === "string" && /^UC[a-zA-Z0-9_-]{22}$/.test(message.channel)
                ? message.channel
                : null,
            );
            pending.delete(message.request);
          }
        } catch {
          rejectReady(unavailable());
        }
      });
      let cleanup: Promise<void> | null = null;
      const release = (): Promise<void> => {
        if (cleanup) return cleanup;
        cleanup = (async () => {
          await exit;
          pipe.close();
          for (let attempt = 0; ; attempt++) {
            try {
              await profile.release();
              break;
            } catch (error) {
              if (attempt >= 12) throw error;
              await pause(200);
            }
          }
          this.active.delete(id);
          input.signal.removeEventListener("abort", abort);
          lines.close();
          for (const done of pending.values()) done(null);
          pending.clear();
          for (const done of pageRequests.values()) done(null);
          pageRequests.clear();
        })().catch((error) => {
          cleanup = null;
          throw error;
        });
        return cleanup;
      };
      const abort = () => {
        stopping = true;
        send({ kind: "hide" });
        send({ kind: "stop" });
      };
      const closed = exit.then(async () => {
        await release();
        if (!stopping && exitCode !== 0) throw unavailable();
      });
      void closed.catch(() => undefined);
      const stop = async () => {
        abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exit,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                if (!exited) child.kill();
                resolve();
              }, 8500);
            }),
          ]);
          await release();
        } finally {
          clearTimeout(timer);
        }
      };
      const currentChannel = async () => {
        const request = ++sequence;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise<string | null>((resolve) => {
            pending.set(request, resolve);
            timer = setTimeout(() => resolve(null), 2000);
            send({ kind: "channel", request });
          });
        } finally {
          clearTimeout(timer);
          pending.delete(request);
        }
      };
      const browser: ManagedGlobalBrowser = {
        readPage: async () => {
          input.assertCurrent();
          if (stopping || exited || !ready) throw new Error("WEB_OBSERVE_CLOSED");
          if (this.contentHost) {
            const raw = await controller.read<GlobalPageText>(GLOBAL_PAGE_TEXT_SCRIPT);
            input.assertCurrent();
            if (!observationPage(input.platformId, raw.url)) throw new Error("WEB_OBSERVE_PAGE_REQUIRED");
            return raw;
          }
          const request = ++sequence;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const page = await new Promise<GlobalPageText | null>((resolve) => {
              pageRequests.set(request, resolve);
              timeout = setTimeout(() => resolve(null), 5500);
              send({ kind: "page", request });
            });
            input.assertCurrent();
            if (!page) throw new Error("WEB_OBSERVE_UNAVAILABLE");
            if (!observationPage(input.platformId, page.url)) throw new Error("WEB_OBSERVE_PAGE_REQUIRED");
            return page;
          } finally {
            clearTimeout(timeout);
            pageRequests.delete(request);
          }
        },
        engine: "chrome",
        ...(this.contentHost
          ? {
              getPageState: () => controller.getState(),
              onPageState: (listener: Parameters<ChromePage["subscribe"]>[0]) =>
                controller.subscribe(listener),
              openDevTools: () => controller.devTools(),
              openLoginWindow: async () => {
                input.assertCurrent();
                await controller.pipe.request("Target.createTarget", {
                  url: GLOBAL_WEB_ENTRY_URLS[input.platformId],
                  newWindow: true,
                });
                input.assertCurrent();
              },
              readIdentity: async () => {
                input.assertCurrent();
                const raw = await controller.read<GlobalPageRead>(globalPageScript(input.platformId));
                input.assertCurrent();
                return raw.identity;
              },
              readBackground: async (url: string) => {
                if (!allowGlobalUrl(input.platformId, url)) throw unavailable();
                return controller.background<GlobalPageRead>(
                  url,
                  globalPageScript(input.platformId),
                  input.assertCurrent,
                );
              },
              navigateOfficial: async (url: string) => {
                input.assertCurrent();
                if (!allowGlobalUrl(input.platformId, url)) throw unavailable();
                await controller.navigate(url);
              },
              attachFiles: async (files: string[]) => {
                input.assertCurrent();
                const url = controller.getState().url;
                const selector = globalUploadInput(input.platformId, url);
                if (!selector) throw new Error("请先进入官方上传页面");
                const { root } = await controller.call<{ root: { nodeId: number } }>("DOM.getDocument", {
                  depth: 0,
                });
                const { nodeId } = await controller.call<{ nodeId: number }>("DOM.querySelector", {
                  nodeId: root.nodeId,
                  selector,
                });
                if (!nodeId) return 0;
                if (controller.getState().url !== url) throw new Error("页面已变化，请重新选择文件");
                input.assertCurrent();
                await controller.call("DOM.setFileInputFiles", { nodeId, files });
                return files.length;
              },
            }
          : {}),
        closed,
        stop,
        show: (bounds) => {
          input.assertCurrent();
          if (stopping || !ready || this.window.isDestroyed()) return;
          for (const [otherId, other] of this.active) if (otherId !== id) other.hide?.();
          send({ kind: "show", ...bounds });
        },
        hide: () => send({ kind: "hide" }),
        command: (action) => {
          input.assertCurrent();
          if (this.contentHost) return controller.command(action);
          else send({ kind: "command", action });
        },
        go: async (capability) => {
          input.assertCurrent();
          let url = globalWebRoute(
            input.platformId,
            capability,
            this.contentHost ? controller.getState().url : "",
          );
          if (!url && this.contentHost && input.platformId === "x" && capability === "works") {
            const identity = (await controller.read<GlobalPageRead>(globalPageScript("x"))).identity;
            if (identity.status === "online" && /^[a-zA-Z0-9_]{1,15}$/.test(identity.subjectId ?? ""))
              url = "https://x.com/" + identity.subjectId;
          }
          if (!url && input.platformId === "youtube") {
            const channel = this.contentHost
              ? /^https:\/\/studio.youtube.com\/channel\/(UC[a-zA-Z0-9_-]{22})/.exec(
                  controller.getState().url,
                )?.[1]
              : await currentChannel();
            if (channel)
              url = globalWebRoute(
                input.platformId,
                capability,
                `https://studio.youtube.com/channel/${channel}/`,
              );
          }
          if (!url) throw new Error("GLOBAL_WEB_ROUTE_UNAVAILABLE");
          input.assertCurrent();
          if (this.contentHost) await controller.navigate(url);
          else send({ kind: "navigate", url });
        },
      };
      this.active.set(id, browser);
      input.signal.addEventListener("abort", abort, { once: true });
      const handle = this.window.getNativeWindowHandle();
      send({
        parent: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
        owner: process.pid,
        executable,
        profile: profile.directory,
        platform: input.platformId,
        entry: GLOBAL_WEB_ENTRY_URLS[input.platformId],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (input.signal.aborted) throw unavailable();
        await Promise.race([
          whenReady,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(unavailable()), 30000);
          }),
        ]);
        input.assertCurrent();
        if (this.contentHost) await controller.start();
        return browser;
      } catch (error) {
        await stop();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.opening.delete(id);
    }
  }
}
