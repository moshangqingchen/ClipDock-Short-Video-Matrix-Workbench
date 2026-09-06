import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { z } from "zod";

export interface IpcRegistrar {
  /** Register an invoke handler; only the shell WebContents may call it. */
  handle<Args extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>,
  ): void;
  /** Register with zod-validated first argument. */
  handleValidated<S extends z.ZodTypeAny, R>(
    channel: string,
    schema: S,
    fn: (event: IpcMainInvokeEvent, input: z.output<S>) => R | Promise<R>,
  ): void;
  send(channel: string, payload: unknown): void;
  dispose(): void;
}

export function createIpcRegistrar(shell: () => WebContents | null): IpcRegistrar {
  const channels: string[] = [];

  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const wc = shell();
    if (!wc || wc.isDestroyed()) return false;
    if (event.sender.id !== wc.id) return false;
    // Only the shell's main frame may invoke privileged handlers.
    if (event.senderFrame && event.senderFrame.parent !== null) return false;
    return true;
  };

  const wrap = <Args extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      try {
        return await fn(event, ...(args as Args));
      } catch (error) {
        // Surface a clean message to the renderer; stack traces stay in main.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message, { cause: error });
      }
    });
    channels.push(channel);
  };

  return {
    handle: wrap,
    handleValidated(channel, schema, fn) {
      wrap(channel, (event, raw: unknown) => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success)
          throw new Error(
            `参数无效: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`,
          );
        return fn(event, parsed.data);
      });
    },
    send(channel, payload) {
      const wc = shell();
      if (wc && !wc.isDestroyed()) wc.send(channel, payload);
    },
    dispose() {
      for (const channel of channels.splice(0)) ipcMain.removeHandler(channel);
    },
  };
}
