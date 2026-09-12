import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { app, session, type Session } from "electron";
import { configureAnonymousCredentials, guardAnonymousClientCertificates } from "./anonymous-session-privacy";

/** Producer contract identity only; it does not attest compatibility with an account path. */
export const ANONYMOUS_EGRESS_FACTORY_ID = "clipdock-anonymous-egress-v1" as const;

export type AnonymousEgressProvider = "ipip" | "ipify-ipv6";
const ECHO_URLS: Record<AnonymousEgressProvider, string> = {
  ipip: "https://myip.ipip.net/",
  "ipify-ipv6": "https://api6.ipify.org/",
};
const CLEANUP_MS = 2_000;

interface HttpsObservation {
  origin: { host: string; port: 443 };
  startedAtMono: number;
  completedAtMono: number;
  statusCode: 200;
  responseFromCache: false;
  certificateValidation: "chromium-default";
  credentials: "omit";
}

/** Main-process memory only: neither this object nor its IP belongs in IPC, logs or backups. */
export interface AnonymousEgressObservation {
  factoryId: typeof ANONYMOUS_EGRESS_FACTORY_ID;
  source: AnonymousEgressProvider;
  ip: string;
  /** Family of the address in the provider's response, NOT the Chromium socket's family. */
  reportedAddressFamily: "ipv4" | "ipv6";
  countryCode: string;
  /** Auxiliary network ownership information; never used to infer the country. */
  asn: number | null;
  transportContextId: string;
  startedAtMono: number;
  /** Echo completion, retained unchanged while the separate geography query completes. */
  observedAtMono: number;
  completedAtMono: number;
  echo: HttpsObservation;
  geo: HttpsObservation & { provider: "ipwho.is" };
}

/** Main-only private tracing context. The geo URL includes an IP and must never escape here. */
export interface AnonymousEgressObserverContext {
  readonly factoryId: typeof ANONYMOUS_EGRESS_FACTORY_ID;
  readonly source: AnonymousEgressProvider;
  readonly stage: "echo" | "geo";
  readonly origin: Readonly<{ host: string; port: 443 }>;
  readonly transportContextId: string;
  readonly signal: AbortSignal;
  readonly trace: Readonly<{ netLog: Session["netLog"] }>;
}

/** Actual fetch boundaries, captured before a hook holds the original response. */
export interface AnonymousEgressObserverTiming {
  readonly requestId: number;
  readonly sentAtMono: number;
  readonly sentAtWall: number;
  readonly headersAtMono: number;
  readonly headersAtWall: number;
  readonly statusCode: 200;
  readonly responseFromCache: false;
}

/** Each entered request context has its own cleanup, even when beforeSend fails.
 * No Response/body/headers/fetch capability is provided. Raw NetLog files remain private,
 * sensitive main-process temporary data; in particular the geo path must not be projected.
 */
export interface AnonymousEgressObserver {
  beforeSend?(context: AnonymousEgressObserverContext): void | Promise<void>;
  headers?(
    context: AnonymousEgressObserverContext,
    timing: AnonymousEgressObserverTiming,
  ): void | Promise<void>;
  cleanup?(context: AnonymousEgressObserverContext): void | Promise<void>;
}

export type AnonymousEgressResult =
  | { available: true; observation: AnonymousEgressObservation }
  | { available: false; reason: "PROBE_UNAVAILABLE" | "PROBE_CANCELLED" | "PROBE_BUSY" };

interface RequestObservation {
  url: string;
  id: number | null;
  status: number | null;
  fromCache: boolean | null;
}
interface Flight {
  abort: AbortController;
  session: Session;
  urls: Set<string>;
  active: RequestObservation | null;
}
interface Slot {
  session: Session;
  contextId: string;
  busy: boolean;
  poisoned: boolean;
  flight: Flight | null;
  cleanup: Promise<void>;
  observerDrain: Promise<void>;
  observerTurn: Promise<void>;
}

function canonicalIp(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim() || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) return new URL(`https://[${value}]`).hostname.slice(1, -1);
  return null;
}

function parseEcho(provider: AnonymousEgressProvider, body: string): string | null {
  if (provider === "ipify-ipv6") {
    const ip = canonicalIp(body.trim());
    return ip && isIP(ip) === 6 ? ip : null;
  }
  // IPIP's public text page embeds the address in Chinese prose. Reject ambiguous
  // or invalid candidate addresses rather than taking the first arbitrary match.
  const candidates = body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  if (candidates.length !== 1) return null;
  const ip = canonicalIp(candidates[0]);
  return ip && isIP(ip) === 4 ? ip : null;
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
 * Fixed, anonymous HTTPS echo + independent IP geography. Lazy bounded Chromium
 * sessions, no account Session or arbitrary destination input, no background timer.
 * This establishes neither DIRECT, actual socket AF, nor applicability to accounts.
 * The caller must authorize the current echo route before invoking probe().
 */
export class AnonymousEgressProbe {
  private readonly slots: Slot[] = [];
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly options: { concurrency?: number; timeoutMs?: number; maxBytes?: number } = {},
  ) {
    for (const [value, max] of [
      [options.concurrency ?? 2, 4],
      [options.timeoutMs ?? 12_000, 15_000],
      [options.maxBytes ?? 32_768, 32_768],
    ])
      if (!Number.isInteger(value) || value < 1 || value > max)
        throw new Error("INVALID_ANONYMOUS_EGRESS_OPTIONS");
  }

  private createSlot(): Slot {
    const contextId = randomUUID();
    const ses = session.fromPartition(`sv-egress-probe-${contextId}`, { cache: false });
    const slot: Slot = {
      session: ses,
      contextId,
      busy: false,
      poisoned: true,
      flight: null,
      cleanup: Promise.resolve(),
      observerDrain: Promise.resolve(),
      observerTurn: Promise.resolve(),
    };
    // A partially configured Session still counts against the finite pool.
    this.slots.push(slot);
    configureAnonymousCredentials(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const flight = slot.flight;
      const active = flight?.active;
      const allow =
        !slot.poisoned &&
        !flight?.abort.signal.aborted &&
        active &&
        details.url === active.url &&
        details.method === "GET" &&
        (active.id === null || active.id === details.id);
      if (allow) active.id = details.id;
      callback({ cancel: !allow });
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
      const active = slot.flight?.active;
      if (active?.id === details.id && active.url === details.url) active.status = details.statusCode;
      callback({ responseHeaders: headers });
    });
    ses.webRequest.onResponseStarted((details) => {
      const active = slot.flight?.active;
      if (active?.id === details.id && active.url === details.url) active.fromCache = details.fromCache;
    });
    slot.poisoned = false;
    return slot;
  }

  private clean(slot: Slot): Promise<void> {
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

  private async read(
    slot: Slot,
    flight: Flight,
    url: string,
    current: () => boolean,
    observer?: {
      source: AnonymousEgressProvider;
      stage: "echo" | "geo";
      hooks: Readonly<AnonymousEgressObserver>;
    },
  ): Promise<{ body: string; observation: HttpsObservation }> {
    if (!current()) throw new Error();
    const active: RequestObservation = { url, id: null, status: null, fromCache: null };
    const context: AnonymousEgressObserverContext | undefined = observer
      ? Object.freeze({
          factoryId: ANONYMOUS_EGRESS_FACTORY_ID,
          source: observer.source,
          stage: observer.stage,
          origin: Object.freeze({ host: new URL(url).hostname, port: 443 as const }),
          transportContextId: slot.contextId,
          signal: flight.abort.signal,
          // The native NetLog object itself must not be frozen.
          trace: Object.freeze({ netLog: slot.session.netLog }),
        })
      : undefined;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyCancellation: Promise<void> | undefined;
    const cancelBody = () => {
      if (reader) {
        bodyCancellation ??= reader.cancel();
        void bodyCancellation.catch(() => {
          slot.poisoned = true;
        });
      }
    };
    try {
      if (context) await observer!.hooks.beforeSend?.(context);
      if (!current()) throw new Error();
      flight.urls.add(url);
      flight.active = active;
      const startedAtMono = performance.now();
      const sentAtWall = Date.now();
      response = await slot.session.fetch(url, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: flight.abort.signal,
      });
      const headersAtMono = performance.now();
      const headersAtWall = Date.now();
      if (
        !current() ||
        active.id === null ||
        active.status !== 200 ||
        response.status !== 200 ||
        response.redirected ||
        active.fromCache !== false
      )
        throw new Error();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > (this.options.maxBytes ?? 32_768)))
        throw new Error();
      if (context)
        await observer!.hooks.headers?.(
          context,
          Object.freeze({
            requestId: active.id,
            sentAtMono: startedAtMono,
            sentAtWall,
            headersAtMono,
            headersAtWall,
            statusCode: 200,
            responseFromCache: false,
          }),
        );
      if (!current()) throw new Error();
      reader = response.body?.getReader();
      if (!reader) throw new Error();
      flight.abort.signal.addEventListener("abort", cancelBody, { once: true });
      if (flight.abort.signal.aborted) cancelBody();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      let body = "";
      while (true) {
        const chunk = await reader.read();
        if (!current()) throw new Error();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > (this.options.maxBytes ?? 32_768)) throw new Error();
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return {
        body,
        observation: {
          origin: { host: new URL(url).hostname, port: 443 },
          startedAtMono,
          completedAtMono: performance.now(),
          statusCode: 200,
          responseFromCache: false,
          certificateValidation: "chromium-default",
          credentials: "omit",
        },
      };
    } finally {
      if (flight.active === active) flight.active = null;
      flight.abort.signal.removeEventListener("abort", cancelBody);
      // Abort/close is also performed by the owner. Do not let a stuck reader
      // cancellation keep a successful-looking observation alive indefinitely.
      try {
        if (reader) {
          cancelBody();
          await bounded(bodyCancellation!, CLEANUP_MS).catch(() => {
            slot.poisoned = true;
          });
          reader.releaseLock();
        } else
          await bounded(response?.body?.cancel() ?? Promise.resolve(), CLEANUP_MS).catch(() => {
            slot.poisoned = true;
          });
      } finally {
        try {
          // A partial beforeSend may have started native tracing. Cleanup follows the
          // real hook and body work, never a raced timeout; geo waits for echo cleanup.
          if (context) await observer!.hooks.cleanup?.(context);
        } catch {
          // The owner's current() check rejects the result and the next stage.
          slot.poisoned = true;
        }
      }
    }
  }

  async probe(
    provider: AnonymousEgressProvider,
    signal: AbortSignal,
    observer?: AnonymousEgressObserver,
  ): Promise<AnonymousEgressResult> {
    if (this.disposed || signal.aborted || !Object.hasOwn(ECHO_URLS, provider))
      return { available: false, reason: signal.aborted ? "PROBE_CANCELLED" : "PROBE_UNAVAILABLE" };
    let slot: Slot | undefined;
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
    const deadlineMono = performance.now() + (this.options.timeoutMs ?? 12_000);
    const revision = this.revision;
    const flight: Flight = {
      abort: new AbortController(),
      session: slot.session,
      urls: new Set(),
      active: null,
    };
    slot.flight = flight;
    let timedOut = false;
    const cancel = () => flight.abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, this.options.timeoutMs ?? 12_000);
    const current = () =>
      !this.disposed &&
      !slot.poisoned &&
      revision === this.revision &&
      !flight.abort.signal.aborted &&
      performance.now() < deadlineMono;
    let observation: AnonymousEgressObservation | null = null;
    let unguard = () => {};
    let work: Promise<AnonymousEgressObservation | null> = Promise.resolve(null);
    let onAbort = () => {};
    let hooks: Readonly<AnonymousEgressObserver> | undefined;
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
    const withObserverDrain = (pending: Promise<AnonymousEgressObservation | null>) => {
      observerWorkAttached = true;
      return pending.finally(() => {
        observerFinished = true;
        finishObserver();
      });
    };
    try {
      if (observer) {
        const beforeSend = observer.beforeSend,
          headers = observer.headers,
          cleanup = observer.cleanup;
        if ([beforeSend, headers, cleanup].some((hook) => hook !== undefined && typeof hook !== "function"))
          throw new Error();
        hooks = Object.freeze({
          beforeSend: beforeSend?.bind(observer),
          headers: headers?.bind(observer),
          cleanup: cleanup?.bind(observer),
        });
      }
      unguard = guardAnonymousClientCertificates(flight);
      work = (async () => {
        await slot.cleanup;
        if (!current()) throw new Error();
        await slot.session.setProxy({ mode: "direct" });
        await slot.session.closeAllConnections();
        if (!current()) throw new Error();
        await slot.session.clearHostResolverCache();
        if (!current()) throw new Error();
        await slot.session.clearAuthCache();
        if (!current() || (await slot.session.cookies.get({})).length !== 0) throw new Error();
        const echo = await this.read(
          slot,
          flight,
          ECHO_URLS[provider],
          current,
          hooks ? { source: provider, stage: "echo", hooks } : undefined,
        );
        if (!current()) throw new Error();
        const ip = parseEcho(provider, echo.body);
        if (!ip) throw new Error();
        const geo = await this.read(
          slot,
          flight,
          `https://ipwho.is/${encodeURIComponent(ip)}`,
          current,
          hooks ? { source: provider, stage: "geo", hooks } : undefined,
        );
        const raw: unknown = JSON.parse(geo.body);
        if (!current() || !raw || typeof raw !== "object") throw new Error();
        const value = raw as {
          success?: unknown;
          ip?: unknown;
          country_code?: unknown;
          connection?: { asn?: unknown };
        };
        if (
          value.success !== true ||
          canonicalIp(value.ip) !== ip ||
          typeof value.country_code !== "string" ||
          !/^[A-Z]{2}$/.test(value.country_code)
        )
          throw new Error();
        const asn = value.connection?.asn;
        return {
          factoryId: ANONYMOUS_EGRESS_FACTORY_ID,
          source: provider,
          ip,
          reportedAddressFamily: isIP(ip) === 4 ? "ipv4" : "ipv6",
          countryCode: value.country_code,
          asn:
            typeof asn === "number" && Number.isSafeInteger(asn) && asn > 0 && asn <= 4_294_967_295
              ? asn
              : null,
          transportContextId: slot.contextId,
          startedAtMono: echo.observation.startedAtMono,
          observedAtMono: echo.observation.completedAtMono,
          completedAtMono: geo.observation.completedAtMono,
          echo: echo.observation,
          geo: { ...geo.observation, provider: "ipwho.is" },
        };
      })();
      if (observer) work = withObserverDrain(work);
      observation = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error());
          flight.abort.signal.addEventListener("abort", onAbort, { once: true });
          if (flight.abort.signal.aborted) onAbort();
        }),
      ]);
    } catch {
      // Fixed results only. Neither provider bodies, errors, full IPs nor URLs are logged.
    } finally {
      if (observer && !observerWorkAttached) work = withObserverDrain(work);
      flight.active = null;
      flight.abort.abort();
      flight.abort.signal.removeEventListener("abort", onAbort);
      // Keep the certificate rejection installed until ignored/late work really ends.
      void work.then(unguard, unguard);
      await bounded(Promise.allSettled([work, this.clean(slot)]), CLEANUP_MS).catch(() => {
        slot.poisoned = true;
      });
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      const release = () => {
        if (slot.flight === flight) slot.flight = null;
        slot.busy = false;
      };
      if (observerFinished) release();
      else void slot.observerDrain.then(release);
      finishObserverTurn();
    }
    const completedAtMono = performance.now();
    if (
      observation &&
      !timedOut &&
      completedAtMono < deadlineMono &&
      !slot.poisoned &&
      !this.disposed &&
      revision === this.revision &&
      !signal.aborted
    ) {
      return { available: true, observation };
    }
    return {
      available: false,
      reason: signal.aborted || revision !== this.revision ? "PROBE_CANCELLED" : "PROBE_UNAVAILABLE",
    };
  }

  /** Wait for entered observation transactions and queued cleanup without aborting or extending them. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const snapshot = this.slots.map((slot) => ({
        slot,
        cleanup: slot.cleanup,
        observerDrain: slot.observerDrain,
        observerTurn: slot.observerTurn,
      }));
      // The outer finally may enqueue Session cleanup after a request's hook has drained.
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

  /** Revocation closes the request gate synchronously; every cleanup is bounded and fail-closed. */
  invalidate(): Promise<void> {
    this.revision++;
    for (const slot of this.slots) {
      slot.flight?.abort.abort();
      if (slot.flight) slot.flight.active = null;
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
