import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ClashReader } from "./clash-reader";

const servers: Server[] = [];

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function liveResponses() {
  return {
    "/configs": {
      mode: "rule",
      "mixed-port": 10090,
      tun: { enable: true, stack: "mixed" },
      secret: "controller-response-secret",
      authentication: ["private-user:private-password"],
    },
    "/rules": {
      rules: [
        { type: "DomainSuffix", payload: "bilibili.com", proxy: "DIRECT" },
        { type: "GeoIP", payload: "CN", proxy: "DIRECT", size: 500 },
        { type: "Match", payload: "", proxy: "PROXY" },
      ],
    },
    "/version": { version: "v-test-kernel", meta: true },
    "/proxies/DIRECT": { type: "Direct", interface: "", "dialer-proxy": "" },
  };
}

function sendJson(response: ServerResponse, value: unknown) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ClashReader GET real transport drain", () => {
  it("waits for real GET close notifications after successful public parsing", async () => {
    const responses = liveResponses();
    const url = await fixture((req, res) => sendJson(res, responses[req.url as keyof typeof responses]));
    const delayed: (() => void)[] = [];
    let allClosed!: () => void;
    const notifications = new Promise<void>((resolve) => {
      allClosed = resolve;
    });
    const emit = ClientRequest.prototype.emit;
    // Real loopback HTTP remains unchanged; delay only its delivered close notification.
    const spy = vi.spyOn(ClientRequest.prototype, "emit").mockImplementation(function (
      this: ClientRequest,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "close") {
        delayed.push(() => emit.call(this, event, ...args));
        if (delayed.length === 4) allClosed();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const reader = new ClashReader({ controllerUrl: url, getSecret: () => null });
    try {
      await reader.read();
      let idle = false;
      const waiting = reader.whenIdle().then(() => {
        idle = true;
      });
      await notifications;
      expect(idle).toBe(false);
      expect(delayed).toHaveLength(4);
      delayed.splice(0).forEach((close) => close());
      await waiting;
      expect(idle).toBe(true);
    } finally {
      spy.mockRestore();
      delayed.splice(0).forEach((close) => close());
      await reader.whenIdle();
    }
  });

  it("retains failed batch transports until all real GET close notifications drain", async () => {
    const url = await fixture((req, res) => {
      if (req.url === "/configs") res.writeHead(401).end("PRIVATE_RESPONSE");
      else {
        res.writeHead(200);
        res.write("{");
      }
    });
    const delayed: (() => void)[] = [],
      emit = ClientRequest.prototype.emit;
    let allClosed!: () => void;
    const notifications = new Promise<void>((resolve) => {
      allClosed = resolve;
    });
    const spy = vi.spyOn(ClientRequest.prototype, "emit").mockImplementation(function (
      this: ClientRequest,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "close") {
        delayed.push(() => emit.call(this, event, ...args));
        if (delayed.length === 4) allClosed();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const reader = new ClashReader({ controllerUrl: url, getSecret: () => null });
    try {
      await expect(reader.read()).rejects.toThrow("CONTROLLER_UNAVAILABLE");
      let idle = false;
      const waiting = reader.whenIdle().then(() => {
        idle = true;
      });
      await notifications;
      expect(idle).toBe(false);
      expect(delayed).toHaveLength(4);
      delayed.splice(0).forEach((close) => close());
      await waiting;
    } finally {
      spy.mockRestore();
      delayed.splice(0).forEach((close) => close());
      await reader.whenIdle();
    }
  });

  it("reserves the pending operation before a credential getter reenters read and whenIdle", async () => {
    const responses = liveResponses();
    let calls = 0,
      seen = 0,
      premature = false;
    const url = await fixture((req, res) => {
      seen++;
      sendJson(res, responses[req.url as keyof typeof responses]);
    });
    let nested: Promise<unknown> | null = null,
      idle: Promise<void> | null = null;
    const reader = new ClashReader({
      controllerUrl: url,
      getSecret: () => {
        calls++;
        nested = reader.read();
        idle = reader.whenIdle().then(() => {
          premature = seen !== 4;
        });
        return null;
      },
    });
    const pending = reader.read();
    await pending;
    await idle;
    expect(nested).toBe(pending);
    expect(calls).toBe(1);
    expect(seen).toBe(4);
    expect(premature).toBe(false);
  });
});

describe("ClashReader exact owned-connection close transport", () => {
  const FIRST = "0deb6b53-ce57-4783-bb89-49184cdf45e1";
  const SECOND = "bd850d84-eb9d-435b-8288-a4dc4f0246d1";
  it("issues one exact UUID DELETE with only controller credentials and returns the original status", async () => {
    const seen: string[] = [];
    vi.stubEnv("HTTP_PROXY", "http://unusable.invalid:9999");
    const controllerUrl = await fixture((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe("Bearer synthetic-control-secret");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["proxy-authorization"]).toBeUndefined();
      expect(request.headers["accept-encoding"]).toBe("identity");
      response.writeHead(204);
      response.end();
    });
    const reader = new ClashReader({ controllerUrl, getSecret: () => "synthetic-control-secret" });
    const result = await reader.closeConnection(FIRST);
    await reader.whenIdle();
    expect(seen).toEqual([`DELETE /connections/${FIRST}`]);
    expect(result.status).toBe(204);
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(Object.keys(result).sort()).toEqual(["status", "startedAtMono", "completedAtMono"].sort());
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|connections|closed|confirmed|socket|ownership/);
  });
  it.each([
    "",
    "*",
    "connections",
    "../connections",
    `${FIRST}/`,
    `${FIRST}?all=true`,
    `%2e%2e`,
    ` ${FIRST}`,
    `${FIRST}\n`,
    FIRST.replaceAll("-", ""),
    `https://127.0.0.1/${FIRST}`,
    `${FIRST},${SECOND}`,
  ])("rejects bulk, non-UUID or endpoint injection before credentials: %s", async (id) => {
    const getSecret = vi.fn(() => "private");
    const reader = new ClashReader({ controllerUrl: "http://127.0.0.1:1", getSecret });
    await expect(reader.closeConnection(id)).rejects.toThrow("CONTROLLER_CONFIG_INVALID");
    expect(getSecret).not.toHaveBeenCalled();
    await reader.whenIdle();
  });
  it("preserves UUID spelling and makes no interpretation of a non-success status", async () => {
    const seen: string[] = [];
    const controllerUrl = await fixture((request, response) => {
      seen.push(request.url!);
      response.writeHead(404);
      response.end("synthetic private diagnostic");
    });
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    const result = await reader.closeConnection(FIRST.toUpperCase());
    await reader.whenIdle();
    expect(seen).toEqual([`/connections/${FIRST.toUpperCase()}`]);
    expect(result.status).toBe(404);
    expect(JSON.stringify(result)).not.toContain("diagnostic");
  });
  it("rejects redirects without visiting the location or retrying", async () => {
    const redirected = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.end();
    });
    const location = await fixture(redirected);
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(307, { Location: `${location}/connections/${SECOND}` });
      response.end();
    });
    const reader = new ClashReader({ controllerUrl: await fixture(handler), getSecret: () => "private" });
    await expect(reader.closeConnection(FIRST)).rejects.toThrow("CONTROLLER_REDIRECT_REJECTED");
    await reader.whenIdle();
    expect(handler).toHaveBeenCalledOnce();
    expect(redirected).not.toHaveBeenCalled();
  });
  it("waits for response end and keeps a single mutation slot without queuing a second ID", async () => {
    let received!: () => void, held: ServerResponse | undefined;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const seen: string[] = [];
    const controllerUrl = await fixture((request, response) => {
      seen.push(request.url!);
      if (seen.length === 1) {
        held = response;
        response.writeHead(200);
        response.write("partial private body");
        received();
      } else {
        response.writeHead(204);
        response.end();
      }
    });
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    let completed = false,
      idle = false;
    const pending = reader.closeConnection(FIRST).then((value) => {
      completed = true;
      return value;
    });
    await arrived;
    const idleWait = reader.whenIdle().then(() => {
      idle = true;
    });
    await expect(reader.closeConnection(SECOND)).rejects.toThrow("CONTROLLER_BUSY");
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(idle).toBe(false);
    expect(seen).toHaveLength(1);
    held!.end(" done");
    expect((await pending).status).toBe(200);
    await idleWait;
    expect(seen).toHaveLength(1);
    expect((await reader.closeConnection(SECOND)).status).toBe(204);
    await reader.whenIdle();
    expect(seen).toEqual([`/connections/${FIRST}`, `/connections/${SECOND}`]);
  });
  it.each(["declared", "streamed", "encoding"])(
    "bounds and discards %s close response bodies",
    async (kind) => {
      const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(
          200,
          kind === "declared"
            ? { "Content-Length": "65537" }
            : kind === "encoding"
              ? { "Content-Encoding": "gzip" }
              : {},
        );
        response.end(kind === "streamed" ? "x".repeat(65537) : "private");
      });
      const reader = new ClashReader({ controllerUrl: await fixture(handler), getSecret: () => null });
      await expect(reader.closeConnection(FIRST)).rejects.toThrow(
        kind === "encoding" ? "CONTROLLER_RESPONSE_INVALID" : "CONTROLLER_RESPONSE_TOO_LARGE",
      );
      await reader.whenIdle();
      expect(handler).toHaveBeenCalledOnce();
    },
  );
  it("cancels a partial response without exposing the caller reason and drains the actual HTTP transport", async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200);
      response.write("private response");
      received();
    });
    const reader = new ClashReader({ controllerUrl: await fixture(handler), getSecret: () => null });
    const abort = new AbortController();
    const pending = reader.closeConnection(FIRST, abort.signal);
    await arrived;
    abort.abort(Error("private caller reason"));
    await expect(pending).rejects.toThrow(/^CONTROLLER_CANCELLED$/);
    await reader.whenIdle();
    expect(handler).toHaveBeenCalledOnce();
  });
  it("times out exactly one request with no automatic retry", async () => {
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200);
      response.write("held");
    });
    const reader = new ClashReader({
      controllerUrl: await fixture(handler),
      getSecret: () => null,
      timeoutMs: 100,
    });
    await expect(reader.closeConnection(FIRST)).rejects.toThrow(/^CONTROLLER_TIMEOUT$/);
    await reader.whenIdle();
    expect(handler).toHaveBeenCalledOnce();
  });
  it("rejects an upgraded protocol and drains its detached socket", async () => {
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(101, { Connection: "Upgrade", Upgrade: "synthetic-protocol" });
      response.end();
    });
    const reader = new ClashReader({ controllerUrl: await fixture(handler), getSecret: () => null });
    await expect(reader.closeConnection(FIRST)).rejects.toThrow("CONTROLLER_RESPONSE_INVALID");
    await reader.whenIdle();
    expect(handler).toHaveBeenCalledOnce();
  });
  it("does not return a status from a prematurely terminated response body", async () => {
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("truncated");
      setImmediate(() => response.destroy());
    });
    const reader = new ClashReader({ controllerUrl: await fixture(handler), getSecret: () => null });
    await expect(reader.closeConnection(FIRST)).rejects.toThrow("CONTROLLER_UNAVAILABLE");
    await reader.whenIdle();
    expect(handler).toHaveBeenCalledOnce();
  });
  it("checks the monotonic deadline when the timer has not yet run", async () => {
    let mono = 0;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    const reader = new ClashReader({
      controllerUrl: await fixture((_request, response) => {
        mono = 100;
        response.writeHead(204);
        response.end();
      }),
      getSecret: () => null,
      timeoutMs: 100,
    });
    await expect(reader.closeConnection(FIRST)).rejects.toThrow("CONTROLLER_TIMEOUT");
    await reader.whenIdle();
  });
  it("does not read credentials or send when already cancelled", async () => {
    const getSecret = vi.fn(() => null),
      abort = new AbortController();
    abort.abort();
    const reader = new ClashReader({ controllerUrl: "http://127.0.0.1:1", getSecret });
    await expect(reader.closeConnection(FIRST, abort.signal)).rejects.toThrow("CONTROLLER_CANCELLED");
    await reader.whenIdle();
    expect(getSecret).not.toHaveBeenCalled();
  });
  it("rechecks cancellation caused by credential access before creating a request", async () => {
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end());
    const abort = new AbortController();
    const reader = new ClashReader({
      controllerUrl: await fixture(handler),
      getSecret: () => {
        abort.abort();
        return "private";
      },
    });
    await expect(reader.closeConnection(FIRST, abort.signal)).rejects.toThrow("CONTROLLER_CANCELLED");
    await reader.whenIdle();
    expect(handler).not.toHaveBeenCalled();
  });
  it("reserves its mutation slot before a credential provider can reenter", async () => {
    let nested: Promise<unknown> | undefined;
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(204);
      response.end();
    });
    const reader = new ClashReader({
      controllerUrl: await fixture(handler),
      getSecret: () => {
        nested = reader.closeConnection(SECOND).catch((error) => error.message);
        return null;
      },
    });
    expect((await reader.closeConnection(FIRST)).status).toBe(204);
    expect(await nested).toBe("CONTROLLER_BUSY");
    await reader.whenIdle();
    expect(handler).toHaveBeenCalledOnce();
  });
  it("sanitizes credential errors and releases the unused mutation slot", async () => {
    const reader = new ClashReader({
      controllerUrl: "http://127.0.0.1:1",
      getSecret: () => {
        throw Error("synthetic-secret");
      },
    });
    await expect(reader.closeConnection(FIRST)).rejects.toThrow(/^CREDENTIAL_UNAVAILABLE$/);
    await reader.whenIdle();
    await expect(reader.closeConnection(SECOND)).rejects.toThrow(/^CREDENTIAL_UNAVAILABLE$/);
  });
});

describe("ClashReader", () => {
  it("validates actual mihomo Go dns.Question Name/Qtype/Qclass without assuming aliases", async () => {
    let question: unknown = { Name: "www.example.com.", Qtype: 28, Qclass: 1 };
    const controllerUrl = await fixture((_request, response) =>
      sendJson(response, {
        Status: 0,
        TC: false,
        Question: [question],
        Answer: [{ name: "www.example.com.", type: 28, TTL: 47, data: "2001:db8::8" }],
      }),
    );
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    expect(await reader.readDnsQuery("www.example.com", "AAAA")).toMatchObject({
      question: { name: "www.example.com", type: 28 },
      answers: [{ ttl: 47, data: "2001:db8::8" }],
    });
    for (const invalid of [
      { Name: "www.example.com.", Qtype: 28, Qclass: 3 },
      { Name: "www.example.com.", Qtype: 28 },
      { Name: "www.example.com.", Qtype: 1, Qclass: 1 },
      { Name: "www.example.com.", Qtype: 28, Qclass: 1, name: "wrong.example.com" },
    ]) {
      question = invalid;
      await expect(reader.readDnsQuery("www.example.com", "AAAA")).rejects.toThrow(
        "CONTROLLER_RESPONSE_INVALID",
      );
    }
  });
  it("reads exact DNS questions through fixed loopback HTTP and projects only bounded DNS fields", async () => {
    const seen: string[] = [];
    const controllerUrl = await fixture((request, response) => {
      seen.push(request.url!);
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe("Bearer synthetic-secret");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["proxy-authorization"]).toBeUndefined();
      sendJson(response, {
        Status: 0,
        TC: false,
        Question: [{ name: "WWW.EXAMPLE.COM.", type: 1 }],
        Answer: [
          { name: "www.example.com.", type: 5, TTL: 12, data: "cdn.example.com." },
          { name: "cdn.example.com.", type: 1, TTL: 30, data: "203.0.113.8" },
        ],
        secret: "must-not-escape",
        provider: "private",
      });
    });
    const result = await new ClashReader({ controllerUrl, getSecret: () => "synthetic-secret" }).readDnsQuery(
      "WWW.EXAMPLE.COM.",
      "A",
    );
    expect(seen).toEqual(["/dns/query?name=www.example.com&type=A"]);
    expect(result).toMatchObject({
      host: "www.example.com",
      status: 0,
      truncated: false,
      question: { name: "www.example.com", type: 1 },
      answers: [
        { name: "www.example.com", type: 5, ttl: 12, data: "cdn.example.com" },
        { name: "cdn.example.com", type: 1, ttl: 30, data: "203.0.113.8" },
      ],
    });
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(JSON.stringify(result)).not.toMatch(/must-not-escape|private|synthetic-secret/);
  });

  it.each([
    "https://example.com",
    "127.0.0.1",
    "127.1",
    "localhost",
    "*.example.com",
    "example.com?type=AAAA&secret=value",
    "bad\\example.com",
    "a..example.com",
  ])("rejects DNS endpoint injection before reading credentials: %s", async (host) => {
    const getSecret = vi.fn(() => "synthetic");
    const reader = new ClashReader({ controllerUrl: "http://127.0.0.1:1", getSecret });
    await expect(reader.readDnsQuery(host, "A")).rejects.toThrow("CONTROLLER_CONFIG_INVALID");
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each([
    "wrong-name",
    "wrong-type",
    "missing-question",
    "bad-status",
    "missing-tc",
    "invalid-ip",
    "oversized-records",
    "invalid-ttl",
  ])("refuses incomplete or mismatched DNS response: %s", async (mode) => {
    const controllerUrl = await fixture((_request, response) => {
      const record = {
        name: "www.example.com.",
        type: 28,
        TTL: mode === "invalid-ttl" ? -1 : 60,
        data: mode === "invalid-ip" ? "not-an-address" : "2001:db8::8",
      };
      sendJson(response, {
        Status: mode === "bad-status" ? "0" : 0,
        ...(mode === "missing-tc" ? {} : { TC: false }),
        Question:
          mode === "missing-question"
            ? []
            : [
                {
                  name: mode === "wrong-name" ? "wrong.example.com" : "www.example.com.",
                  type: mode === "wrong-type" ? 1 : 28,
                },
              ],
        Answer: mode === "oversized-records" ? Array(129).fill(record) : [record],
      });
    });
    await expect(
      new ClashReader({ controllerUrl, getSecret: () => null }).readDnsQuery("www.example.com", "AAAA"),
    ).rejects.toThrow("CONTROLLER_RESPONSE_INVALID");
  });

  it("preserves NXDOMAIN, truncation and empty Answer for the candidate reader to reject semantically", async () => {
    const controllerUrl = await fixture((_request, response) =>
      sendJson(response, { Status: 3, TC: true, Question: [{ name: "www.example.com.", type: 28 }] }),
    );
    expect(
      await new ClashReader({ controllerUrl, getSecret: () => null }).readDnsQuery("www.example.com", "AAAA"),
    ).toMatchObject({ status: 3, truncated: true, answers: [] });
  });

  it("caps DNS response size at 64 KiB even when general controller responses allow more", async () => {
    const controllerUrl = await fixture((_request, response) =>
      sendJson(response, { filler: "a".repeat(65_537) }),
    );
    await expect(
      new ClashReader({ controllerUrl, getSecret: () => null }).readDnsQuery("www.example.com", "A"),
    ).rejects.toThrow("CONTROLLER_RESPONSE_TOO_LARGE");
  });

  it("cancels a current DNS stream promptly and does not leak caller abort reason", async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const controllerUrl = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"Status":');
      received();
    });
    const abort = new AbortController();
    const pending = new ClashReader({ controllerUrl, getSecret: () => null }).readDnsQuery(
      "www.example.com",
      "A",
      abort.signal,
    );
    await arrived;
    abort.abort(new Error("caller-secret"));
    await expect(pending).rejects.toThrow("CONTROLLER_CANCELLED");
  });

  it("makes no DNS request or credential read when already cancelled", async () => {
    const getSecret = vi.fn(() => null);
    const abort = new AbortController();
    abort.abort();
    await expect(
      new ClashReader({ controllerUrl: "http://127.0.0.1:1", getSecret }).readDnsQuery(
        "www.example.com",
        "A",
        abort.signal,
      ),
    ).rejects.toThrow("CONTROLLER_CANCELLED");
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("inspects the policy type behind DIRECT and keeps absent fields unknown", async () => {
    const paths: string[] = [];
    const controllerUrl = await fixture((request, response) => {
      paths.push(request.url!);
      expect(request.headers.authorization).toBe("Bearer synthetic-control-secret");
      sendJson(response, {
        name: "DIRECT",
        type: "Direct",
        interface: "",
        "dialer-proxy": "",
        secret: "must-not-escape",
      });
    });
    const result = await new ClashReader({
      controllerUrl,
      getSecret: () => "synthetic-control-secret",
    }).readDirectPolicy();
    expect(paths).toEqual(["/proxies/DIRECT"]);
    expect(result).toMatchObject({ kind: "direct", interfaceName: "", dialer: "none", ipVersion: null });
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(result.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-control-secret|must-not-escape/);
    expect(result).not.toHaveProperty("directProof");
  });

  it.each([
    { policy: { name: "DIRECT", type: "Shadowsocks" }, kind: "other", dialer: "unknown" },
    { policy: { name: "DIRECT" }, kind: "unknown", dialer: "unknown" },
    {
      policy: { type: "Direct", "dialer-proxy": "private-upstream-node" },
      kind: "direct",
      dialer: "configured",
    },
    { policy: { type: "Direct", "dialer-proxy": null, interface: null }, kind: "direct", dialer: "unknown" },
  ])(
    "does not certify an alias or missing/upstream policy: $kind/$dialer",
    async ({ policy, kind, dialer }) => {
      const controllerUrl = await fixture((_request, response) => sendJson(response, policy));
      const result = await new ClashReader({ controllerUrl, getSecret: () => null }).readDirectPolicy();
      expect(result).toMatchObject({ kind, dialer, interfaceName: null });
      expect(JSON.stringify(result)).not.toContain("private-upstream-node");
    },
  );

  it("fingerprints visible policy changes while excluding only alive/history statistics", async () => {
    const initial = {
      type: "Direct",
      interface: "",
      "dialer-proxy": "",
      "ip-version": "dual",
      alive: true,
      history: [{ delay: 20 }],
    };
    let policy: Record<string, unknown> = initial;
    const controllerUrl = await fixture((_request, response) => sendJson(response, policy));
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    const first = await reader.readDirectPolicy();
    policy = { ...initial, alive: false, history: [{ delay: 45 }] };
    expect((await reader.readDirectPolicy()).policyFingerprint).toBe(first.policyFingerprint);
    for (const change of [
      { interface: "Ethernet" },
      { "dialer-proxy": "changed-upstream" },
      { "ip-version": "ipv4" },
      { "new-policy-field": true },
    ]) {
      policy = { ...initial, ...change };
      expect((await reader.readDirectPolicy()).policyFingerprint).not.toBe(first.policyFingerprint);
    }
  });

  it("returns only a fixed error for a malformed DIRECT policy response", async () => {
    const controllerUrl = await fixture((_request, response) => sendJson(response, "private-body"));
    await expect(
      new ClashReader({ controllerUrl, getSecret: () => null }).readDirectPolicy(),
    ).rejects.toThrow(/^CONTROLLER_RESPONSE_INVALID$/);
  });
  it("reads live scoped connections over loopback and discards unrelated connections and secret fields", async () => {
    const seen: string[] = [];
    const controllerUrl = await fixture((request, response) => {
      seen.push(request.url!);
      expect(request.headers.authorization).toBe("Bearer control-secret");
      sendJson(response, {
        connections: [
          {
            id: "own-connection",
            start: "2026-09-07T10:00:00Z",
            chains: ["DIRECT"],
            metadata: {
              host: "creator.douyin.com",
              sourcePort: "50000",
              sourceIP: "198.18.0.0",
              destinationPort: "443",
              network: "tcp",
              type: "Tun",
              processPath: "C:\\ClipDock\\ClipDock.exe",
              destinationIP: "",
              token: "private-token",
            },
          },
          { id: "private-connection", metadata: { host: "private.example", password: "private-password" } },
        ],
      });
    });
    const reader = new ClashReader({ controllerUrl, getSecret: () => "control-secret" });
    const first = await reader.readConnections(["creator.douyin.com"]);
    const second = await reader.readConnections(["creator.douyin.com"]);
    expect(seen).toEqual(["/connections", "/connections"]);
    expect(first.connections).toHaveLength(1);
    expect(first.connections[0]).toMatchObject({
      id: "own-connection",
      route: "direct",
      destinationIp: null,
    });
    expect(first.completedAtMono).toBeGreaterThanOrEqual(first.startedAtMono);
    expect(second.startedAtMono).toBeGreaterThanOrEqual(first.completedAtMono);
    expect(JSON.stringify(first)).not.toMatch(/secret|private|token|password|processPath/);
  });

  it("rejects a malformed connection envelope with only a fixed error", async () => {
    const controllerUrl = await fixture((_request, response) =>
      sendJson(response, { connections: "private-secret" }),
    );
    await expect(
      new ClashReader({ controllerUrl, getSecret: () => null }).readConnections(["creator.douyin.com"]),
    ).rejects.toThrow(/^CONTROLLER_RESPONSE_INVALID$/);
  });

  it("reads only live API data, preserves unknown ordered rules and returns no config secrets", async () => {
    const responses = liveResponses();
    const paths: string[] = [];
    const authorization: Array<string | undefined> = [];
    const controllerUrl = await fixture((request, response) => {
      paths.push(request.url!);
      authorization.push(request.headers.authorization);
      sendJson(response, responses[request.url as keyof typeof responses]);
    });
    const getSecret = vi.fn(() => "test-controller-secret");
    const result = await new ClashReader({ controllerUrl, getSecret }).read();

    expect(paths.sort()).toEqual(["/configs", "/proxies/DIRECT", "/rules", "/version"]);
    expect(authorization).toEqual(Array(4).fill("Bearer test-controller-secret"));
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: "rule", tun: true, mixedPort: 10090, version: "v-test-kernel" });
    expect(result.rules[1]).toEqual({ type: "GeoIP", payload: "CN", proxy: "DIRECT" });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.startedAtMono).toBeTypeOf("number");
    expect(result.completedAtMono!).toBeGreaterThanOrEqual(result.startedAtMono!);
    expect(Object.keys(result.configFieldHashes!)).toEqual(Object.keys(responses["/configs"]));
    expect(Object.values(result.configFieldHashes!).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(
      true,
    );
    expect(result.directPolicy).toMatchObject({ kind: "direct", dialer: "none", ipVersion: null });
    expect(result.configFieldHashes).not.toHaveProperty("dns");
    expect(JSON.stringify(result)).not.toMatch(
      /controller-response-secret|private-user|private-password|test-controller-secret/,
    );
    expect(result).not.toHaveProperty("config");
  });

  it("deduplicates concurrent reads but performs a new live batch after completion", async () => {
    const responses = liveResponses();
    let count = 0;
    const controllerUrl = await fixture((request, response) => {
      count += 1;
      setTimeout(() => sendJson(response, responses[request.url as keyof typeof responses]), 10);
    });
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    const first = reader.read();
    const second = reader.read();
    expect(second).toBe(first);
    expect((await first).fingerprint).toBe((await second).fingerprint);
    expect(count).toBe(4);
    await reader.read();
    expect(count).toBe(8);
  });

  it("fingerprints complete visible config/rules responses while ignoring JSON object key order", async () => {
    const initial = liveResponses();
    let responses: Record<string, unknown> = initial;
    const controllerUrl = await fixture((request, response) => sendJson(response, responses[request.url!]));
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    const first = await reader.read();
    responses = { ...initial, "/configs": Object.fromEntries(Object.entries(initial["/configs"]).reverse()) };
    expect((await reader.read()).fingerprint).toBe(first.fingerprint);
    responses = { ...initial, "/configs": { ...initial["/configs"], "find-process-mode": "always" } };
    const configChanged = await reader.read();
    expect(configChanged.fingerprint).not.toBe(first.fingerprint);
    responses = { ...initial, "/rules": { rules: [...initial["/rules"].rules].reverse() } };
    expect((await reader.read()).fingerprint).not.toBe(first.fingerprint);
    responses = {
      ...initial,
      "/rules": { rules: initial["/rules"].rules.map((rule) => ({ ...rule, size: 501 })) },
    };
    expect((await reader.read()).fingerprint).not.toBe(first.fingerprint);
  });

  it("revokes the visible observation version when DIRECT changes, but not on health statistics", async () => {
    const initial = liveResponses();
    let policy: Record<string, unknown> = initial["/proxies/DIRECT"];
    const controllerUrl = await fixture((request, response) =>
      sendJson(
        response,
        request.url === "/proxies/DIRECT" ? policy : initial[request.url as keyof typeof initial],
      ),
    );
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    const first = await reader.read();
    policy = { ...initial["/proxies/DIRECT"], alive: true, history: [{ delay: 12 }] };
    expect((await reader.read()).fingerprint).toBe(first.fingerprint);
    for (const change of [
      { interface: "changed-interface" },
      { "dialer-proxy": "private-upstream" },
      { type: "Selector" },
    ]) {
      policy = { ...initial["/proxies/DIRECT"], ...change };
      const result = await reader.read();
      expect(result.fingerprint).not.toBe(first.fingerprint);
      expect(JSON.stringify(result)).not.toContain("private-upstream");
      if ("interface" in change) expect(result.directPolicy?.interfaceName).toBe(change.interface);
    }
    policy = {};
    expect((await reader.read()).fingerprint).not.toBe(first.fingerprint);
  });

  it("does not retain a readable kernel batch when the DIRECT endpoint is unavailable", async () => {
    const initial = liveResponses();
    const controllerUrl = await fixture((request, response) => {
      if (request.url === "/proxies/DIRECT") {
        response.writeHead(503);
        response.end();
        return;
      }
      sendJson(response, initial[request.url as keyof typeof initial]);
    });
    await expect(new ClashReader({ controllerUrl, getSecret: () => null }).read()).rejects.toThrow(
      /^CONTROLLER_UNAVAILABLE$/,
    );
  });

  it("rejects redirects without following them or disclosing their URL/body", async () => {
    let redirectedRequests = 0;
    const redirectTarget = await fixture((_request, response) => {
      redirectedRequests += 1;
      response.end("must-not-be-contacted");
    });
    const controllerUrl = await fixture((_request, response) => {
      response.writeHead(302, { location: `${redirectTarget}/?secret=redirect-secret` });
      response.end("redirect-response-secret");
    });
    await expect(new ClashReader({ controllerUrl, getSecret: () => "auth-secret" }).read()).rejects.toThrow(
      /^CONTROLLER_REDIRECT_REJECTED$/,
    );
    expect(redirectedRequests).toBe(0);
  });

  it("uses direct literal-loopback sockets even when proxy environment variables are set", async () => {
    let proxyRequests = 0;
    const proxy = await fixture((_request, response) => {
      proxyRequests += 1;
      response.end("proxy");
    });
    vi.stubEnv("HTTP_PROXY", proxy);
    vi.stubEnv("http_proxy", proxy);
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    const responses = liveResponses();
    const controllerUrl = await fixture((request, response) =>
      sendJson(response, responses[request.url as keyof typeof responses]),
    );
    await expect(new ClashReader({ controllerUrl, getSecret: () => null }).read()).resolves.toMatchObject({
      mode: "rule",
    });
    expect(proxyRequests).toBe(0);
  });

  it.each([
    "http://localhost:9090",
    "http://127.1:9090",
    "http://2130706433:9090",
    "http://0x7f000001:9090",
    "http://192.168.1.1:9090",
    "http://127.0.0.1:9090/configs",
    "http://secret@127.0.0.1:9090",
    "http://127.0.0.1:9090?token=secret",
    "http://127.0.0.1:9090#secret",
    "https://127.0.0.1:9090",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
  ])("rejects noncanonical or unsafe controller address %s", (controllerUrl) => {
    expect(() => new ClashReader({ controllerUrl, getSecret: () => null })).toThrow(
      /^CONTROLLER_CONFIG_INVALID$/,
    );
  });

  it("bounds both declared and streamed response sizes", async () => {
    const declared = await fixture((_request, response) => {
      response.writeHead(200, { "content-length": 1024 });
      response.flushHeaders();
    });
    await expect(
      new ClashReader({ controllerUrl: declared, getSecret: () => null, maxResponseBytes: 100 }).read(),
    ).rejects.toThrow(/^CONTROLLER_RESPONSE_TOO_LARGE$/);
    const streamed = await fixture((_request, response) => {
      response.writeHead(200);
      response.write("a".repeat(64));
      response.end("b".repeat(64));
    });
    await expect(
      new ClashReader({ controllerUrl: streamed, getSecret: () => null, maxResponseBytes: 100 }).read(),
    ).rejects.toThrow(/^CONTROLLER_RESPONSE_TOO_LARGE$/);
  });

  it("enforces a hard deadline even while the controller keeps streaming", async () => {
    const controllerUrl = await fixture((_request, response) => {
      response.writeHead(200);
      response.write("{");
      const interval = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(interval));
    });
    await expect(
      new ClashReader({ controllerUrl, getSecret: () => null, timeoutMs: 60 }).read(),
    ).rejects.toThrow(/^CONTROLLER_TIMEOUT$/);
  });

  it("does not retain failed single-flight reads or expose parsing errors containing body secrets", async () => {
    let broken = true;
    const responses = liveResponses();
    const controllerUrl = await fixture((request, response) => {
      if (broken) response.end("invalid-json-with-secret-body");
      else sendJson(response, responses[request.url as keyof typeof responses]);
    });
    const reader = new ClashReader({ controllerUrl, getSecret: () => null });
    await expect(reader.read()).rejects.toThrow(/^CONTROLLER_RESPONSE_INVALID$/);
    broken = false;
    await expect(reader.read()).resolves.toMatchObject({ mode: "rule" });
  });

  it("fails closed on incomplete live responses instead of inventing DIRECT defaults", async () => {
    const responses = liveResponses();
    const controllerUrl = await fixture((request, response) => {
      sendJson(
        response,
        request.url === "/configs" ? { mode: "rule" } : responses[request.url as keyof typeof responses],
      );
    });
    await expect(new ClashReader({ controllerUrl, getSecret: () => null }).read()).rejects.toThrow(
      /^CONTROLLER_RESPONSE_INVALID$/,
    );
  });

  it("sanitizes unavailable secrets before issuing any controller requests", async () => {
    let requests = 0;
    const controllerUrl = await fixture((_request, response) => {
      requests += 1;
      response.end("{}");
    });
    const getSecret = () => {
      throw new Error("dpapi-error-with-private-secret");
    };
    await expect(new ClashReader({ controllerUrl, getSecret }).read()).rejects.toThrow(
      /^CREDENTIAL_UNAVAILABLE$/,
    );
    await expect(
      new ClashReader({ controllerUrl, getSecret: () => "secret\r\ninjected-header" }).read(),
    ).rejects.toThrow(/^CREDENTIAL_UNAVAILABLE$/);
    expect(requests).toBe(0);
  });
});
