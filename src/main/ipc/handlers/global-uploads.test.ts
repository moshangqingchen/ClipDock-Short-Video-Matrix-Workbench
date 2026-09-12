import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { GlobalUploadJob } from "@shared/global-uploads";
import type { IpcRegistrar } from "../register";
import { registerGlobalUploadHandlers } from "./global-uploads";
const job: GlobalUploadJob = {
  id: randomUUID(),
  accountId: randomUUID(),
  assetId: randomUUID(),
  platformId: "tiktok",
  fileName: "video.mp4",
  state: "waiting-proxy",
  sentBytes: 0,
  totalBytes: 100,
  revision: 1,
  errorCode: "GLOBAL_UPLOAD_WAITING_PROXY",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
  const queue = {
    submit: vi.fn(() => job),
    list: vi.fn(() => [job]),
    cancel: vi.fn((): GlobalUploadJob | null => null),
    check: vi.fn(() => job),
  };
  registerGlobalUploadHandlers(
    {
      handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => handlers.set(channel, fn),
    } as unknown as IpcRegistrar,
    queue,
  );
  return { queue, run: (channel: string, raw: unknown) => handlers.get(channel)!(null, raw) };
}
describe("TikTok upload IPC", () => {
  const metadata = {
    title: "视频",
    description: "",
    categoryId: "22",
    privacy: "private" as const,
    madeForKids: false,
    containsSyntheticMedia: true,
    notifySubscribers: false,
  };
  it("round-trips validated YouTube metadata and rejects substituted privacy", () => {
    const f = fixture(),
      input = { accountId: job.accountId, assetId: job.assetId, youtube: metadata };
    const result: GlobalUploadJob = { ...job, platformId: "youtube", youtube: metadata };
    f.queue.submit.mockReturnValue(result);
    expect(f.run(IPC.globalUploadsSubmit, input)).toEqual(result);
    expect(f.queue.submit).toHaveBeenCalledExactlyOnceWith(input);
    f.queue.submit.mockReturnValue({ ...result, youtube: { ...metadata, privacy: "public" } });
    expect(() => f.run(IPC.globalUploadsSubmit, input)).toThrow(/^GLOBAL_UPLOAD_UNAVAILABLE$/);
  });
  it("returns persisted intent for account and asset IDs only", () => {
    const f = fixture();
    expect(f.run(IPC.globalUploadsSubmit, { accountId: job.accountId, assetId: job.assetId })).toEqual(job);
    expect(f.run(IPC.globalUploadsList, job.accountId)).toEqual([job]);
    expect(f.run(IPC.globalUploadsCancel, job.id)).toBeNull();
    expect(f.run(IPC.globalUploadsCheck, job.id)).toEqual(job);
  });
  it.each(["filePath", "uploadUrl", "accessToken", "headers"])(
    "rejects caller-supplied %s without invoking a service",
    (field) => {
      const f = fixture();
      expect(() =>
        f.run(IPC.globalUploadsSubmit, {
          accountId: job.accountId,
          assetId: job.assetId,
          [field]: "private",
        }),
      ).toThrow(/^GLOBAL_UPLOAD_INVALID$/);
      expect(f.queue.submit).not.toHaveBeenCalled();
    },
  );
  it.each([IPC.globalUploadsCancel, IPC.globalUploadsCheck, IPC.globalUploadsList])(
    "%s accepts a UUID and no remote task data",
    (channel) => {
      const f = fixture();
      expect(() => f.run(channel, { id: job.id, publishId: "remote" })).toThrow(/^GLOBAL_UPLOAD_INVALID$/);
    },
  );
  it("refuses private result fields and mismatched IDs", () => {
    const f = fixture();
    f.queue.submit.mockReturnValue({ ...job, uploadUrl: "private" } as GlobalUploadJob);
    expect(() => f.run(IPC.globalUploadsSubmit, { accountId: job.accountId, assetId: job.assetId })).toThrow(
      /^GLOBAL_UPLOAD_UNAVAILABLE$/,
    );
    f.queue.check.mockReturnValue({ ...job, id: randomUUID() });
    expect(() => f.run(IPC.globalUploadsCheck, job.id)).toThrow(/^GLOBAL_UPLOAD_UNAVAILABLE$/);
  });
  it("suppresses native diagnostics and preserves only known error codes", () => {
    const f = fixture();
    f.queue.check.mockImplementation(() => {
      throw new Error("signed-private-path");
    });
    expect(() => f.run(IPC.globalUploadsCheck, job.id)).toThrow(/^GLOBAL_UPLOAD_UNAVAILABLE$/);
    f.queue.check.mockImplementation(() => {
      throw new Error("GLOBAL_UPLOAD_UNCERTAIN");
    });
    expect(() => f.run(IPC.globalUploadsCheck, job.id)).toThrow(/^GLOBAL_UPLOAD_UNCERTAIN$/);
  });
});
