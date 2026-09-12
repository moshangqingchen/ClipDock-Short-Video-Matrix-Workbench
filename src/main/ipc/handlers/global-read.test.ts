import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { GlobalReadSnapshot } from "@shared/global-read";
import type { IpcRegistrar } from "../register";
import { registerGlobalReadHandlers } from "./global-read";

const accountId = randomUUID();
const snapshot: GlobalReadSnapshot = {
  accountId,
  platformId: "youtube",
  remoteId: "remote-channel",
  fetchedAt: new Date().toISOString(),
  profile: { displayName: "Channel", username: null },
  totals: { followers: "9007199254740993", following: null, works: "1", views: null, likes: null },
  works: [],
  hasMoreWorks: null,
  capabilities: { readProfile: "ready", readMetrics: "ready", listWorks: "forbidden" },
};
function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
  const ipc = {
    handle: (key: string, handler: (event: unknown, input: unknown) => unknown) => handlers.set(key, handler),
  };
  const service = {
    get: vi.fn((): GlobalReadSnapshot | null => null),
    refresh: vi.fn(async () => snapshot),
    cancel: vi.fn(),
  };
  registerGlobalReadHandlers(ipc as unknown as IpcRegistrar, service);
  return { service, handlers, run: (channel: string, input: unknown) => handlers.get(channel)!(null, input) };
}
describe("global official-read IPC", () => {
  it("accepts only an account UUID, never renderer tokens, URLs or arbitrary request fields", async () => {
    const f = fixture();
    await expect(
      f.run(IPC.globalReadGet, { accountId, token: "private", url: "https://example.test" }),
    ).rejects.toThrow("GLOBAL_READ_INPUT_INVALID");
    expect(f.service.get).not.toHaveBeenCalled();
    expect(f.service.refresh).not.toHaveBeenCalled();
  });
  it("registers local get only, without a direct network refresh or account-cancel bypass", async () => {
    const f = fixture();
    expect(await f.run(IPC.globalReadGet, accountId)).toBeNull();
    expect([...f.handlers.keys()]).toEqual([IPC.globalReadGet]);
    expect(f.service.refresh).not.toHaveBeenCalled();
    f.service.get.mockReturnValue(snapshot);
    expect(await f.run(IPC.globalReadGet, accountId)).toEqual(snapshot);
  });
  it("rejects secret-bearing or mismatched results and preserves exact public counts", async () => {
    const f = fixture();
    f.service.get.mockReturnValue(snapshot);
    expect(((await f.run(IPC.globalReadGet, accountId)) as GlobalReadSnapshot).totals.followers).toBe(
      "9007199254740993",
    );
    f.service.get.mockReturnValue({ ...snapshot, token: "secret-response" } as GlobalReadSnapshot);
    await expect(f.run(IPC.globalReadGet, accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    f.service.get.mockReturnValue({ ...snapshot, accountId: randomUUID() });
    await expect(f.run(IPC.globalReadGet, accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
  });
  it("retains fixed public error codes and never forwards raw provider errors", async () => {
    const f = fixture();
    f.service.get.mockImplementation(() => {
      throw new Error("Bearer private-token /private/path");
    });
    await expect(f.run(IPC.globalReadGet, accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    f.service.get.mockImplementation(() => {
      throw new Error("GLOBAL_READ_WAITING_PROXY");
    });
    await expect(f.run(IPC.globalReadGet, accountId)).rejects.toThrow(/^GLOBAL_READ_WAITING_PROXY$/);
  });
});
