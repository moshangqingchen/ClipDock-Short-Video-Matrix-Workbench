import type { WebContents } from "electron";
import { canUseBusinessNetwork } from "@main/network/business-access";
import { acquireDebugger } from "./debugger-lease";

type Stage = "get" | "check";
type Outcome = "response" | "network-failed" | "body-unavailable" | "body-too-large" | "non-json";
type Codes = Partial<Record<"error_code" | "status_code" | "code" | "data_error_code" | "data_status_code" | "data_code", number>>;
interface BrowserMetadata {
  chromeMajor: number | null;
  chromiumHintMajor: number | null;
  majorMatch: boolean | null;
  electronToken: boolean | null;
  productToken: boolean | null;
}
interface VerificationHeaders { bdturingParameters: boolean; bdturingVerify: boolean }
interface IdentityValues { aid: string | null; fp: string | null; verifyFp: string | null }
interface IdentityComparison {
  queryOnly: true;
  aidPresent: boolean; fpPresent: boolean; verifyFpPresent: boolean;
  aidMatchesGet: boolean | null; fpMatchesGet: boolean | null; verifyFpMatchesGet: boolean | null;
  fpMatchesVerifyFp: boolean | null;
}
export interface DouyinQrDiagnostic {
  stage: Stage;
  route: "web" | "sso" | "legacy";
  method: "GET" | "POST";
  host: string;
  httpStatus: number | null;
  outcome: Outcome;
  messageKind: "frequent" | "expired" | "verification" | "unknown" | "none";
  codes?: Codes;
  status?: string | number;
  challenge?: boolean;
  canceled?: boolean;
  networkError?: string;
  cached?: boolean;
  securityParams: { msToken: boolean; aBogus: boolean; xBogus: boolean; verifyFp: boolean };
  browser: BrowserMetadata;
  requestIdentity: IdentityComparison;
  responseVerificationHeaders: VerificationHeaders;
  requestGapMs: number | null;
  requestCount: number;
  /** Includes duplicate observations suppressed since the preceding emitted diagnostic. */
  observations: number;
}
type Target = Pick<DouyinQrDiagnostic, "stage" | "route" | "host" | "securityParams">;
interface Pending extends Target {
  method: "GET" | "POST";
  id: string;
  epoch: number;
  valid: boolean;
  at: number;
  requestGapMs: number | null;
  requestCount: number;
  httpStatus: number | null;
  cached: boolean;
  allowExtraInfo: boolean;
  browser: BrowserMetadata;
  requestIdentity: IdentityComparison;
  responseVerificationHeaders: VerificationHeaders;
}
const MAX_BODY_BYTES = 262144;
const MAX_TRACKED = 32;
const MAX_EVENTS_PER_MINUTE = 20;
const QR_STATUS = new Set<string | number>([1, 2, 3, 4, 5, "new", "scanned", "confirmed", "expired", "refused", "cancelled", "canceled"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const emptyBrowser = (): BrowserMetadata => ({ chromeMajor: null, chromiumHintMajor: null,
  majorMatch: null, electronToken: null, productToken: null });
const emptyVerification = (): VerificationHeaders => ({ bdturingParameters: false, bdturingVerify: false });

/** Read just the two request identity headers, never Cookie/Authorization or full header objects. */
function browserMetadata(input: unknown): BrowserMetadata {
  const headers = record(input), result = emptyBrowser();
  if (!headers) return result;
  for (const name of Object.keys(headers)) {
    const key = name.toLowerCase();
    if (key !== "user-agent" && key !== "sec-ch-ua") continue;
    const value = headers[name];
    if (typeof value !== "string" || value.length > 4096) continue;
    if (key === "user-agent") {
      const version = /\bChrome\/(\d{1,3})(?:\.|\s|$)/.exec(value);
      result.chromeMajor = version ? Number(version[1]) : null;
      result.electronToken = /\bElectron\//i.test(value);
      result.productToken = /(?:short-video-matrix-workbench|短视频矩阵工作台|ClipDock)\//i.test(value);
    } else {
      const version = /"Chromium"\s*;\s*v="(\d{1,3})"/i.exec(value);
      result.chromiumHintMajor = version ? Number(version[1]) : null;
    }
  }
  result.majorMatch = result.chromeMajor !== null && result.chromiumHintMajor !== null
    ? result.chromeMajor === result.chromiumHintMajor : null;
  return result;
}
function mergeBrowser(previous: BrowserMetadata, next: BrowserMetadata): BrowserMetadata {
  const merged = { ...previous };
  for (const key of ["chromeMajor", "chromiumHintMajor", "electronToken", "productToken"] as const)
    if (next[key] !== null) Object.assign(merged, { [key]: next[key] });
  merged.majorMatch = merged.chromeMajor !== null && merged.chromiumHintMajor !== null
    ? merged.chromeMajor === merged.chromiumHintMajor : null;
  return merged;
}
/** Only header names are inspected. Challenge/ticket header values are never accessed or decoded. */
function verificationHeaders(input: unknown): VerificationHeaders {
  const keys = Object.keys(record(input) ?? {}).map(name => name.toLowerCase());
  return { bdturingParameters: keys.includes("x-vc-bdturing-parameters"), bdturingVerify: keys.includes("bdturing-verify") };
}
function mergeVerification(first: VerificationHeaders, next: VerificationHeaders): VerificationHeaders {
  return { bdturingParameters: first.bdturingParameters || next.bdturingParameters,
    bdturingVerify: first.bdturingVerify || next.bdturingVerify };
}

/** Official clients declare web paths and the legacy-to-sso check rewrite.
 * The consumer's dynamic host is still being observed.
 * This passive family match grants no network permission and never stores a URL or query value. */
function target(address: unknown): Target | null {
  if (typeof address !== "string" || address.length > 16384 || /[\\\s]/.test(address) ||
      [...address].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(address);
    const authority = /^https:\/\/([^/?#]+)/.exec(address)?.[1];
    if (url.protocol !== "https:" || url.username || url.password || url.port || authority !== url.hostname ||
        !(url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"))) return null;
    const stage = url.pathname === "/passport/web/get_qrcode/" ? "get"
      : ["/passport/web/check_qrconnect/", "/passport/sso/check_qrconnect/", "/check_qrconnect", "/check_qrconnect/"].includes(url.pathname) ? "check" : null;
    if (!stage) return null;
    const route = url.pathname.startsWith("/passport/web/") ? "web"
      : url.pathname.startsWith("/passport/sso/") ? "sso" : "legacy";
    return { stage, route, host: url.hostname, securityParams: {
      msToken: url.searchParams.has("msToken"), aBogus: url.searchParams.has("a_bogus"),
      xBogus: url.searchParams.has("X-Bogus"), verifyFp: url.searchParams.has("verifyFp"),
    } };
  } catch { return null; }
}
const httpStatus = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

function projection(root: Record<string, unknown>): Pick<DouyinQrDiagnostic, "codes" | "status" | "challenge" | "messageKind"> {
  const data = record(root.data) ?? {};
  const codes: Codes = {};
  for (const field of ["error_code", "status_code", "code"] as const) {
    for (const [source, key] of [[root, field], [data, `data_${field}`]] as const) {
      const raw = source[field];
      const value = typeof raw === "string" && /^-?\d{1,9}$/.test(raw) ? Number(raw) : raw;
      if (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000) codes[key] = value;
    }
  }
  const challenge = [root, data].some(source =>
    ["verify_center_decision_conf", "verify_center_secondary_decision_conf"].some(key => Object.hasOwn(source, key)));
  const messages = [root.description, data.description, root.message, data.message]
    .filter((value): value is string => typeof value === "string")
    .map(value => value.slice(0, 1024).trim()).filter(Boolean).join(" ");
  const messageKind = /频繁|频率|too\s+many|frequen|rate.?limit/i.test(messages) ? "frequent"
    : /过期|失效|expir/i.test(messages) ? "expired"
    : challenge || /验证|验证码|captcha|verif/i.test(messages) ? "verification"
    : Object.values(codes).some(value => value !== 0) || (messages && messages !== "success") ? "unknown" : "none";
  const status = typeof data.status === "string" && /^[1-5]$/.test(data.status) ? Number(data.status) : data.status;
  return { codes, challenge, messageKind,
    ...(QR_STATUS.has(status as string | number) ? { status: status as string | number } : {}) };
}

/** Reads existing QR responses only. It never issues requests, changes login state, or reloads a page. */
export class DouyinQrObserver {
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Set<Pending>();
  private readonly counts = new Map<Stage, { at: number; count: number }>();
  // Values are bounded, memory-only, scoped to this document and expire after five minutes.
  private identityBaseline: { at: number; values: IdentityValues } | null = null;
  private identityExpiry: ReturnType<typeof setTimeout> | undefined;
  private epoch = 0;
  private disposed = false;
  private release: (() => void) | null = null;
  private minuteAt = 0;
  private emitted = 0;
  private observations = 0;
  private lastSignature = "";
  private lastEmittedAt = -Infinity;

  constructor(private readonly contents: WebContents, private readonly accountId: string,
    private readonly sink: (diagnostic: DouyinQrDiagnostic) => void) {
    try {
      this.release = acquireDebugger(contents);
      contents.debugger.on("message", this.onMessage);
      contents.debugger.on("detach", this.invalidate);
      contents.on("did-start-navigation", this.onNavigate);
      // Only Douyin views instantiate this observer. Existing identity/works observers
      // run on other platforms; use their same buffer sizes and never Network.disable.
      void contents.debugger.sendCommand("Network.enable", {
        maxTotalBufferSize: 1048576, maxResourceBufferSize: MAX_BODY_BYTES, maxPostDataSize: 0,
      }).catch(this.invalidate);
    } catch { this.dispose(); }
  }

  private readonly invalidate = () => {
    this.epoch++;
    this.pending.clear();
    this.identityBaseline = null;
    if (this.identityExpiry) clearTimeout(this.identityExpiry);
    this.identityExpiry = undefined;
    for (const request of this.inFlight) request.valid = false;
  };
  private readonly onNavigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) this.invalidate();
  };
  private current(request: Pending): boolean {
    return !this.disposed && request.valid && request.epoch === this.epoch &&
      !this.contents.isDestroyed() && canUseBusinessNetwork(this.accountId);
  }
  private identityComparison(address: string, stage: Stage, now: number): IdentityComparison {
    const query = new URL(address).searchParams;
    const read = (key: keyof IdentityValues) => {
      const values = query.getAll(key);
      return values.length === 1 && values[0].length > 0 && values[0].length <= 256 ? values[0] : null;
    };
    const values = { aid: read("aid"), fp: read("fp"), verifyFp: read("verifyFp") };
    if (this.identityBaseline && (now < this.identityBaseline.at || now - this.identityBaseline.at > 300_000)) this.identityBaseline = null;
    const same = (first: string | null | undefined, second: string | null | undefined) => first && second ? first === second : null;
    const result: IdentityComparison = { queryOnly: true,
      aidPresent: query.has("aid"), fpPresent: query.has("fp"), verifyFpPresent: query.has("verifyFp"),
      aidMatchesGet: same(values.aid, this.identityBaseline?.values.aid),
      fpMatchesGet: same(values.fp, this.identityBaseline?.values.fp),
      verifyFpMatchesGet: same(values.verifyFp, this.identityBaseline?.values.verifyFp),
      fpMatchesVerifyFp: same(values.fp, values.verifyFp),
    };
    if (stage === "get") {
      this.identityBaseline = { at: now, values };
      if (this.identityExpiry) clearTimeout(this.identityExpiry);
      this.identityExpiry = setTimeout(() => { this.identityBaseline = null; this.identityExpiry = undefined; }, 300_000);
      this.identityExpiry.unref?.();
    }
    return result;
  }
  private readonly onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (this.disposed) return;
    if (!canUseBusinessNetwork(this.accountId)) { this.invalidate(); return; }
    const id = typeof params.requestId === "string" ? params.requestId : "";
    if (!id || id.length > 256) return;
    if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceivedExtraInfo") {
      const request = this.pending.get(id) ?? [...this.inFlight].find(item => item.id === id && this.current(item));
      // ExtraInfo can precede a request or describe another redirect hop using the
      // same CDP id. Prefer missing metadata over attributing those headers to QR.
      if (!request?.allowExtraInfo) return;
      const browser = method === "Network.requestWillBeSentExtraInfo" ? browserMetadata(params.headers) : undefined;
      const verification = method === "Network.responseReceivedExtraInfo" ? verificationHeaders(params.headers) : undefined;
      if (browser) request.browser = mergeBrowser(request.browser, browser);
      if (verification) request.responseVerificationHeaders = mergeVerification(request.responseVerificationHeaders, verification);
      return;
    }
    if (method === "Network.requestWillBeSent") {
      this.pending.delete(id);
      for (const item of this.inFlight) if (item.id === id) item.valid = false;
      const request = record(params.request);
      const match = target(request?.url);
      if (!match || (request?.method !== "GET" && request?.method !== "POST")) return;
      const now = Date.now(), previous = this.counts.get(match.stage);
      const count = Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1);
      this.counts.set(match.stage, { at: now, count });
      for (const [key, value] of this.pending) if (now - value.at > 30_000) this.pending.delete(key);
      // Native CDP promises cannot be canceled. Keep in-flight slots occupied until
      // they settle, including after invalidation, to bound outstanding body reads.
      if (this.pending.size + this.inFlight.size >= MAX_TRACKED) return;
      this.pending.set(id, { ...match, method: request.method, id, epoch: this.epoch, valid: true, at: now,
        allowExtraInfo: !params.redirectResponse,
        browser: browserMetadata(request.headers),
        requestIdentity: this.identityComparison(request.url as string, match.stage, now),
        responseVerificationHeaders: emptyVerification(),
        requestGapMs: previous ? Math.max(0, Math.min(3600_000, now - previous.at)) : null,
        requestCount: count, httpStatus: null, cached: false });
    } else if (method === "Network.responseReceived") {
      const request = this.pending.get(id), response = record(params.response);
      const match = target(response?.url);
      if (!request || !match || match.stage !== request.stage || match.route !== request.route || match.host !== request.host) {
        this.pending.delete(id); return;
      }
      request.httpStatus = httpStatus(response?.status);
      request.cached = response?.fromDiskCache === true || response?.fromServiceWorker === true;
      request.responseVerificationHeaders = mergeVerification(request.responseVerificationHeaders, verificationHeaders(response?.headers));
    } else if (method === "Network.loadingFailed") {
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (request) this.emit(request, { outcome: "network-failed", messageKind: "unknown",
        canceled: params.canceled === true,
        ...(typeof params.errorText === "string" && /^net::ERR_[A-Z0-9_]{1,64}$/.test(params.errorText)
          ? { networkError: params.errorText } : {}) });
    } else if (method === "Network.loadingFinished") {
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (!request || request.httpStatus === null || !this.current(request)) return;
      if (typeof params.encodedDataLength === "number" && params.encodedDataLength > MAX_BODY_BYTES) {
        this.emit(request, { outcome: "body-too-large", messageKind: "unknown" }); return;
      }
      this.inFlight.add(request);
      void this.consume(request).finally(() => this.inFlight.delete(request));
    }
  };

  private async consume(request: Pending): Promise<void> {
    try {
      if (!this.current(request)) return;
      const body = record(await this.contents.debugger.sendCommand("Network.getResponseBody", { requestId: request.id }));
      if (!this.current(request)) return;
      if (typeof body?.body !== "string") { this.emit(request, { outcome: "body-unavailable", messageKind: "unknown" }); return; }
      if (body.body.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) {
        this.emit(request, { outcome: "body-too-large", messageKind: "unknown" }); return;
      }
      const text = body.base64Encoded === true ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
        this.emit(request, { outcome: "body-too-large", messageKind: "unknown" }); return;
      }
      let root: Record<string, unknown> | null;
      try { root = record(JSON.parse(text)); } catch { root = null; }
      this.emit(request, root ? { outcome: "response", ...projection(root) }
        : { outcome: "non-json", messageKind: "unknown" });
    } catch { this.emit(request, { outcome: "body-unavailable", messageKind: "unknown" }); }
  }

  private emit(request: Pending, fields: Pick<DouyinQrDiagnostic, "outcome" | "messageKind"> & Partial<DouyinQrDiagnostic>): void {
    if (!this.current(request)) return;
    const summary = { stage: request.stage, route: request.route, method: request.method, host: request.host, httpStatus: request.httpStatus,
      cached: request.cached, securityParams: request.securityParams, browser: request.browser,
      requestIdentity: request.requestIdentity, responseVerificationHeaders: request.responseVerificationHeaders, ...fields };
    const signature = JSON.stringify(summary), now = Date.now();
    this.observations++;
    if (now - this.minuteAt >= 60_000 || now < this.minuteAt) { this.minuteAt = now; this.emitted = 0; }
    if (this.emitted >= MAX_EVENTS_PER_MINUTE || (signature === this.lastSignature && now - this.lastEmittedAt < 10_000)) return;
    this.emitted++;
    this.lastSignature = signature;
    this.lastEmittedAt = now;
    const observations = this.observations;
    this.observations = 0;
    try { this.sink({ ...summary, requestGapMs: request.requestGapMs, requestCount: request.requestCount, observations }); }
    catch { /* Diagnostic storage must not affect the website or its login state. */ }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.contents.debugger?.removeListener("message", this.onMessage);
    this.contents.debugger?.removeListener("detach", this.invalidate);
    this.contents.removeListener("did-start-navigation", this.onNavigate);
    try { this.release?.(); } catch { /* Native destruction may have already detached it. */ }
    this.release = null;
  }
}
