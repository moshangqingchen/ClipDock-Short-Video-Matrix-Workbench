import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { WorkbenchApi } from "@shared/ipc";
const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.remove },
}));
const id = "8e65b156-a2ee-48ac-957e-2f990141c207",
  state = { accountId: id, phase: "open", errorCode: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});
async function api() {
  await import("./index");
  return (bridge.expose.mock.calls[0][1] as WorkbenchApi).globalWeb;
}
describe("website sandbox bridge", () => {
  it("loads local history without triggering login or accepting raw webpage content", async () => {
    const b = await api();
    bridge.invoke.mockResolvedValue([]);
    expect(await b.observationHistory(id)).toEqual([]);
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(IPC.globalWebObservationHistory, id);
    bridge.invoke.mockResolvedValue([{ accountId: id, text: "private" }]);
    await expect(b.observationHistory(id)).rejects.toThrow(/^WEB_OBSERVE_UNAVAILABLE$/);
  });
  it("does no startup network work and sends only account IDs", async () => {
    const b = await api();
    expect(bridge.invoke).not.toHaveBeenCalled();
    bridge.invoke.mockResolvedValue(state);
    expect(await b.open(id)).toEqual(state);
    expect(bridge.invoke).toHaveBeenCalledWith(IPC.globalWebOpen, id);
  });
  it.each([
    { ...state, directory: "C:\\private" },
    { ...state, token: "synthetic" },
    { ...state, accountId: "77777777-7777-4777-8777-777777777777" },
  ])("refuses untrusted result fields/identity (%j)", async (raw) => {
    const b = await api();
    bridge.invoke.mockResolvedValue(raw);
    await expect(b.open(id)).rejects.toThrow(/^GLOBAL_WEB_UNAVAILABLE$/);
  });
  it("strips native errors and validates change events", async () => {
    const b = await api();
    bridge.invoke.mockRejectedValue(new Error("Cookie: synthetic; C:\\private"));
    await expect(b.close(id)).rejects.toThrow(/^GLOBAL_WEB_UNAVAILABLE$/);
    const listener = vi.fn(),
      stop = b.onChanged(listener),
      handle = bridge.on.mock.calls[0][1];
    handle(null, { ...state, cookie: "synthetic" });
    expect(listener).not.toHaveBeenCalled();
    handle(null, state);
    expect(listener).toHaveBeenCalledWith(state);
    stop();
    expect(bridge.remove).toHaveBeenCalled();
  });
});
