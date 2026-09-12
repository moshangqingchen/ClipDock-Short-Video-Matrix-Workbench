import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import tls from "node:tls";
import type { WindowsControllerProcessIdentity } from "@main/network/windows-controller-owner";
import type { ProxyTunnelReader } from "./proxy-tunnel-reader";
import { parseDisplayIpipLocation, type DisplayIpipLocation } from "@main/network/display-ipip-location";
import {
  verifyProxyTunnelEvidence,
  verifyDomesticTunnelEvidence,
  isPublicIpv4,
  type AnonymousProxyTunnelContext,
  type VerifiedProxyTunnelEvidence,
} from "./proxy-tunnel-evidence";

type Endpoint = Readonly<{ host: string; port: number }>;
type Version = Readonly<{ generation: number; revision: string }>;
export interface ProxyEgressProbeOptions {
  readonly domesticDirect?: boolean;
  readonly proxy: Endpoint;
  readonly controller: Endpoint;
  readonly readVersion: () => Version | null;
  readonly reader: Pick<ProxyTunnelReader, "readAnonymousTunnel" | "whenIdle">;
  readonly allowedCountries: readonly string[];
  readonly timeoutMs?: number;
  readonly evidenceTtlMs?: number;
}
/** Main-process memory only. No raw trace, controller policies, URL, credentials or renderer grant. */
export interface ProxyEgressSample extends Version {
  readonly sampleId: string;
  readonly ip: string;
  readonly countryCode: string;
  /** Actual trace body completion, unchanged by reader or socket cleanup. */
  readonly observedAtMono: number;
  readonly expiresAtMono: number;
  readonly chainFingerprint: string;
  readonly controllerFingerprint: string;
  readonly kernelOwner: WindowsControllerProcessIdentity;
  /** Optional display data only; never consulted by route permission checks. */
  readonly location?: DisplayIpipLocation;
}
const HOST = "www.cloudflare.com";

const MAX_BYTES = 16_384;
// ISO 3166-1 assigned alpha-2 codes. Unknown, reserved and network pseudo-countries are not grants.
const COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);
const TRACE_KEYS = new Set([
  "fl",
  "h",
  "ip",
  "ts",
  "visit_scheme",
  "uag",
  "colo",
  "sliver",
  "http",
  "loc",
  "tls",
  "sni",
  "warp",
  "gateway",
  "rbi",
  "kex",
]);
const validInteger = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
function fail(): never {
  throw new Error("PROXY_EGRESS_UNAVAILABLE");
}
function localEndpoint(value: Endpoint): boolean {
  return !!value && ["127.0.0.1", "::1"].includes(value.host) && validInteger(value.port, 1, 65_535);
}
function parseTrace(body: Buffer, countries: readonly string[]): { ip: string; countryCode: string } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (
    !text ||
    body.length > MAX_BYTES ||
    [...text].some((char) => {
      const code = char.charCodeAt(0);
      return code !== 10 && code !== 13 && (code < 32 || code > 126);
    })
  )
    fail();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > TRACE_KEYS.size) fail();
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-z_]+)=(.*)$/.exec(line);
    if (!match || !TRACE_KEYS.has(match[1]) || fields.has(match[1])) fail();
    fields.set(match[1], match[2]);
  }
  const address = fields.get("ip"),
    country = fields.get("loc");
  if (
    !address ||
    address !== address.trim() ||
    address.includes("%") ||
    !isIP(address) ||
    !country ||
    !COUNTRIES.has(country) ||
    !countries.includes(country) ||
    (fields.has("h") && fields.get("h") !== HOST) ||
    (fields.has("visit_scheme") && fields.get("visit_scheme") !== "https")
  )
    fail();
  return {
    ip: isIP(address) === 6 ? new URL(`https://[${address}]`).hostname.slice(1, -1) : address,
    countryCode: country,
  };
}
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("PROXY_EGRESS_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
/** Fixed TLS-authenticated IPIP response; malformed or non-mainland geography never grants access. */
export function parseDomesticEgress(body: Buffer): { ip: string; countryCode: string } {
  if (body.length > MAX_BYTES) fail();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body).trim();
  const match = /^当前 IP[：:]\s*(\d{1,3}(?:\.\d{1,3}){3})\s+来自于[：:]\s*中国(?:\s+[^\r\n<>]+)?$/.exec(
    text,
  );
  if (
    !match ||
    !isPublicIpv4(match[1]) ||
    /香港|澳门|澳門|台湾|臺灣|Hong Kong|Macao|Macau|Taiwan/i.test(text)
  )
    fail();
  return { ip: match[1], countryCode: "CN" };
}
interface Job {
  epoch: number;
  abort: AbortController;
  drained: Promise<void>;
  guard: () => void;
}

/** Fixed anonymous Node CONNECT + default-verified TLS + trace GET. No default fetch or account Session.
 * A single active job includes cancelled reader work and actual native close, not just public promises.
 */
export class ProxyEgressProbe {
  private readonly options: ProxyEgressProbeOptions;
  private readonly timeoutMs: number;
  private readonly evidenceTtlMs: number;
  private active: Job | null = null;
  private epoch = 0;
  private disposed = false;
  private cleanupFailed = false;
  constructor(options: ProxyEgressProbeOptions) {
    try {
      this.timeoutMs = options.timeoutMs ?? 15_000;
      this.evidenceTtlMs = options.evidenceTtlMs ?? 15_000;
      if (
        !localEndpoint(options.proxy) ||
        !localEndpoint(options.controller) ||
        typeof options.readVersion !== "function" ||
        typeof options.reader?.readAnonymousTunnel !== "function" ||
        typeof options.reader.whenIdle !== "function" ||
        !validInteger(this.timeoutMs, 1, 15_000) ||
        !validInteger(this.evidenceTtlMs, 1, 15_000) ||
        !Array.isArray(options.allowedCountries) ||
        !options.allowedCountries.length ||
        options.allowedCountries.length > 249 ||
        new Set(options.allowedCountries).size !== options.allowedCountries.length ||
        options.allowedCountries.some((country) => !COUNTRIES.has(country))
      )
        fail();
      this.options = Object.freeze({
        ...options,
        proxy: Object.freeze({ host: options.proxy.host, port: options.proxy.port }),
        controller: Object.freeze({ host: options.controller.host, port: options.controller.port }),
        reader: Object.freeze({
          readAnonymousTunnel: options.reader.readAnonymousTunnel.bind(options.reader),
          whenIdle: options.reader.whenIdle.bind(options.reader),
        }),
        allowedCountries: Object.freeze([...options.allowedCountries]),
      });
    } catch {
      throw new Error("INVALID_PROXY_EGRESS_OPTIONS");
    }
  }

  probe(signal?: AbortSignal): Promise<ProxyEgressSample | null> {
    if (this.disposed || this.cleanupFailed || this.active || signal?.aborted) return Promise.resolve(null);
    let finished!: () => void;
    const job: Job = {
      epoch: this.epoch,
      abort: new AbortController(),
      guard: fail,
      drained: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    this.active = job;
    const cancel = () => job.abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, this.timeoutMs);
    const work = Promise.resolve()
      .then(() => this.execute(job))
      .catch(() => null)
      .then((sample) => {
        try {
          job.guard();
          if (this.cleanupFailed || !sample || performance.now() >= sample.expiresAtMono) return null;
          return sample;
        } catch {
          return null;
        }
      });
    const result = interrupted(work, job.abort.signal).catch(() => null);
    void Promise.allSettled([work, result]).then(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (this.active === job) this.active = null;
      finished();
    });
    return result;
  }
  invalidate(): void {
    this.epoch++;
    this.active?.abort.abort();
  }
  async whenIdle(): Promise<void> {
    while (this.active) await this.active.drained;
    if (this.cleanupFailed) throw new Error("PROXY_EGRESS_CLEANUP_FAILED");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
  }
  private version(): Version {
    const value = this.options.readVersion();
    if (
      !value ||
      !validInteger(value.generation, 0, Number.MAX_SAFE_INTEGER) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.revision)
    )
      fail();
    return Object.freeze({ generation: value.generation, revision: value.revision });
  }
  private async execute(job: Job): Promise<ProxyEgressSample> {
    const HOST = this.options.domesticDirect ? "myip.ipip.net" : "www.cloudflare.com";
    const PATH = this.options.domesticDirect ? "/" : "/cdn-cgi/trace";
    const startedAtMono = performance.now(),
      deadline = startedAtMono + this.timeoutMs;
    let version: Version | null = null,
      evidenceExpiry = Number.POSITIVE_INFINITY;
    const sockets = new Set<Socket>(),
      closes: Promise<void>[] = [],
      reads: Promise<unknown>[] = [];
    let connectRequest: http.ClientRequest | undefined, application: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined,
      agent: https.Agent | undefined,
      finished = false;
    let tlsOwner: tls.TLSSocket | undefined;
    const own = (socket: Socket) => {
      if (sockets.has(socket)) return;
      sockets.add(socket);
      closes.push(new Promise<void>((resolve) => socket.once("close", resolve)));
      socket.on("error", () => undefined);
      if (job.abort.signal.aborted || finished) socket.destroy();
    };
    const trackRequest = (request: http.ClientRequest) => {
      closes.push(new Promise<void>((resolve) => request.once("close", resolve)));
    };
    const close = () => {
      // Once TLS owns the CONNECT socket, destroying the old HTTP request/raw socket first
      // races TLS's native handle teardown on Windows. The outer owner closes both layers.
      if (!tlsOwner) connectRequest?.destroy();
      application?.destroy();
      response?.destroy();
      agent?.destroy();
      if (tlsOwner) tlsOwner.destroy();
      else for (const socket of sockets) socket.destroy();
    };
    job.abort.signal.addEventListener("abort", close, { once: true });
    job.guard = () => {
      if (
        this.disposed ||
        this.active !== job ||
        job.epoch !== this.epoch ||
        job.abort.signal.aborted ||
        performance.now() >= Math.min(deadline, evidenceExpiry)
      )
        fail();
      const current = this.version();
      if (
        !version ||
        current.generation !== version.generation ||
        current.revision !== version.revision ||
        this.disposed ||
        this.active !== job ||
        job.epoch !== this.epoch ||
        job.abort.signal.aborted
      )
        fail();
    };
    try {
      version = this.version();
      job.guard();
      const proxy = this.options.proxy;
      const tunnel = await interrupted(
        new Promise<Socket>((resolve, reject) => {
          connectRequest = http.request({
            hostname: proxy.host,
            port: proxy.port,
            family: proxy.host === "::1" ? 6 : 4,
            method: "CONNECT",
            path: `${HOST}:443`,
            headers: { host: `${HOST}:443` },
            agent: false,
            maxHeaderSize: MAX_BYTES,
          });
          trackRequest(connectRequest);
          connectRequest.once("socket", own);
          connectRequest.once("error", () => reject(new Error("PROXY_EGRESS_UNAVAILABLE")));
          connectRequest.once("response", (value) => {
            value.destroy();
            reject(new Error("PROXY_EGRESS_UNAVAILABLE"));
          });
          connectRequest.once("connect", (value, socket, head) => {
            own(socket);
            if (
              value.statusCode !== 200 ||
              head.length ||
              !socket.localAddress ||
              !socket.localPort ||
              !socket.remoteAddress ||
              !socket.remotePort ||
              job.abort.signal.aborted ||
              finished
            ) {
              socket.destroy();
              reject(new Error("PROXY_EGRESS_UNAVAILABLE"));
              return;
            }
            socket.pause();
            resolve(socket);
          });
          connectRequest.end();
        }),
        job.abort.signal,
      );
      job.guard();
      const context: AnonymousProxyTunnelContext = Object.freeze({
        id: randomUUID(),
        platformId: "anonymous-egress",
        target: Object.freeze({ host: HOST, port: 443 }),
        proxy,
        socket: Object.freeze({
          localAddress: tunnel.localAddress!,
          localPort: tunnel.localPort!,
          remoteAddress: tunnel.remoteAddress!,
          remotePort: tunnel.remotePort!,
        }),
        connectedAtMono: performance.now(),
      });
      const inspect = async (): Promise<VerifiedProxyTunnelEvidence> => {
        const read = Promise.resolve().then(async () => {
          job.guard();
          if (tunnel.destroyed || !tunnel.writable) fail();
          const readStartedAtMono = performance.now();
          const raw = await this.options.reader.readAnonymousTunnel(context, job.abort.signal);
          const snapshot = raw ? structuredClone(raw) : null;
          await this.options.reader.whenIdle();
          job.guard();
          if (!snapshot || tunnel.destroyed || !tunnel.writable) fail();
          const evidence = (
            this.options.domesticDirect ? verifyDomesticTunnelEvidence : verifyProxyTunnelEvidence
          )({
            context,
            evidence: snapshot,
            controller: this.options.controller,
            proxy,
            ...version!,
            nowMono: performance.now(),
            readStartedAtMono,
            evidenceTtlMs: this.evidenceTtlMs,
          });
          if (!evidence) fail();
          evidenceExpiry = Math.min(evidenceExpiry, evidence.evidenceExpiresAtMono);
          job.guard();
          return evidence;
        });
        reads.push(read);
        return interrupted(read, job.abort.signal);
      };
      // This handshake is anonymous. Inspect the same live tunnel once after SNI is sent,
      // before any HTTP bytes; business ProxyTransport keeps its separate pre-TLS gate.
      const secured = await interrupted(
        new Promise<tls.TLSSocket>((resolve, reject) => {
          const socket = tls.connect({
            socket: tunnel,
            servername: HOST,
            rejectUnauthorized: true,
            ALPNProtocols: ["http/1.1"],
          });
          tlsOwner = socket;
          own(socket);
          socket.once("error", () => reject(new Error("PROXY_EGRESS_UNAVAILABLE")));
          socket.once("secureConnect", () => {
            if (socket.authorized && (!socket.alpnProtocol || socket.alpnProtocol === "http/1.1"))
              resolve(socket);
            else reject(new Error("PROXY_EGRESS_UNAVAILABLE"));
          });
        }),
        job.abort.signal,
      );
      job.guard();
      const verified = await inspect();
      job.guard();
      agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
      let supplied = false;
      agent.createConnection = () => {
        job.guard();
        if (supplied || secured.destroyed) fail();
        supplied = true;
        return secured;
      };
      const received = await interrupted(
        new Promise<{ body: Buffer; observedAtMono: number }>((resolve, reject) => {
          job.guard();
          application = https.request(
            {
              hostname: HOST,
              port: 443,
              path: PATH,
              method: "GET",
              agent,
              maxHeaderSize: MAX_BYTES,
              headers: {
                host: HOST,
                accept: "text/plain",
                "accept-encoding": "identity",
                "cache-control": "no-cache, no-store",
                connection: "close",
                "user-agent": "ClipDock-Anonymous-Egress/1",
              },
            },
            (value) => {
              response = value;
              const chunks: Buffer[] = [];
              let size = 0;
              closes.push(new Promise<void>((done) => value.once("close", done)));
              const bad = () => {
                reject(new Error("PROXY_EGRESS_UNAVAILABLE"));
                value.destroy();
              };
              value.once("error", bad);
              value.once("aborted", bad);
              const length = value.headers["content-length"],
                encoding = value.headers["content-encoding"];
              if (
                value.statusCode !== 200 ||
                (encoding && encoding !== "identity") ||
                (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) ||
                !/^text\/plain(?:\s*;\s*charset=utf-8)?$/i.test(value.headers["content-type"] ?? "")
              ) {
                bad();
                return;
              }
              value.on("data", (chunk: Buffer) => {
                try {
                  job.guard();
                  size += chunk.length;
                  if (size > MAX_BYTES) fail();
                  chunks.push(Buffer.from(chunk));
                } catch {
                  bad();
                }
              });
              value.once("end", () => {
                try {
                  job.guard();
                  if (!value.complete) fail();
                  resolve({ body: Buffer.concat(chunks, size), observedAtMono: performance.now() });
                } catch {
                  bad();
                }
              });
            },
          );
          trackRequest(application);
          application.once("error", () => reject(new Error("PROXY_EGRESS_UNAVAILABLE")));
          application.once("upgrade", (value, socket) => {
            value.destroy();
            socket.destroy();
            reject(new Error("PROXY_EGRESS_UNAVAILABLE"));
          });
          job.guard();
          application.end();
        }),
        job.abort.signal,
      );
      job.guard();
      const parsed = this.options.domesticDirect
        ? parseDomesticEgress(received.body)
        : parseTrace(received.body, this.options.allowedCountries);
      const location = this.options.domesticDirect ? parseDisplayIpipLocation(received.body) : null;
      return Object.freeze({
        sampleId: randomUUID(),
        ...parsed,
        ...version,
        observedAtMono: received.observedAtMono,
        expiresAtMono: Math.min(evidenceExpiry, received.observedAtMono + this.evidenceTtlMs),
        chainFingerprint: verified.chainFingerprint,
        controllerFingerprint: verified.controllerFingerprint,
        kernelOwner: verified.kernelOwner,
        ...(location ? { location } : {}),
      });
    } finally {
      finished = true;
      close();
      await Promise.allSettled(reads);
      let drained = 0;
      while (drained < closes.length) {
        const batch = closes.slice(drained);
        drained = closes.length;
        await Promise.allSettled(batch);
      }
      try {
        await this.options.reader.whenIdle();
      } catch {
        this.cleanupFailed = true;
      }
      job.abort.signal.removeEventListener("abort", close);
    }
  }
}
