import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { WorkbenchApi } from "@shared/ipc";
import type { GlobalUploadJob } from "@shared/global-uploads";
const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.remove },
}));
const job: GlobalUploadJob = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  assetId: "33333333-3333-4333-8333-333333333333",
  platformId: "tiktok",
  fileName: "video.mp4",
  state: "waiting-proxy",
  sentBytes: 0,
  totalBytes: 100,
  revision: 1,
  errorCode: "GLOBAL_UPLOAD_WAITING_PROXY",
  createdAt: "2026-09-08T10:00:00Z",
  updatedAt: "2026-09-08T10:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});
async function api() {
  await import("./index");
  return bridge.expose.mock.calls[0][1] as WorkbenchApi;
}
describe("upload preload boundary", () => {
  const metadata = {
    title: "视频",
    description: "",
    categoryId: "22",
    privacy: "private" as const,
    madeForKids: false,
    containsSyntheticMedia: true,
    notifySubscribers: false,
  };
  it("validates and preserves explicit YouTube metadata through the bridge", async () => {
    const b = await api(),
      result = { ...job, platformId: "youtube", youtube: metadata };
    bridge.invoke.mockResolvedValue(result);
    const input = { accountId: job.accountId, assetId: job.assetId, youtube: metadata };
    expect(await b.globalUploads.submit(input)).toEqual(result);
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(IPC.globalUploadsSubmit, input);
  });
  it("refuses a reply that changes the upload's privacy intent", async () => {
    const b = await api();
    bridge.invoke.mockResolvedValue({
      ...job,
      platformId: "youtube",
      youtube: { ...metadata, privacy: "public" },
    });
    await expect(
      b.globalUploads.submit({ accountId: job.accountId, assetId: job.assetId, youtube: metadata }),
    ).rejects.toThrow(/^GLOBAL_UPLOAD_UNAVAILABLE$/);
  });
  it("rejects private upload addresses in metadata before invoking main", async () => {
    const b = await api();
    await expect(
      b.globalUploads.submit({
        accountId: job.accountId,
        assetId: job.assetId,
        youtube: { ...metadata, uploadUrl: "private" } as typeof metadata,
      }),
    ).rejects.toThrow(/^GLOBAL_UPLOAD_INVALID$/);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("does no startup I/O and sends IDs for explicit upload and result queries", async () => {
    const b = await api();
    expect(bridge.invoke).not.toHaveBeenCalled();
    bridge.invoke.mockResolvedValue(job);
    const input = { accountId: job.accountId, assetId: job.assetId };
    expect(await b.globalUploads.submit(input)).toEqual(job);
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.globalUploadsSubmit, input);
    expect(await b.globalUploads.check(job.id)).toEqual(job);
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.globalUploadsCheck, job.id);
  });
  it.each(["uploadUrl", "publishId", "accessToken", "bindingHash"])(
    "refuses the private field %s in an IPC response",
    async (field) => {
      const b = await api();
      bridge.invoke.mockResolvedValue({ ...job, [field]: "private" });
      await expect(b.globalUploads.check(job.id)).rejects.toThrow(/^GLOBAL_UPLOAD_UNAVAILABLE$/);
    },
  );
  it("filters private events and unsubscribes without cancelling persisted work", async () => {
    const b = await api(),
      receive = vi.fn(),
      off = b.globalUploads.onChanged(receive);
    const event = bridge.on.mock.calls.find(([channel]) => channel === IPC.evGlobalUploadChanged)![1];
    event({}, { ...job, uploadUrl: "private" });
    expect(receive).not.toHaveBeenCalled();
    event({}, job);
    expect(receive).toHaveBeenCalledExactlyOnceWith(job);
    off();
    event({}, job);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("keeps known wrapped errors, never a raw provider message", async () => {
    const b = await api();
    bridge.invoke.mockRejectedValue(
      new Error("Error invoking remote method 'global-uploads:check': Error: GLOBAL_UPLOAD_UNCERTAIN"),
    );
    await expect(b.globalUploads.check(job.id)).rejects.toThrow(/^GLOBAL_UPLOAD_UNCERTAIN$/);
    bridge.invoke.mockRejectedValue(new Error("upload_token=private"));
    await expect(b.globalUploads.cancel(job.id)).rejects.toThrow(/^GLOBAL_UPLOAD_UNAVAILABLE$/);
  });
});
