import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalWebState } from "@shared/global-web";
import type { GlobalBrowserLaunchInput } from "@main/browser/global-browser-launcher";
import type { GlobalWebRelayOptions } from "@main/network/global-web-relay";
import { GlobalWebService } from "./global-web-service";

const id = "8e65b156-a2ee-48ac-957e-2f990141c207";
const account: GlobalAccount = {
  id,
  platformId: "youtube",
  displayName: "fixture",
  authStatus: "unauthorized",
  remoteId: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const services: GlobalWebService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
});
function fixture(transport: "relay" | "system" = "relay") {
  const abort = new AbortController(),
    states: GlobalWebState[] = [],
    entries = new Map([[id, account]]);
  let finish!: () => void, failBrowser!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    failBrowser = reject;
  });
  const profile = {
    directory: "C:\\owned-profile",
    assertCurrent: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const browser = {
    closed,
    stop: vi.fn(async () => finish()),
    readPage: vi.fn(async () => ({
      url: "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/analytics",
      text: "Views\n25",
    })),
  };
  const observations = { get: vi.fn(() => null), save: vi.fn() };
  const relay = {
    start: vi.fn(async () => ({ host: "127.0.0.1" as const, port: 12345 })),
    dispose: vi.fn(async () => undefined),
  };
  const eligibility = {
    generation: 1,
    signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    release: vi.fn(),
  };
  const claim = vi.fn(async () => profile),
    configure = vi.fn(async () => undefined);
  const launch = vi.fn(async (_input: GlobalBrowserLaunchInput) => browser);
  let finishChrome!: () => void;
  const chromeBrowser = {
    engine: "chrome" as const,
    show: vi.fn(),
    closed: new Promise<void>((resolve) => {
      finishChrome = resolve;
    }),
    stop: vi.fn(async () => finishChrome()),
  };
  const launchChrome = vi.fn(async (_input: GlobalBrowserLaunchInput) => chromeBrowser);
  const createRelay = vi.fn((_input: GlobalWebRelayOptions) => relay);
  const acquireEligibility = vi.fn(async () => eligibility as typeof eligibility | null);
  const openTunnel = vi.fn(async () => ({
    stream: new PassThrough(),
    closed: Promise.resolve(),
    close: vi.fn(),
  }));
  const service = new GlobalWebService(
    {
      dataDirectory: "C:\\controlled",
      observations,
      transport,
      getAccount: (key) => entries.get(key),
      acquireEligibility,
      openTunnel,
      onChanged: (state) => states.push(state),
    },
    { claim, configure, launch, launchChrome, relay: createRelay },
  );
  services.push(service);
  return {
    observations,
    service,
    abort,
    states,
    entries,
    finish,
    failBrowser,
    profile,
    browser,
    relay,
    eligibility,
    claim,
    configure,
    launch,
    launchChrome,
    chromeBrowser,
    createRelay,
    acquireEligibility,
    openTunnel,
  };
}
describe("international website lifecycle", () => {
  it("reads a webpage without API authorization and refuses a late result after network revocation", async () => {
    const f = fixture("system");
    await expect(f.service.readPage(id)).rejects.toThrow("WEB_OBSERVE_CLOSED");
    await f.service.open(id);
    expect((await f.service.readPage(id)).metrics).toEqual([{ key: "views", label: "Views", value: "25" }]);
    expect(f.entries.get(id)?.authStatus).toBe("unauthorized");
    expect(f.observations.save).toHaveBeenCalledOnce();
    let resolve!: (raw: { url: string; text: string }) => void;
    f.browser.readPage.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const reading = f.service.readPage(id);
    await expect(f.service.readPage(id)).rejects.toThrow("WEB_OBSERVE_BUSY");
    f.abort.abort();
    resolve({
      url: "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/analytics",
      text: "Views\n100",
    });
    await expect(reading).rejects.toThrow("WEB_OBSERVE_CANCELLED");
    expect(f.observations.save).toHaveBeenCalledOnce();
  });
  it("uses real Chrome only after the explicit trial action and closes the old embedded browser", async () => {
    const f = fixture("system");
    await f.service.open(id);
    expect(f.launchChrome).not.toHaveBeenCalled();
    expect(await f.service.openChrome(id)).toMatchObject({ phase: "open", embedded: true, engine: "chrome" });
    expect(f.browser.stop).toHaveBeenCalledOnce();
    expect(f.launchChrome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transport: "system", accountId: id }),
    );
    expect(f.openTunnel).not.toHaveBeenCalled();
    expect(f.entries.get(id)).toEqual(account);
    await f.service.openChrome(id);
    expect(f.launchChrome).toHaveBeenCalledOnce();
    expect(f.chromeBrowser.stop).not.toHaveBeenCalled();
  });
  it("revokes Chrome along with the proxy lease and does not start Chrome with the proxy off", async () => {
    const f = fixture("system");
    f.acquireEligibility.mockResolvedValueOnce(null);
    expect(await f.service.openChrome(id)).toMatchObject({ phase: "dormant" });
    expect(f.launchChrome).not.toHaveBeenCalled();
    await f.service.openChrome(id);
    f.abort.abort();
    expect(f.launchChrome.mock.calls[0][0].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(f.service.state(id).phase).toBe("dormant"));
    expect(f.chromeBrowser.stop).toHaveBeenCalledOnce();
    expect(f.entries.get(id)).toEqual(account);
  });
  it("opens system-proxy websites in-app without exit probes, relays or Chrome profile checks", async () => {
    const f = fixture("system");
    expect(await f.service.open(id)).toMatchObject({ phase: "open" });
    expect(f.acquireEligibility).toHaveBeenCalledOnce();
    expect(f.openTunnel).not.toHaveBeenCalled();
    expect(f.createRelay).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledWith(expect.objectContaining({ transport: "system", accountId: id }));
    expect(f.launch.mock.calls[0][0]).not.toHaveProperty("endpoint");
    expect(f.launch.mock.calls[0][0]).not.toHaveProperty("profile");
  });
  it("revokes a system-proxy website on proxy-off while preserving its account and login storage", async () => {
    const f = fixture("system");
    await f.service.open(id);
    const input = f.launch.mock.calls[0][0];
    f.abort.abort();
    expect(input.signal.aborted).toBe(true);
    expect(() => input.assertCurrent()).toThrow();
    await vi.waitFor(() => expect(f.service.state(id).phase).toBe("dormant"));
    expect(f.browser.stop).toHaveBeenCalledOnce();
    expect(f.eligibility.release).toHaveBeenCalledOnce();
    expect(f.entries.get(id)).toEqual(account);
    expect(f.relay.dispose).not.toHaveBeenCalled();
  });
  it("does not close an in-app system website to launch an external browser", async () => {
    const f = fixture("system");
    await f.service.open(id);
    await expect(f.service.openExternal(id)).rejects.toThrow("GLOBAL_WEB_UNAVAILABLE");
    expect(f.browser.stop).not.toHaveBeenCalled();
    expect(f.service.state(id).phase).toBe("open");
  });
  it("reports an embedded main-document failure instead of leaving a blank open website", async () => {
    const f = fixture("system");
    await f.service.open(id);
    f.failBrowser(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
    await vi.waitFor(() =>
      expect(f.service.state(id)).toMatchObject({
        phase: "error",
        errorCode: "GLOBAL_WEB_BROWSER_UNAVAILABLE",
      }),
    );
    expect(f.browser.stop).toHaveBeenCalledOnce();
    expect(f.eligibility.release).toHaveBeenCalledOnce();
    expect(f.entries.get(id)).toEqual(account);
  });
  it("keeps the browser closed if the platform entry route fails despite general proxy eligibility", async () => {
    const f = fixture();
    f.openTunnel.mockRejectedValueOnce(new Error("GLOBAL_WEB_UNVERIFIED"));
    expect(await f.service.open(id)).toMatchObject({
      phase: "dormant",
      errorCode: "GLOBAL_WEB_PROXY_UNVERIFIED",
    });
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("starts closed and opens an independent environment without any API grant", async () => {
    const f = fixture();
    expect(f.service.state(id).phase).toBe("closed");
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect((await f.service.open(id)).phase).toBe("open");
    expect(f.claim).toHaveBeenCalledWith({
      dataDirectory: "C:\\controlled",
      accountId: id,
      platformId: "youtube",
    });
    expect(f.configure).toHaveBeenCalledWith(f.profile);
    expect(f.launch.mock.calls[0][0]).toMatchObject({
      platformId: "youtube",
      profile: f.profile,
      endpoint: { port: 12345 },
    });
    expect(f.entries.get(id)?.authStatus).toBe("unauthorized");
    expect(JSON.stringify(f.states)).not.toMatch(/directory|Cookie|token|pid|proxyPort/i);
  });
  it("does not create a profile or browser when proxy qualification fails", async () => {
    const f = fixture();
    f.acquireEligibility.mockResolvedValue(null);
    expect(await f.service.open(id)).toMatchObject({
      phase: "dormant",
      errorCode: "GLOBAL_WEB_PROXY_UNVERIFIED",
    });
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("revokes the relay synchronously, then closes the browser before releasing the profile", async () => {
    const f = fixture();
    await f.service.open(id);
    const signal = f.createRelay.mock.calls[0][0].signal;
    f.abort.abort();
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(f.service.state(id).phase).toBe("dormant"));
    expect(f.browser.stop).toHaveBeenCalledOnce();
    expect(f.profile.release.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.browser.stop.mock.invocationCallOrder[0],
    );
    expect(f.states.map((state) => state.phase)).toEqual([
      "checking",
      "opening",
      "open",
      "closing",
      "dormant",
    ]);
  });
  it("invalidates an open website when the proxy eligibility is withdrawn", async () => {
    const f = fixture();
    await f.service.open(id);
    f.service.invalidate();
    await vi.waitFor(() => expect(f.service.state(id).phase).toBe("dormant"));
    expect(f.browser.stop).toHaveBeenCalledOnce();
    expect(f.relay.dispose).toHaveBeenCalledOnce();
    expect(f.eligibility.release).toHaveBeenCalledOnce();
  });
  it("coalesces repeated opens instead of reusing a profile with ignored new proxy arguments", async () => {
    const f = fixture();
    await Promise.all([f.service.open(id), f.service.open(id)]);
    await f.service.open(id);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.claim).toHaveBeenCalledOnce();
  });
  it("waits for an in-progress close before returning a repeated open", async () => {
    const f = fixture();
    await f.service.open(id);
    let releaseStop!: () => void;
    const stop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    f.browser.stop.mockImplementationOnce(async () => {
      await stop;
      f.finish();
    });
    const closing = f.service.close(id);
    await vi.waitFor(() => expect(f.browser.stop).toHaveBeenCalledOnce());
    const repeated = f.service.open(id);
    await Promise.resolve();
    expect(f.service.state(id).phase).toBe("closing");
    releaseStop();
    await expect(closing).resolves.toMatchObject({ phase: "closed" });
    await expect(repeated).resolves.toMatchObject({ phase: "closed" });
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it("late eligibility after cancellation cannot launch a browser", async () => {
    const f = fixture();
    let give!: (value: typeof f.eligibility) => void;
    f.acquireEligibility.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          give = resolve;
        }),
    );
    const opening = f.service.open(id);
    await vi.waitFor(() => expect(f.acquireEligibility).toHaveBeenCalledOnce());
    const closing = f.service.close(id);
    give(f.eligibility);
    await Promise.all([opening, closing]);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.profile.release).not.toHaveBeenCalled();
    expect(f.eligibility.release).toHaveBeenCalled();
  });
  it("closes a browser which finishes launching after network revocation", async () => {
    const f = fixture();
    let give!: (value: typeof f.browser) => void;
    f.launch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          give = resolve;
        }),
    );
    const opening = f.service.open(id);
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    f.abort.abort();
    give(f.browser);
    await opening;
    expect(f.service.state(id).phase).toBe("dormant");
    expect(f.browser.stop).toHaveBeenCalled();
    expect(f.states.some((state) => state.phase === "open")).toBe(false);
  });
  it("retains cleanup failures and permits a retry without another profile or launch", async () => {
    const f = fixture();
    await f.service.open(id);
    f.profile.release.mockRejectedValueOnce(new Error("private profile location"));
    await expect(f.service.close(id)).rejects.toThrow("GLOBAL_WEB_CLEANUP_FAILED");
    expect(f.service.state(id)).toMatchObject({ phase: "error", errorCode: "GLOBAL_WEB_CLEANUP_FAILED" });
    await f.service.open(id);
    expect(f.launch).toHaveBeenCalledOnce();
    await expect(f.service.close(id)).resolves.toHaveProperty("phase", "closed");
  });
  it("closing the actual browser releases the network lease but preserves API/login metadata", async () => {
    const f = fixture();
    await f.service.open(id);
    f.finish();
    await vi.waitFor(() => expect(f.service.state(id).phase).toBe("closed"));
    expect(f.eligibility.release).toHaveBeenCalledOnce();
    expect(f.entries.get(id)).toEqual(account);
  });
  it("account deletion waits for browser shutdown and cannot bypass a cleanup failure", async () => {
    const f = fixture();
    await f.service.open(id);
    f.profile.release.mockRejectedValueOnce(new Error("busy"));
    await expect(f.service.beforeDelete(id)).rejects.toThrow("GLOBAL_WEB_CLEANUP_FAILED");
    expect(f.entries.has(id)).toBe(true);
    await f.service.beforeDelete(id);
    expect(f.service.state(id).phase).toBe("closed");
  });
  it("limits target hosts by platform even inside the independent browser relay", async () => {
    const f = fixture();
    await f.service.open(id);
    const guard = f.createRelay.mock.calls[0][0];
    expect(guard.allowTarget("youtube", "studio.youtube.com")).toBe(true);
    expect(guard.allowTarget("youtube", "creator.douyin.com")).toBe(false);
    expect(guard.allowTarget("youtube", "x.com")).toBe(false);
    await f.service.close(id);
    expect(() => guard.assertCurrent()).toThrow();
  });
});
