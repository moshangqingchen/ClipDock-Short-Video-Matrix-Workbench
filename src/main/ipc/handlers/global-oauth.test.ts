import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { GlobalOAuthState } from "@shared/global-oauth";
import type { IpcRegistrar } from "../register";
import { registerGlobalOAuthHandlers } from "./global-oauth";

const id = "8e65b156-a2ee-48ac-957e-2f990141c207";
const state: GlobalOAuthState = {
  accountId: id,
  platformId: "youtube",
  transactionId: null,
  phase: "idle",
  errorCode: null,
};
function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (event: unknown, input: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const service = {
    state: vi.fn(() => state),
    start: vi.fn(async () => state),
    startDraft: vi.fn(async () => state),
    startUpload: vi.fn(async () => state),
    cancel: vi.fn(() => state),
  };
  registerGlobalOAuthHandlers(ipc as unknown as IpcRegistrar, service);
  return { service, run: (channel: string, input: unknown) => handlers.get(channel)!(null, input) };
}
describe("explicit global OAuth IPC", () => {
  it.each([
    IPC.globalOAuthState,
    IPC.globalOAuthStart,
    IPC.globalOAuthStartDraft,
    IPC.globalOAuthStartUpload,
    IPC.globalOAuthCancel,
  ])("validates UUID before %s and never accepts a renderer authorization payload", async (channel) => {
    const f = fixture();
    for (const input of ["youtube", { accountId: id, code: "private-code" }, "https://private.example/"])
      await expect(f.run(channel, input)).rejects.toThrow("GLOBAL_OAUTH_INVALID_ACCOUNT");
    expect(f.service.state).not.toHaveBeenCalled();
    expect(f.service.start).not.toHaveBeenCalled();
    expect(f.service.startDraft).not.toHaveBeenCalled();
    expect(f.service.cancel).not.toHaveBeenCalled();
  });
  it("routes an explicit draft consent to the separate main-only operation", async () => {
    const f = fixture();
    expect(await f.run(IPC.globalOAuthStartDraft, id)).toEqual(state);
    expect(f.service.startDraft).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.service.start).not.toHaveBeenCalled();
  });
  it("does not invoke any workflow merely on registration or reading state", async () => {
    const f = fixture();
    expect(f.service.start).not.toHaveBeenCalled();
    expect(await f.run(IPC.globalOAuthState, id)).toEqual(state);
    expect(f.service.state).toHaveBeenCalledWith(id);
    expect(f.service.start).not.toHaveBeenCalled();
    expect(await f.run(IPC.globalOAuthStart, id)).toEqual(state);
    expect(f.service.start).toHaveBeenCalledWith(id);
    expect(await f.run(IPC.globalOAuthCancel, id)).toEqual(state);
    expect(f.service.cancel).toHaveBeenCalledWith(id);
  });
  it("strips secret extras and rejects mismatched identity instead of returning them", async () => {
    const f = fixture();
    f.service.start.mockResolvedValue({
      ...state,
      code: "private-code",
      token: "private-token",
      authorizationUrl: "https://private.example",
    } as GlobalOAuthState);
    expect(await f.run(IPC.globalOAuthStart, id)).toEqual(state);
    f.service.start.mockResolvedValue({ ...state, accountId: "34e48c6d-c367-46ab-96ef-78dca825fd99" });
    await expect(f.run(IPC.globalOAuthStart, id)).rejects.toThrow("GLOBAL_OAUTH_UNAVAILABLE");
  });
  it("normalizes both synchronous and asynchronous service failures", async () => {
    const f = fixture();
    f.service.state.mockImplementation(() => {
      throw new Error("private-secret database path");
    });
    f.service.start.mockRejectedValue({
      code: "GLOBAL_OAUTH_PROXY_UNVERIFIED",
      message: "Bearer private-token",
    });
    await expect(f.run(IPC.globalOAuthState, id)).rejects.toThrow(/^GLOBAL_OAUTH_UNAVAILABLE$/);
    await expect(f.run(IPC.globalOAuthStart, id)).rejects.toThrow(/^GLOBAL_OAUTH_PROXY_UNVERIFIED$/);
  });
});
