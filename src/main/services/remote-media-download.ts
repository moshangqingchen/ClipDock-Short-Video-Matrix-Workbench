import type { Session } from "electron";

export class RemoteMediaUnavailableError extends Error {
  constructor() {
    super("REMOTE_MEDIA_UNAVAILABLE");
  }
}

/** Abort races also settle mocks/native promises that never reject after signal cancellation. */
export function mediaAbortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RemoteMediaUnavailableError());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

/** No caller-supplied RequestInit: account authentication is never a retry option for images. */
export async function downloadAnonymousMedia(input: {
  session: Pick<Session, "fetch">;
  sourceUrl: string;
  signal: AbortSignal;
  maxBytes: number;
  assertCurrent(): void;
}): Promise<{ bytes: Buffer; mime: string }> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    input.assertCurrent();
    const response = await mediaAbortable(
      input.session.fetch(input.sourceUrl, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "image/png,image/jpeg,image/webp" },
        signal: input.signal,
      }),
      input.signal,
    );
    body = response.body;
    input.assertCurrent();
    if (response.status !== 200 || !response.body) throw new RemoteMediaUnavailableError();
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new RemoteMediaUnavailableError();
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null && (!/^\d+$/.test(rawLength) || Number(rawLength) > input.maxBytes))
      throw new RemoteMediaUnavailableError();
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      input.assertCurrent();
      const chunk = await mediaAbortable(reader.read(), input.signal);
      input.assertCurrent();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || size + chunk.value.byteLength > input.maxBytes)
        throw new RemoteMediaUnavailableError();
      size += chunk.value.byteLength;
      chunks.push(Buffer.from(chunk.value));
    }
    if (size === 0) throw new RemoteMediaUnavailableError();
    return { bytes: Buffer.concat(chunks, size), mime };
  } catch {
    throw new RemoteMediaUnavailableError();
  } finally {
    // Cancellation must not leave a task forever occupying its slot if native cleanup hangs.
    if (reader) {
      void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* A pending read is already covered by request abort. */
      }
    } else if (body) void body.cancel().catch(() => undefined);
  }
}
