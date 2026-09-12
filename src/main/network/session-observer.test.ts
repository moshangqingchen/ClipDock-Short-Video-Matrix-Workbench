import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { installBusinessNetwork } from "./business-access";
import {
  ensureSessionObservation,
  installSessionNetworkPolicy,
  setBlockedRequestSink,
  setNetworkObservationSink,
} from "./session-observer";
import { RequestAudit } from "./request-audit";

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  setBlockedRequestSink(() => undefined);
  setNetworkObservationSink(() => undefined);
});

function fixture() {
  let listener!: (
    details: { url: string; resourceType: string },
    callback: (result: { cancel: boolean }) => void,
  ) => void;
  const install = vi.fn((handler: typeof listener) => {
    listener = handler;
  });
  const session = { webRequest: { onBeforeRequest: install } } as unknown as Session;
  return {
    session,
    install,
    request(url: string, resourceType = "xhr") {
      const callback = vi.fn();
      listener({ url, resourceType }, callback);
      return callback;
    },
  };
}

describe("Session lifetime request guard", () => {
  it("starts closed without a controller or policy, including passport/CDN/WebSocket requests", () => {
    const f = fixture();
    ensureSessionObservation(f.session, "weixin_channels", "account");
    for (const [url, resourceType] of [
      ["https://channels.weixin.qq.com/", "mainFrame"],
      ["https://open.weixin.qq.com/qrconnect", "subFrame"],
      ["https://res.wx.qq.com/secret/path?token=x", "script"],
      ["wss://example.test/socket", "webSocket"],
    ]) {
      const callback = f.request(url, resourceType);
      expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    }
  });

  it("observation still calls Chromium once with cancel:false when diagnostics throw", () => {
    cleanup.push(
      installBusinessNetwork({
        enforcement: "observe",
        check: () => ({ allowed: false, reason: "CHECKING" }),
        acquire: () => null,
      }),
    );
    setNetworkObservationSink(() => {
      throw new Error("diagnostic failure");
    });
    const f = fixture();
    ensureSessionObservation(f.session, "bilibili", "account");
    expect(f.request("https://api.bilibili.com/x/web-interface/nav")).toHaveBeenCalledExactlyOnceWith({
      cancel: false,
    });
  });

  it("keeps one listener across view recreation and consults the current policy per request", () => {
    const f = fixture();
    ensureSessionObservation(f.session, "douyin", "account");
    ensureSessionObservation(f.session, "douyin", "account");
    expect(f.install).toHaveBeenCalledTimes(1);
    let cancel = false;
    const dispose = installSessionNetworkPolicy({
      registerSession: () => ({ ready: Promise.resolve() }),
      checkSessionRequest: () => ({ cancel }),
    });
    cleanup.push(dispose);
    expect(f.request("https://creator.douyin.com/")).toHaveBeenCalledExactlyOnceWith({ cancel: false });
    cancel = true;
    expect(f.request("https://creator.douyin.com/")).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    dispose();
    expect(f.request("https://creator.douyin.com/")).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(() => ensureSessionObservation(f.session, "youtube" as never, "account")).toThrow();
    expect(() => ensureSessionObservation(f.session, "douyin", "other-account")).toThrow();
  });

  it("failed audit cannot reopen a blocked request; audit omits URL secrets and bounds traffic volume", () => {
    const rows: unknown[] = [];
    let time = 0;
    const audit = new RequestAudit(
      (row) => {
        rows.push(row);
        throw new Error("disk full");
      },
      () => time,
    );
    const f = fixture();
    cleanup.push(
      installSessionNetworkPolicy({
        registerSession: () => ({ ready: Promise.resolve() }),
        checkSessionRequest: () => ({ cancel: true, reason: "PROOF_EXPIRED", generation: 3 }),
      }),
    );
    setBlockedRequestSink((request) => audit.record(request));
    ensureSessionObservation(f.session, "douyin", "account");
    const url = "https://username:password@creator.douyin.com/token-in-path?access_token=secret#secret";
    for (let i = 0; i < 100; i++) expect(f.request(url)).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(rows).toEqual([
      {
        accountId: "account",
        host: "creator.douyin.com",
        resourceType: "xhr",
        reason: "PROOF_EXPIRED",
        generation: 3,
        canceled: true,
        sampled: true,
      },
    ]);
    for (let i = 0; i < 600; i++) f.request(`https://cdn${i}.example.test/`);
    expect(rows).toHaveLength(512);
    time = 60_000;
    f.request(url);
    expect(rows).toHaveLength(513);
    expect(JSON.stringify(rows)).not.toMatch(/username|password|token-in-path|access_token|secret/);
  });
});
