import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc";
import type { IpcRegistrar } from "../register";
import type { AccountService } from "@main/services/account-service";
import type { ViewPool } from "@main/browser/view-pool";
import { NetworkDormantError } from "@main/network/business-access";
import { registerViewHandlers } from "./views";

const id = "8e65b156-a2ee-48ac-957e-2f990141c207";
function fixture(target: string | null) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    handleValidated: (
      channel: string,
      schema: { parse: (input: unknown) => unknown },
      fn: (...args: unknown[]) => unknown,
    ) => handlers.set(channel, (event, value) => fn(event, schema.parse(value))),
  };
  const accounts = { get: vi.fn(() => ({ id, platformId: "bilibili" })), prepareNetworkOperation: vi.fn(), showView: vi.fn() };
  const pool = { historyTarget: vi.fn(() => target), back: vi.fn(), forward: vi.fn() };
  registerViewHandlers(
    ipc as unknown as IpcRegistrar,
    pool as unknown as ViewPool,
    accounts as unknown as AccountService,
  );
  return { accounts, pool, run: (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, id, ...args) };
}

describe("foreground homepage entry", () => {
  const bounds = { x: 0, y: 0, width: 640, height: 480 };
  it("passes an explicit homepage entry and defaults ordinary restores to false", () => {
    const f = fixture(null);
    f.run(IPC.viewShow, bounds, true);
    expect(f.accounts.showView).toHaveBeenLastCalledWith(id, bounds, true);
    f.run(IPC.viewShow, bounds);
    expect(f.accounts.showView).toHaveBeenLastCalledWith(id, bounds, false);
  });
  it("rejects a malformed homepage entry option before opening a view", () => {
    const f = fixture(null);
    expect(() => f.run(IPC.viewShow, bounds, "true")).toThrow("主页入口参数无效");
    expect(f.accounts.showView).not.toHaveBeenCalled();
  });
});

describe("history navigation scope", () => {
  it("declares the exact history destination before Chromium moves", () => {
    const url = "https://passport.bilibili.com/login";
    const f = fixture(url);
    f.run(IPC.viewBack);
    expect(f.pool.historyTarget).toHaveBeenCalledWith(id, "back");
    expect(f.accounts.prepareNetworkOperation).toHaveBeenCalledWith(id, "view-navigate", url);
    expect(f.accounts.prepareNetworkOperation.mock.invocationCallOrder[0]).toBeLessThan(
      f.pool.back.mock.invocationCallOrder[0],
    );
  });
  it("does not move when the target scope cannot be authorized", () => {
    const f = fixture("https://member.bilibili.com/platform/home");
    f.accounts.prepareNetworkOperation.mockImplementation(() => {
      throw new NetworkDormantError();
    });
    expect(() => f.run(IPC.viewForward)).toThrow(NetworkDormantError);
    expect(f.pool.forward).not.toHaveBeenCalled();
  });
  it("rejects an international history destination before preparing it", () => {
    const f = fixture("https://www.youtube.com/");
    expect(() => f.run(IPC.viewBack)).toThrow(/不属于此平台/);
    expect(f.accounts.prepareNetworkOperation).not.toHaveBeenCalled();
    expect(f.pool.back).not.toHaveBeenCalled();
  });
  it("does not invent a target when history has no next entry", () => {
    const f = fixture(null);
    f.run(IPC.viewForward);
    expect(f.accounts.prepareNetworkOperation).not.toHaveBeenCalled();
    expect(f.pool.forward).not.toHaveBeenCalled();
  });
});
