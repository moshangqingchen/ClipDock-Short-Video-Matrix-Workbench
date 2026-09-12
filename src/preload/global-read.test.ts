import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { WorkbenchApi } from "@shared/ipc";
const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.remove },
}));
const accountId = "8e65b156-a2ee-48ac-957e-2f990141c207";
beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});
async function api() {
  await import("./index");
  return bridge.expose.mock.calls[0][1] as WorkbenchApi;
}
describe("sandbox official-read bridge", () => {
  it("does no work at startup, sends only UUID, and permits null only for local snapshots", async () => {
    const b = await api();
    expect(bridge.invoke).not.toHaveBeenCalled();
    bridge.invoke.mockResolvedValue(null);
    expect(await b.globalRead.get(accountId)).toBeNull();
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.globalReadGet, accountId);
    expect(Object.keys(b.globalRead)).toEqual(["get"]);
    await b.globalRead.get(accountId);
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.globalReadGet, accountId);
  });
  it("refuses raw responses with credentials and strips private error messages", async () => {
    const b = await api();
    bridge.invoke.mockResolvedValue({ accountId, accessToken: "secret", response: "private" });
    await expect(b.globalRead.get(accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    bridge.invoke.mockRejectedValue(
      new Error("Error invoking remote method 'global-read:get': Error: GLOBAL_READ_WAITING_PROXY"),
    );
    await expect(b.globalRead.get(accountId)).rejects.toThrow(/^GLOBAL_READ_WAITING_PROXY$/);
    bridge.invoke.mockRejectedValue(new Error("Cookie: private-value"));
    await expect(b.globalRead.get(accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
  });
});
