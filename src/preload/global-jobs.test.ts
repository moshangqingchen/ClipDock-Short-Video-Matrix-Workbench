import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { WorkbenchApi } from "@shared/ipc";
import type { GlobalJob } from "@shared/global-jobs";
const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.remove },
}));
const job: GlobalJob = {
  id: "8e65b156-a2ee-48ac-957e-2f990141c208",
  accountId: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  kind: "read",
  state: "waiting-proxy",
  errorCode: "GLOBAL_READ_WAITING_PROXY",
  revision: 1,
  attempts: 0,
  createdAt: "2026-09-08T10:00:00Z",
  updatedAt: "2026-09-08T10:00:00Z",
  finishedAt: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});
async function api() {
  await import("./index");
  return bridge.expose.mock.calls[0][1] as WorkbenchApi;
}
describe("durable job preload projection", () => {
  it("does no startup work, sends only UUIDs, and exposes no direct refresh bypass", async () => {
    const b = await api();
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(Object.keys(b.globalRead)).toEqual(["get"]);
    bridge.invoke.mockResolvedValue(job);
    expect(await b.globalJobs.submit(job.accountId)).toEqual(job);
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.globalJobsSubmit, job.accountId);
    bridge.invoke.mockResolvedValue([job]);
    expect(await b.globalJobs.list(job.accountId)).toEqual([job]);
    bridge.invoke.mockResolvedValue(null);
    expect(await b.globalJobs.cancel(job.id)).toBeNull();
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.globalJobsCancel, job.id);
  });
  it("rejects extra private fields, missing submit results and mismatched identities", async () => {
    const b = await api();
    bridge.invoke.mockResolvedValue({ ...job, bindingHash: "private" });
    await expect(b.globalJobs.submit(job.accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    bridge.invoke.mockResolvedValue(null);
    await expect(b.globalJobs.submit(job.accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    bridge.invoke.mockResolvedValue([{ ...job, accountId: job.id }]);
    await expect(b.globalJobs.list(job.accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    bridge.invoke.mockResolvedValue({ ...job, id: job.accountId });
    await expect(b.globalJobs.cancel(job.id)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
  });
  it("filters malformed event payloads and removes the listener without cancelling the job", async () => {
    const b = await api(),
      onJob = vi.fn(),
      off = b.globalJobs.onChanged(onJob);
    const listener = bridge.on.mock.calls.find(([channel]) => channel === IPC.evGlobalJobChanged)![1];
    listener({}, { ...job, accessToken: "private" });
    expect(onJob).not.toHaveBeenCalled();
    listener({}, job);
    expect(onJob).toHaveBeenCalledExactlyOnceWith(job);
    off();
    listener({}, job);
    expect(onJob).toHaveBeenCalledTimes(1);
    expect(bridge.remove).toHaveBeenCalledWith(IPC.evGlobalJobChanged, listener);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("keeps safe wrapped errors and suppresses raw private messages", async () => {
    const b = await api();
    bridge.invoke.mockRejectedValue(
      new Error("Error invoking remote method 'global-jobs:submit': Error: GLOBAL_READ_REAUTHORIZE"),
    );
    await expect(b.globalJobs.submit(job.accountId)).rejects.toThrow(/^GLOBAL_READ_REAUTHORIZE$/);
    bridge.invoke.mockRejectedValue(new Error("Cookie: private-value"));
    await expect(b.globalJobs.cancel(job.id)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
  });
});
