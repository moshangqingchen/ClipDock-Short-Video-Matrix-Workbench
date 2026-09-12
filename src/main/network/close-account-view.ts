import type { WebContents } from "electron";

type ClosableContents = Pick<WebContents, "isDestroyed" | "stop" | "once" | "removeListener" | "close">;

/** Issue cancellation synchronously, then require actual destruction before a new permit can qualify. */
export function closeAccountView(contents: ClosableContents): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener("destroyed", destroyed);
      if (success) resolve();
      else reject(new Error("ACCOUNT_VIEW_CLOSE_FAILED"));
    };
    const destroyed = () => finish(true);
    const timer = setTimeout(() => finish(contents.isDestroyed()), 5_000);
    timer.unref?.();
    contents.once("destroyed", destroyed);
    try {
      contents.stop();
    } catch {
      /* Still force close the view if stop fails. */
    }
    try {
      contents.close({ waitForBeforeUnload: false });
      if (contents.isDestroyed()) finish(true);
    } catch {
      finish(false);
    }
  });
}
