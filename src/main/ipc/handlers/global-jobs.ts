import { IPC } from "@shared/ipc-channels";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { globalJobSchema, globalJobsSchema } from "@shared/global-jobs";
import { globalReadErrorCode } from "@shared/global-read";
import type { GlobalJobQueue } from "@main/api/global-job-queue";
import type { IpcRegistrar } from "../register";

export function registerGlobalJobHandlers(
  ipc: IpcRegistrar,
  queue: Pick<GlobalJobQueue, "submit" | "list" | "cancel">,
): void {
  for (const [channel, operation] of [
    [IPC.globalJobsSubmit, "submit"],
    [IPC.globalJobsList, "list"],
    [IPC.globalJobsCancel, "cancel"],
  ] as const)
    ipc.handle(channel, async (_event, raw: unknown) => {
      const input = globalAccountIdSchema.safeParse(raw);
      if (!input.success) throw new Error("GLOBAL_READ_INPUT_INVALID");
      try {
        const result = queue[operation](input.data);
        if (operation === "list") {
          const jobs = globalJobsSchema.safeParse(result);
          if (!jobs.success || jobs.data.some((job) => job.accountId !== input.data))
            throw new Error("GLOBAL_READ_UNAVAILABLE");
          return jobs.data;
        }
        if (operation === "cancel" && result === null) return null;
        const job = globalJobSchema.safeParse(result);
        if (!job.success || (operation === "submit" ? job.data.accountId : job.data.id) !== input.data)
          throw new Error("GLOBAL_READ_UNAVAILABLE");
        return job.data;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Never expose private bindings, credentials or SQL diagnostics.
        throw new Error(globalReadErrorCode(error));
      }
    });
}
