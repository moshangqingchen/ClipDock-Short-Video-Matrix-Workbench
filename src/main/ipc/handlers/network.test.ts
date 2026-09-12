import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import { DEFAULT_NETWORK_SETTINGS, checkingNetworkSnapshot, type NetworkSettings } from "@shared/network";
import type { NetworkObserver } from "@main/network/observer";
import type { NetworkSettingsRepository } from "@main/network/settings";
import type { IpcRegistrar } from "../register";
import { registerNetworkHandlers } from "./network";

function fixture(
  callback: () => void = () => undefined,
  refreshSource: () => Promise<void> = async () => undefined,
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    handleValidated: (
      channel: string,
      schema: { parse: (input: unknown) => unknown },
      fn: (...args: unknown[]) => unknown,
    ) => handlers.set(channel, (event, value) => fn(event, schema.parse(value))),
  };
  let current = { ...DEFAULT_NETWORK_SETTINGS };
  const settings = {
    get: vi.fn(() => current),
    set: vi.fn((value: NetworkSettings) => {
      current = value;
      return value;
    }),
  };
  const observer = { invalidate: vi.fn(), refresh: vi.fn(async () => checkingNetworkSnapshot()) };
  registerNetworkHandlers(
    ipc as unknown as IpcRegistrar,
    observer as unknown as NetworkObserver,
    settings as unknown as NetworkSettingsRepository,
    undefined,
    callback,
    refreshSource,
  );
  return {
    settings,
    observer,
    configure: (value: unknown) => handlers.get(IPC.networkConfigure)!(null, value),
    refresh: () => handlers.get(IPC.networkRefresh)!(null),
  };
}

describe("network settings lifecycle boundary", () => {
  it("commits the new endpoint then synchronously withdraws owner readiness before observer refresh", () => {
    let ownerReady = true;
    const events: string[] = [];
    const callback = vi.fn(() => {
      expect(f.settings.get().controllerUrl).toBe("http://127.0.0.1:9791");
      ownerReady = false;
      events.push("owner-revoked");
    });
    const f = fixture(callback);
    f.observer.invalidate.mockImplementation(() => {
      expect(ownerReady).toBe(false);
      events.push("observer-invalidated");
    });
    const input = { ...DEFAULT_NETWORK_SETTINGS, controllerUrl: "http://127.0.0.1:9791" };
    expect(f.configure(input)).toEqual(input);
    expect(events).toEqual(["owner-revoked", "observer-invalidated"]);
    expect(f.settings.set.mock.invocationCallOrder[0]).toBeLessThan(callback.mock.invocationCallOrder[0]);
  });

  it("invalid or failed settings do not disturb the existing owner lifecycle", () => {
    const callback = vi.fn();
    const f = fixture(callback);
    expect(() =>
      f.configure({ ...DEFAULT_NETWORK_SETTINGS, controllerUrl: "https://untrusted.example.com" }),
    ).toThrow();
    expect(f.settings.set).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(f.observer.invalidate).not.toHaveBeenCalled();
    f.settings.set.mockImplementation(() => {
      throw new Error("SETTINGS_WRITE_FAILED");
    });
    expect(() => f.configure(DEFAULT_NETWORK_SETTINGS)).toThrow("SETTINGS_WRITE_FAILED");
    expect(callback).not.toHaveBeenCalled();
    expect(f.observer.invalidate).not.toHaveBeenCalled();
  });

  it("still invalidates observation if lifecycle teardown unexpectedly throws after commit", () => {
    const f = fixture(() => {
      throw new Error("LIFECYCLE_RESET_FAILED");
    });
    expect(() => f.configure(DEFAULT_NETWORK_SETTINGS)).toThrow("LIFECYCLE_RESET_FAILED");
    expect(f.settings.set).toHaveBeenCalledOnce();
    expect(f.observer.invalidate).toHaveBeenCalledOnce();
  });
  it("manual refresh waits for selected-source inspection while keeping the observer projection", async () => {
    let resolve!: () => void;
    const source = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const f = fixture(undefined, source);
    let settled = false;
    const result = Promise.resolve(f.refresh()).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(f.observer.refresh).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    resolve();
    expect(await result).toMatchObject({ enforcement: "observe", state: "checking" });
  });
});
