import http from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ProxyTransport,
  type ProxyTransportLease,
  type ProxyTransportOptions,
  type ProxyTunnelContext,
  type ProxyTransportRequest,
} from "./proxy-transport";
import { issueTikTokUploadTarget, type TikTokUploadTarget } from "./proxy-target-policy";
import { issueYouTubeUploadTarget } from "./youtube-upload-target";
import { YouTubeUploadAdapter, type YouTubeUploadContext } from "./youtube-upload-adapter";
import { YOUTUBE_UPLOAD_SCOPE } from "@shared/youtube-upload";

// Synthetic identity only: the fixture maps CONNECT to a loopback receiver, never TikTok.
const uploadIdentity = {
  key: readFileSync(new URL("./test-fixtures/tiktok-upload-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./test-fixtures/tiktok-upload-cert.pem", import.meta.url)),
};
const youtubeIdentity = {
  key: readFileSync(new URL("./test-fixtures/youtube-upload-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./test-fixtures/youtube-upload-cert.pem", import.meta.url)),
};

// Disposable public test identity, trusted only inside this Vitest worker. Production has no CA override.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGYJZighZhnEV1
WxStavvtXcB/h+gVNchCB1ykuq4TdmIL+oEq+PPyM01SErQMjrnQgxhyBhDMWqEW
vaNcsg1AzPj2lhxKp3nNVHJ+/Z6Wuldsu7LROu3wvFsazPfZ4jZpmALD6DbVYnEt
ZaOILHS8b9wu3/qaGSYAMAJq77zOpgVe6eusR8/nauHydUTipZqDpPA+u+33wnjX
LHbU0Axc/jeznvxi1XOI/36pzk/Hc3qJG3x8sTt/7LHr25B6Z7joowORSSnRwpsg
0PcumUfSQxnEfdr5Ptq73zpDpwqw7oi3R0+s/OSfkZi6ml7QY569lkjiFJnUyOKE
3a49g1ePAgMBAAECggEAAQMEb4/2z7Qev1AAr40nSTIDedAUDD+la1ljE/woNSJQ
zxyI+O8sfnUxC7qZNeYmFnghJYeWBRaVPxWFMXLD7D40uRZuGM59fwc7kWA+cRWy
cZCHg28V/eOiHwac+LW0Upnr6pP0JIgHcu6Hl8WUWTaVI4pJuVSX4FISg3RyYqJj
wSIdPMq7WwnRvxXD1wn13OC/aZnQ107H057SqfAqMDISdYQQrVkgmwuswX8jqtLV
D3HY6g6zL/u76ZrCBVYPdGKb23ues9v7Zeq4ztuciz5yHds2s2iuD7NS1P6PAJqQ
rcp3sUfHIf6FCJnjuBoC1l/RSbyYJUmofZr4wPxFKQKBgQD5l5rl7g8mRuisMGum
qhFrWcr1uDaLaw8M1Pj3ocAd+eLZobodmwbXY4yI29oYzS0Bnp8Yb6yQ+puLb6i1
4dH70rOl29UecvmuCV87OxQXt7/hW99kOBwyP7Q4GBLOBkhADgH+GL5TaEgzE/6c
vpupKL0VrYTGxIgwBNB2fTt9KwKBgQDLeGHxKi0XAr8pk8dUBlq0ol0ITK3HlBxF
mz84nDQAJtQ8UXxHs1XAPJuIhaxowmjTs2nu+UJYE9RWDOOTPblpohHJUIgSAnDh
bPW7TwTApvV00rV3nF2VC//EvfVrko7V/WeVOcQ4xrbd/7UDdYXUNkIK9Jou1ORP
VKNzaJWFLQKBgFbX5EKKkWTdGUoIUvybghIbHR5gKUJbTtJFLBdlhWYos0DMH+j7
Luc0sQpRjNJCWZ2NpoenG6EaQZLDmC0o1JpNVsqn8cB1euCOTD9csAIMokv0XocN
auok9jzqS2i6ENuQxCq4S0jUKQL0uwuo2pqCHUB0rpVGfqhOlIYVzuQfAoGABi2j
m7USJW6560NHfC+tNWrwtD3P0Q2YRizOoKNtmMuVCjfXND4nzmyItH6Km6u7jyIV
h2IeN5pyiiJeDqyDIsf/DkPZveJBFzc9xvBBTrBDJ8b2J6mh1dLFc23pM9kBaVIG
gSt939N43gjTsEUzSRxUqQyAWgew3w/M3sZANAkCgYEAvsKBakYchxlzB+6HdaB+
4MVSj4mhaO+QjQtIgUCt9o28YAnnGxbnq/55i62ffAhFz5aZEsumfsWkPNZmXsHZ
XPe0/TWvNvfaNQxnzhA4ZoU0QRmfJo0bdOR7TX1xLELN6B8ArcOm6TQ98OiZbZxr
nX78xh2EtIzl+SOunNqpkwM=
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUfl/vQs4Til/fwGcdtAyIAUhZD5QwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJYXBpLnguY29tMCAXDTI2MDkwODA0NTE0OVoYDzIxMjYw
ODE1MDQ1MTQ5WjAUMRIwEAYDVQQDDAlhcGkueC5jb20wggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDGYJZighZhnEV1WxStavvtXcB/h+gVNchCB1ykuq4T
dmIL+oEq+PPyM01SErQMjrnQgxhyBhDMWqEWvaNcsg1AzPj2lhxKp3nNVHJ+/Z6W
uldsu7LROu3wvFsazPfZ4jZpmALD6DbVYnEtZaOILHS8b9wu3/qaGSYAMAJq77zO
pgVe6eusR8/nauHydUTipZqDpPA+u+33wnjXLHbU0Axc/jeznvxi1XOI/36pzk/H
c3qJG3x8sTt/7LHr25B6Z7joowORSSnRwpsg0PcumUfSQxnEfdr5Ptq73zpDpwqw
7oi3R0+s/OSfkZi6ml7QY569lkjiFJnUyOKE3a49g1ePAgMBAAGjaTBnMB0GA1Ud
DgQWBBQe4VouA+frY2kMWU43oo7L3C0IYDAfBgNVHSMEGDAWgBQe4VouA+frY2kM
WU43oo7L3C0IYDAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWFwaS54LmNv
bTANBgkqhkiG9w0BAQsFAAOCAQEAOfwR2fbxyuoig82Q5nR3plCCy1rNrFokIxER
TguGBD+Ty8UM0yTP21UpxFb0P0lh72aUmLRatAxyjI0QyLtktTjKLsSWTEQaT7o7
rJAQMwPig6ak97Ho3aJ3tFDzqdDd4UO7+1t/u1NvUhnZV9s79daHIoytIU4AyVj2
4nDCgEd68zNVKUqtF50l9hrYB4NqMWWwg/s/Glqk9NWk+x44zQuZXzrIziH3WW6q
NlWTVev1KQFyWfChnlQVfgM+TRHZtjfiNdzvkIL6oJzpCHZRQiL/YqYmG51L+HLv
47LtRxklnX/yyN+QMRVNvdVBlGGJJRAtOk1H4kD9GM7CrsYEjA==
-----END CERTIFICATE-----`;
const originalCas = tls.getCACertificates();
beforeAll(() =>
  tls.setDefaultCACertificates([cert, uploadIdentity.cert.toString(), youtubeIdentity.cert.toString()]),
);
afterAll(() => tls.setDefaultCACertificates(originalCas));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function liveLease(duration = 5000) {
  const abort = new AbortController();
  const value: ProxyTransportLease = {
    generation: 1,
    expiresAtMono: performance.now() + duration,
    signal: abort.signal,
    isCurrent: vi.fn(() => !abort.signal.aborted),
    release: vi.fn(),
  };
  return { value, abort };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  options: {
    status?: number;
    head?: string;
    holdConnect?: boolean;
    uploadIdentity?: boolean;
    youtubeIdentity?: boolean;
    onRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    respond?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  } = {},
) {
  const sockets = new Set<Socket>();
  const connectRequests: {
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    sourcePort: number | undefined;
    targetPort: number | undefined;
  }[] = [];
  const targetRequests: { url: string | undefined; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const arrived = deferred<void>(),
    targetArrived = deferred<void>();
  let secureConnections = 0,
    tunneledBytes = 0;
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  };
  const target = https.createServer(
    options.youtubeIdentity ? youtubeIdentity : options.uploadIdentity ? uploadIdentity : { key, cert },
    (request, response) => {
      targetArrived.resolve();
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        targetRequests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
        if (options.respond) options.respond(request, response);
        else response.end("ok");
      });
      options.onRequest?.(request, response);
    },
  );
  target.on("connection", own);
  target.on("secureConnection", () => {
    secureConnections++;
  });
  target.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as net.AddressInfo).port;
  const proxy = http.createServer((_request, response) => {
    response.writeHead(405).end();
  });
  proxy.on("connection", own);
  proxy.on("connect", (request, downstream, head) => {
    own(downstream);
    connectRequests.push({
      url: request.url,
      headers: request.headers,
      sourcePort: downstream.remotePort,
      targetPort: downstream.localPort,
    });
    arrived.resolve();
    if (options.holdConnect) return;
    if (options.status || options.head) {
      downstream.end(`HTTP/1.1 ${options.status ?? 200} Fixture\r\n\r\n${options.head ?? ""}`);
      return;
    }
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort }, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    own(upstream);
    downstream.on("data", (chunk) => {
      tunneledBytes += chunk.byteLength;
    });
    // This is a proxy's normal peer-close propagation, never a test-triggered request cancellation.
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  });
  return {
    proxyPort,
    connectRequests,
    targetRequests,
    arrived,
    targetArrived,
    get secureConnections() {
      return secureConnections;
    },
    get tunneledBytes() {
      return tunneledBytes;
    },
    transport(overrides: Partial<ProxyTransportOptions> = {}) {
      const transport = new ProxyTransport({
        proxy: { host: "127.0.0.1", port: proxyPort },
        authorizeTunnel: async () => liveLease().value,
        ...overrides,
      });
      cleanup.push(() => transport.dispose());
      return transport;
    },
  };
}
const request = { platformId: "x" as const, url: "https://api.x.com/2/users/me?private=synthetic" };

describe("YouTube resumable protocol over loopback CONNECT and verified TLS", () => {
  const url =
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic&part=snippet%2Cstatus";
  const upload = (): ProxyTransportRequest => ({
    platformId: "youtube",
    url,
    method: "PUT",
    body: Buffer.alloc(0),
    headers: { Authorization: "Bearer synthetic-token", "Content-Range": "bytes */100" },
    uploadTarget: issueYouTubeUploadTarget(url, performance.now() + 60_000, () => undefined),
  });
  it("allows only an owned protocol 308 and never follows a redirect", async () => {
    const f = await fixture({
      youtubeIdentity: true,
      respond: (_request, response) => response.writeHead(308, { Range: "bytes=0-3" }).end(),
    });
    const result = await f.transport().request(upload());
    expect(result.status).toBe(308);
    expect(result.headers.range).toBe("bytes=0-3");
    expect(f.targetRequests[0].headers["content-length"]).toBe("0");
    expect(f.connectRequests).toHaveLength(1);
    expect(f.secureConnections).toBe(1);
  });
  it.each([301, 302, 303, 307, 308])(
    "refuses %s with a Location header, even for an owned upload target",
    async (status) => {
      const f = await fixture({
        youtubeIdentity: true,
        respond: (_request, response) => response.writeHead(status, { Location: url }).end(),
      });
      await expect(f.transport().request(upload())).rejects.toMatchObject({ code: "REDIRECT_REJECTED" });
      expect(f.connectRequests).toHaveLength(1);
    },
  );
  it("does not widen 308 handling for ordinary Google API requests", async () => {
    const f = await fixture({
      youtubeIdentity: true,
      respond: (_request, response) => response.writeHead(308).end(),
    });
    await expect(
      f.transport().request({ platformId: "youtube", url: "https://www.googleapis.com/youtube/v3/channels" }),
    ).rejects.toMatchObject({ code: "REDIRECT_REJECTED" });
  });
  it.each(["missing", "copied", "platform", "authorization-header-cookie"])(
    "refuses %s upload intent before CONNECT",
    async (mode) => {
      const f = await fixture({ youtubeIdentity: true }),
        input = upload();
      if (mode === "missing") delete input.uploadTarget;
      if (mode === "copied") input.uploadTarget = { kind: "youtube-upload" };
      if (mode === "platform") input.platformId = "tiktok";
      if (mode === "authorization-header-cookie") input.headers = { Cookie: "synthetic" };
      await expect(f.transport().request(input)).rejects.toMatchObject({
        code: mode === "authorization-header-cookie" ? "INVALID_REQUEST" : "TARGET_NOT_ALLOWED",
      });
      expect(f.connectRequests).toHaveLength(0);
    },
  );
  it("uses the real adapter for a partial first acknowledgement, exact byte resumption and final receipt", async () => {
    const size = 8 * 1024 ** 2 + 7,
      original = Buffer.alloc(size, 7);
    original[3] = 20;
    original[size - 1] = 42;
    let received = Buffer.alloc(0),
      transfer = 0;
    const f = await fixture({
      youtubeIdentity: true,
      respond: (incoming, response) => {
        if (incoming.method === "POST") {
          response.writeHead(200, { Location: url }).end();
          return;
        }
        const request = f.targetRequests.at(-1)!;
        const range = /^bytes ([0-9]+)-([0-9]+)\/[0-9]+$/.exec(String(incoming.headers["content-range"]));
        expect(range).not.toBeNull();
        expect(Number(range![1])).toBe(received.byteLength);
        transfer++;
        const count = transfer === 1 ? 3 : request.body.length;
        received = Buffer.concat([received, request.body.subarray(0, count)]);
        if (received.length === size)
          response
            .writeHead(201)
            .end(
              JSON.stringify({
                id: "abcdefghijk",
                snippet: { channelId: "synthetic-channel" },
                status: { privacyStatus: "private", uploadStatus: "uploaded" },
              }),
            );
        else response.writeHead(308, { Range: `bytes=0-${received.length - 1}` }).end();
      },
    });
    const adapter = new YouTubeUploadAdapter(f.transport());
    const ctx: YouTubeUploadContext = {
      signal: new AbortController().signal,
      assertCurrent: () => undefined,
      token: {
        version: 1,
        platformId: "youtube",
        accountId: "11111111-1111-4111-8111-111111111111",
        remoteId: "synthetic-channel",
        tokenType: "Bearer",
        accessToken: "synthetic-account-token",
        scopes: [YOUTUBE_UPLOAD_SCOPE],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const session = await adapter.initialize(ctx, size, "video/mp4", {
      title: "synthetic",
      description: "",
      categoryId: "22",
      privacy: "private",
      madeForKids: false,
      containsSyntheticMedia: false,
      notifySubscribers: false,
    });
    let offset = 0;
    for (let index = 0; index < 3; index++) {
      const result = await adapter.upload(
        ctx,
        session,
        size,
        offset,
        "video/mp4",
        original.subarray(offset, Math.min(size, offset + 8 * 1024 ** 2)),
      );
      if (result.kind === "progress") offset = result.receivedBytes;
      else {
        expect(index).toBe(2);
        expect(result.receipt).toMatchObject({ state: "processing", privacy: "private" });
      }
    }
    expect(received.equals(original)).toBe(true);
    expect(f.connectRequests).toHaveLength(4);
    expect(f.secureConnections).toBe(4);
    expect(f.targetRequests.map((value) => value.headers["content-range"])).toEqual([
      undefined,
      `bytes 0-${8 * 1024 ** 2 - 1}/${size}`,
      `bytes 3-${8 * 1024 ** 2 + 2}/${size}`,
      `bytes ${8 * 1024 ** 2 + 3}-${size - 1}/${size}`,
    ]);
    expect(f.targetRequests.every((value) => !value.headers.cookie)).toBe(true);
  });
});

describe("owned signed TikTok upload target over real CONNECT and TLS", () => {
  const url =
    "https://open-upload.tiktokapis.com/video/?upload_id=synthetic&upload_token=synthetic-upload-secret";
  const target = () => issueTikTokUploadTarget(url, performance.now() + 60_000, () => undefined);
  const upload = (): ProxyTransportRequest => ({
    platformId: "tiktok",
    url,
    method: "PUT",
    uploadTarget: target(),
    headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/4" },
    body: Buffer.from([1, 2, 3, 4]),
    timeoutMs: 120_000,
  });
  it("sends exactly one signed PUT after tunnel approval, with no account authorization header", async () => {
    const authorize = vi.fn(async () => liveLease().value);
    const f = await fixture({
      uploadIdentity: true,
      respond: (_request, response) => response.writeHead(201).end(),
    });
    const transport = f.transport({ authorizeTunnel: authorize });
    expect((await transport.request(upload())).status).toBe(201);
    await transport.whenIdle();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(f.connectRequests.map((value) => value.url)).toEqual(["open-upload.tiktokapis.com:443"]);
    expect(f.secureConnections).toBe(1);
    expect(f.targetRequests).toHaveLength(1);
    expect(f.targetRequests[0]).toMatchObject({
      url: new URL(url).pathname + new URL(url).search,
      headers: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-3/4",
        "content-length": "4",
      },
      body: Buffer.from([1, 2, 3, 4]),
    });
    expect(f.targetRequests[0].headers).not.toHaveProperty("authorization");
    expect(f.targetRequests[0].headers).not.toHaveProperty("cookie");
    expect(JSON.stringify(f.connectRequests)).not.toContain("synthetic-upload-secret");
  });
  it.each(["missing", "copied", "different-url", "wrong-platform", "wrong-method"])(
    "refuses %s target before CONNECT",
    async (mode) => {
      const f = await fixture({ uploadIdentity: true }),
        input = upload();
      if (mode === "missing") delete input.uploadTarget;
      if (mode === "copied") input.uploadTarget = { ...input.uploadTarget } as TikTokUploadTarget;
      if (mode === "different-url") input.url = url.replace("synthetic&", "other&");
      if (mode === "wrong-platform") input.platformId = "youtube";
      if (mode === "wrong-method") input.method = "POST";
      await expect(f.transport().request(input)).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
      expect(f.connectRequests).toHaveLength(0);
    },
  );
  it.each(["Authorization", "Cookie", "Host", "X-Secret", "Content-Length"])(
    "rejects %s on signed PUT before CONNECT",
    async (name) => {
      const f = await fixture({ uploadIdentity: true });
      await expect(
        f.transport().request({ ...upload(), headers: { [name]: "synthetic" } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(f.connectRequests).toHaveLength(0);
    },
  );
  it.each([0, -1, 120_001, 1.5, NaN, Infinity])(
    "rejects invalid request timeout %s before CONNECT",
    async (timeoutMs) => {
      const f = await fixture({ uploadIdentity: true });
      await expect(f.transport().request({ ...upload(), timeoutMs })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(f.connectRequests).toHaveLength(0);
    },
  );
  it("still refuses the upload server's invalid TLS identity", async () => {
    const f = await fixture();
    await expect(f.transport().request(upload())).rejects.toMatchObject({ code: "TLS_FAILED" });
    expect(f.targetRequests).toHaveLength(0);
  });
  it("rechecks the owned target after the tunnel callback and before any TLS bytes", async () => {
    let current = true;
    const f = await fixture({ uploadIdentity: true });
    const uploadTarget = issueTikTokUploadTarget(url, performance.now() + 60_000, () => {
      if (!current) throw new Error("cancelled synthetic upload");
    });
    const transport = f.transport({
      authorizeTunnel: async () => {
        current = false;
        return liveLease().value;
      },
    });
    await expect(transport.request({ ...upload(), uploadTarget })).rejects.toMatchObject({
      code: "LEASE_REVOKED",
    });
    expect(f.connectRequests).toHaveLength(1);
    expect(f.tunneledBytes).toBe(0);
    expect(f.targetRequests).toHaveLength(0);
  });
});

describe("explicit authorized Node CONNECT transport", () => {
  it("continues a slow 6 MiB request beyond the original five-second lease on the same CONNECT and TLS socket", async () => {
    const leases: ReturnType<typeof liveLease>[] = [];
    const issue = () => {
      const lease = liveLease();
      lease.value.release = vi.fn(() => lease.abort.abort());
      leases.push(lease);
      return lease.value;
    };
    let resume: ReturnType<typeof setTimeout> | undefined;
    const f = await fixture({
      onRequest: (incoming) => {
        incoming.pause();
        resume = setTimeout(
          () => incoming.resume(),
          Math.max(1, leases[0].value.expiresAtMono + 200 - performance.now()),
        );
      },
    });
    cleanup.push(async () => {
      clearTimeout(resume);
    });
    const authorizeTunnel = vi.fn(async (_context: ProxyTunnelContext) => issue());
    const renewTunnel = vi.fn(async (_context: ProxyTunnelContext, previous: ProxyTransportLease) => {
      expect(previous).toBe(leases.at(-1)!.value);
      expect(previous.signal.aborted).toBe(false);
      expect(performance.now()).toBeLessThan(previous.expiresAtMono);
      return issue();
    });
    const transport = f.transport({ authorizeTunnel, renewTunnel, timeoutMs: 12_000 });
    const payload = Buffer.alloc(6 * 1024 * 1024, 7);
    const result = await transport.request({ ...request, method: "PUT", body: payload });
    await transport.whenIdle();
    expect(result.body.toString()).toBe("ok");
    expect(performance.now()).toBeGreaterThan(leases[0].value.expiresAtMono);
    expect(renewTunnel.mock.calls.length).toBeGreaterThanOrEqual(2);
    const context = authorizeTunnel.mock.calls[0][0];
    for (const [renewedContext] of renewTunnel.mock.calls) expect(renewedContext).toBe(context);
    expect(f.connectRequests).toHaveLength(1);
    expect(f.secureConnections).toBe(1);
    expect(f.targetRequests).toHaveLength(1);
    expect(f.targetRequests[0].body.equals(payload)).toBe(true);
    expect(f.targetRequests[0].headers["content-length"]).toBe(String(payload.byteLength));
    for (const lease of leases) {
      expect(lease.value.release).toHaveBeenCalledTimes(1);
      expect(lease.abort.signal.aborted).toBe(true);
    }
  }, 15_000);

  it.each([
    "deny",
    "throw",
    "expired",
    "aborted",
    "not-current",
    "generation",
    "same-lease",
    "same-signal",
    "same-expiry",
    "reentrant-revoke",
  ])("%s renewal aborts the existing connection without retry or response success", async (mode) => {
    const responseReady = deferred<http.ServerResponse>();
    const f = await fixture({
      respond: (_incoming, response) => {
        responseReady.resolve(response);
      },
    });
    let initial!: ReturnType<typeof liveLease>, replacement: ReturnType<typeof liveLease> | undefined;
    const renewTunnel = vi.fn(async () => {
      if (mode === "throw") throw new Error("synthetic upload URL must remain private");
      if (mode === "deny") return null;
      if (mode === "same-lease") return initial.value;
      replacement = liveLease(mode === "expired" ? -1 : 5000);
      if (mode === "aborted") replacement.abort.abort();
      if (mode === "not-current") replacement.value.isCurrent = () => false;
      if (mode === "generation") replacement.value = { ...replacement.value, generation: 2 };
      if (mode === "same-signal") replacement.value = { ...replacement.value, signal: initial.abort.signal };
      if (mode === "same-expiry")
        replacement.value = { ...replacement.value, expiresAtMono: initial.value.expiresAtMono };
      if (mode === "reentrant-revoke")
        replacement.value.isCurrent = () => {
          initial.abort.abort();
          return true;
        };
      return replacement.value;
    });
    const transport = f.transport({
      authorizeTunnel: async () => {
        initial = liveLease(600);
        return initial.value;
      },
      renewTunnel,
    });
    const rejected = expect(transport.request(request)).rejects.toMatchObject({
      code: "LEASE_REVOKED",
      message: "LEASE_REVOKED",
    });
    const response = await responseReady.promise;
    await rejected;
    await transport.whenIdle();
    expect(renewTunnel).toHaveBeenCalledTimes(1);
    expect(initial.value.release).toHaveBeenCalledTimes(1);
    if (replacement) expect(replacement.value.release).toHaveBeenCalledTimes(1);
    expect(f.connectRequests).toHaveLength(1);
    expect(f.secureConnections).toBe(1);
    response.end("late success must not arrive");
  });

  it.each(["caller", "dispose", "expire"])(
    "%s during pending renewal retains the real busy slot and releases a late replacement without resurrection",
    async (mode) => {
      const f = await fixture({ respond: () => undefined });
      const entered = deferred<void>(),
        approval = deferred<ProxyTransportLease | null>();
      const caller = new AbortController();
      let initial!: ReturnType<typeof liveLease>;
      const transport = f.transport({
        concurrency: 1,
        authorizeTunnel: async () => {
          initial = liveLease(800);
          return initial.value;
        },
        renewTunnel: async () => {
          entered.resolve();
          return approval.promise;
        },
      });
      cleanup.push(async () => {
        approval.resolve(null);
      });
      const code =
        mode === "caller" ? "REQUEST_ABORTED" : mode === "dispose" ? "TRANSPORT_DISPOSED" : "LEASE_REVOKED";
      const rejected = expect(transport.request({ ...request, signal: caller.signal })).rejects.toMatchObject(
        { code },
      );
      await entered.promise;
      let disposing: Promise<void> | undefined;
      if (mode === "caller") caller.abort();
      if (mode === "dispose") disposing = transport.dispose();
      await rejected;
      let idle = false;
      const drain = transport.whenIdle().then(() => {
        idle = true;
      });
      await tick();
      expect(idle).toBe(false);
      await expect(transport.request(request)).rejects.toMatchObject({
        code: mode === "dispose" ? "TRANSPORT_DISPOSED" : "TRANSPORT_BUSY",
      });
      const late = liveLease();
      approval.resolve(late.value);
      await drain;
      await disposing;
      expect(late.value.release).toHaveBeenCalledTimes(1);
      expect(initial.value.release).toHaveBeenCalledTimes(1);
      expect(f.connectRequests).toHaveLength(1);
      expect(f.targetRequests).toHaveLength(1);
    },
  );

  it("finishing while renewal is pending releases both grants and waits the real renewal drain", async () => {
    const responseReady = deferred<http.ServerResponse>();
    const f = await fixture({
      respond: (_incoming, response) => {
        responseReady.resolve(response);
      },
    });
    const entered = deferred<void>(),
      approval = deferred<ProxyTransportLease | null>();
    const transport = f.transport({
      authorizeTunnel: async () => liveLease(800).value,
      renewTunnel: async () => {
        entered.resolve();
        return approval.promise;
      },
    });
    cleanup.push(async () => {
      approval.resolve(null);
    });
    const pending = transport.request(request);
    const response = await responseReady.promise;
    await entered.promise;
    response.end("finished");
    expect((await pending).body.toString()).toBe("finished");
    let idle = false;
    const drain = transport.whenIdle().then(() => {
      idle = true;
    });
    await tick();
    expect(idle).toBe(false);
    const late = liveLease();
    approval.resolve(late.value);
    await drain;
    expect(late.value.release).toHaveBeenCalledTimes(1);
    expect(f.connectRequests).toHaveLength(1);
  });

  it("sends no TLS or application token before the actual tunnel has a live lease; credentials stay on their own hop", async () => {
    const f = await fixture(),
      approval = deferred<ProxyTransportLease | null>(),
      called = deferred<ProxyTunnelContext>();
    const lease = liveLease();
    const transport = f.transport({
      proxy: { host: "127.0.0.1", port: f.proxyPort, username: "proxy-user", password: "proxy-only" },
      authorizeTunnel: async (context) => {
        called.resolve(context);
        return approval.promise;
      },
    });
    const pending = transport.request({
      ...request,
      method: "POST",
      headers: { Authorization: "Bearer synthetic-app-token", "Content-Type": "application/json" },
      body: "payload",
    });
    const context = await called.promise;
    await tick();
    expect(f.tunneledBytes).toBe(0);
    expect(f.secureConnections).toBe(0);
    expect(f.targetRequests).toHaveLength(0);
    expect(context.target).toEqual({ host: "api.x.com", port: 443 });
    expect(context.socket.localPort).toBe(f.connectRequests[0].sourcePort);
    expect(context.socket.remotePort).toBe(f.proxyPort);
    expect(Object.isFrozen(context.socket)).toBe(true);
    expect(f.connectRequests[0].headers.authorization).toBeUndefined();
    expect(f.connectRequests[0].headers["proxy-authorization"]).toBe(
      "Basic " + Buffer.from("proxy-user:proxy-only").toString("base64"),
    );
    approval.resolve(lease.value);
    expect((await pending).body.toString()).toBe("ok");
    await transport.whenIdle();
    expect(f.targetRequests[0].headers.authorization).toBe("Bearer synthetic-app-token");
    expect(f.targetRequests[0].headers["proxy-authorization"]).toBeUndefined();
    expect(f.targetRequests[0].headers.cookie).toBeUndefined();
    expect(f.targetRequests[0].body.toString()).toBe("payload");
    expect(f.connectRequests).toHaveLength(1);
    expect(lease.value.release).toHaveBeenCalledTimes(1);
  });

  it("requires an authorizer even before an anonymous CONNECT", async () => {
    const f = await fixture();
    await expect(f.transport({ authorizeTunnel: undefined }).request(request)).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    });
    expect(f.connectRequests).toHaveLength(0);
  });

  it.each(["deny", "throw", "expired", "revoked", "not-current"])(
    "%s authorization never sends TLS/application bytes",
    async (mode) => {
      const f = await fixture(),
        lease = liveLease(mode === "expired" ? -1 : 5000);
      if (mode === "revoked") lease.abort.abort();
      if (mode === "not-current") lease.value.isCurrent = () => false;
      const transport = f.transport({
        authorizeTunnel: async () => {
          if (mode === "throw") throw new Error("secret query must not be exposed");
          return mode === "deny" ? null : lease.value;
        },
      });
      const error = await transport.request(request).catch((value) => value);
      expect(["AUTHORIZATION_DENIED", "LEASE_REVOKED"]).toContain(error.code);
      expect(error.message).toBe(error.code);
      expect(error.cause).toBeUndefined();
      expect(f.tunneledBytes).toBe(0);
      expect(f.targetRequests).toHaveLength(0);
    },
  );

  it("retains its busy slot and actual drain until an uncancellable authorizer settles; a late lease is released", async () => {
    const f = await fixture(),
      approval = deferred<ProxyTransportLease | null>(),
      called = deferred<void>();
    const lease = liveLease();
    const transport = f.transport({
      concurrency: 1,
      timeoutMs: 50,
      authorizeTunnel: async () => {
        called.resolve();
        return approval.promise;
      },
    });
    const rejected = expect(transport.request(request)).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await called.promise;
    await rejected;
    let idle = false;
    const drain = transport.whenIdle().then(() => {
      idle = true;
    });
    await tick();
    expect(idle).toBe(false);
    await expect(transport.request(request)).rejects.toMatchObject({ code: "TRANSPORT_BUSY" });
    approval.resolve(lease.value);
    await drain;
    expect(lease.value.release).toHaveBeenCalledTimes(1);
    expect(f.targetRequests).toHaveLength(0);
  });

  it.each([407, 502])("proxy CONNECT %s never reaches the target or tries another path", async (status) => {
    const f = await fixture({ status }),
      authorizeTunnel = vi.fn(async () => liveLease().value);
    await expect(f.transport({ authorizeTunnel }).request(request)).rejects.toMatchObject({
      code: "PROXY_CONNECT_FAILED",
    });
    expect(authorizeTunnel).not.toHaveBeenCalled();
    expect(f.connectRequests).toHaveLength(1);
    expect(f.targetRequests).toHaveLength(0);
  });

  it("rejects unsolicited bytes in CONNECT's head before authorizing or TLS", async () => {
    const f = await fixture({ head: "unexpected bytes" }),
      authorizeTunnel = vi.fn(async () => liveLease().value);
    await expect(f.transport({ authorizeTunnel }).request(request)).rejects.toMatchObject({
      code: "PROXY_CONNECT_FAILED",
    });
    expect(authorizeTunnel).not.toHaveBeenCalled();
  });

  it("checks certificate hostname using Node's default verification, with no retry", async () => {
    const f = await fixture();
    await expect(
      f.transport().request({ ...request, url: "https://api.twitter.com/2/users/me" }),
    ).rejects.toMatchObject({ code: "TLS_FAILED" });
    expect(f.targetRequests).toHaveLength(0);
    expect(f.connectRequests).toHaveLength(1);
  });

  it("rejects an untrusted certificate without sending HTTP credentials", async () => {
    const f = await fixture();
    tls.setDefaultCACertificates(originalCas);
    try {
      await expect(
        f.transport().request({ ...request, headers: { Authorization: "Bearer synthetic" } }),
      ).rejects.toMatchObject({ code: "TLS_FAILED" });
    } finally {
      tls.setDefaultCACertificates([cert]);
    }
    expect(f.targetRequests).toHaveLength(0);
  });

  it.each([
    "http://api.x.com/",
    "https://api.x.com.evil.test/",
    "https://api.x.com:444/",
    "https://user:pass@api.x.com/",
    "https://api.x.com/#fragment",
    "https://creator.douyin.com/",
    "https://127.0.0.1/",
  ])("refuses non-approved destination %s before proxy I/O", async (url) => {
    const f = await fixture();
    await expect(f.transport().request({ ...request, url })).rejects.toMatchObject({
      code: "TARGET_NOT_ALLOWED",
    });
    expect(f.connectRequests).toHaveLength(0);
  });

  it.each([
    "Cookie",
    "Host",
    "Proxy-Authorization",
    "Connection",
    "Transfer-Encoding",
    "Content-Length",
    "Upgrade",
    "Expect",
    "TE",
  ])("rejects caller header %s before dialing", async (name) => {
    const f = await fixture();
    await expect(
      f.transport().request({ ...request, headers: { [name]: "synthetic" } }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.connectRequests).toHaveLength(0);
  });

  it("copies mutable headers, body, platform and signal before entering the authorizer", async () => {
    const f = await fixture(),
      approval = deferred<ProxyTransportLease | null>(),
      called = deferred<void>();
    const transport = f.transport({
      authorizeTunnel: async () => {
        called.resolve();
        return approval.promise;
      },
    });
    const controller = new AbortController();
    const input: ProxyTransportRequest & { headers: Record<string, string>; body: Buffer } = {
      ...request,
      headers: { Authorization: "Bearer original" },
      body: Buffer.from("original"),
      method: "POST",
    };
    const pending = transport.request(input);
    input.headers.Authorization = "Bearer changed";
    input.body.fill(0);
    input.platformId = "tiktok";
    input.signal = controller.signal;
    controller.abort();
    await called.promise;
    approval.resolve(liveLease().value);
    await pending;
    expect(f.targetRequests[0].headers.authorization).toBe("Bearer original");
    expect(f.targetRequests[0].body.toString()).toBe("original");
  });

  it("rejects malformed lease signals using only a sanitized error", async () => {
    const f = await fixture(),
      lease = liveLease();
    const invalid = { ...lease.value, signal: {} } as ProxyTransportLease;
    await expect(
      f.transport({ authorizeTunnel: async () => invalid }).request(request),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED", message: "AUTHORIZATION_DENIED" });
    expect(f.tunneledBytes).toBe(0);
    expect(lease.value.release).toHaveBeenCalledTimes(1);
  });

  it("a synchronously reentrant lease check cannot dispose the transport and still send credentials", async () => {
    const f = await fixture(),
      lease = liveLease();
    const transport = f.transport({ authorizeTunnel: async () => lease.value });
    lease.value.isCurrent = () => {
      void transport.dispose();
      return true;
    };
    await expect(transport.request(request)).rejects.toMatchObject({ code: "TRANSPORT_DISPOSED" });
    await transport.whenIdle();
    expect(f.tunneledBytes).toBe(0);
    expect(f.targetRequests).toHaveLength(0);
  });

  it.each([302, 307, 308])("does not follow %s, or reflect a signed Location in errors", async (status) => {
    const f = await fixture({
      respond: (_request, response) =>
        response.writeHead(status, { Location: "https://creator.douyin.com/?token=synthetic" }).end(),
    });
    const error = await f
      .transport()
      .request(request)
      .catch((value) => value);
    expect(error).toMatchObject({ code: "REDIRECT_REJECTED", message: "REDIRECT_REJECTED" });
    expect(JSON.stringify(error)).not.toContain("synthetic");
    expect(f.connectRequests).toHaveLength(1);
    expect(f.targetRequests).toHaveLength(1);
  });

  it("bounds both request and response bytes", async () => {
    const f = await fixture({ respond: (_request, response) => response.end(Buffer.alloc(128)) });
    const transport = f.transport({ maxRequestBytes: 8, maxResponseBytes: 32 });
    await expect(transport.request({ ...request, body: Buffer.alloc(9) })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(f.connectRequests).toHaveLength(0);
    await expect(transport.request(request)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await transport.whenIdle();
  });

  it.each(["abort", "expire", "caller"])(
    "%s during a response tears down the actual tunnel, without returning a partial body",
    async (mode) => {
      const responseStarted = deferred<void>(),
        responseClosed = deferred<void>();
      const f = await fixture({
        respond: (_request, response) => {
          response.writeHead(200, { "Content-Length": "1000000" });
          response.write("partial");
          response.once("close", () => responseClosed.resolve());
          responseStarted.resolve();
        },
      });
      const lease = liveLease(mode === "expire" ? 100 : 5000),
        caller = new AbortController();
      const transport = f.transport({ authorizeTunnel: async () => lease.value });
      const expected = expect(transport.request({ ...request, signal: caller.signal })).rejects.toMatchObject(
        { code: mode === "caller" ? "REQUEST_ABORTED" : "LEASE_REVOKED" },
      );
      await responseStarted.promise;
      if (mode === "abort") lease.abort.abort();
      if (mode === "caller") caller.abort();
      await expected;
      await responseClosed.promise;
      await transport.whenIdle();
      expect(lease.value.release).toHaveBeenCalledTimes(1);
    },
  );

  it("times out a stalled CONNECT and never calls its authorizer", async () => {
    const f = await fixture({ holdConnect: true }),
      authorizeTunnel = vi.fn(async () => liveLease().value);
    await expect(f.transport({ timeoutMs: 40, authorizeTunnel }).request(request)).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    expect(authorizeTunnel).not.toHaveBeenCalled();
  });

  it("dispose is idempotent, cancels an outstanding authorization and waits its real completion", async () => {
    const f = await fixture(),
      called = deferred<void>(),
      approval = deferred<ProxyTransportLease | null>();
    const lease = liveLease();
    const transport = f.transport({
      authorizeTunnel: async () => {
        called.resolve();
        return approval.promise;
      },
    });
    const expected = expect(transport.request(request)).rejects.toMatchObject({ code: "TRANSPORT_DISPOSED" });
    await called.promise;
    const disposal = transport.dispose();
    expect(transport.dispose()).toBe(disposal);
    await expected;
    let closed = false;
    void disposal.then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    approval.resolve(lease.value);
    await disposal;
    expect(lease.value.release).toHaveBeenCalledTimes(1);
    await expect(transport.request(request)).rejects.toMatchObject({ code: "TRANSPORT_DISPOSED" });
    expect(f.targetRequests).toHaveLength(0);
  });
});
