import { net, type ClientRequest, type Session } from "electron";
import { assertBusinessNetwork, beginBusinessOperation } from "./business-access";

export interface SessionProbeResult {
  status: number;
  text: string;
  url: string;
}

/**
 * A bounded GET probe with an observable redirect chain. Electron 43's Session.fetch
 * constructs a Response without its URL, so it cannot supply final-origin evidence.
 * ClientRequest uses the same Chromium Session and webRequest guard. No new session,
 * proxy choice or credential copy is involved.
 */
export async function gatedSessionProbe(
  accountId: string,
  session: Session,
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<SessionProbeResult> {
  const initial = probeUrl(url);
  if (!initial) throw new Error("INVALID_SESSION_PROBE_TARGET");
  const operation = beginBusinessOperation(accountId, initial.href);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8_000);
  const signal = AbortSignal.any([operation.signal, timeout.signal, ...(init.signal ? [init.signal] : [])]);
  let request: ClientRequest | undefined;
  let abort: (() => void) | undefined;
  try {
    operation.assertCurrent();
    signal.throwIfAborted();
    return await new Promise<SessionProbeResult>((resolve, reject) => {
      let settled = false;
      let current = initial;
      let redirects = 0;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
        request?.abort();
      };
      const succeed = (status: number, text: string) => {
        if (settled) return;
        try {
          operation.assertCurrent();
          signal.throwIfAborted();
          assertBusinessNetwork(accountId, current.href);
          settled = true;
          resolve({ status, text, url: current.href });
          request?.abort();
        } catch (error) {
          fail(error);
        }
      };
      abort = () => fail(signal.reason ?? new DOMException("Probe aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      try {
        request = net.request({
          session,
          url: initial.href,
          method: "GET",
          credentials: "include",
          redirect: "manual",
          cache: "no-store",
          bypassCustomProtocolHandlers: true,
          headers: init.headers,
        });
        request.on("error", fail);
        request.on("abort", () => fail(new DOMException("Probe aborted", "AbortError")));
        request.on("redirect", (status, method, location) => {
          if (settled) return;
          try {
            operation.assertCurrent();
            signal.throwIfAborted();
            const next = probeUrl(location);
            if (
              !next ||
              next.origin !== initial.origin ||
              method !== "GET" ||
              ![301, 302, 303, 307, 308].includes(status) ||
              redirects >= 5
            ) {
              // This response belongs to the current URL. The next target is never sent.
              succeed(status, "");
              return;
            }
            assertBusinessNetwork(accountId, next.href);
            current = next;
            redirects += 1;
            request!.followRedirect();
          } catch (error) {
            fail(error);
          }
        });
        request.on("response", (response) => {
          // Keep an error listener even after cancellation destroys the incoming stream.
          response.on("error", fail);
          if (settled) return;
          try {
            operation.assertCurrent();
            signal.throwIfAborted();
            assertBusinessNetwork(accountId, current.href);
          } catch (error) {
            fail(error);
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            succeed(response.statusCode, "");
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            try {
              operation.assertCurrent();
              signal.throwIfAborted();
              const piece = chunk.subarray(0, 20_000 - bytes);
              chunks.push(piece);
              bytes += piece.byteLength;
              // A truncated prefix cannot confirm authentication, even if it parses as JSON.
              if (piece.byteLength < chunk.byteLength) succeed(response.statusCode, "");
            } catch (error) {
              fail(error);
            }
          });
          response.on("end", () =>
            succeed(response.statusCode, Buffer.concat(chunks, bytes).toString("utf8")),
          );
          response.on("aborted", () => fail(new DOMException("Probe response aborted", "AbortError")));
        });
        operation.assertCurrent();
        signal.throwIfAborted();
        request.end();
      } catch (error) {
        fail(error);
      }
    });
  } catch (error) {
    // Revocation must stay a network-wait result instead of an authentication failure.
    operation.assertCurrent();
    throw error;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    clearTimeout(timer);
    timeout.abort();
    request?.abort();
    operation.release();
  }
}

function probeUrl(raw: string): URL | null {
  if (
    !raw ||
    raw.includes("\\") ||
    [...raw].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed : null;
  } catch {
    return null;
  }
}
