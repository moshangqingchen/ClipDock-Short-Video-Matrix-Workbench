import type { Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBusinessNetwork, type BusinessNetworkController } from "./business-access";
import { ensureShellNetworkGuard } from "./shell-network-guard";

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

function mode(enforcement: "strict" | "observe") {
  const controller: BusinessNetworkController = {
    enforcement,
    check: vi.fn(() => ({ allowed: true, reason: "READY" })),
    acquire: vi.fn(() => null),
  };
  const dispose = installBusinessNetwork(controller);
  cleanup.push(dispose);
  return { controller, dispose };
}

function fixture() {
  let listener!: (
    details: { url: string; resourceType?: string },
    callback: (result: { cancel: boolean }) => void,
  ) => void;
  const install = vi.fn((handler: typeof listener) => {
    listener = handler;
  });
  const session = { webRequest: { onBeforeRequest: install } } as unknown as Session;
  return {
    session,
    install,
    request(url: string, resourceType = "image") {
      const callback = vi.fn();
      listener({ url, resourceType }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0];
    },
    dispatch(details: { url: string }) {
      const callback = vi.fn();
      listener(details, callback);
      return callback;
    },
  };
}

describe("shell Session network guard", () => {
  it("starts closed without a controller for signed images and other remote request types", () => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, null);
    for (const [url, type] of [
      ["https://cdn.example.test/private-signature/avatar?token=private-token", "image"],
      ["http://cdn.example.test/cover", "image"],
      ["https://api.example.test/profile", "xhr"],
      ["https://example.test/worker.js", "script"],
      ["ws://example.test/live", "webSocket"],
      ["wss://example.test/live", "webSocket"],
      ["https://example.test/", "subFrame"],
    ]) {
      expect(f.request(url, type)).toEqual({ cancel: true });
    }
  });

  it("remains closed in strict mode even if an account controller would grant a permit", () => {
    const { controller } = mode("strict");
    const f = fixture();
    ensureShellNetworkGuard(f.session, null);
    expect(f.request("https://creator.douyin.com/avatar")).toEqual({ cancel: true });
    expect(controller.check).not.toHaveBeenCalled();
    expect(controller.acquire).not.toHaveBeenCalled();
  });

  it("preserves observation behavior and reads mode again without replacing the listener", () => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, null);
    const observation = mode("observe");
    for (const url of ["https://example.test/?signature=x", "wss://example.test/live", "invalid url"]) {
      expect(f.request(url)).toEqual({ cancel: false });
    }
    observation.dispose();
    expect(f.request("https://example.test/")).toEqual({ cancel: true });
    mode("strict");
    expect(f.request("https://example.test/")).toEqual({ cancel: true });
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("keeps local shell documents and asset previews usable while closed", () => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, null);
    for (const url of [
      "file:///D:/project%20development/clipdock/dist/index.html",
      "file:///C:/assets/thumbnail.png",
      "data:image/png;base64,AA==",
      "blob:https://example.test/locally-created-object",
      "sv-asset://file/local-asset-id",
      "sv-asset://thumb/local-asset-id",
      "sv-asset://remote/6ee7babe-7e1a-4f1b-a433-5f9e514120e7",
      "about:blank",
      "about:srcdoc",
    ]) {
      expect(f.request(url)).toEqual({ cancel: false });
    }
  });

  it("does not mistake file UNC spellings or an unknown scheme for local traffic", () => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, null);
    for (const url of [
      "file://server.example.test/share/image.png",
      "file://127.0.0.1/share/image.png",
      "file:////server.example.test/share/image.png",
      "file:///%5C%5Cserver.example.test/share/image.png",
      "file:///%2F%2Fserver.example.test/share/image.png",
      "file:///C:/broken%path",
      "ftp://example.test/image.png",
      "sv-asset://remote.example.test/image.png",
      "sv-asset://user:password@file/image.png",
      "about:config",
      "not a URL",
    ]) {
      expect(f.request(url)).toEqual({ cancel: true });
    }
  });

  it.each([
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173", "ws://127.0.0.1:5173"],
    ["http://127.0.0.2:5173/index.html", "http://127.0.0.2:5173", "ws://127.0.0.2:5173"],
    ["http://[::1]:5173", "http://[::1]:5173", "ws://[::1]:5173"],
    ["https://[0:0:0:0:0:0:0:1]:5173", "https://[::1]:5173", "wss://[::1]:5173"],
  ])("allows only configured literal loopback origin %s and its matching websocket", (dev, http, ws) => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, dev);
    expect(f.request(http + "/src/main.ts")).toEqual({ cancel: false });
    expect(f.request(ws + "/?vite-hmr-token=local")).toEqual({ cancel: false });
    expect(f.request("http://127.0.0.1:5174/")).toEqual({ cancel: true });
    expect(f.request("ws://127.0.0.1:5174/")).toEqual({ cancel: true });
    expect(f.request("https://cdn.example.test/asset.png")).toEqual({ cancel: true });
  });

  it("does not extend the dev exception to alternate hosts, credentials, ports or TLS schemes", () => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, "http://127.0.0.1:5173");
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.2:5173/",
      "http://127.0.0.1.example.test:5173/",
      "http://[::1]:5173/",
      "http://user:password@127.0.0.1:5173/",
      "ws://user:password@127.0.0.1:5173/",
      "https://127.0.0.1:5173/",
      "wss://127.0.0.1:5173/",
      "http://127.0.0.1/",
      "ws://127.0.0.1/",
    ]) {
      expect(f.request(url)).toEqual({ cancel: true });
    }
  });

  it.each([
    null,
    "http://localhost:5173",
    "http://example.test:5173",
    "http://127.0.0.1.example.test:5173",
    "http://127.1:5173",
    "http://2130706433:5173",
    "http://0x7f000001:5173",
    "http://0177.0.0.1:5173",
    "http://user:password@127.0.0.1:5173",
    "ws://127.0.0.1:5173",
    "http://127.0.0.1:5173\\@example.test",
    "invalid URL",
  ])("does not authorize loopback through absent or nonliteral dev config %s", (dev) => {
    const f = fixture();
    ensureShellNetworkGuard(f.session, dev);
    expect(f.request("http://127.0.0.1:5173/")).toEqual({ cancel: true });
    expect(f.request("ws://127.0.0.1:5173/")).toEqual({ cancel: true });
  });

  it("installs once for the default Session without touching independent Sessions or widening on recreation", () => {
    const shell = fixture();
    const account = fixture();
    const diagnostic = fixture();
    ensureShellNetworkGuard(shell.session, "http://127.0.0.1:5173");
    ensureShellNetworkGuard(shell.session, "http://127.0.0.1:9000");
    expect(shell.install).toHaveBeenCalledTimes(1);
    expect(account.install).not.toHaveBeenCalled();
    expect(diagnostic.install).not.toHaveBeenCalled();
    expect(shell.request("http://127.0.0.1:5173/")).toEqual({ cancel: false });
    expect(shell.request("http://127.0.0.1:9000/")).toEqual({ cancel: true });
  });

  it("fails closed without logging signed URLs or exceptions and always completes the callback", () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const f = fixture();
    ensureShellNetworkGuard(f.session, null);
    expect(f.request("https://cdn.example.test/private-path?signature=private-token")).toEqual({
      cancel: true,
    });
    const details = {
      get url(): string {
        throw new Error("https://cdn.example.test/?signature=private-token");
      },
    };
    expect(f.dispatch(details)).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    cleanup.push(
      installBusinessNetwork({
        get enforcement(): "strict" {
          throw new Error("private-controller-detail");
        },
        check: () => ({ allowed: true, reason: "READY" }),
        acquire: () => null,
      }),
    );
    expect(f.request("file:///C:/assets/image.png")).toEqual({ cancel: true });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
