import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import type { GlobalJob } from "@shared/global-jobs";
import type { IpcRegistrar } from "../register";
import { registerGlobalJobHandlers } from "./global-jobs";
const job: GlobalJob = {
  id: randomUUID(),
  accountId: randomUUID(),
  platformId: "youtube",
  kind: "read",
  state: "waiting-proxy",
  errorCode: "GLOBAL_READ_WAITING_PROXY",
  revision: 1,
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: null,
};
function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const ipc = {
    handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<unknown>) =>
      handlers.set(channel, fn),
  };
  const queue = {
    submit: vi.fn(() => job),
    list: vi.fn(() => [job]),
    cancel: vi.fn((): GlobalJob | null => null),
  };
  registerGlobalJobHandlers(ipc as unknown as IpcRegistrar, queue);
  return { queue, run: (channel: string, input: unknown) => handlers.get(channel)!(null, input) };
}
describe("international queue IPC", () => {
  it.each([IPC.globalJobsSubmit, IPC.globalJobsList, IPC.globalJobsCancel])(
    "%s accepts UUIDs only",
    async (channel) => {
      const f = fixture();
      await expect(
        f.run(channel, { accountId: job.accountId, token: "private", url: "https://private.test" }),
      ).rejects.toThrow(/^GLOBAL_READ_INPUT_INVALID$/);
      expect(f.queue.submit).not.toHaveBeenCalled();
      expect(f.queue.list).not.toHaveBeenCalled();
    },
  );
  it("submit returns a task, and list/cancel do not submit additional work", async () => {
    const f = fixture();
    expect(await f.run(IPC.globalJobsSubmit, job.accountId)).toEqual(job);
    expect(await f.run(IPC.globalJobsList, job.accountId)).toEqual([job]);
    expect(await f.run(IPC.globalJobsCancel, job.id)).toBeNull();
    expect(f.queue.submit).toHaveBeenCalledExactlyOnceWith(job.accountId);
    expect(f.queue.cancel).toHaveBeenCalledExactlyOnceWith(job.id);
  });
  it("rejects private bindings and mismatched job/account responses", async () => {
    const f = fixture();
    f.queue.submit.mockReturnValue({ ...job, bindingHash: "private" } as GlobalJob);
    await expect(f.run(IPC.globalJobsSubmit, job.accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    f.queue.list.mockReturnValue([{ ...job, accountId: randomUUID() }]);
    await expect(f.run(IPC.globalJobsList, job.accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    f.queue.cancel.mockReturnValue({ ...job, id: randomUUID() });
    await expect(f.run(IPC.globalJobsCancel, job.id)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
  });
  it("keeps fixed errors and never forwards raw database diagnostics", async () => {
    const f = fixture();
    f.queue.submit.mockImplementation(() => {
      throw new Error("token=private-secret");
    });
    await expect(f.run(IPC.globalJobsSubmit, job.accountId)).rejects.toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
    f.queue.submit.mockImplementation(() => {
      throw new Error("GLOBAL_READ_REAUTHORIZE");
    });
    await expect(f.run(IPC.globalJobsSubmit, job.accountId)).rejects.toThrow(/^GLOBAL_READ_REAUTHORIZE$/);
  });
});
