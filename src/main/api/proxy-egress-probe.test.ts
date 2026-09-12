import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProxyEgressProbe, type ProxyEgressProbeOptions } from "./proxy-egress-probe";
import type { AnonymousProxyTunnelContext, ProxyTunnelReadResult } from "./proxy-tunnel-evidence";
// Static synthetic test credentials; never used outside the local test receiver.
const key =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGYJZighZhnEV1\nWxStavvtXcB/h+gVNchCB1ykuq4TdmIL+oEq+PPyM01SErQMjrnQgxhyBhDMWqEW\nvaNcsg1AzPj2lhxKp3nNVHJ+/Z6Wuldsu7LROu3wvFsazPfZ4jZpmALD6DbVYnEt\nZaOILHS8b9wu3/qaGSYAMAJq77zOpgVe6eusR8/nauHydUTipZqDpPA+u+33wnjX\nLHbU0Axc/jeznvxi1XOI/36pzk/Hc3qJG3x8sTt/7LHr25B6Z7joowORSSnRwpsg\n0PcumUfSQxnEfdr5Ptq73zpDpwqw7oi3R0+s/OSfkZi6ml7QY569lkjiFJnUyOKE\n3a49g1ePAgMBAAECggEAAQMEb4/2z7Qev1AAr40nSTIDedAUDD+la1ljE/woNSJQ\nzxyI+O8sfnUxC7qZNeYmFnghJYeWBRaVPxWFMXLD7D40uRZuGM59fwc7kWA+cRWy\ncZCHg28V/eOiHwac+LW0Upnr6pP0JIgHcu6Hl8WUWTaVI4pJuVSX4FISg3RyYqJj\nwSIdPMq7WwnRvxXD1wn13OC/aZnQ107H057SqfAqMDISdYQQrVkgmwuswX8jqtLV\nD3HY6g6zL/u76ZrCBVYPdGKb23ues9v7Zeq4ztuciz5yHds2s2iuD7NS1P6PAJqQ\nrcp3sUfHIf6FCJnjuBoC1l/RSbyYJUmofZr4wPxFKQKBgQD5l5rl7g8mRuisMGum\nqhFrWcr1uDaLaw8M1Pj3ocAd+eLZobodmwbXY4yI29oYzS0Bnp8Yb6yQ+puLb6i1\n4dH70rOl29UecvmuCV87OxQXt7/hW99kOBwyP7Q4GBLOBkhADgH+GL5TaEgzE/6c\nvpupKL0VrYTGxIgwBNB2fTt9KwKBgQDLeGHxKi0XAr8pk8dUBlq0ol0ITK3HlBxF\nmz84nDQAJtQ8UXxHs1XAPJuIhaxowmjTs2nu+UJYE9RWDOOTPblpohHJUIgSAnDh\nbPW7TwTApvV00rV3nF2VC//EvfVrko7V/WeVOcQ4xrbd/7UDdYXUNkIK9Jou1ORP\nVKNzaJWFLQKBgFbX5EKKkWTdGUoIUvybghIbHR5gKUJbTtJFLBdlhWYos0DMH+j7\nLuc0sQpRjNJCWZ2NpoenG6EaQZLDmC0o1JpNVsqn8cB1euCOTD9csAIMokv0XocN\nauok9jzqS2i6ENuQxCq4S0jUKQL0uwuo2pqCHUB0rpVGfqhOlIYVzuQfAoGABi2j\nm7USJW6560NHfC+tNWrwtD3P0Q2YRizOoKNtmMuVCjfXND4nzmyItH6Km6u7jyIV\nh2IeN5pyiiJeDqyDIsf/DkPZveJBFzc9xvBBTrBDJ8b2J6mh1dLFc23pM9kBaVIG\ngSt939N43gjTsEUzSRxUqQyAWgew3w/M3sZANAkCgYEAvsKBakYchxlzB+6HdaB+\n4MVSj4mhaO+QjQtIgUCt9o28YAnnGxbnq/55i62ffAhFz5aZEsumfsWkPNZmXsHZ\nXPe0/TWvNvfaNQxnzhA4ZoU0QRmfJo0bdOR7TX1xLELN6B8ArcOm6TQ98OiZbZxr\nnX78xh2EtIzl+SOunNqpkwM=\n-----END PRIVATE KEY-----";
const cert =
  "-----BEGIN CERTIFICATE-----\nMIIDPDCCAiSgAwIBAgIUG4YPjPAOWjF2jGzyM8jcOGFLfjUwDQYJKoZIhvcNAQEL\nBQAwHTEbMBkGA1UEAwwSd3d3LmNsb3VkZmxhcmUuY29tMCAXDTI2MDkwODA2NTAw\nNloYDzIxMjYwODE1MDY1MDA2WjAdMRswGQYDVQQDDBJ3d3cuY2xvdWRmbGFyZS5j\nb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDGYJZighZhnEV1WxSt\navvtXcB/h+gVNchCB1ykuq4TdmIL+oEq+PPyM01SErQMjrnQgxhyBhDMWqEWvaNc\nsg1AzPj2lhxKp3nNVHJ+/Z6Wuldsu7LROu3wvFsazPfZ4jZpmALD6DbVYnEtZaOI\nLHS8b9wu3/qaGSYAMAJq77zOpgVe6eusR8/nauHydUTipZqDpPA+u+33wnjXLHbU\n0Axc/jeznvxi1XOI/36pzk/Hc3qJG3x8sTt/7LHr25B6Z7joowORSSnRwpsg0Pcu\nmUfSQxnEfdr5Ptq73zpDpwqw7oi3R0+s/OSfkZi6ml7QY569lkjiFJnUyOKE3a49\ng1ePAgMBAAGjcjBwMB0GA1UdDgQWBBQe4VouA+frY2kMWU43oo7L3C0IYDAfBgNV\nHSMEGDAWgBQe4VouA+frY2kMWU43oo7L3C0IYDAPBgNVHRMBAf8EBTADAQH/MB0G\nA1UdEQQWMBSCEnd3dy5jbG91ZGZsYXJlLmNvbTANBgkqhkiG9w0BAQsFAAOCAQEA\nu3jFNpCilq2E84QRTmKfS1IdcHTiYTFuhDIXF2Njpl2UBvmjR98aUbytMdniNg+y\nPf9MjP13DQmtM/sTITmuMBt2hTdSyhZE5j7PTGlm7+mJEzjfrExgglazwOXWydxP\niK5hC42bbo04agAhJddTgqnENCk7Lv/7Nw/ezF4DmDQq7SItpIIvbMU1u+KcDGSR\na9JfdaLk60PHWxZr5Yq5163w+LYg1nhS96D5/nUOhWTZm4tTu4Ar12EuGFbQHv6r\nUUKbXG/eow2G7PFbwR5CbRQXwJNRw7By1dDxQp+GMsCzM/Eo2+o9eGUKTs+LtDav\npvmFOjWLuACt2f7jjXll/g==\n-----END CERTIFICATE-----\n";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const originalCas = tls.getCACertificates();
beforeAll(() => tls.setDefaultCACertificates([cert]));
afterAll(() => tls.setDefaultCACertificates(originalCas));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close().catch(() => undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
function evidence(context: AnonymousProxyTunnelContext, controllerPort = 9790): ProxyTunnelReadResult {
  const stamp = () => ({ startedAtMono: performance.now(), completedAtMono: performance.now() });
  const startedAtMono = performance.now();
  const config = () => ({
    ...stamp(),
    fingerprint: hash("config"),
    mixedPort: context.proxy.port,
    mode: "rule",
  });
  const before = config();
  const owner = (port: number) => ({
    available: true as const,
    basis: "windows-controller-listener" as const,
    ...stamp(),
    scopeHash: hash(JSON.stringify({ address: "127.0.0.1", port })),
    kernelEpoch: hash(`kernel-${port}`),
    owner: { pid: 1234, createdAtTicks: "134332323232323232", executablePathIdentity: hash("kernel-path") },
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4" as const, port, coverage: "exact" as const }],
  });
  const controllerOwner = owner(controllerPort),
    proxyOwner = owner(context.proxy.port);
  const connections = {
    ...stamp(),
    value: {
      connections: [
        {
          id: "owned-connect-id",
          chains: ["node", "group"],
          metadata: {
            host: "www.cloudflare.com",
            sourceIP: context.socket.localAddress,
            sourcePort: String(context.socket.localPort),
            inboundIP: context.socket.remoteAddress,
            inboundPort: String(context.socket.remotePort),
            destinationPort: "443",
            network: "tcp",
            type: "HTTPS",
            processPath: process.execPath,
          },
        },
      ],
    },
  };
  const proxies = {
    ...stamp(),
    value: {
      proxies: {
        node: { type: "Shadowsocks", id: "node-id" },
        group: { type: "Selector", now: "node" },
      },
    },
  };
  const after = config();
  return {
    contextId: context.id,
    generation: 1,
    revision: "revision-1",
    startedAtMono,
    completedAtMono: performance.now(),
    controllerBefore: before,
    controllerAfter: after,
    controllerOwner,
    proxyOwner,
    connections,
    proxies,
  };
}
async function fixture(
  options: {
    connectStatus?: number;
    head?: string;
    holdConnect?: boolean;
    respond?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  } = {},
) {
  const sockets = new Set<Socket>();
  const connectRequests: {
    target: string | undefined;
    headers: http.IncomingHttpHeaders;
    sourcePort: number | undefined;
  }[] = [];
  const traceRequests: {
    target: string | undefined;
    method: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }[] = [];
  const arrived = deferred<void>(),
    targetArrived = deferred<void>(),
    targetClosed = deferred<void>();
  let secureConnections = 0;
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  };
  const target = https.createServer({ key, cert }, (request, response) => {
    targetArrived.resolve();
    response.once("close", () => targetClosed.resolve());
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      traceRequests.push({
        target: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      if (options.respond) options.respond(request, response);
      else {
        response.setHeader("content-type", "text/plain; charset=UTF-8");
        response.setHeader("set-cookie", "synthetic-secret=never-reuse");
        response.end(
          "fl=test\nh=www.cloudflare.com\nip=198.51.100.10\nloc=JP\ncolo=NRT\nvisit_scheme=https\ntls=TLSv1.3\n",
        );
      }
    });
  });
  target.on("connection", own);
  target.on("secureConnection", () => secureConnections++);
  target.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as net.AddressInfo).port;
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connection", own);
  proxy.on("connect", (request, downstream, head) => {
    own(downstream);
    downstream.once("end", () => downstream.destroy());
    connectRequests.push({
      target: request.url,
      headers: request.headers,
      sourcePort: downstream.remotePort,
    });
    arrived.resolve();
    if (options.holdConnect) return;
    if (options.connectStatus || options.head) {
      downstream.end(`HTTP/1.1 ${options.connectStatus ?? 200} Fixture\r\n\r\n${options.head ?? ""}`);
      return;
    }
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort }, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    own(upstream);
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  cleanup.push(async () => {
    // Probe cleanup runs first. Let peer-close propagation drain the synthetic proxy/TLS server;
    // do not destroy the HTTPS server's raw socket underneath its TLS wrapper.
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  });
  let version: { generation: number; revision: string } | null = { generation: 1, revision: "revision-1" };
  const reader = {
    readAnonymousTunnel: vi.fn(async (context: AnonymousProxyTunnelContext, _signal: AbortSignal) =>
      evidence(context),
    ),
    whenIdle: vi.fn(async () => undefined),
  };
  const readVersion = vi.fn(() => version);
  const config: ProxyEgressProbeOptions = {
    proxy: { host: "127.0.0.1", port: proxyPort },
    controller: { host: "127.0.0.1", port: 9790 },
    reader,
    readVersion,
    allowedCountries: ["JP", "US"],
    timeoutMs: 2000,
  };
  const make = (changes: Partial<ProxyEgressProbeOptions> = {}) => {
    const probe = new ProxyEgressProbe({ ...config, ...changes });
    cleanup.push(() => probe.dispose());
    return probe;
  };
  return {
    make,
    config,
    reader,
    readVersion,
    setVersion: (value: typeof version) => {
      version = value;
    },
    connectRequests,
    traceRequests,
    arrived,
    targetArrived,
    targetClosed,
    get secureConnections() {
      return secureConnections;
    },
  };
}

describe("ProxyEgressProbe real anonymous CONNECT/TLS factory", () => {
  it("checks the same active socket once after verified TLS and before fixed GET; keeps original evidence expiry and no credentials", async () => {
    const f = await fixture();
    const tlsConnect = vi.spyOn(tls, "connect");
    f.reader.readAnonymousTunnel.mockImplementation(async (context) => {
      const socket = tlsConnect.mock.results[0].value as tls.TLSSocket;
      expect(socket.authorized).toBe(true);
      expect(socket.destroyed).toBe(false);
      expect(f.traceRequests).toHaveLength(0);
      return evidence(context);
    });
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    const probe = f.make(),
      result = await probe.probe();
    expect(result).toMatchObject({
      ip: "198.51.100.10",
      countryCode: "JP",
      generation: 1,
      revision: "revision-1",
    });
    expect(result!.chainFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(f.reader.readAnonymousTunnel).toHaveBeenCalledTimes(1);
    const [first] = f.reader.readAnonymousTunnel.mock.calls;
    expect(first[0]).toMatchObject({
      platformId: "anonymous-egress",
      target: { host: "www.cloudflare.com", port: 443 },
      socket: { localPort: f.connectRequests[0].sourcePort },
    });
    expect(Object.isFrozen(first[0].socket)).toBe(true);
    expect(f.connectRequests).toHaveLength(1);
    expect(f.secureConnections).toBe(1);
    expect(f.traceRequests).toHaveLength(1);
    expect(f.connectRequests[0].target).toBe("www.cloudflare.com:443");
    expect(f.traceRequests[0]).toMatchObject({
      target: "/cdn-cgi/trace",
      method: "GET",
      body: Buffer.alloc(0),
    });
    for (const headers of [f.connectRequests[0].headers, f.traceRequests[0].headers]) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers["proxy-authorization"]).toBeUndefined();
    }
    expect(f.traceRequests[0].headers["accept-encoding"]).toBe("identity");
    const facts = await f.reader.readAnonymousTunnel.mock.results[0].value;
    expect(result!.expiresAtMono).toBeLessThanOrEqual(facts.startedAtMono + 15_000);
    expect(result!.observedAtMono).toBeGreaterThanOrEqual(facts.completedAtMono);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|node-id|www.cloudflare.com|\bcolo\b/);
    await probe.whenIdle();
    f.reader.readAnonymousTunnel.mockImplementation(async (context) => evidence(context));
    expect(await probe.probe()).not.toBeNull();
    expect(f.connectRequests).toHaveLength(2);
    expect(f.traceRequests[1].headers.cookie).toBeUndefined();
  });
  it.each(["DIRECT", "missing", "wrong-host", "wrong-owner", "duplicate"])(
    "refuses %s evidence after anonymous TLS and sends no HTTP",
    async (mode) => {
      const f = await fixture();
      const tlsConnect = vi.spyOn(tls, "connect");
      f.reader.readAnonymousTunnel.mockImplementation(async (context) => {
        const value = evidence(context);
        const rows = (
          value.connections.value as { connections: { chains: string[]; metadata: { host: string } }[] }
        ).connections;
        if (mode === "DIRECT") rows[0].chains = ["DIRECT"];
        if (mode === "missing") rows.length = 0;
        if (mode === "wrong-host") rows[0].metadata.host = "api.x.com";
        if (mode === "wrong-owner" && value.proxyOwner.available) value.proxyOwner.owner.pid++;
        if (mode === "duplicate") rows.push(rows[0]);
        return value;
      });
      expect(await f.make().probe()).toBeNull();
      expect(f.reader.readAnonymousTunnel).toHaveBeenCalledTimes(1);
      expect(tlsConnect.mock.results[0].value.authorized).toBe(true);
      expect(f.traceRequests).toHaveLength(0);
    },
  );
  it("closes the real TLS wrapper when the controller changes during the sole evidence read, without sending GET", async () => {
    const f = await fixture();
    const tlsConnect = vi.spyOn(tls, "connect");
    f.reader.readAnonymousTunnel.mockImplementation(async (context) => {
      const value = evidence(context);
      value.controllerAfter.fingerprint = hash("changed-controller");
      return value;
    });
    const probe = f.make();
    expect(await probe.probe()).toBeNull();
    await probe.whenIdle();
    expect(tlsConnect.mock.results[0].value.authorized).toBe(true);
    expect(tlsConnect.mock.results[0].value.destroyed).toBe(true);
    expect(f.reader.readAnonymousTunnel).toHaveBeenCalledTimes(1);
    expect(f.traceRequests).toHaveLength(0);
  });
  it("does not bypass normal certificate validation", async () => {
    const f = await fixture();
    tls.setDefaultCACertificates(originalCas);
    try {
      expect(await f.make().probe()).toBeNull();
      expect(f.traceRequests).toHaveLength(0);
      expect(f.reader.readAnonymousTunnel).not.toHaveBeenCalled();
    } finally {
      tls.setDefaultCACertificates([cert]);
    }
  });
  it.each([{ connectStatus: 302 }, { connectStatus: 407 }, { head: "unexpected-early-bytes" }])(
    "rejects anomalous CONNECT %j without following",
    async (config) => {
      const f = await fixture(config);
      expect(await f.make().probe()).toBeNull();
      expect(f.connectRequests).toHaveLength(1);
      expect(f.reader.readAnonymousTunnel).not.toHaveBeenCalled();
      expect(f.traceRequests).toHaveLength(0);
    },
  );
  it.each([302, 401, 503])(
    "rejects trace HTTP %s and never retries or follows its location",
    async (status) => {
      const f = await fixture({
        respond: (_req, res) =>
          res.writeHead(status, { location: "https://private.example/secret" }).end("SECRET"),
      });
      expect(await f.make().probe()).toBeNull();
      expect(f.connectRequests).toHaveLength(1);
      expect(f.traceRequests).toHaveLength(1);
    },
  );
  it.each([
    "ip=198.51.100.1\nloc=XX\n",
    "ip=198.51.100.1\nloc=ZZ\n",
    "ip=198.51.100.1\nloc=CN\n",
    "ip=198.51.100.1\nloc=jp\n",
    "ip=not-an-ip\nloc=JP\n",
    "ip=198.51.100.1\nloc=JP\nip=198.51.100.2\n",
    "ip=198.51.100.1\nloc=JP\nunknown_field=US\n",
    "ip=198.51.100.1\ncolo=JP\n",
    "ip=198.51.100.1\nloc=JP\nh=private.example\n",
    "ip=198.51.100.1\nloc=JP\nvisit_scheme=http\n",
    "ip=fe80::1%eth0\nloc=JP\n",
    "ip= 198.51.100.1\nloc=JP\n",
  ])("does not upgrade malformed/ambiguous/disallowed trace %j", async (body) => {
    const f = await fixture({
      respond: (_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(body),
    });
    expect(await f.make().probe()).toBeNull();
    expect(f.traceRequests).toHaveLength(1);
  });
  it("accepts a legitimate IPv6 and explicit CN policy without treating CN failure as foreign success", async () => {
    const f = await fixture({
      respond: (_req, res) =>
        res.writeHead(200, { "content-type": "text/plain" }).end("ip=2001:db8:0:0::1\nloc=CN\n"),
    });
    expect(await f.make({ allowedCountries: ["CN"] }).probe()).toMatchObject({
      ip: "2001:db8::1",
      countryCode: "CN",
    });
  });
  it.each(["oversized-length", "stream-overflow", "compressed", "bad-utf8", "wrong-mime"])(
    "refuses %s and closes the response",
    async (mode) => {
      const f = await fixture({
        respond: (_req, res) => {
          res.setHeader("content-type", mode === "wrong-mime" ? "text/html" : "text/plain");
          if (mode === "oversized-length") res.setHeader("content-length", 16_385);
          if (mode === "compressed") res.setHeader("content-encoding", "gzip");
          if (mode === "bad-utf8") res.end(Buffer.from([255]));
          else if (mode === "stream-overflow") {
            res.write("x".repeat(16_385));
          } else res.end("ip=198.51.100.1\nloc=JP\n");
        },
      });
      const probe = f.make();
      expect(await probe.probe()).toBeNull();
      await probe.whenIdle();
      await f.targetClosed.promise;
    },
  );
});

describe("ProxyEgressProbe cancellation, epochs and native drain", () => {
  it("unknown version and synchronous provider revocation make zero CONNECT requests", async () => {
    const f = await fixture(),
      probe = f.make();
    f.setVersion(null);
    expect(await probe.probe()).toBeNull();
    await probe.whenIdle();
    f.readVersion.mockImplementationOnce(() => {
      probe.invalidate();
      return { generation: 1, revision: "revision-1" };
    });
    expect(await probe.probe()).toBeNull();
    expect(f.connectRequests).toHaveLength(0);
  });
  it("aborts a streaming trace on version change and never publishes its late body", async () => {
    const f = await fixture({
      respond: (_req, res) => {
        res.setHeader("content-type", "text/plain");
        res.write("ip=198.51.100.1\n");
        f.setVersion({ generation: 2, revision: "revision-1" });
        res.end("loc=JP\n");
      },
    });
    const probe = f.make();
    expect(await probe.probe()).toBeNull();
    await probe.whenIdle();
    await f.targetClosed.promise;
  });
  it("cancels a real pending body and remains closed after dispose", async () => {
    const f = await fixture({
      respond: (_req, res) => {
        res.setHeader("content-type", "text/plain");
        res.write("ip=198.51.100.1\n");
      },
    });
    const probe = f.make(),
      abort = new AbortController(),
      pending = probe.probe(abort.signal);
    await f.targetArrived.promise;
    abort.abort();
    expect(await pending).toBeNull();
    await probe.whenIdle();
    await f.targetClosed.promise;
    await probe.dispose();
    expect(await probe.probe()).toBeNull();
    expect(f.connectRequests).toHaveLength(1);
  });
  it("does not overlap late reader work after the public abort result", async () => {
    const f = await fixture(),
      held = deferred<ProxyTunnelReadResult>(),
      entered = deferred<AnonymousProxyTunnelContext>(),
      drain = deferred<void>();
    f.reader.readAnonymousTunnel.mockImplementationOnce((context) => {
      entered.resolve(context);
      return held.promise;
    });
    f.reader.whenIdle.mockImplementation(() => drain.promise);
    const probe = f.make(),
      abort = new AbortController(),
      pending = probe.probe(abort.signal);
    const context = await entered.promise;
    abort.abort();
    expect(await pending).toBeNull();
    expect(await probe.probe()).toBeNull();
    let idle = false;
    const waiting = probe.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    held.resolve(evidence(context));
    await flush();
    expect(idle).toBe(false);
    drain.resolve();
    await waiting;
    expect(f.traceRequests).toHaveLength(0);
    expect(f.connectRequests).toHaveLength(1);
  });
  it("expires the actual factory deadline without retrying a stalled CONNECT", async () => {
    const f = await fixture({ holdConnect: true }),
      probe = f.make({ timeoutMs: 50 });
    expect(await probe.probe()).toBeNull();
    await probe.whenIdle();
    expect(f.connectRequests).toHaveLength(1);
    expect(f.reader.readAnonymousTunnel).not.toHaveBeenCalled();
  });
  it("does not refresh the sole evidence deadline while a reader drains after anonymous TLS", async () => {
    const f = await fixture(),
      entered = deferred<void>(),
      held = deferred<void>();
    f.reader.whenIdle.mockImplementationOnce(() => {
      entered.resolve();
      return held.promise;
    });
    const probe = f.make({ evidenceTtlMs: 10 }),
      pending = probe.probe();
    await entered.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    held.resolve();
    expect(await pending).toBeNull();
    expect(f.reader.readAnonymousTunnel).toHaveBeenCalledTimes(1);
    expect(f.traceRequests).toHaveLength(0);
  });
  it("does not publish after cleanup failure and retains a closed instance", async () => {
    const f = await fixture();
    f.reader.whenIdle.mockImplementation(() => {
      throw new Error("SECRET-CLEANUP");
    });
    const probe = f.make();
    expect(await probe.probe()).toBeNull();
    await expect(probe.whenIdle()).rejects.toThrow("PROXY_EGRESS_CLEANUP_FAILED");
    await expect(probe.dispose()).rejects.toThrow("PROXY_EGRESS_CLEANUP_FAILED");
    expect(await probe.probe()).toBeNull();
  });
  it.each([
    { proxy: { host: "localhost", port: 10090 } },
    { controller: { host: "192.168.0.1", port: 9790 } },
    { timeoutMs: 15_001 },
    { allowedCountries: [] },
    { allowedCountries: ["XX"] },
    { allowedCountries: ["ZZ"] },
    { allowedCountries: ["US", "US"] },
  ])("refuses unsupported options %j before network", async (changes) => {
    const f = await fixture();
    expect(() => f.make(changes)).toThrow("INVALID_PROXY_EGRESS_OPTIONS");
    expect(f.connectRequests).toHaveLength(0);
  });
});
