import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { IPC } from "@shared/ipc-channels";
import type { IpcRegistrar } from "../register";
import { registerGlobalWebHandlers } from "./global-web";
const id = "8e65b156-a2ee-48ac-957e-2f990141c207";
function fixture() {
  const handlers = new Map<string, (...raw: unknown[]) => Promise<unknown>>();
  const service = {
    observation: vi.fn(),
    observationHistory: vi.fn(),
    readPage: vi.fn(),
    state: vi.fn(),
    open: vi.fn(),
    openChrome: vi.fn(),
    close: vi.fn(),
    openExternal: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    go: vi.fn(),
    command: vi.fn(),
  };
  registerGlobalWebHandlers(
    {
      handleValidated(
        channel: string,
        schema: z.ZodType,
        handler: (event: null, id: unknown) => Promise<unknown>,
      ) {
        handlers.set(channel, async (raw) => handler(null, schema.parse(raw)));
      },
      handle(channel: string, handler: (event: null, ...raw: unknown[]) => unknown) {
        handlers.set(channel, async (...raw) => handler(null, ...raw));
      },
    } as unknown as IpcRegistrar,
    service,
  );
  return { service, run: (channel: string, ...raw: unknown[]) => handlers.get(channel)!(...raw) };
}
describe("website IPC", () => {
  it("keeps history account-bound and strips unexpected payloads", async () => {
    const f = fixture();
    f.service.observationHistory.mockReturnValue([]);
    expect(await f.run(IPC.globalWebObservationHistory, id)).toEqual([]);
    f.service.observationHistory.mockReturnValue([{ accountId: id, rawPage: "private" }]);
    await expect(f.run(IPC.globalWebObservationHistory, id)).rejects.toThrow(/^WEB_OBSERVE_UNAVAILABLE$/);
  });
  it("accepts the Chrome trial only for an account ID and exposes no native paths", async () => {
    const f = fixture();
    f.service.openChrome.mockResolvedValue({
      accountId: id,
      phase: "open",
      errorCode: null,
      embedded: true,
      engine: "chrome",
    });
    expect(await f.run(IPC.globalWebOpenChrome, id)).toMatchObject({ engine: "chrome" });
    await expect(f.run(IPC.globalWebOpenChrome, { id, executable: "C:\\other.exe" })).rejects.toThrow();
    expect(f.service.openChrome).toHaveBeenCalledExactlyOnceWith(id);
  });
  it("rejects platform strings, caller URLs and directories before reaching the service", async () => {
    const f = fixture();
    for (const raw of ["youtube", { id, url: "https://x.com", directory: "C:\\private" }])
      await expect(f.run(IPC.globalWebOpen, raw)).rejects.toThrow();
    expect(f.service.open).not.toHaveBeenCalled();
  });
  it("projects only exact public state and fixed errors", async () => {
    const f = fixture(),
      state = { accountId: id, phase: "open", errorCode: null };
    f.service.open.mockResolvedValue(state);
    expect(await f.run(IPC.globalWebOpen, id)).toEqual(state);
    f.service.open.mockResolvedValue({ ...state, Cookie: "private" });
    await expect(f.run(IPC.globalWebOpen, id)).rejects.toThrow(/^GLOBAL_WEB_UNAVAILABLE$/);
    f.service.close.mockRejectedValue(new Error("C:\\private\\token"));
    await expect(f.run(IPC.globalWebClose, id)).rejects.toThrow(/^GLOBAL_WEB_UNAVAILABLE$/);
  });
  it("accepts fixed publish and browser commands without accepting caller URLs or scripts", async () => {
    const f = fixture();
    await f.run(IPC.globalWebGo, id, "publish");
    expect(f.service.go).toHaveBeenCalledExactlyOnceWith(id, "publish");
    await f.run(IPC.globalWebCommand, id, "reload");
    expect(f.service.command).toHaveBeenCalledExactlyOnceWith(id, "reload");
    for (const value of [
      "https://x.com/compose/post",
      "javascript:alert(1)",
      { capability: "publish", submit: true },
    ])
      await expect(f.run(IPC.globalWebGo, id, value)).rejects.toThrow();
    await expect(f.run(IPC.globalWebCommand, id, "evaluate")).rejects.toThrow();
    expect(f.service.go).toHaveBeenCalledOnce();
    expect(f.service.command).toHaveBeenCalledOnce();
  });
});
