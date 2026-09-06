import { Notification } from "electron";
import type { ToastEvent } from "@shared/ipc";

export type Notifier = (toast: ToastEvent, system?: boolean) => void;

/**
 * Fan a toast out to the renderer and, when requested, to the OS notification
 * center (so a logged-out account is noticed while the window is minimized).
 */
export function createNotifier(sendToRenderer: (toast: ToastEvent) => void): Notifier {
  let lastSystemAt = 0;
  return (toast, system = false) => {
    sendToRenderer(toast);
    if (!system) return;
    // Rate-limit OS notifications so a flapping network does not spam.
    const now = Date.now();
    if (now - lastSystemAt < 4_000) return;
    lastSystemAt = now;
    try {
      if (!Notification.isSupported()) return;
      new Notification({
        title: toast.title,
        body: toast.message ?? "",
        silent: toast.kind === "info",
      }).show();
    } catch {
      // notifications are optional
    }
  };
}
