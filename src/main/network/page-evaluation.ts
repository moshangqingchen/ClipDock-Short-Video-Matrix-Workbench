import type { WebContents } from "electron";
import type { BusinessOperation } from "./business-access";

/** Chromium may leave executeJavaScript pending after forced destruction. Main owns termination. */
export function evaluateWithLease<T>(
  contents: WebContents,
  script: string,
  operation: BusinessOperation,
  timeoutMs?: number,
): Promise<T> {
  operation.assertCurrent();
  if (contents.isDestroyed()) return Promise.reject(new Error("view-destroyed"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean, result: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      operation.signal.removeEventListener("abort", interrupted);
      contents.removeListener("destroyed", interrupted);
      if (success) resolve(result as T);
      else reject(result);
    };
    const interrupted = () => {
      try {
        operation.assertCurrent();
        finish(false, new Error("view-destroyed"));
      } catch (error) {
        finish(false, error);
      }
    };
    operation.signal.addEventListener("abort", interrupted, { once: true });
    contents.once("destroyed", interrupted);
    if (timeoutMs) timer = setTimeout(() => finish(false, new Error("page-evaluation-timeout")), timeoutMs);
    try {
      operation.assertCurrent();
      void contents.executeJavaScript(script, true).then(
        (result) => finish(true, result),
        (error) => finish(false, error),
      );
    } catch (error) {
      finish(false, error);
    }
  });
}
