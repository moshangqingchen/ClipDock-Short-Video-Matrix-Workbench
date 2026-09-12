import { createHash } from "node:crypto";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { NETWORK_TIMING } from "@shared/network";
import type { KernelRule } from "./rules";
import {
  connectionHostScope,
  parseScopedConnections,
  type KernelConnectionsSnapshot,
} from "./connection-evidence";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
const MAX_CLOSE_RESPONSE_BYTES = 64 * 1024;

/** A controller response only. Ownership and actual socket disappearance are checked by the caller. */
export interface ConnectionCloseResponse {
  readonly status: number;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}

export type KernelDnsQueryType = "A" | "AAAA";
export interface KernelDnsQueryResponse {
  readonly host: string;
  readonly queryType: KernelDnsQueryType;
  readonly status: number;
  readonly truncated: boolean;
  readonly question: Readonly<{ name: string; type: number }>;
  readonly answers: readonly Readonly<{ name: string; type: 1 | 5 | 28; ttl: number; data: string }>[];
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}

/** Exact DNS names only. No IP literals, URL syntax, search suffixes or wildcard targets. */
export function normalizeKernelDnsHost(value: string): string {
  if (typeof value !== "string" || value.length > 1024 || /[\s\\/:@?#*%]/u.test(value))
    throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
  const host = domainToASCII(value.endsWith(".") ? value.slice(0, -1) : value).toLowerCase();
  const labels = host.split(".");
  if (
    !host ||
    host.length > 253 ||
    isIP(host) ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^\d+$/.test(labels.at(-1)!)
  )
    throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
  return host;
}

export interface ClashReaderOptions {
  controllerUrl: string;
  getSecret: () => string | null;
  /** Tests may shorten the deadline; callers cannot exceed the production limit. */
  timeoutMs?: number;
  /** Response bounds apply separately to each API response. */
  maxResponseBytes?: number;
}

export interface ClashReadResult {
  mode: string;
  tun: boolean;
  mixedPort: number;
  version: string;
  rules: KernelRule[];
  /** Digest of visible config/rules/kernel/DIRECT policy; not the full DNS/provider configuration. */
  fingerprint: string;
  /** Main-process input only. Optional solely for legacy test adapters; real reads always populate it. */
  configFieldHashes?: Readonly<Record<string, string>>;
  /** JSON Pointer digests permit comparison of explicitly supplied nested fields without inventing defaults. */
  configPathHashes?: Readonly<Record<string, string>>;
  directPolicy?: DirectPolicyObservation;
  startedAtMono?: number;
  completedAtMono?: number;
}

/** Main-process observation only; omitted policy fields remain unknown, never default DIRECT evidence. */
export interface DirectPolicyObservation {
  kind: "direct" | "other" | "unknown";
  interfaceName: string | null;
  dialer: "none" | "configured" | "unknown";
  ipVersion: string | null;
  /** Visible DIRECT metadata excluding alive/history statistics, not hidden resolver configuration. */
  policyFingerprint: string;
  startedAtMono: number;
  completedAtMono: number;
}

type ClashReaderErrorCode =
  | "CONTROLLER_CONFIG_INVALID"
  | "CONTROLLER_BUSY"
  | "CREDENTIAL_UNAVAILABLE"
  | "CONTROLLER_UNAVAILABLE"
  | "CONTROLLER_TIMEOUT"
  | "CONTROLLER_CANCELLED"
  | "CONTROLLER_REDIRECT_REJECTED"
  | "CONTROLLER_RESPONSE_TOO_LARGE"
  | "CONTROLLER_RESPONSE_INVALID";

/** Only fixed codes cross this boundary; no URL, headers, body or provider errors. */
export class ClashReaderError extends Error {
  constructor(readonly code: ClashReaderErrorCode) {
    super(code);
    this.name = "ClashReaderError";
  }
}

export class ClashReader {
  private readonly hostname: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private pending: Promise<ClashReadResult> | null = null;
  private closing: Readonly<{ drain: Promise<void> }> | null = null;
  private readonly getOperations = new Set<Promise<void>>();
  private readonly getTransports = new Set<Promise<void>>();

  constructor(private readonly options: ClashReaderOptions) {
    // Validate again at the transport boundary. Numeric aliases, DNS names,
    // userinfo, paths and redirects cannot move this request off literal loopback.
    const raw = typeof options.controllerUrl === "string" ? options.controllerUrl.trim() : "";
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/.test(raw))
      throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
    try {
      const url = new URL(raw);
      this.hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
      this.port = url.port ? Number(url.port) : 80;
    } catch {
      throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
    }
    this.timeoutMs = options.timeoutMs ?? NETWORK_TIMING.controllerTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.port) ||
      this.port < 1 ||
      this.port > 65_535 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > NETWORK_TIMING.controllerTimeoutMs ||
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > MAX_RESPONSE_BYTES
    )
      throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
  }

  /** One live API batch per reader; success is not cached as a future observation. */
  read(): Promise<ClashReadResult> {
    if (this.pending) return this.pending;
    // Reserve before the external credential getter can synchronously reenter read/whenIdle.
    const pending = this.trackGet(() => this.readCurrentKernel());
    this.pending = pending;
    const clear = () => {
      if (this.pending === pending) this.pending = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  /** Only an independently attributed connection UUID may be supplied. No bulk close or retry.
   * A 204 acknowledges this HTTP request; it does not prove the connection/socket disappeared.
   */
  async closeConnection(id: string, signal?: AbortSignal): Promise<ConnectionCloseResponse> {
    if (typeof id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))
      throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
    if (signal?.aborted) throw new ClashReaderError("CONTROLLER_CANCELLED");
    if (this.closing) throw new ClashReaderError("CONTROLLER_BUSY");
    let resolveDrain!: () => void;
    const slot = {
      drain: new Promise<void>((resolve) => {
        resolveDrain = resolve;
      }),
    };
    this.closing = slot;
    const drained = () => {
      if (this.closing === slot) this.closing = null;
      resolveDrain();
    };
    let secret: string | null;
    try {
      secret = this.options.getSecret();
      if (secret !== null && (typeof secret !== "string" || /[\r\n\0]/.test(secret))) throw new Error();
    } catch {
      drained();
      throw new ClashReaderError("CREDENTIAL_UNAVAILABLE");
    }
    const controller = new AbortController();
    let req: ClientRequest | undefined, response: IncomingMessage | undefined;
    let requestClosed = false,
      responseClosed = false,
      settled = false;
    let openSockets = 0;
    let rejectResult!: (error: ClashReaderError) => void;
    const result = new Promise<ConnectionCloseResponse>((resolve, reject) => {
      rejectResult = reject;
      const fail = (code: ClashReaderErrorCode) => {
        if (settled) return;
        settled = true;
        reject(new ClashReaderError(code));
      };
      const finishDrain = () => {
        if (requestClosed && (!response || responseClosed) && openSockets === 0) drained();
      };
      const errorCode = (): ClashReaderErrorCode =>
        controller.signal.reason instanceof ClashReaderError
          ? controller.signal.reason.code
          : "CONTROLLER_UNAVAILABLE";
      const startedAtMono = performance.now();
      const deadlineMono = startedAtMono + this.timeoutMs;
      try {
        // A credential provider may synchronously cancel/reenter. The slot was reserved
        // before invoking it, and cancellation is checked again before any native request.
        if (signal?.aborted) {
          fail("CONTROLLER_CANCELLED");
          requestClosed = true;
          finishDrain();
          return;
        }
        req = request(
          {
            protocol: "http:",
            hostname: this.hostname,
            port: this.port,
            family: this.hostname === "::1" ? 6 : 4,
            path: `/connections/${id}`,
            method: "DELETE",
            agent: false,
            signal: controller.signal,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              ...(secret ? { authorization: `Bearer ${secret}` } : {}),
            },
          },
          (incoming) => {
            response = incoming;
            incoming.once("close", () => {
              responseClosed = true;
              if (!incoming.complete) fail(errorCode());
              finishDrain();
            });
            incoming.once("error", () => fail(errorCode()));
            incoming.once("aborted", () => fail(errorCode()));
            const status = incoming.statusCode ?? 0;
            const length = incoming.headers["content-length"],
              encoding = incoming.headers["content-encoding"];
            const limit = Math.min(this.maxResponseBytes, MAX_CLOSE_RESPONSE_BYTES);
            let invalid: ClashReaderErrorCode | null = null;
            if (!Number.isInteger(status) || status < 200 || status > 599)
              invalid = "CONTROLLER_RESPONSE_INVALID";
            else if (status >= 300 && status < 400) invalid = "CONTROLLER_REDIRECT_REJECTED";
            else if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
              invalid = "CONTROLLER_RESPONSE_INVALID";
            else if (length !== undefined && Number(length) > limit)
              invalid = "CONTROLLER_RESPONSE_TOO_LARGE";
            else if (encoding && encoding !== "identity") invalid = "CONTROLLER_RESPONSE_INVALID";
            if (invalid) {
              fail(invalid);
              incoming.destroy();
              req?.destroy();
              return;
            }
            let bytes = 0;
            incoming.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > limit) {
                fail("CONTROLLER_RESPONSE_TOO_LARGE");
                incoming.destroy();
                req?.destroy();
              }
            });
            incoming.once("end", () => {
              if (settled) return;
              const completedAtMono = performance.now();
              if (controller.signal.aborted) {
                fail(errorCode());
                return;
              }
              if (completedAtMono >= deadlineMono) {
                fail("CONTROLLER_TIMEOUT");
                return;
              }
              settled = true;
              resolve(Object.freeze({ status, startedAtMono, completedAtMono }));
            });
          },
        );
        req.once("error", () => fail(errorCode()));
        req.once("socket", (socket) => {
          openSockets++;
          socket.once("close", () => {
            openSockets--;
            finishDrain();
          });
        });
        req.once("close", () => {
          requestClosed = true;
          if (!settled) fail(errorCode());
          finishDrain();
        });
        // Switching protocols cannot yield a usable HTTP response or an untracked socket.
        req.once("upgrade", (_incoming, socket) => {
          fail("CONTROLLER_RESPONSE_INVALID");
          socket.destroy();
          req?.destroy();
        });
        req.end();
      } catch {
        fail(errorCode());
        if (req) req.destroy();
        else {
          requestClosed = true;
          finishDrain();
        }
      }
    });
    const stop = (code: "CONTROLLER_CANCELLED" | "CONTROLLER_TIMEOUT") => {
      controller.abort(new ClashReaderError(code));
      if (!settled) {
        settled = true;
        rejectResult(new ClashReaderError(code));
      }
      response?.destroy();
      req?.destroy();
    };
    const cancel = () => stop("CONTROLLER_CANCELLED");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop("CONTROLLER_TIMEOUT"), this.timeoutMs);
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      // Public cancellation may precede native close. The slot and whenIdle wait for
      // both actual close events, so another DELETE cannot escape a still-live operation.
      controller.abort();
      response?.destroy();
      req?.destroy();
    }
  }

  /** Public cancellation/failure can precede native close; drain both GET and exact-ID DELETE work. */
  async whenIdle(): Promise<void> {
    while (this.closing || this.getOperations.size || this.getTransports.size)
      await Promise.allSettled([
        ...(this.closing ? [this.closing.drain] : []),
        ...this.getOperations,
        ...this.getTransports,
      ]);
  }

  private trackGet<T>(operation: () => Promise<T>): Promise<T> {
    let finished!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.getOperations.add(barrier);
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.getOperations.delete(barrier);
        finished();
      });
  }

  /** Current, scoped connection metadata for an independently instrumented anonymous probe. */
  async readConnections(hosts: readonly string[]): Promise<KernelConnectionsSnapshot> {
    let scope: ReadonlySet<string>;
    try {
      scope = connectionHostScope(hosts);
    } catch {
      throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
    }
    const result = await this.readCurrentResponse("/connections", (response) =>
      parseScopedConnections(response, scope),
    );
    return {
      startedAtMono: result.startedAtMono,
      completedAtMono: result.completedAtMono,
      connections: result.value,
    };
  }

  /** Inspect the actual policy behind the built-in name without returning node labels/credentials. */
  async readDirectPolicy(): Promise<DirectPolicyObservation> {
    const result = await this.readCurrentResponse("/proxies/DIRECT", projectDirectPolicy);
    return { ...result.value, startedAtMono: result.startedAtMono, completedAtMono: result.completedAtMono };
  }

  /** A bounded current kernel lookup. This is not Chromium DNS or fake-IP mapping evidence. */
  async readDnsQuery(
    host: string,
    type: KernelDnsQueryType,
    signal?: AbortSignal,
  ): Promise<KernelDnsQueryResponse> {
    const name = normalizeKernelDnsHost(host);
    if (type !== "A" && type !== "AAAA") throw new ClashReaderError("CONTROLLER_CONFIG_INVALID");
    const endpoint = `/dns/query?${new URLSearchParams({ name, type }).toString()}` as const;
    const result = await this.readCurrentResponse(
      endpoint,
      (response) => projectDnsResponse(response, name, type),
      signal,
      Math.min(this.maxResponseBytes, MAX_DNS_RESPONSE_BYTES),
    );
    return { ...result.value, startedAtMono: result.startedAtMono, completedAtMono: result.completedAtMono };
  }

  private readCurrentResponse<T>(
    endpoint: "/connections" | "/proxies/DIRECT" | `/dns/query?${string}`,
    project: (response: unknown) => T,
    signal?: AbortSignal,
    maxResponseBytes = this.maxResponseBytes,
  ): Promise<{ value: T; startedAtMono: number; completedAtMono: number }> {
    return this.trackGet(async () => {
      if (signal?.aborted) throw new ClashReaderError("CONTROLLER_CANCELLED");
      let secret: string | null;
      try {
        secret = this.options.getSecret();
        if (secret !== null && (typeof secret !== "string" || /[\r\n\0]/.test(secret))) throw new Error();
      } catch {
        throw new ClashReaderError("CREDENTIAL_UNAVAILABLE");
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(new ClashReaderError("CONTROLLER_CANCELLED"));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const timer = setTimeout(
        () => controller.abort(new ClashReaderError("CONTROLLER_TIMEOUT")),
        this.timeoutMs,
      );
      const startedAtMono = performance.now();
      try {
        const response = await this.readJson(endpoint, secret, controller.signal, maxResponseBytes);
        if (controller.signal.aborted) throw controller.signal.reason;
        const value = project(response);
        return {
          startedAtMono,
          completedAtMono: performance.now(),
          value,
        };
      } catch (error) {
        if (controller.signal.reason instanceof ClashReaderError) throw controller.signal.reason;
        if (error instanceof ClashReaderError) throw error;
        throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        controller.abort();
      }
    });
  }

  private async readCurrentKernel(): Promise<ClashReadResult> {
    const startedAtMono = performance.now();
    let secret: string | null;
    try {
      secret = this.options.getSecret();
      if (secret !== null && (typeof secret !== "string" || /[\r\n\0]/.test(secret))) throw new Error();
    } catch {
      throw new ClashReaderError("CREDENTIAL_UNAVAILABLE");
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ClashReaderError("CONTROLLER_TIMEOUT")),
      this.timeoutMs,
    );
    try {
      const [configResponse, rulesResponse, versionResponse, directResponse] = await Promise.all([
        this.readJson("/configs", secret, controller.signal),
        this.readJson("/rules", secret, controller.signal),
        this.readJson("/version", secret, controller.signal),
        this.readJson("/proxies/DIRECT", secret, controller.signal),
      ]);
      const config = asRecord(configResponse);
      const rulesEnvelope = asRecord(rulesResponse);
      const kernelVersion = asRecord(versionResponse);
      const mode = boundedString(config.mode, 32);
      const version = boundedString(kernelVersion.version, 128);
      const tun = asRecord(config.tun).enable;
      const mixedPort = config["mixed-port"];
      if (
        typeof tun !== "boolean" ||
        typeof mixedPort !== "number" ||
        !Number.isInteger(mixedPort) ||
        mixedPort < 0 ||
        mixedPort > 65_535 ||
        !Array.isArray(rulesEnvelope.rules)
      )
        throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");

      const rules = rulesEnvelope.rules.map((entry): KernelRule => {
        const rule = asRecord(entry);
        return {
          type: boundedString(rule.type, 128),
          payload: boundedString(rule.payload, 8192, true),
          proxy: boundedString(rule.proxy, 1024),
        };
      });
      // Hash the complete visible responses, including uninterpreted fields. /configs does
      // not expose the complete active DNS, hosts, providers or outbound configuration;
      // this is a control-state observation version, not an attestation of those hidden parts.
      // Only the digest escapes; no config secrets or substitute geo/rules are returned.
      const policy = projectDirectPolicy(directResponse);
      const fingerprint = createHash("sha256")
        .update(canonicalJson([configResponse, rulesResponse, versionResponse, policy.policyFingerprint]))
        .digest("hex");
      const completedAtMono = performance.now();
      return {
        mode,
        tun,
        mixedPort,
        version,
        rules,
        fingerprint,
        startedAtMono,
        completedAtMono,
        configFieldHashes: Object.freeze(
          Object.fromEntries(
            Object.entries(config).map(([key, value]) => [
              key,
              createHash("sha256").update(canonicalJson(value)).digest("hex"),
            ]),
          ),
        ),
        configPathHashes: configurationPathHashes(config),
        directPolicy: Object.freeze({ ...policy, startedAtMono, completedAtMono }),
      };
    } catch (error) {
      const reason = controller.signal.reason;
      controller.abort();
      if (reason instanceof ClashReaderError) throw reason;
      if (error instanceof ClashReaderError) throw error;
      throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
    } finally {
      clearTimeout(timer);
    }
  }

  private readJson(
    path: string,
    secret: string | null,
    signal: AbortSignal,
    maxResponseBytes = this.maxResponseBytes,
  ): Promise<unknown> {
    let drained!: () => void;
    const drain = new Promise<void>((resolve) => {
      drained = resolve;
    });
    this.getTransports.add(drain);
    return new Promise((resolve, reject) => {
      let settled = false,
        requestClosed = false,
        responseClosed = false,
        openSockets = 0;
      let req: ClientRequest | undefined, incoming: IncomingMessage | undefined;
      const finishDrain = () => {
        if (!requestClosed || (incoming && !responseClosed) || openSockets) return;
        this.getTransports.delete(drain);
        drained();
      };
      const fail = (code: ClashReaderErrorCode) => {
        if (!settled) {
          settled = true;
          reject(new ClashReaderError(code));
        }
        incoming?.destroy();
        req?.destroy();
      };
      try {
        if (signal.aborted) {
          fail("CONTROLLER_CANCELLED");
          requestClosed = true;
          finishDrain();
          return;
        }
        // Node HTTP with a literal IP and an explicitly unpooled agent uses a
        // loopback socket, not Chromium, environment proxies or a DNS lookup.
        req = request(
          {
            protocol: "http:",
            hostname: this.hostname,
            port: this.port,
            family: this.hostname === "::1" ? 6 : 4,
            path,
            method: "GET",
            agent: false,
            signal,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              ...(secret ? { authorization: `Bearer ${secret}` } : {}),
            },
          },
          (response) => {
            incoming = response;
            response.once("close", () => {
              responseClosed = true;
              if (!settled) fail("CONTROLLER_UNAVAILABLE");
              finishDrain();
            });
            response.once("error", () => fail("CONTROLLER_UNAVAILABLE"));
            response.once("aborted", () => fail("CONTROLLER_UNAVAILABLE"));
            if (signal.aborted || settled) {
              fail("CONTROLLER_CANCELLED");
              return;
            }
            const status = response.statusCode ?? 0;
            if (status !== 200) {
              fail(status >= 300 && status < 400 ? "CONTROLLER_REDIRECT_REJECTED" : "CONTROLLER_UNAVAILABLE");
              response.destroy();
              return;
            }
            const length = Number(response.headers["content-length"]);
            const encoding = response.headers["content-encoding"];
            if (Number.isFinite(length) && length > maxResponseBytes) {
              fail("CONTROLLER_RESPONSE_TOO_LARGE");
              response.destroy();
              return;
            }
            if (encoding && encoding !== "identity") {
              fail("CONTROLLER_RESPONSE_INVALID");
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > maxResponseBytes) {
                fail("CONTROLLER_RESPONSE_TOO_LARGE");
                response.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () => {
              if (settled) return;
              try {
                const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                settled = true;
                resolve(json);
                // No pooling: explicitly close this completed read's native transport.
                req?.destroy();
              } catch {
                fail("CONTROLLER_RESPONSE_INVALID");
              }
            });
          },
        );
        req.once("socket", (socket) => {
          openSockets++;
          socket.once("close", () => {
            openSockets--;
            finishDrain();
          });
        });
        req.once("close", () => {
          requestClosed = true;
          if (!settled) fail("CONTROLLER_UNAVAILABLE");
          finishDrain();
        });
        req.once("upgrade", (response, socket) => {
          response.destroy();
          socket.destroy();
          fail("CONTROLLER_RESPONSE_INVALID");
        });
        req.once("error", () => fail("CONTROLLER_UNAVAILABLE"));
        req.end();
      } catch {
        fail("CONTROLLER_UNAVAILABLE");
        if (!req) {
          requestClosed = true;
          finishDrain();
        }
      }
    });
  }
}

function projectDnsResponse(
  response: unknown,
  host: string,
  queryType: KernelDnsQueryType,
): Omit<KernelDnsQueryResponse, "startedAtMono" | "completedAtMono"> {
  const value = asRecord(response);
  if (
    !Number.isInteger(value.Status) ||
    (value.Status as number) < 0 ||
    (value.Status as number) > 15 ||
    typeof value.TC !== "boolean" ||
    !Array.isArray(value.Question) ||
    value.Question.length !== 1 ||
    (value.Answer !== undefined &&
      value.Answer !== null &&
      (!Array.isArray(value.Answer) || value.Answer.length > 128))
  )
    throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
  const question = asRecord(value.Question[0]);
  // Running mihomo returns Go dns.Question (Name/Qtype/Qclass). Some controllers
  // expose DNS JSON (name/type). Accept complete known shapes, never mixed aliases.
  const goQuestion = ["Name", "Qtype", "Qclass"].some((key) => Object.hasOwn(question, key));
  if (
    goQuestion &&
    (question.Qclass !== 1 || Object.hasOwn(question, "name") || Object.hasOwn(question, "type"))
  )
    throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
  let name: string;
  try {
    name = normalizeKernelDnsHost(boundedString(goQuestion ? question.Name : question.name, 1024));
  } catch {
    throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
  }
  const questionType = goQuestion ? question.Qtype : question.type;
  if (name !== host || questionType !== (queryType === "A" ? 1 : 28))
    throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
  const answers = ((value.Answer ?? []) as unknown[]).map((entry) => {
    const rr = asRecord(entry);
    if (
      (rr.type !== 1 && rr.type !== 5 && rr.type !== 28) ||
      !Number.isInteger(rr.TTL) ||
      (rr.TTL as number) < 0 ||
      (rr.TTL as number) > 2_147_483_647
    )
      throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
    const owner = normalizeKernelDnsHost(boundedString(rr.name, 1024));
    const rawData = boundedString(rr.data, 1024);
    const data = rr.type === 5 ? normalizeKernelDnsHost(rawData) : rawData;
    if (rr.type !== 5 && (rawData.includes("%") || isIP(rawData) !== (rr.type === 1 ? 4 : 6)))
      throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
    return Object.freeze({ name: owner, type: rr.type, ttl: rr.TTL as number, data });
  });
  return Object.freeze({
    host,
    queryType,
    status: value.Status as number,
    truncated: value.TC,
    question: Object.freeze({ name, type: questionType as number }),
    answers: Object.freeze(answers),
  });
}

function configurationPathHashes(value: unknown): Readonly<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = (node: unknown, pointer: string): void => {
    hashes[pointer] = createHash("sha256").update(canonicalJson(node)).digest("hex");
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, pointer + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"));
      }
    }
  };
  visit(value, "");
  return Object.freeze(hashes);
}

function projectDirectPolicy(
  response: unknown,
): Omit<DirectPolicyObservation, "startedAtMono" | "completedAtMono"> {
  const policy = asRecord(response);
  const stringOrUnknown = (key: string, max: number): string | null => {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) return null;
    return typeof policy[key] === "string" && policy[key].length <= max && !/[\r\n\0]/.test(policy[key])
      ? policy[key]
      : null;
  };
  const type = stringOrUnknown("type", 128);
  const dialer = stringOrUnknown("dialer-proxy", 1024);
  const stable = Object.fromEntries(
    Object.entries(policy).filter(([key]) => key !== "alive" && key !== "history"),
  );
  return {
    kind: type === null ? "unknown" : type === "Direct" ? "direct" : "other",
    interfaceName: stringOrUnknown("interface", 256),
    dialer: dialer === null ? "unknown" : dialer === "" ? "none" : "configured",
    ipVersion: stringOrUnknown("ip-version", 64),
    policyFingerprint: createHash("sha256").update(canonicalJson(stable)).digest("hex"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0))
    throw new ClashReaderError("CONTROLLER_RESPONSE_INVALID");
  return value;
}

/** Object ordering is immaterial, but rule array ordering must remain significant. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
