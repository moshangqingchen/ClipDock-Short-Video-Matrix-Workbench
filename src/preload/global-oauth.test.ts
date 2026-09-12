import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { WorkbenchApi } from "@shared/ipc";
const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.remove },
}));
const id = "8e65b156-a2ee-48ac-957e-2f990141c207";
const state = { accountId: id, platformId: "youtube", transactionId: null, phase: "idle", errorCode: null };
async function fixture() {
  await import("./index");
  return bridge.expose.mock.calls[0][1] as WorkbenchApi;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});
describe("sandbox OAuth bridge", () => {
  it("exposes only explicit state/start/cancel/subscription and filters invoke results", async () => {
    const api = await fixture();
    expect(Object.keys(api.globalOAuth)).toEqual([
      "state",
      "start",
      "startDraft",
      "startUpload",
      "cancel",
      "onState",
    ]);
    expect(bridge.invoke).not.toHaveBeenCalled();
    bridge.invoke.mockResolvedValue({ ...state, state: "private-state", token: "private-token" });
    for (const [method, channel] of [
      ["state", IPC.globalOAuthState],
      ["start", IPC.globalOAuthStart],
      ["cancel", IPC.globalOAuthCancel],
    ] as const) {
      expect(await api.globalOAuth[method](id)).toEqual(state);
      expect(bridge.invoke).toHaveBeenLastCalledWith(channel, id);
    }
  });
  it("does not forward malformed events, secret fields or callbacks after unsubscribe", async () => {
    const api = await fixture();
    const handler = vi.fn();
    const off = api.globalOAuth.onState(handler);
    const [channel, listener] = bridge.on.mock.calls[0];
    expect(channel).toBe(IPC.evGlobalOAuthState);
    listener({}, { ...state, token: "private-token" });
    expect(handler).toHaveBeenCalledExactlyOnceWith(state);
    listener({}, { ...state, errorCode: "private-error" });
    off();
    off();
    listener({}, state);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bridge.remove).toHaveBeenCalledExactlyOnceWith(channel, listener);
  });
  it("normalizes raw errors and rejects a response for another account", async () => {
    const api = await fixture();
    bridge.invoke.mockRejectedValue(new Error("Bearer private-secret"));
    await expect(api.globalOAuth.start(id)).rejects.toThrow(/^GLOBAL_OAUTH_UNAVAILABLE$/);
    bridge.invoke.mockResolvedValue({ ...state, accountId: "34e48c6d-c367-46ab-96ef-78dca825fd99" });
    await expect(api.globalOAuth.state(id)).rejects.toThrow(/^GLOBAL_OAUTH_UNAVAILABLE$/);
  });
});
