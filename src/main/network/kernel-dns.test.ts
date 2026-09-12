import { describe, expect, it, vi } from "vitest";
import { KernelDnsReader, type KernelDnsCandidates, type KernelDnsReaderOptions } from "./kernel-dns";
import type { KernelDnsQueryResponse, KernelDnsQueryType } from "./clash-reader";

const VERSION = "a".repeat(64);
const HOST = "www.example.com";
function response(
  host: string,
  type: KernelDnsQueryType,
  startedAtMono: number,
  completedAtMono: number,
): KernelDnsQueryResponse {
  return {
    host,
    queryType: type,
    status: 0,
    truncated: false,
    question: { name: host, type: type === "A" ? 1 : 28 },
    answers: [
      {
        name: host,
        type: type === "A" ? 1 : 28,
        ttl: 60,
        data: type === "A" ? "203.0.113.8" : "2001:db8::8",
      },
    ],
    startedAtMono,
    completedAtMono,
  };
}
function setup(overrides: Partial<KernelDnsReaderOptions> = {}) {
  let time = 100;
  const reader = {
    readDnsQuery: vi.fn(async (host: string, type: KernelDnsQueryType) =>
      response(host, type, time++, time++),
    ),
  };
  const readControllerVersion = vi.fn(async () => ({
    controllerVersion: VERSION,
    startedAtMono: time++,
    completedAtMono: time++,
  }));
  const options: KernelDnsReaderOptions = { reader, readControllerVersion, now: () => time, ...overrides };
  return {
    reader,
    readControllerVersion,
    options,
    service: new KernelDnsReader(options),
    advance: (amount: number) => {
      time += amount;
    },
  };
}
async function available(value: ReturnType<KernelDnsReader["read"]>): Promise<KernelDnsCandidates> {
  const result = await value;
  expect(result.available).toBe(true);
  if (!result.available) throw new Error("Expected candidate snapshot");
  return result;
}

describe("KernelDnsReader", () => {
  it("normalizes and deduplicates exact hosts; reads both families inside fresh controller references", async () => {
    const input = setup();
    const result = await available(input.service.read(["WWW.Example.COM.", HOST]));
    expect(input.reader.readDnsQuery.mock.calls.map(([host, type]) => [host, type])).toEqual([
      [HOST, "A"],
      [HOST, "AAAA"],
    ]);
    expect(input.readControllerVersion).toHaveBeenCalledTimes(2);
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({
      status: "unverified",
      ipv4: ["203.0.113.8"],
      ipv6: ["2001:db8::8"],
      reasons: ["ADDRESS_CLASS_UNKNOWN"],
    });
    expect(result.chromiumResolutionProven).toBe(false);
    expect(result.ttlCapAtMono).toBe(result.startedAtMono + 15_000);
    expect(result.controllerVersionBefore.completedAtMono).toBeLessThanOrEqual(result.hosts[0].startedAtMono);
    expect(result.controllerVersionAfter.startedAtMono).toBeGreaterThanOrEqual(
      result.hosts[0].completedAtMono,
    );
  });

  it.each([
    [],
    ["https://www.example.com"],
    ["127.0.0.1"],
    ["localhost"],
    ["foo.example.com?token=secret"],
    ["*.example.com"],
    ["a..example.com"],
    Array(65).fill(HOST),
  ])("rejects invalid/bounded original targets before touching controller: %j", async (hosts) => {
    const input = setup();
    expect(await input.service.read(hosts)).toMatchObject({ available: false, reason: "INPUT_INVALID" });
    expect(input.reader.readDnsQuery).not.toHaveBeenCalled();
    expect(input.readControllerVersion).not.toHaveBeenCalled();
  });

  it("keeps actual CNAME TTL and caps freshness without rewriting the answer deadline", async () => {
    const input = setup({ classifyAddress: () => "real", maxTtlMs: 1000 });
    input.reader.readDnsQuery.mockImplementation(async (host, type) => {
      const start = input.options.now!();
      input.advance(100);
      return {
        ...response(host, type, start, input.options.now!()),
        answers: [
          { name: host, type: 5, ttl: 2, data: "cdn.example.com" },
          {
            name: "cdn.example.com",
            type: type === "A" ? 1 : 28,
            ttl: 300,
            data: type === "A" ? "203.0.113.9" : "2001:db8::9",
          },
        ],
      };
    });
    const result = await available(input.service.read([HOST]));
    expect(result.status).toBe("candidate");
    expect(result.chromiumResolutionProven).toBe(false);
    expect(result.expiresAtMono).toBe(result.startedAtMono + 1000);
    expect(result.ttlCapAtMono).toBe(result.startedAtMono + 1000);
    for (const answer of result.hosts[0].answers) {
      expect(answer.expiresAtMono).toBe(answer.observedAtMono + answer.ttl * 1000);
      expect(answer.ttl).toBe(answer.type === 5 ? 2 : 300);
    }
  });

  it("expires from the lookup start and the earliest CNAME, not response completion", async () => {
    const input = setup({ classifyAddress: () => "real" });
    input.reader.readDnsQuery.mockImplementation(async (host, type) => {
      const start = input.options.now!();
      input.advance(1500);
      return {
        ...response(host, type, start, input.options.now!()),
        answers: [
          { name: host, type: 5, ttl: 1, data: "cdn.example.com" },
          {
            name: "cdn.example.com",
            type: type === "A" ? 1 : 28,
            ttl: 60,
            data: type === "A" ? "203.0.113.9" : "2001:db8::9",
          },
        ],
      };
    });
    const result = await available(input.service.read([HOST]));
    expect(result.hosts[0].reasons).toContain("EXPIRED");
    expect(result.expiresAtMono).toBeLessThan(result.completedAtMono);
    expect(result.ttlCapAtMono).toBe(result.startedAtMono + 15_000);
    expect(result.ttlCapAtMono).toBeGreaterThan(result.expiresAtMono);
  });

  it.each(["nodata", "nxdomain", "failed", "truncated", "wrong-question"])(
    "keeps successful A observations but never invents IPv4-only evidence when AAAA is %s",
    async (mode) => {
      const input = setup({ classifyAddress: () => "real" });
      input.reader.readDnsQuery.mockImplementation(async (host, type) => {
        const item = response(host, type, input.options.now!(), input.options.now!());
        if (type === "A") return item;
        if (mode === "failed") throw new Error("secret-url?token=credential");
        return {
          ...item,
          answers: mode === "nodata" || mode === "nxdomain" ? [] : item.answers,
          status: mode === "nxdomain" ? 3 : 0,
          truncated: mode === "truncated",
          question: { ...item.question, name: mode === "wrong-question" ? "other.example.com" : host },
        };
      });
      const result = await available(input.service.read([HOST]));
      expect(result.status).toBe("unverified");
      expect(result.hosts[0].ipv4).toEqual(["203.0.113.8"]);
      expect(result.hosts[0].ipv6).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("secret-url");
      expect(JSON.stringify(result)).not.toContain("ipv4-only");
    },
  );

  it.each(["cycle", "unrelated", "conflicting", "wrong-family", "bad-ip", "negative-ttl", "bad-owner"])(
    "rejects incoherent Answer chains: %s",
    async (mode) => {
      const input = setup({ classifyAddress: () => "real" });
      input.reader.readDnsQuery.mockImplementation(async (host, type) => {
        const item = response(host, type, input.options.now!(), input.options.now!());
        if (type === "AAAA") return item;
        const records =
          mode === "cycle"
            ? [
                { name: host, type: 5, ttl: 60, data: "cdn.example.com" },
                { name: "cdn.example.com", type: 5, ttl: 60, data: host },
              ]
            : mode === "unrelated"
              ? [{ name: "attacker.example.com", type: 1, ttl: 60, data: "203.0.113.77" }]
              : mode === "conflicting"
                ? [
                    { name: host, type: 5, ttl: 60, data: "one.example.com" },
                    { name: host, type: 5, ttl: 60, data: "two.example.com" },
                  ]
                : mode === "wrong-family"
                  ? [{ name: host, type: 28, ttl: 60, data: "2001:db8::77" }]
                  : [
                      {
                        name: mode === "bad-owner" ? "BAD.example.com" : host,
                        type: 1,
                        ttl: mode === "negative-ttl" ? -1 : 60,
                        data: mode === "bad-ip" ? "127.1" : "203.0.113.77",
                      },
                    ];
        return { ...item, answers: records as KernelDnsQueryResponse["answers"] };
      });
      const result = await available(input.service.read([HOST]));
      expect(result.status).toBe("unverified");
      expect(result.hosts[0].ipv4).toEqual([]);
      expect(result.hosts[0].ipv6).toEqual(["2001:db8::8"]);
    },
  );

  it("does not map fake IP, and classification never turns candidate data into resolution proof", async () => {
    const input = setup({ classifyAddress: () => "real" });
    input.reader.readDnsQuery.mockImplementation(async (host, type) => ({
      ...response(host, type, input.options.now!(), input.options.now!()),
      answers: [
        {
          name: host,
          type: type === "A" ? 1 : 28,
          ttl: 60,
          data: type === "A" ? "198.19.0.22" : "2001:db8::8",
        },
      ],
    }));
    const result = await available(input.service.read([HOST]));
    expect(result.hosts[0].addresses).toContainEqual({
      address: "198.19.0.22",
      addressFamily: "ipv4",
      addressClass: "fake-ip",
    });
    expect(result.hosts[0].reasons).toContain("FAKE_IP_UNVERIFIED");
    expect(result.chromiumResolutionProven).toBe(false);
  });

  it("keeps current observations but marks every host unverified across controller change", async () => {
    const input = setup({ classifyAddress: () => "real" });
    input.readControllerVersion.mockImplementationOnce(async () => ({
      controllerVersion: VERSION,
      startedAtMono: input.options.now!(),
      completedAtMono: input.options.now!(),
    }));
    input.readControllerVersion.mockImplementationOnce(async () => ({
      controllerVersion: "b".repeat(64),
      startedAtMono: input.options.now!(),
      completedAtMono: input.options.now!(),
    }));
    const result = await available(input.service.read([HOST, "creator.example.com"]));
    expect(result.hosts.every((entry) => entry.reasons.includes("CONTROLLER_CHANGED"))).toBe(true);
    expect(result.controllerVersionAfter.controllerVersion).not.toBe(
      result.controllerVersionBefore.controllerVersion,
    );
  });

  it("rejects historical controller and DNS timing instead of refreshing old results", async () => {
    const input = setup();
    input.readControllerVersion.mockResolvedValueOnce({
      controllerVersion: VERSION,
      startedAtMono: 1,
      completedAtMono: 2,
    });
    expect(await input.service.read([HOST])).toMatchObject({
      available: false,
      reason: "CONTROLLER_VERSION_INVALID",
    });
    expect(input.reader.readDnsQuery).not.toHaveBeenCalled();
    input.reader.readDnsQuery.mockImplementation(async (host, type) => response(host, type, 1, 2));
    const result = await available(input.service.read([HOST]));
    expect(result.hosts[0].reasons).toContain("QUERY_FAILED");
    expect(result.hosts[0].ipv4).toEqual([]);
  });

  it("bounds total query concurrency, rejects overlapping rounds, and does not cache a subsequent round", async () => {
    let active = 0,
      maximum = 0;
    const releases: (() => void)[] = [];
    const input = setup({ concurrency: 2 });
    input.reader.readDnsQuery.mockImplementation(async (host, type) => {
      const start = input.options.now!();
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return response(host, type, start, input.options.now!());
    });
    const pending = input.service.read([HOST, "second.example.com", "third.example.com"]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(await input.service.read([HOST])).toMatchObject({ available: false, reason: "READ_BUSY" });
    for (let step = 0; step < 3; step++) {
      releases.splice(0).forEach((release) => release());
      if (step < 2) await vi.waitFor(() => expect(releases).toHaveLength(2));
    }
    await available(pending);
    expect(maximum).toBe(2);
    input.reader.readDnsQuery.mockImplementation(async (host, type) =>
      response(host, type, input.options.now!(), input.options.now!()),
    );
    await available(input.service.read([HOST]));
    expect(input.reader.readDnsQuery).toHaveBeenCalledTimes(8);
  });

  it.each(["cancel", "invalidate", "dispose", "timeout"])(
    "terminates a hanging lookup and suppresses late result after %s",
    async (action) => {
      const input = setup({ timeoutMs: action === "timeout" ? 20 : 1000 });
      let complete: ((value: KernelDnsQueryResponse) => void) | undefined;
      input.reader.readDnsQuery.mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const abort = new AbortController();
      const pending = input.service.read([HOST], abort.signal);
      await vi.waitFor(() => expect(input.reader.readDnsQuery).toHaveBeenCalledTimes(2));
      if (action === "cancel") abort.abort(new Error("credential-secret"));
      if (action === "invalidate") input.service.invalidate();
      if (action === "dispose") input.service.dispose();
      const result = await pending;
      expect(result).toMatchObject({
        available: false,
        reason: {
          cancel: "CANCELLED",
          invalidate: "INVALIDATED",
          dispose: "DISPOSED",
          timeout: "READ_TIMEOUT",
        }[action],
      });
      expect(input.readControllerVersion).toHaveBeenCalledTimes(1);
      complete?.(response(HOST, "AAAA", 100, 100));
      await Promise.resolve();
      expect(JSON.stringify(result)).not.toContain("credential-secret");
    },
  );
});
