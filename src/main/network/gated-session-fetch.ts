import type { Session } from "electron";
import { beginBusinessOperation } from "./business-access";

/** Keep the lease until the response body is consumed, so revocation aborts active probes. */
export async function gatedSessionFetch(
  accountId: string,
  session: Pick<Session, "fetch">,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string; url: string }> {
  const operation = beginBusinessOperation(accountId, url);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8_000);
  const signals = [operation.signal, timeout.signal];
  if (init.signal) signals.push(init.signal);
  const signal = AbortSignal.any(signals);
  try {
    operation.assertCurrent();
    const response = await session.fetch(url, { ...init, credentials: "include", signal });
    operation.assertCurrent();
    let text = "";
    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (bytes < 20_000) {
          operation.assertCurrent();
          const chunk = await reader.read();
          if (chunk.done) break;
          const piece = chunk.value.subarray(0, 20_000 - bytes);
          bytes += piece.byteLength;
          text += decoder.decode(piece, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    operation.assertCurrent();
    return { status: response.status, text, url: response.url };
  } catch (error) {
    // A revoked probe must not be reported as an authentication/network failure.
    operation.assertCurrent();
    throw error;
  } finally {
    clearTimeout(timer);
    timeout.abort();
    operation.release();
  }
}
