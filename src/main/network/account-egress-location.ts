import { createHash } from "node:crypto";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { AccountEgressLocation } from "@shared/network";
import { ProxyEgressProbe, parseDomesticEgress } from "@main/api/proxy-egress-probe";
import { ProxyTunnelReader } from "@main/api/proxy-tunnel-reader";
import { WindowsTunnelOwnership } from "./windows-tunnel-ownership";
import { parseDisplayIpipLocation, type DisplayIpipLocation } from "./display-ipip-location";

const CACHE_MS = 10 * 60_000,
  RETRY_MS = 60_000;
const MAX_BYTES = 16_384,
  DIRECT_TIMEOUT_MS = 8_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export interface AccountEgressLocationContext {
  mode: "direct" | "rule";
  generation: number;
  networkHash: string;
  controllerUrl: string;
  proxyPort: number;
  credentialRevision: string;
  controllerFingerprint: string | null;
}
interface LocationSample {
  ip: string;
  location: DisplayIpipLocation;
  observedAtMono: number;
}
interface Client {
  sample(signal: AbortSignal): Promise<LocationSample | null>;
  dispose(): Promise<void>;
}
export interface AccountEgressLocationOptions {
  readContext(): AccountEgressLocationContext | null;
  getSecret(): string | null;
  onChanged?(): void;
  /** Controlled tests only. Real runs use isolated anonymous clients below. */
  createClient?(context: AccountEgressLocationContext, isCurrent: () => boolean): Client;
  now?(): number;
  wallNow?(): number;
}
interface Job {
  abort: AbortController;
  done: Promise<void>;
}
const empty = (state: AccountEgressLocation["state"]): AccountEgressLocation => ({
  state,
  route: "direct",
  ip: null,
  country: null,
  region: null,
  city: null,
  checkedAt: null,
});

/** Informational observer: never holds, grants or revokes an account/business lease. */
export class AccountEgressLocationService {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private value = empty("unavailable");
  private binding: string | null = null;
  private dueAt = 0;
  private job: Job | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private disposed = false;
  private syncing = false;
  constructor(private readonly options: AccountEgressLocationOptions) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
  }
  private context(): { value: AccountEgressLocationContext; key: string } | null {
    try {
      const raw = this.options.readContext();
      if (
        !raw ||
        !["direct", "rule"].includes(raw.mode) ||
        !Number.isSafeInteger(raw.generation) ||
        raw.generation < 0 ||
        !digest(raw.networkHash)
      )
        return null;
      if (
        raw.mode === "rule" &&
        (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(raw.controllerUrl) ||
          !Number.isSafeInteger(raw.proxyPort) ||
          raw.proxyPort < 1 ||
          raw.proxyPort > 65535 ||
          !digest(raw.credentialRevision) ||
          !digest(raw.controllerFingerprint))
      )
        return null;
      // Pick only declared fields; unrelated projection timestamps never churn the cache.
      const value: AccountEgressLocationContext = {
        mode: raw.mode,
        generation: raw.generation,
        networkHash: raw.networkHash,
        controllerUrl: raw.controllerUrl,
        proxyPort: raw.proxyPort,
        credentialRevision: raw.credentialRevision,
        controllerFingerprint: raw.controllerFingerprint,
      };
      return { value, key: hash(value) };
    } catch {
      return null;
    }
  }
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.timer = setInterval(() => this.sync(), 1_000);
    this.timer.unref?.();
    this.sync();
  }
  /** Pure projection: never publish or call sync from a network status read. */
  read(): AccountEgressLocation {
    if (!this.running || this.disposed || this.context()?.key !== this.binding || !this.binding)
      return empty("unavailable");
    if (this.value.state === "ready" && this.now() >= this.dueAt) return empty("checking");
    return { ...this.value };
  }
  private publish(value: AccountEgressLocation): void {
    if (JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value;
    try {
      this.options.onChanged?.();
    } catch {
      /* Display callbacks cannot affect network work. */
    }
  }
  sync(): void {
    if (!this.running || this.disposed || this.syncing) return;
    this.syncing = true;
    try {
      const context = this.context();
      if ((context?.key ?? null) !== this.binding) {
        this.binding = context?.key ?? null;
        this.dueAt = 0;
        this.job?.abort.abort();
        this.publish(empty(context ? "checking" : "unavailable"));
      }
      if (!context || this.job || this.now() < this.dueAt) return;
      this.publish(empty("checking"));
      const abort = new AbortController();
      const current = () =>
        this.running &&
        !this.disposed &&
        !abort.signal.aborted &&
        this.binding === context.key &&
        this.context()?.key === context.key;
      const job: Job = { abort, done: Promise.resolve() };
      this.job = job;
      job.done = Promise.resolve()
        .then(async () => {
          let client: Client | null = null,
            sample: LocationSample | null = null;
          try {
            if (!current()) return;
            client =
              this.options.createClient?.(context.value, current) ??
              this.createClient(context.value, current);
            sample = await client.sample(abort.signal);
          } catch {
            /* No diagnostic failure escapes into business routing. */
          } finally {
            try {
              await client?.dispose();
            } catch {
              sample = null;
            }
          }
          if (!current()) return;
          if (
            sample &&
            Number.isFinite(sample.observedAtMono) &&
            sample.observedAtMono >= 0 &&
            sample.observedAtMono <= this.now() &&
            this.now() < sample.observedAtMono + CACHE_MS
          ) {
            this.dueAt = sample.observedAtMono + CACHE_MS;
            this.publish({
              state: "ready",
              route: "direct",
              ip: sample.ip,
              ...sample.location,
              checkedAt: new Date(this.wallNow() - (this.now() - sample.observedAtMono)).toISOString(),
            });
          } else {
            this.dueAt = this.now() + RETRY_MS;
            this.publish(empty("unavailable"));
          }
        })
        .finally(() => {
          if (this.job === job) this.job = null;
          // A changed context may have been waiting for its predecessor's native cleanup.
          if (this.running && !this.disposed && this.binding !== context.key) this.sync();
        });
    } finally {
      this.syncing = false;
    }
  }
  private createClient(context: AccountEgressLocationContext, current: () => boolean): Client {
    if (context.mode === "direct") return createDirectClient(current);
    const url = new URL(context.controllerUrl),
      host = url.hostname === "[::1]" ? "::1" : url.hostname;
    const proxy = { host, port: context.proxyPort },
      controller = { host, port: Number(url.port || 80) };
    const ownership = new WindowsTunnelOwnership(1);
    const readVersion = () =>
      current() ? { generation: context.generation, revision: hash(context) } : null;
    const reader = new ProxyTunnelReader(
      {
        targetScope: "domestic",
        controllerUrl: context.controllerUrl,
        proxy,
        getSecret: this.options.getSecret,
        readVersion,
      },
      {
        controllerOwner: ownership.controller(context.controllerUrl),
        createAcceptedSocketReader: (scope) => ownership.accepted(scope),
      },
    );
    const probe = new ProxyEgressProbe({
      domesticDirect: true,
      proxy,
      controller,
      readVersion,
      reader,
      allowedCountries: ["CN"],
    });
    return {
      sample: async (signal) => {
        const result = await probe.probe(signal);
        return result?.location &&
          result.countryCode === "CN" &&
          current() &&
          result.controllerFingerprint === context.controllerFingerprint
          ? { ip: result.ip, location: result.location, observedAtMono: result.observedAtMono }
          : null;
      },
      dispose: async () => {
        const results = await Promise.allSettled([probe.dispose(), reader.dispose()]);
        const workers = await Promise.allSettled([ownership.dispose()]);
        if ([...results, ...workers].some((item) => item.status === "rejected"))
          throw new Error("LOCATION_CLEANUP_FAILED");
      },
    };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.running = false;
    clearInterval(this.timer);
    this.binding = null;
    this.job?.abort.abort();
    this.value = empty("unavailable");
    await this.job?.done;
  }
}

function createDirectClient(current: () => boolean): Client {
  const stop = new AbortController();
  let work: Promise<LocationSample | null> | null = null;
  return {
    sample: (signal) => {
      if (work || stop.signal.aborted) return Promise.resolve(null);
      work = readDirectIpip(AbortSignal.any([signal, stop.signal]), current);
      return work;
    },
    dispose: async () => {
      stop.abort();
      await work;
    },
  };
}
async function readDirectIpip(signal: AbortSignal, current: () => boolean): Promise<LocationSample | null> {
  if (signal.aborted || !current()) return null;
  let request: ClientRequest | undefined, response: IncomingMessage | undefined;
  let requestClosed = Promise.resolve(),
    responseClosed = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    response?.destroy();
    request?.destroy();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    return await new Promise<LocationSample | null>((resolve) => {
      let settled = false;
      const finish = (result: LocationSample | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
        close();
      };
      timer = setTimeout(() => finish(null), DIRECT_TIMEOUT_MS);
      timer.unref?.();
      request = https.request(
        {
          hostname: "myip.ipip.net",
          port: 443,
          path: "/",
          method: "GET",
          family: 4,
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: MAX_BYTES,
          headers: {
            accept: "text/plain",
            "accept-encoding": "identity",
            "cache-control": "no-cache, no-store",
            connection: "close",
            "user-agent": "ClipDock-Location-Diagnostic/1",
          },
        },
        (value) => {
          response = value;
          responseClosed = new Promise<void>((done) => value.once("close", done));
          const length = value.headers["content-length"],
            encoding = value.headers["content-encoding"];
          if (
            signal.aborted ||
            !current() ||
            value.statusCode !== 200 ||
            (encoding && encoding !== "identity") ||
            !/^text\/plain(?:\s*;\s*charset=utf-8)?$/i.test(value.headers["content-type"] ?? "") ||
            (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
          ) {
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          value.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (signal.aborted || !current() || bytes > MAX_BYTES) {
              finish(null);
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          value.once("error", () => finish(null));
          value.once("aborted", () => finish(null));
          value.once("end", () => {
            try {
              if (signal.aborted || !current() || !value.complete) {
                finish(null);
                return;
              }
              const body = Buffer.concat(chunks, bytes),
                parsed = parseDomesticEgress(body),
                location = parseDisplayIpipLocation(body);
              finish(location ? { ip: parsed.ip, location, observedAtMono: performance.now() } : null);
            } catch {
              finish(null);
            }
          });
        },
      );
      requestClosed = new Promise<void>((done) =>
        request!.once("close", () => {
          finish(null);
          done();
        }),
      );
      request.once("error", () => finish(null));
      request.once("upgrade", (value, socket) => {
        value.destroy();
        socket.destroy();
        finish(null);
      });
      if (signal.aborted || !current()) finish(null);
      else request.end();
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
    close();
    await Promise.allSettled([requestClosed, responseClosed]);
  }
}
