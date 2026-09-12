import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "./account-service";
import type { AssetService } from "./asset-service";
import {
  installBusinessNetwork,
  NetworkDormantError,
  type BusinessNetworkController,
} from "@main/network/business-access";
import { PublishService } from "./publish-service";

const uninstallers: Array<() => void> = [];

function fixture(allowedInitially = true) {
  let allowed = allowedInitially;
  let generation = 0;
  const leases: Array<{ abort: AbortController; release: ReturnType<typeof vi.fn> }> = [];
  const controller: BusinessNetworkController = {
    enforcement: "strict",
    check: vi.fn(() => ({ allowed, reason: allowed ? "READY" : "CHECKING" })),
    acquire: vi.fn(() => {
      if (!allowed) return null;
      const epoch = generation;
      const abort = new AbortController();
      let released = false;
      const release = vi.fn(() => {
        released = true;
      });
      leases.push({ abort, release });
      return { signal: abort.signal, isCurrent: () => epoch === generation && !released, release };
    }),
  };
  uninstallers.push(installBusinessNetwork(controller));
  const replies: Record<string, object> = {
    "DOM.getDocument": { root: { nodeId: 1 } },
    "DOM.querySelectorAll": { nodeIds: [2] },
    "DOM.getAttributes": { attributes: ["type", "file", "accept", "video/mp4"] },
    "DOM.setFileInputFiles": {},
  };
  const debug = {
    once: vi.fn(),
    isAttached: vi.fn(() => false),
    attach: vi.fn(() => debug.isAttached.mockReturnValue(true)),
    detach: vi.fn(),
    sendCommand: vi.fn<(method: string, params?: object) => Promise<object>>(
      async (method) => replies[method],
    ),
  };
  const contents = {
    isDestroyed: vi.fn(() => false),
    debugger: debug,
    getURL: vi.fn(() => "https://creator.douyin.com/creator-micro/content/upload"),
  };
  const accounts = {
    get: vi.fn(() => ({ id: "account-one", platformId: "douyin" })),
    prepareNetworkOperation: vi.fn(),
    go: vi.fn(async () => undefined),
  };
  const assets = { get: vi.fn(() => ({ filePath: "C:\\synthetic-fixture\\video.mp4" })) };
  const pool = { getWebContents: vi.fn(() => contents) };
  const store = { publish: { save: vi.fn() }, audit: { append: vi.fn() } };
  const service = new PublishService({
    store: store as unknown as Store,
    pool: pool as unknown as ViewPool,
    accounts: accounts as unknown as AccountService,
    assets: assets as unknown as AssetService,
  });
  return {
    service,
    controller,
    accounts,
    assets,
    pool,
    debug,
    replies,
    leases,
    store,
    revoke() {
      allowed = false;
      generation += 1;
      for (const lease of leases) lease.abort.abort();
    },
  };
}

beforeEach(() => {
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
});
afterEach(() => {
  for (const uninstall of uninstallers.splice(0)) uninstall();
  vi.restoreAllMocks();
});

describe("strict domestic publishing entrypoints", () => {
  it("declares the upload scope before inspecting files or the page", async () => {
    const f = fixture(true);
    f.accounts.prepareNetworkOperation.mockImplementation(() => {
      throw new NetworkDormantError("CATALOG_UNVERIFIED");
    });
    await expect(f.service.attachFiles("account-one", ["asset-one"])).rejects.toBeInstanceOf(
      NetworkDormantError,
    );
    expect(f.accounts.prepareNetworkOperation).toHaveBeenCalledWith("account-one", "view-upload");
    expect(f.assets.get).not.toHaveBeenCalled();
    expect(f.pool.getWebContents).not.toHaveBeenCalled();
    expect(f.debug.attach).not.toHaveBeenCalled();
  });

  it("rejects opening the upload page without navigating when dormant", async () => {
    const f = fixture(false);
    await expect(f.service.openUpload("account-one")).rejects.toBeInstanceOf(NetworkDormantError);
    expect(f.accounts.go).not.toHaveBeenCalled();
    expect(f.assets.get).not.toHaveBeenCalled();
    expect(f.pool.getWebContents).not.toHaveBeenCalled();
    expect(f.debug.attach).not.toHaveBeenCalled();
    expect(f.controller.check).toHaveBeenCalledWith(
      "account-one",
      "https://creator.douyin.com/creator-micro/content/upload",
    );
  });

  it("rejects file attachment before reading assets, checking files or touching DevTools", async () => {
    const f = fixture(false);
    await expect(f.service.attachFiles("account-one", ["asset-one"])).rejects.toBeInstanceOf(
      NetworkDormantError,
    );
    expect(f.assets.get).not.toHaveBeenCalled();
    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(f.pool.getWebContents).not.toHaveBeenCalled();
    expect(f.accounts.go).not.toHaveBeenCalled();
    expect(f.debug.isAttached).not.toHaveBeenCalled();
    expect(f.debug.attach).not.toHaveBeenCalled();
    expect(f.debug.sendCommand).not.toHaveBeenCalled();
    expect(f.store.publish.save).not.toHaveBeenCalled();
  });

  it.each(["DOM.getDocument", "DOM.querySelectorAll", "DOM.getAttributes"])(
    "does not hand files to the page after revocation during %s",
    async (pausedCommand) => {
      const f = fixture();
      let resume!: (value: object) => void;
      let markWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => {
        markWaiting = resolve;
      });
      f.debug.sendCommand.mockImplementation(async (method) => {
        if (method !== pausedCommand) return f.replies[method];
        markWaiting();
        return new Promise<object>((resolve) => {
          resume = resolve;
        });
      });
      const pending = f.service.attachFiles("account-one", ["asset-one"]);
      const rejected = expect(pending).rejects.toMatchObject({
        code: "NETWORK_DORMANT",
        reason: "GATE_REVOKED",
      });
      await waiting;
      f.revoke();
      resume(f.replies[pausedCommand]);
      await rejected;
      expect(f.debug.sendCommand.mock.calls.map(([method]) => method)).not.toContain("DOM.setFileInputFiles");
      expect(f.debug.detach).toHaveBeenCalledOnce();
      expect(f.leases[0].release).toHaveBeenCalledOnce();
      expect(f.accounts.go).not.toHaveBeenCalled();
      expect(f.store.publish.save).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "allows current attachment and preserves debugger ownership (already attached: %s)",
    async (alreadyAttached) => {
      const f = fixture();
      f.debug.isAttached.mockReturnValue(alreadyAttached);
      await expect(f.service.attachFiles("account-one", ["asset-one"])).resolves.toEqual({ attached: 1 });
      expect(f.debug.sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
        nodeId: 2,
        files: ["C:\\synthetic-fixture\\video.mp4"],
      });
      if (alreadyAttached) {
        expect(f.debug.attach).not.toHaveBeenCalled();
        expect(f.debug.detach).not.toHaveBeenCalled();
      } else {
        expect(f.debug.attach).toHaveBeenCalledWith("1.3");
        expect(f.debug.detach).toHaveBeenCalledOnce();
      }
      expect(f.leases[0].release).toHaveBeenCalledOnce();
      expect(f.accounts.go).not.toHaveBeenCalled();
      expect(f.store.publish.save).not.toHaveBeenCalled();
    },
  );
});
