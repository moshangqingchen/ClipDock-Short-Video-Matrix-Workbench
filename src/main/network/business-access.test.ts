import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBusinessNetwork,
  businessPageOrigin,
  installBusinessNetwork,
  NetworkDormantError,
  prepareBusinessOperation,
  type BusinessNetworkController,
} from "./business-access";

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});
const selection = { operation: "collect" as const, activePageOrigin: null };
function install(overrides: Partial<BusinessNetworkController> = {}) {
  const controller: BusinessNetworkController = {
    enforcement: "strict",
    check: vi.fn(() => ({ allowed: false, reason: "CHECKING" })),
    acquire: vi.fn(() => null),
    prepareOperation: vi.fn(() => ({
      ready: Promise.resolve(),
      contextId: "fixture",
      scopeVersion: "fixture",
    })),
    ...overrides,
  };
  releases.push(installBusinessNetwork(controller));
  return controller;
}

describe("outer business operation declaration", () => {
  it("defaults closed when the coordinator adapter is missing", () => {
    expect(() => prepareBusinessOperation("account", selection)).toThrow(NetworkDormantError);
    install({ prepareOperation: undefined });
    expect(() => prepareBusinessOperation("account", selection)).toThrow(NetworkDormantError);
  });

  it("declares promptly without waiting for protection, acquiring a lease or granting permission", () => {
    const ready = new Promise<void>(() => {});
    const controller = install({
      prepareOperation: vi.fn(() => ({ ready, contextId: "f", scopeVersion: "f" })),
    });
    expect(prepareBusinessOperation("account", selection)).toBeUndefined();
    expect(controller.prepareOperation).toHaveBeenCalledWith("account", selection);
    expect(controller.check).not.toHaveBeenCalled();
    expect(controller.acquire).not.toHaveBeenCalled();
    expect(() => assertBusinessNetwork("account")).toThrow(NetworkDormantError);
  });

  it("returns fixed dormancy for invalid declarations without exposing a provider URL", () => {
    install({
      prepareOperation: () => {
        throw Error("https://private.example/token-path?secret=fixture");
      },
    });
    expect(() => prepareBusinessOperation("account", selection)).toThrow(NetworkDormantError);
    try {
      prepareBusinessOperation("account", selection);
    } catch (error) {
      expect(String(error)).not.toMatch(/private\.example|token-path|fixture/);
    }
  });

  it("handles cleanup rejection without turning it into readiness or replaying the activity", async () => {
    const controller = install({
      prepareOperation: vi.fn(() => ({
        ready: Promise.reject(Error("synthetic-cleanup-failure")),
        contextId: "f",
        scopeVersion: "f",
      })),
    });
    prepareBusinessOperation("account", selection);
    await Promise.resolve();
    expect(controller.prepareOperation).toHaveBeenCalledTimes(1);
    expect(controller.acquire).not.toHaveBeenCalled();
    expect(() => assertBusinessNetwork("account")).toThrow(NetworkDormantError);
  });

  it("observation preserves business behavior when declarations are unavailable or fail", () => {
    install({ enforcement: "observe", prepareOperation: undefined });
    expect(() => prepareBusinessOperation("account", selection)).not.toThrow();
    install({
      enforcement: "observe",
      prepareOperation: () => {
        throw Error("unreviewed");
      },
    });
    expect(() => prepareBusinessOperation("account", selection)).not.toThrow();
    expect(() => assertBusinessNetwork("account")).not.toThrow();
  });

  it("extracts only the origin of an actual HTTPS page", () => {
    expect(
      businessPageOrigin("https://Creator.Douyin.com/a/private-value?signature=secret#fragment"),
    ).toEqual({ protocol: "https:", host: "creator.douyin.com", port: 443 });
    expect(businessPageOrigin("https://creator.douyin.com:8443/path")).toEqual({
      protocol: "https:",
      host: "creator.douyin.com",
      port: 8443,
    });
  });

  it.each([
    null,
    undefined,
    "about:blank",
    "file:///private/file",
    "not a url",
    "https://user:secret@example.com",
  ])("does not fabricate a page origin from %s", (url) => expect(businessPageOrigin(url)).toBeNull());
});
