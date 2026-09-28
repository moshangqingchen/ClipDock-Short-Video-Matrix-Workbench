import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBusinessNetwork } from "@main/network/business-access";
import { acquireDebugger } from "./debugger-lease";
import { DouyinQrObserver } from "./douyin-qr-observer";

const getUrl = "https://www.douyin.com/passport/web/get_qrcode/";
const checkUrl = "https://www.douyin.com/passport/web/check_qrconnect/";
const cleanup: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.useRealTimers(); });
function fixture(sink = vi.fn()) {
  let allowed = true, attached = false, destroyed = false;
  const acquire = vi.fn(() => null);
  cleanup.push(installBusinessNetwork({ enforcement: "strict", check: () => ({ allowed, reason: allowed ? "READY" : "CHECKING" }), acquire }));
  const replies = new Map<string, Array<(value: unknown) => void>>();
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; debug.emit("detach", {}, "fixture"); }),
    sendCommand: vi.fn(async (method: string, params?: { requestId: string }) => {
      if (method !== "Network.getResponseBody") return {};
      return new Promise(resolve => {
        const queue = replies.get(params!.requestId) ?? [];
        queue.push(resolve); replies.set(params!.requestId, queue);
      });
    }),
  });
  const contents = Object.assign(new EventEmitter(), { id: 42, debugger: debug, isDestroyed: () => destroyed }) as unknown as WebContents;
  const observer = new DouyinQrObserver(contents, "fixture-account", sink);
  cleanup.push(() => observer.dispose());
  const event = (method: string, params: Record<string, unknown>) => debug.emit("message", {}, method, params);
  const start = (id: string, url = getUrl, method = "GET") =>
    event("Network.requestWillBeSent", { requestId: id, request: { url, method, postData: "SECRET_REQUEST_BODY" } });
  const finish = (id: string, url = getUrl, status = 200, encodedDataLength = 80) => {
    event("Network.responseReceived", { requestId: id, response: { url, status } });
    event("Network.loadingFinished", { requestId: id, encodedDataLength });
  };
  const respond = async (id: string, body: unknown, base64Encoded = false) => {
    replies.get(id)?.shift()?.({ body: typeof body === "string" ? body : JSON.stringify(body), base64Encoded });
    for (let index = 0; index < 5; index++) await Promise.resolve();
  };
  return { debug, contents, observer, sink, start, finish, event, respond, acquire,
    gate: (value: boolean) => { allowed = value; }, destroy: () => { destroyed = true; } };
}

describe("passive Douyin QR diagnostics", () => {
  it("projects only numeric codes, status enums and message categories without response/query/request secrets", async () => {
    const f = fixture();
    const address = `${getUrl}?msToken=SECRET_TOKEN&a_bogus=SECRET_SIGNATURE&device_id=SECRET_DEVICE`;
    f.start("one", address); f.finish("one", address, 429);
    await f.respond("one", { error_code: "1105", status_code: -2, code: "SECRET_CODE", description: "访问太频繁 SECRET_DESCRIPTION",
      token: "SECRET_TOKEN", data: { error_code: 12, status_code: "42", code: {}, status: "1",
        verify_center_decision_conf: "SECRET_TICKET", qrcode: "SECRET_IMAGE" } });
    expect(f.sink).toHaveBeenCalledExactlyOnceWith({ stage: "get", route: "web", method: "GET", host: "www.douyin.com", httpStatus: 429,
      outcome: "response", cached: false, messageKind: "frequent", codes: { error_code: 1105, status_code: -2, data_error_code: 12, data_status_code: 42 },
      status: 1, challenge: true, securityParams: { msToken: true, aBogus: true, xBogus: false, verifyFp: false },
      browser: { chromeMajor: null, chromiumHintMajor: null, majorMatch: null, electronToken: null, productToken: null },
      requestIdentity: { queryOnly: true, aidPresent: false, fpPresent: false, verifyFpPresent: false,
        aidMatchesGet: null, fpMatchesGet: null, verifyFpMatchesGet: null, fpMatchesVerifyFp: null },
      responseVerificationHeaders: { bdturingParameters: false, bdturingVerify: false },
      requestGapMs: null, requestCount: 1, observations: 1 });
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.debug.sendCommand.mock.calls.map(([method]) => method)).toEqual(["Network.enable", "Network.getResponseBody"]);
    expect(f.debug.sendCommand).toHaveBeenNthCalledWith(1, "Network.enable", {
      maxTotalBufferSize: 1048576, maxResourceBufferSize: 262144, maxPostDataSize: 0,
    });
  });

  it("records UA/CH version consistency and app-token presence without retaining header values", async () => {
    const f = fixture();
    const headers = Object.defineProperties({
      "User-Agent": "Mozilla/5.0 短视频矩阵工作台/1.0.6-rc.3 Chrome/150.0.123.4 Electron/43.3.0 Safari/537.36 SECRET_UA",
      "Sec-CH-UA": '"Not A Brand";v="8", "Chromium";v="150"',
    }, { Cookie: { enumerable: true, get: () => { throw new Error("Cookie must not be read"); } },
      Authorization: { enumerable: true, get: () => { throw new Error("Authorization must not be read"); } } });
    f.event("Network.requestWillBeSent", { requestId: "browser", request: { url: getUrl, method: "GET", headers } });
    f.finish("browser"); await f.respond("browser", { error_code: 7 });
    expect(f.sink.mock.calls[0][0].browser).toEqual({ chromeMajor: 150, chromiumHintMajor: 150,
      majorMatch: true, electronToken: true, productToken: true });
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("短视频矩阵工作台");
    f.start("mismatch", checkUrl);
    f.event("Network.requestWillBeSentExtraInfo", { requestId: "mismatch", headers: {
      "user-agent": "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36", "sec-ch-ua": '"Chromium";v="149"',
    } });
    f.finish("mismatch", checkUrl); await f.respond("mismatch", { error_code: 7 });
    expect(f.sink.mock.calls[1][0].browser).toEqual({ chromeMajor: 150, chromiumHintMajor: 149,
      majorMatch: false, electronToken: false, productToken: false });
  });

  it("only reads response verification header names, including ExtraInfo, never any response header value", async () => {
    const f = fixture();
    const headers = Object.defineProperties({}, Object.fromEntries([
      "X-Vc-Bdturing-Parameters", "Bdturing-Verify", "Set-Cookie", "X-Unknown-Secret",
    ].map(name => [name, { enumerable: true, get: () => { throw new Error("Response header values must not be read"); } }])));
    f.start("headers");
    f.event("Network.responseReceived", { requestId: "headers", response: { url: getUrl, status: 200, headers } });
    f.event("Network.loadingFinished", { requestId: "headers", encodedDataLength: 30 });
    await f.respond("headers", { error_code: 7 });
    expect(f.sink.mock.calls[0][0].responseVerificationHeaders).toEqual({ bdturingParameters: true, bdturingVerify: true });
    f.start("extra", checkUrl); f.finish("extra", checkUrl);
    f.event("Network.responseReceivedExtraInfo", { requestId: "extra", headers });
    await f.respond("extra", { error_code: 7 });
    expect(f.sink.mock.calls[1][0].responseVerificationHeaders).toEqual({ bdturingParameters: true, bdturingVerify: true });
  });

  it("ignores unmatched and redirect-hop ExtraInfo rather than attributing it to a QR request", async () => {
    const f = fixture();
    f.event("Network.requestWillBeSentExtraInfo", { requestId: "early", headers: { "User-Agent": "Chrome/150.0.0.0", "Sec-CH-UA": '"Chromium";v="150"' } });
    f.event("Network.responseReceivedExtraInfo", { requestId: "early", headers: { "bdturing-verify": "SECRET_VERIFY_HEADER" } });
    f.start("early", "https://www.douyin.com/other");
    f.event("Network.requestWillBeSent", { requestId: "early", redirectResponse: { status: 302 },
      request: { url: getUrl, method: "GET" } });
    f.event("Network.responseReceivedExtraInfo", { requestId: "early", headers: { "bdturing-verify": "SECRET_PREVIOUS_HOP" } });
    f.finish("early"); await f.respond("early", { error_code: 0 });
    expect(f.sink.mock.calls[0][0]).toMatchObject({ browser: { majorMatch: null }, responseVerificationHeaders: { bdturingVerify: false } });
    for (let index = 0; index < 40; index++) f.event("Network.requestWillBeSentExtraInfo", {
      requestId: `early-${index}`, headers: { "User-Agent": "Chrome/150.0.0.0" },
    });
    f.start("early-0", checkUrl); f.finish("early-0", checkUrl); await f.respond("early-0", { error_code: 0 });
    expect(f.sink.mock.calls.at(-1)?.[0].browser.chromeMajor).toBeNull();
    f.contents.emit("did-start-navigation", {}, getUrl, false, true);
    f.event("Network.responseReceivedExtraInfo", { requestId: "early-39", headers: { "bdturing-verify": "SECRET_OLD_EPOCH" } });
    f.start("early-39"); f.finish("early-39"); await f.respond("early-39", { error_code: 0 });
    expect(f.sink.mock.calls.at(-1)?.[0].browser.chromeMajor).toBeNull();
    expect(f.sink.mock.calls.at(-1)?.[0].responseVerificationHeaders.bdturingVerify).toBe(false);
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
  });

  it("does not classify a success message with empty descriptions as an unknown error", async () => {
    const f = fixture(); f.start("success"); f.finish("success");
    await f.respond("success", { error_code: 0, message: "success", description: " ", data: { message: "" } });
    expect(f.sink.mock.calls[0][0].messageKind).toBe("none");
  });

  it("compares get/check aid and fingerprint fields in memory and never emits their values", async () => {
    const f = fixture();
    const generation = `${getUrl}?aid=SECRET_AID&fp=SECRET_FP&verifyFp=SECRET_FP`;
    f.start("identity-get", generation); f.finish("identity-get", generation); await f.respond("identity-get", { error_code: 0 });
    const check = `${checkUrl}?aid=SECRET_AID&fp=SECRET_FP&verifyFp=SECRET_CHANGED_FP`;
    f.start("identity-check", check); f.finish("identity-check", check); await f.respond("identity-check", { error_code: 7 });
    expect(f.sink.mock.calls[1][0].requestIdentity).toEqual({ queryOnly: true,
      aidPresent: true, fpPresent: true, verifyFpPresent: true, aidMatchesGet: true, fpMatchesGet: true,
      verifyFpMatchesGet: false, fpMatchesVerifyFp: false });
    const changed = `${checkUrl}?aid=SECRET_CHANGED_AID&fp=SECRET_CHANGED_FP`;
    f.start("changed", changed); f.finish("changed", changed); await f.respond("changed", { error_code: 7 });
    expect(f.sink.mock.calls[2][0].requestIdentity).toMatchObject({ aidMatchesGet: false, fpMatchesGet: false,
      verifyFpPresent: false, verifyFpMatchesGet: null });
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
  });

  it.each(["navigation", "expiry"])("does not compare against an identity baseline after %s", async kind => {
    const f = fixture(), query = "?aid=SECRET_AID&fp=SECRET_FP";
    f.start("get", getUrl + query); f.finish("get", getUrl + query); await f.respond("get", { error_code: 0 });
    if (kind === "navigation") f.contents.emit("did-start-navigation", {}, getUrl, false, true);
    else vi.advanceTimersByTime(300_001);
    f.start("check", checkUrl + query); f.finish("check", checkUrl + query); await f.respond("check", { error_code: 7 });
    expect(f.sink.mock.calls.at(-1)?.[0].requestIdentity).toMatchObject({ aidMatchesGet: null, fpMatchesGet: null });
  });

  it("does not compare duplicated or oversized query identity fields", async () => {
    const f = fixture(), query = `?aid=SECRET_AID&aid=OTHER_AID&fp=${"x".repeat(257)}`;
    f.start("get", getUrl + query); f.finish("get", getUrl + query); await f.respond("get", { error_code: 0 });
    f.start("check", checkUrl + query); f.finish("check", checkUrl + query); await f.respond("check", { error_code: 7 });
    expect(f.sink.mock.calls.at(-1)?.[0].requestIdentity).toMatchObject({ aidPresent: true, fpPresent: true,
      aidMatchesGet: null, fpMatchesGet: null });
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
  });

  it.each(["GET", "POST"])("observes a check request using %s without modifying it", async method => {
    const f = fixture(); f.start("check", checkUrl, method); f.finish("check", checkUrl);
    await f.respond("check", { data: { status: "scanned", description: "二维码已失效" } });
    expect(f.sink.mock.calls[0][0]).toMatchObject({ stage: "check", method, status: "scanned", messageKind: "expired" });
  });

  it.each([
    { path: "/passport/web/check_qrconnect/", route: "web" },
    { path: "/passport/sso/check_qrconnect/", route: "sso" },
    { path: "/check_qrconnect", route: "legacy" },
    { path: "/check_qrconnect/", route: "legacy" },
  ])("observes the official check alias $path and records only its route enum", async ({ path, route }) => {
    const f = fixture(), url = `https://www.douyin.com${path}?token=SECRET_TOKEN`;
    f.start("alias", url, "GET"); f.finish("alias", url);
    await f.respond("alias", { error_code: 0, data: { status: "new" } });
    expect(f.sink.mock.calls[0][0]).toMatchObject({ stage: "check", route, method: "GET", status: "new" });
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
  });

  it.each([
    "http://www.douyin.com/passport/web/get_qrcode/",
    "https://www.douyin.com:443/passport/web/get_qrcode/",
    "https://www.douyin.com:8443/passport/web/get_qrcode/",
    "https://person@www.douyin.com/passport/web/get_qrcode/",
    "https://www.douyin.com.evil.example/passport/web/get_qrcode/",
    "https://evil-douyin.com/passport/web/get_qrcode/",
    "https://www.douyin.com/upload",
    "https://www.douyin.com/passport/web/get_qrcode/extra",
    "https://www.douyin.com/passport/web/check_qrconnect/extra",
    "https://www.douyin.com/passport/sso/check_qrconnect/extra",
    "https://www.douyin.com/check_qrconnect/extra",
    "https://www.douyin.com/check_qrconnect-evil",
    "https://www.douyin.com\\@evil.example/passport/web/get_qrcode/",
  ])("does not inspect an unrelated or malformed target: %s", address => {
    const f = fixture(); f.start("bad", address); f.finish("bad", address);
    expect(f.debug.sendCommand).toHaveBeenCalledOnce();
    expect(f.sink).not.toHaveBeenCalled();
  });

  it("drops a response redirected away from the matched host or endpoint", () => {
    const f = fixture(); f.start("redirect"); f.finish("redirect", "https://other.douyin.com/passport/web/get_qrcode/");
    expect(f.debug.sendCommand).toHaveBeenCalledOnce(); expect(f.sink).not.toHaveBeenCalled();
  });

  it.each(["navigation", "detach", "dispose", "gate", "destroy"])("rejects a body completing after %s", async kind => {
    const f = fixture(); f.start("late"); f.finish("late");
    if (kind === "navigation") f.contents.emit("did-start-navigation", {}, "https://www.douyin.com/", false, true);
    else if (kind === "detach") f.debug.detach();
    else if (kind === "dispose") f.observer.dispose();
    else if (kind === "gate") f.gate(false);
    else f.destroy();
    await f.respond("late", { error_code: 1105 });
    expect(f.sink).not.toHaveBeenCalled();
  });

  it("rejects a pending body after its request id is reused", async () => {
    const f = fixture(); f.start("same"); f.finish("same");
    f.start("same", checkUrl, "POST"); f.finish("same", checkUrl);
    await f.respond("same", { error_code: 1105 });
    expect(f.sink).not.toHaveBeenCalled();
    await f.respond("same", { error_code: 0, data: { status: "confirmed" } });
    expect(f.sink).toHaveBeenCalledOnce();
    expect(f.sink.mock.calls[0][0]).toMatchObject({ stage: "check", status: "confirmed" });
  });

  it("caps both pending requests and native in-flight body reads at 32 across navigation", async () => {
    const f = fixture();
    for (let index = 0; index < 100; index++) f.start(String(index));
    for (let index = 0; index < 100; index++) f.finish(String(index));
    expect(f.debug.sendCommand.mock.calls.filter(([method]) => method === "Network.getResponseBody")).toHaveLength(32);
    f.contents.emit("did-start-navigation", {}, "https://www.douyin.com/", false, true);
    for (let index = 100; index < 150; index++) { f.start(String(index)); f.finish(String(index)); }
    expect(f.debug.sendCommand.mock.calls.filter(([method]) => method === "Network.getResponseBody")).toHaveLength(32);
    await f.respond("0", { error_code: 0 });
    expect(f.sink).not.toHaveBeenCalled();
    f.start("new"); f.finish("new"); await f.respond("new", { error_code: 0 });
    expect(f.sink).toHaveBeenCalledOnce();
  });

  it("rejects oversized wire bodies without reading them and decoded UTF-8/base64 bodies before parsing", async () => {
    const f = fixture(); f.start("wire"); f.finish("wire", getUrl, 200, 262145);
    expect(f.debug.sendCommand).toHaveBeenCalledOnce();
    expect(f.sink.mock.calls[0][0].outcome).toBe("body-too-large");
    f.start("utf8", checkUrl); f.finish("utf8", checkUrl, 200, 100);
    await f.respond("utf8", JSON.stringify({ description: "频".repeat(90_000) }));
    expect(f.sink.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "check", outcome: "body-too-large", messageKind: "unknown" });
    f.start("base64"); f.finish("base64");
    await f.respond("base64", Buffer.from("x".repeat(262145)).toString("base64"), true);
    expect(f.sink.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "get", outcome: "body-too-large" });
  });

  it("handles base64 JSON, malformed JSON and unknown status/code fields without leaking strings", async () => {
    const f = fixture(); f.start("base64"); f.finish("base64");
    await f.respond("base64", Buffer.from(JSON.stringify({ data: { error_code: 0, status: "SECRET_STATUS", code: "SECRET_CODE" } })).toString("base64"), true);
    expect(f.sink.mock.calls[0][0]).toMatchObject({ outcome: "response", codes: { data_error_code: 0 } });
    expect(f.sink.mock.calls[0][0]).not.toHaveProperty("status");
    f.start("html"); f.finish("html"); await f.respond("html", "<html>SECRET_HTML</html>");
    expect(f.sink.mock.calls[1][0].outcome).toBe("non-json");
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
  });

  it("limits repeated content to 10 seconds, reports changes immediately and preserves request frequency/count", async () => {
    const f = fixture();
    f.start("one"); f.finish("one"); await f.respond("one", { error_code: 1105 });
    vi.advanceTimersByTime(2000);
    f.start("two"); f.finish("two"); await f.respond("two", { error_code: 1105 });
    expect(f.sink).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    f.start("three"); f.finish("three"); await f.respond("three", { error_code: 7 });
    expect(f.sink.mock.calls[1][0]).toMatchObject({ observations: 2, requestGapMs: 1000, requestCount: 3 });
    vi.advanceTimersByTime(10_000);
    f.start("four"); f.finish("four"); await f.respond("four", { error_code: 7 });
    expect(f.sink).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 50; index++) {
      const id = `burst-${index}`; f.start(id); f.finish(id); await f.respond(id, { error_code: index });
    }
    expect(f.sink).toHaveBeenCalledTimes(20);
    vi.advanceTimersByTime(60_000);
    f.start("after-cap"); f.finish("after-cap"); await f.respond("after-cap", { error_code: 7 });
    expect(f.sink).toHaveBeenCalledTimes(21);
    expect(f.sink.mock.calls.at(-1)?.[0].observations).toBeGreaterThan(1);
  });

  it.each(["net::ERR_BLOCKED_BY_CLIENT", "SECRET_URL https://host/?token=SECRET"])("only retains fixed Chromium network errors: %s", errorText => {
    const f = fixture(); f.start("failed");
    f.event("Network.loadingFailed", { requestId: "failed", canceled: true, errorText });
    expect(f.sink.mock.calls[0][0]).toMatchObject({ outcome: "network-failed", canceled: true, httpStatus: null });
    expect(f.sink.mock.calls[0][0].networkError).toBe(errorText.startsWith("net::ERR_") ? errorText : undefined);
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain("SECRET");
  });

  it("shares the debugger with uploads and ignores sink failures without disabling Network", async () => {
    const f = fixture(vi.fn(() => { throw new Error("synthetic storage failure"); }));
    const releaseUpload = acquireDebugger(f.contents);
    f.start("one"); f.finish("one"); await f.respond("one", { error_code: 1105 });
    f.observer.dispose();
    expect(f.debug.detach).not.toHaveBeenCalled();
    releaseUpload(); expect(f.debug.detach).toHaveBeenCalledOnce();
    expect(f.debug.sendCommand.mock.calls.map(([method]) => method)).not.toContain("Network.disable");
  });
});
