import { z } from "zod";
import { IPC, accountIdSchema, publishRecordInputSchema } from "@shared/ipc";
import type { PublishService } from "@main/services/publish-service";
import type { IpcRegistrar } from "../register";

export function registerPublishHandlers(ipc: IpcRegistrar, publish: PublishService): void {
  ipc.handle(IPC.publishList, (_e, accountId: unknown) =>
    publish.list(accountId == null ? undefined : accountIdSchema.parse(accountId)),
  );
  ipc.handleValidated(IPC.publishSave, publishRecordInputSchema, (_e, input) => publish.save(input));
  ipc.handleValidated(IPC.publishDelete, z.string().uuid(), (_e, id) => publish.delete(id));
  ipc.handleValidated(IPC.publishOpenUpload, accountIdSchema, (_e, id) => publish.openUpload(id));
  ipc.handle(IPC.publishAttachFiles, (_e, accountId: unknown, assetIds: unknown) =>
    publish.attachFiles(accountIdSchema.parse(accountId), z.array(z.string().uuid()).max(50).parse(assetIds)),
  );
}
