import { IPC } from "@shared/ipc-channels";
import { globalAccountIdSchema } from "@shared/global-accounts";
import {
  globalUploadErrorCode,
  globalUploadSubmitSchema,
  globalUploadJobSchema,
  globalUploadJobsSchema,
} from "@shared/global-uploads";
import type { GlobalUploadQueue } from "@main/api/global-upload-queue";
import type { IpcRegistrar } from "../register";

export function registerGlobalUploadHandlers(
  ipc: IpcRegistrar,
  queue: Pick<GlobalUploadQueue, "submit" | "list" | "cancel" | "check">,
): void {
  for (const [channel, op] of [
    [IPC.globalUploadsSubmit, "submit"],
    [IPC.globalUploadsList, "list"],
    [IPC.globalUploadsCancel, "cancel"],
    [IPC.globalUploadsCheck, "check"],
  ] as const) {
    ipc.handle(channel, (_event, raw: unknown) => {
      try {
        if (op === "submit") {
          const input = globalUploadSubmitSchema.safeParse(raw);
          if (!input.success) throw new Error("GLOBAL_UPLOAD_INVALID");
          const job = globalUploadJobSchema.parse(queue.submit(input.data));
          if (
            job.accountId !== input.data.accountId ||
            job.assetId !== input.data.assetId ||
            JSON.stringify(job.youtube ?? null) !== JSON.stringify(input.data.youtube ?? null)
          )
            throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
          return job;
        }
        const id = globalAccountIdSchema.safeParse(raw);
        if (!id.success) throw new Error("GLOBAL_UPLOAD_INVALID");
        if (op === "list") {
          const jobs = globalUploadJobsSchema.parse(queue.list(id.data));
          if (jobs.some((job) => job.accountId !== id.data)) throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
          return jobs;
        }
        const value = queue[op](id.data);
        if (op === "cancel" && value === null) return null;
        const job = globalUploadJobSchema.parse(value);
        if (job.id !== id.data) throw new Error("GLOBAL_UPLOAD_UNAVAILABLE");
        return job;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Never relay file paths, credentials or signed URLs.
        throw new Error(globalUploadErrorCode(error));
      }
    });
  }
}
