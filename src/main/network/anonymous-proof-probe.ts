import { randomUUID } from "node:crypto";
import { app, session, type Session } from "electron";
import { ensureDirectSession } from "./direct-session";
import { normalizeProofTarget } from "./direct-proof";
import { configureAnonymousCredentials, guardAnonymousClientCertificates } from "./anonymous-session-privacy";

/** Producer contract identity only; it does not attest compatibility with an account path. */
export const ANONYMOUS_TLS_FACTORY_ID = "clipdock-anonymous-tls-v1" as const;
const CLEANUP_MS = 2_000;

export interface AnonymousProbeOrigin {
  host: string;
  port: number;
}

/** Main-process TLS observation only. This API does not reveal physical peers or address families. */
export interface AnonymousTlsObservation {
  factoryId: typeof ANONYMOUS_TLS_FACTORY_ID;
  origin: AnonymousProbeOrigin;
  transportContextId: string;
  startedAtMono: number;
  completedAtMono: number;
  statusCode: number;
  responseFromCache: boolean | null;
  certificateValidation: "chromium-default";
  credentials: "omit";
}

/** Private main-process tracing capability; never pass this context through IPC. */
export interface AnonymousTlsObserverContext {
  readonly factoryId: typeof ANONYMOUS_TLS_FACTORY_ID;
  readonly origin: Readonly<AnonymousProbeOrigin>;
  readonly transportContextId: string;
  readonly signal: AbortSignal;
  readonly trace: Readonly<{ netLog: Session["netLog"] }>;
}

/** Actual fetch boundary times, captured before an observer may hold the response. */
export interface AnonymousTlsObserverTiming {
  readonly requestId: number;
  readonly sentAtMono: number;
  readonly sentAtWall: number;
  readonly headersAtMono: number;
  readonly headersAtWall: number;
  readonly statusCode: number;
  readonly responseFromCache: false;
}

/** Hooks share the existing probe deadline. No Response, headers, body or fetch capability escapes. */
export interface AnonymousTlsObserver {
  beforeSend?(context: AnonymousTlsObserverContext): void | Promise<void>;
  headers?(context: AnonymousTlsObserverContext, timing: AnonymousTlsObserverTiming): void | Promise<void>;
  cleanup?(context: AnonymousTlsObserverContext): void | Promise<void>;
}

export type AnonymousProbeResult =
  | { available: true; observation: AnonymousTlsObservation }
  | { available: false; reason: "PROBE_UNAVAILABLE" | "PROBE_CANCELLED" | "PROBE_BUSY" };

interface ActiveProbe {
  url: string;
  abort: AbortController;
  requestId: number | null;
  statusCode: number | null;
  fromCache: boolean | null;
}

interface ProbeSlot {
  session: Session;
  contextId: string;
  busy: boolean;
  poisoned: boolean;
  active: ActiveProbe | null;
  abort: AbortController | null;
  cleanup: Promise<void>;
  observerDrain: Promise<void>;
  observerTurn: Promise<void>;
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PROBE_UNAVAILABLE")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fixed public TLS probes on a bounded pool of anonymous Chromium Sessions. Never accepts an
 * account Session, business URL/query, Cookie, credential, proxy setting or renderer input.
 * It collects one fact for the issuer; it cannot establish DIRECT, an AF constraint or an exit.
 */
export class AnonymousProofProbe {
  private readonly slots: ProbeSlot[] = [];
  private revision = 0;
  private disposed = false;

  constructor(private readonly options: { concurrency?: number; timeoutMs?: number } = {}) {
    if (
      !Number.isInteger(options.concurrency ?? 2) ||
      (options.concurrency ?? 2) < 1 ||
      (options.concurrency ?? 2) > 4 ||
      !Number.isInteger(options.timeoutMs ?? 8_000) ||
      (options.timeoutMs ?? 8_000) < 1 ||
      (options.timeoutMs ?? 8_000) > 10_000
    )
      throw new Error("INVALID_ANONYMOUS_PROBE_OPTIONS");
  }

  private createSlot(): ProbeSlot {
    const contextId = randomUUID();
    const ses = session.fromPartition(`sv-proof-probe-${contextId}`, { cache: false });
    const slot: ProbeSlot = {
      session: ses,
      contextId,
      busy: false,
      poisoned: true,
      active: null,
      abort: null,
      cleanup: Promise.resolve(),
      observerDrain: Promise.resolve(),
      observerTurn: Promise.resolve(),
    };
    // Electron retains a created Session even if a hook fails to install. Count that slot
    // immediately and keep it poisoned unless every hook succeeds, so retries stay bounded.
    this.slots.push(slot);
    configureAnonymousCredentials(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      let cancel = true;
      try {
        const active = slot.active;
        if (
          active &&
          !slot.poisoned &&
          !active.abort.signal.aborted &&
          details.url === active.url &&
          details.method === "GET" &&
          (active.requestId === null || active.requestId === details.id)
        ) {
          active.requestId = details.id;
          cancel = false;
        }
      } catch {
        cancel = true;
      } finally {
        callback({ cancel });
      }
    });
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers))
        if (/^(cookie|authorization|proxy-authorization|referer)$/i.test(key)) delete headers[key];
      callback({ requestHeaders: headers });
    });
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers))
        if (/^(set-cookie|www-authenticate|proxy-authenticate)$/i.test(key)) delete headers[key];
      const active = slot.active;
      if (active?.requestId === details.id && details.url === active.url)
        active.statusCode = details.statusCode;
      callback({ responseHeaders: headers });
    });
    ses.webRequest.onResponseStarted((details) => {
      const active = slot.active;
      if (active?.requestId === details.id && details.url === active.url)
        active.fromCache = details.fromCache;
    });
    slot.poisoned = false;
    return slot;
  }

  private clean(slot: ProbeSlot): Promise<void> {
    slot.cleanup = slot.cleanup
      .then(() =>
        bounded(
          Promise.allSettled([
            Promise.resolve().then(() => slot.session.closeAllConnections()),
            Promise.resolve().then(() => slot.session.clearAuthCache()),
            Promise.resolve().then(() =>
              slot.session.clearStorageData({ storages: ["cookies", "serviceworkers", "cachestorage"] }),
            ),
          ]).then((results) => {
            if (results.some((result) => result.status === "rejected")) throw new Error();
          }),
          CLEANUP_MS,
        ),
      )
      .catch(() => {
        slot.poisoned = true;
      });
    return slot.cleanup;
  }

  async probeTls(
    origin: AnonymousProbeOrigin,
    signal: AbortSignal,
    observer?: AnonymousTlsObserver,
  ): Promise<AnonymousProbeResult> {
    const target = normalizeProofTarget({ ...origin, protocol: "https:", addressFamily: "ipv4" });
    // The temporary ipv4 discriminator is used ONLY for hostname/port normalization. No AF is
    // selected or claimed in the returned observation; Chromium still chooses its real path.
    if (!target || this.disposed || signal.aborted)
      return { available: false, reason: signal.aborted ? "PROBE_CANCELLED" : "PROBE_UNAVAILABLE" };
    let slot: ProbeSlot | undefined;
    try {
      if (
        app.commandLine.hasSwitch("ignore-certificate-errors") ||
        app.commandLine.hasSwitch("ignore-certificate-errors-spki-list")
      )
        return { available: false, reason: "PROBE_UNAVAILABLE" };
      slot = this.slots.find((candidate) => !candidate.busy && !candidate.poisoned);
      if (!slot && this.slots.length < (this.options.concurrency ?? 2)) slot = this.createSlot();
    } catch {
      return { available: false, reason: "PROBE_UNAVAILABLE" };
    }
    if (!slot) return { available: false, reason: "PROBE_BUSY" };
    slot.busy = true;
    const revision = this.revision;
    const abort = new AbortController();
    slot.abort = abort;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      abort.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(cancel, this.options.timeoutMs ?? 8_000);
    const startedAtMono = performance.now();
    const deadlineMono = startedAtMono + (this.options.timeoutMs ?? 8_000);
    const url = `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}/robots.txt`;
    const active: ActiveProbe = { url, abort, requestId: null, statusCode: null, fromCache: null };
    const current = () =>
      !this.disposed &&
      !slot.poisoned &&
      this.revision === revision &&
      !abort.signal.aborted &&
      performance.now() < deadlineMono;
    let observation: AnonymousTlsObservation | null = null;
    let unguard = () => {};
    let work: Promise<AnonymousTlsObservation | null> = Promise.resolve(null);
    let onAbort = () => {};
    let context: AnonymousTlsObserverContext | undefined;
    let beforeSend: AnonymousTlsObserver["beforeSend"];
    let headers: AnonymousTlsObserver["headers"];
    let cleanupObserver: AnonymousTlsObserver["cleanup"];
    let observerFinished = !observer;
    let observerWorkAttached = false;
    let finishObserver = () => {};
    let finishObserverTurn = () => {};
    if (observer) {
      slot.observerDrain = new Promise<void>((resolve) => {
        finishObserver = resolve;
      });
      slot.observerTurn = new Promise<void>((resolve) => {
        finishObserverTurn = resolve;
      });
    }
    const withObserverCleanup = (pending: Promise<AnonymousTlsObservation | null>) => {
      observerWorkAttached = true;
      return pending.finally(async () => {
        try {
          // A partial beforeSend may already have started native tracing. Wait for the
          // real callback/work before stopping it; a raced timeout is not a drain.
          if (context) await cleanupObserver?.call(observer, context);
        } catch {
          slot.poisoned = true;
          throw new Error("PROBE_UNAVAILABLE");
        } finally {
          observerFinished = true;
          finishObserver();
        }
      });
    };
    try {
      if (observer) {
        beforeSend = observer.beforeSend;
        headers = observer.headers;
        cleanupObserver = observer.cleanup;
        if (
          [beforeSend, headers, cleanupObserver].some(
            (hook) => hook !== undefined && typeof hook !== "function",
          )
        )
          throw new Error();
        context = Object.freeze({
          factoryId: ANONYMOUS_TLS_FACTORY_ID,
          origin: Object.freeze({ host: target.host, port: target.port }),
          transportContextId: slot.contextId,
          signal: abort.signal,
          // Freeze the capability container, not Electron's native NetLog object.
          trace: Object.freeze({ netLog: slot.session.netLog }),
        });
      }
      unguard = guardAnonymousClientCertificates({ session: slot.session, abort, urls: new Set([url]) });
      work = (async () => {
        await slot.cleanup;
        if (!current()) throw new Error();
        await ensureDirectSession(slot.session);
        if (!current()) throw new Error();
        // Slots are reused across input rounds. Initialization is idempotent, so
        // explicitly discard resolver entries again before each new observation.
        await slot.session.clearHostResolverCache();
        if (!current()) throw new Error();
        await slot.session.clearAuthCache();
        if (!current() || (await slot.session.cookies.get({})).length !== 0) throw new Error();
        if (!current()) throw new Error();
        if (context) await beforeSend?.call(observer, context);
        if (!current()) throw new Error();
        slot.active = active;
        const sentAtMono = performance.now();
        const sentAtWall = Date.now();
        const response = await slot.session.fetch(url, {
          method: "GET",
          credentials: "omit",
          redirect: "manual",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: abort.signal,
        });
        const headersAtMono = performance.now();
        const headersAtWall = Date.now();
        try {
          if (
            !current() ||
            active.requestId === null ||
            active.statusCode === null ||
            active.statusCode < 100 ||
            active.statusCode > 599 ||
            active.fromCache !== false ||
            response.status !== active.statusCode ||
            response.redirected
          )
            throw new Error();
          if (context)
            await headers?.call(
              observer,
              context,
              Object.freeze({
                requestId: active.requestId,
                sentAtMono,
                sentAtWall,
                headersAtMono,
                headersAtWall,
                statusCode: active.statusCode,
                responseFromCache: false,
              }),
            );
          if (!current()) throw new Error();
          // A 3xx/4xx proves only that this TLS endpoint replied. Redirects are never followed,
          // and its body is not parsed as a business response or a connectivity success.
          return {
            factoryId: ANONYMOUS_TLS_FACTORY_ID,
            origin: { host: target.host, port: target.port },
            transportContextId: slot.contextId,
            startedAtMono,
            completedAtMono: headersAtMono,
            statusCode: active.statusCode,
            responseFromCache: active.fromCache,
            certificateValidation: "chromium-default" as const,
            credentials: "omit" as const,
          };
        } finally {
          await bounded(response.body?.cancel() ?? Promise.resolve(), CLEANUP_MS).catch(() => {
            slot.poisoned = true;
          });
        }
      })();
      if (observer) work = withObserverCleanup(work);
      observation = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error());
          abort.signal.addEventListener("abort", onAbort, { once: true });
          if (abort.signal.aborted) onAbort();
        }),
      ]);
    } catch {
      /* Fixed result only; no provider URL, path, header or body escapes. */
    } finally {
      if (observer && !observerWorkAttached) work = withObserverCleanup(work);
      if (slot.active === active) slot.active = null;
      abort.abort();
      abort.signal.removeEventListener("abort", onAbort);
      void work.then(unguard, unguard);
      await bounded(Promise.allSettled([work, this.clean(slot)]), CLEANUP_MS).catch(() => {
        slot.poisoned = true;
      });
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      const release = () => {
        if (slot.abort === abort) slot.abort = null;
        slot.busy = false;
      };
      if (observerFinished) release();
      else void slot.observerDrain.then(release);
      finishObserverTurn();
    }
    if (
      observation &&
      !cancelled &&
      !slot.poisoned &&
      performance.now() < deadlineMono &&
      !this.disposed &&
      revision === this.revision &&
      !signal.aborted
    )
      return { available: true, observation };
    return {
      available: false,
      reason: signal.aborted || revision !== this.revision ? "PROBE_CANCELLED" : "PROBE_UNAVAILABLE",
    };
  }

  /** Wait for observation transactions and queued cleanup, without aborting or extending a probe. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const snapshot = this.slots.map((slot) => ({
        slot,
        cleanup: slot.cleanup,
        observerDrain: slot.observerDrain,
        observerTurn: slot.observerTurn,
      }));
      // observerTurn includes the outer finally: a hook may finish before that finally
      // queues the Session cleanup. observerDrain also covers hooks left after timeout.
      await Promise.all(
        snapshot.flatMap(({ cleanup, observerDrain, observerTurn }) => [
          cleanup,
          observerDrain,
          observerTurn,
        ]),
      );
      if (
        snapshot.length === this.slots.length &&
        snapshot.every(
          ({ slot, cleanup, observerDrain, observerTurn }) =>
            slot.cleanup === cleanup &&
            slot.observerDrain === observerDrain &&
            slot.observerTurn === observerTurn,
        )
      )
        return;
    }
  }

  /** Revocation is synchronous; cleanup finishes before a reusable slot may start another probe. */
  invalidate(): Promise<void> {
    this.revision++;
    for (const slot of this.slots) {
      slot.abort?.abort();
      slot.active = null;
      void this.clean(slot);
    }
    return Promise.all(this.slots.flatMap((slot) => [slot.cleanup, slot.observerDrain])).then(
      () => undefined,
    );
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.invalidate();
  }
}
