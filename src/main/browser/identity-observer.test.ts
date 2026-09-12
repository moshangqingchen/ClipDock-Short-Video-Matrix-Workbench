import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBusinessNetwork } from "@main/network/business-access";
import { IdentityObserver } from "./identity-observer";
import { acquireDebugger } from "./debugger-lease";

const url = "https://cp.kuaishou.com/rest/cp/creator/pc/home/infoV2";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
function fixture() {
  cleanups.push(
    installBusinessNetwork({
      enforcement: "observe",
      check: () => ({ allowed: false, reason: "CHECKING" }),
      acquire: () => null,
    }),
  );
  let attached = false;
  const replies = new Map<string, (body: { body: string; base64Encoded: boolean }) => void>();
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
      debug.emit("detach", {}, "test");
    }),
    sendCommand: vi.fn(async (method: string, params?: { requestId: string }) => {
      if (method === "Network.getResponseBody")
        return new Promise((resolve) => {
          replies.set(params!.requestId, resolve);
        });
      return {};
    }),
  });
  const contents = Object.assign(new EventEmitter(), {
    id: 42,
    debugger: debug,
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const changed = vi.fn();
  const observer = new IdentityObserver(contents, "account", "kuaishou", changed);
  cleanups.push(() => observer.dispose());
  const request = (id: string, address = url) => {
    debug.emit("message", {}, "Network.requestWillBeSent", { requestId: id, request: { url: address } });
    debug.emit("message", {}, "Network.responseReceived", {
      requestId: id,
      response: { url: address, status: 200 },
    });
    debug.emit("message", {}, "Network.loadingFinished", { requestId: id, encodedDataLength: 80 });
  };
  const respond = async (id: string, online: boolean) => {
    replies.get(id)?.({
      body: JSON.stringify(
        online ? { result: 1, data: { userId: "redacted" }, token: "never-export" } : { result: 109 },
      ),
      base64Encoded: false,
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { observer, debug, request, respond, contents, changed };
}
describe("passive identity observation", () => {
  it("keeps only the document subject after login evidence expires and clears it on navigation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const f = fixture();f.request("self");await f.respond("self", true);
      expect(f.observer.readSubject()).toBe("redacted");
      now.mockReturnValue(32000);
      expect(f.observer.read()).toBeNull();
      expect(f.observer.readSubject()).toBe("redacted");
      f.contents.emit("did-start-navigation", {}, url, false, true);
      expect(f.observer.readSubject()).toBeNull();
    } finally { now.mockRestore(); }
  });
  it("revokes the collection subject on an explicit logout", async () => {
    const f = fixture();f.request("self");await f.respond("self", true);
    f.request("logout");await f.respond("logout", false);
    expect(f.observer.readSubject()).toBeNull();
  });
  it("does not turn an inconclusive API response into an account switch", async () => {
    const f=fixture();f.request("self");await f.respond("self",true);
    f.debug.emit("message",{},"Network.requestWillBeSent",{requestId:"unconfirmed",request:{url}});
    f.debug.emit("message",{},"Network.responseReceived",{requestId:"unconfirmed",response:{url,status:429}});
    f.debug.emit("message",{},"Network.loadingFinished",{requestId:"unconfirmed",encodedDataLength:80});
    await f.respond("unconfirmed",true);
    expect(f.observer.read()?.kind).toBe("unconfirmed");
    expect(f.observer.readSubject()).toBe("redacted");
  });
  it.each([true, false])("old success/failure cannot overwrite newer evidence (%s)", async (newest) => {
    const f = fixture();
    f.request("old");
    f.request("new");
    await f.respond("new", newest);
    await f.respond("old", !newest);
    expect(f.observer.read()?.kind).toBe(newest ? "online" : "offline");
    expect(JSON.stringify(f.observer.read())).not.toContain("never-export");
  });
  it.each(["navigation", "invalidate", "detach", "dispose"])(
    "invalidates a pending body after %s",
    async (reason) => {
      const f = fixture();
      f.request("one");
      if (reason === "navigation") f.contents.emit("did-start-navigation", {}, url, false, true);
      else if (reason === "detach") f.debug.detach();
      else if (reason === "dispose") f.observer.dispose();
      else f.observer.invalidate();
      await f.respond("one", true);
      if (reason === "detach") expect(f.observer.read()?.kind).toBe("unconfirmed");
      else expect(f.observer.read()).toBeNull();
    },
  );
  it("does not inspect uploads or unrelated responses", () => {
    const f = fixture();
    f.request("upload", "https://cp.kuaishou.com/upload");
    expect(f.debug.sendCommand.mock.calls.map(([method]) => method)).not.toContain("Network.getResponseBody");
  });
  it("shares ownership with upload attachment without detaching either consumer", () => {
    const f = fixture();
    const releaseUpload = acquireDebugger(f.contents);
    expect(f.debug.attach).toHaveBeenCalledOnce();
    f.observer.dispose();
    expect(f.debug.detach).not.toHaveBeenCalled();
    releaseUpload();
    expect(f.debug.detach).toHaveBeenCalledOnce();
    releaseUpload();
    expect(f.debug.detach).toHaveBeenCalledOnce();
  });
});
