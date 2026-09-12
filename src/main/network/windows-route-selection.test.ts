import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsRouteSelectionReader, type WindowsRouteSelectionScope } from "./windows-route-selection";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const scope = { addresses: ["203.0.113.9"] };
const GUID = "abcd0001-0002-0003-0004-000000000005";
const instances: WindowsRouteSelectionReader[] = [];
function row() {
  return {
    targetAddress: "203.0.113.9",
    sourceAddress: "192.0.2.10",
    addressFamily: "IPv4",
    sourceState: "Preferred",
    skipAsSource: false,
    interfaceIndex: 12,
    interfaceGuid: `{${GUID.toUpperCase()}}`,
    hardwareInterface: true,
    adapterStatus: "Up",
    interfaceConnection: "Connected",
    interfaceMetric: 20,
    destinationPrefix: "0.0.0.0/0",
    nextHop: "192.0.2.1",
    routeMetric: 0,
    routeState: "Alive",
  };
}
function response() {
  return { before: [row()], after: [row()] };
}
function reader(
  run: (input: string, signal: AbortSignal) => Promise<string>,
  selected: WindowsRouteSelectionScope = scope,
  timeoutMs = 10000,
) {
  const instance = new WindowsRouteSelectionReader(selected, { runner: run, platform: "win32", timeoutMs });
  instances.push(instance);
  return instance;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
afterEach(() => {
  instances.splice(0).forEach((instance) => instance.dispose());
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("WindowsRouteSelectionReader actual records", () => {
  it("queries an explicit local source without relabeling it as an unconstrained best route", async () => {
    const run = vi.fn<(input: string, signal: AbortSignal) => Promise<string>>(async () =>
      JSON.stringify(response()),
    );
    const result = await reader(run, { ...scope, localAddress: "192.0.2.10" }).read();
    const ordinary = await reader(async () => JSON.stringify(response())).read();
    expect(JSON.parse(run.mock.calls[0][0])).toEqual({ ...scope, localAddress: "192.0.2.10" });
    expect(result).toMatchObject({
      available: true,
      basis: "windows-source-route-query",
      localAddress: "192.0.2.10",
      socketObserved: false,
      selections: [{ sourceAddress: "192.0.2.10" }],
    });
    if (!result.available || !ordinary.available) throw Error("fixture unavailable");
    expect(result.scopeHash).not.toBe(ordinary.scopeHash);
    expect(result.selectionHash).toBe(ordinary.selectionHash);
    expect(ordinary).not.toHaveProperty("localAddress");
  });

  it("rejects a source-constrained result that selects another local source", async () => {
    const result = await reader(async () => JSON.stringify(response()), {
      ...scope,
      localAddress: "192.0.2.11",
    }).read();
    expect(result).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
  });

  it.each([
    "0.0.0.0",
    "::",
    "ANY",
    "192.0.2.0/24",
    "192.0.2.10; whoami",
    "2001:db8::2",
    "::ffff:c000:20a",
    "0:0:0:0:0:ffff:c000:20a",
    "fe80::1%12",
  ])("rejects wildcard, nonliteral or mismatched local source %s", (localAddress) => {
    expect(() => reader(async () => JSON.stringify(response()), { ...scope, localAddress })).toThrow(
      "WINDOWS_ROUTE_SCOPE_INVALID",
    );
  });

  it("canonicalizes the IPv6 source constraint before comparing the real selected source", async () => {
    const item = {
      ...row(),
      targetAddress: "2001:db8:abcd::9",
      sourceAddress: "2001:db8:abcd::2",
      addressFamily: "IPv6",
      destinationPrefix: "::/0",
      nextHop: "fe80::1%12",
    };
    const result = await reader(async () => JSON.stringify({ before: [item], after: [item] }), {
      addresses: [item.targetAddress],
      localAddress: "2001:0db8:abcd:0:0:0:0:2",
    }).read();
    expect(result).toMatchObject({
      available: true,
      basis: "windows-source-route-query",
      localAddress: item.sourceAddress,
    });
  });

  it("retains selected source, route and adapter facts without granting a route or observing a socket", async () => {
    const result = await reader(async () => JSON.stringify(response())).read();
    expect(result.available).toBe(true);
    if (!result.available) throw Error("fixture unavailable");
    expect(result).toMatchObject({ basis: "windows-best-route-query", socketObserved: false });
    expect(result.selections[0]).toMatchObject({
      targetAddress: "203.0.113.9",
      sourceAddress: "192.0.2.10",
      addressFamily: "ipv4",
      interfaceIndex: 12,
      interfaceGuid: GUID,
      hardwareInterface: true,
      adapterUp: true,
      interfaceMetric: 20,
      destinationPrefix: "0.0.0.0/0",
      nextHop: "192.0.2.1",
      routeMetric: 0,
    });
    expect(result.selections[0].interfaceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.selectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(Object.isFrozen(result.selections[0])).toBe(true);
    expect(Object.isFrozen(result.selections)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DIRECT|country|CN|processId/);
  });

  it("does not label a virtual interface or a down adapter as a qualified physical outlet", async () => {
    const data = response();
    for (const item of [...data.before, ...data.after]) {
      item.hardwareInterface = false;
      item.adapterStatus = "Down";
      item.interfaceConnection = "Disconnected";
    }
    const result = await reader(async () => JSON.stringify(data)).read();
    expect(result).toMatchObject({
      available: true,
      selections: [{ hardwareInterface: false, adapterUp: false, interfaceConnection: "Disconnected" }],
    });
  });

  it("preserves a missing CIM interface metric as null, distinct from explicit zero", async () => {
    const item = { ...row(), hardwareInterface: false, interfaceMetric: null };
    const result = await reader(async () => JSON.stringify({ before: [item], after: [item] })).read();
    expect(result).toMatchObject({ available: true, selections: [{ interfaceMetric: null }] });
    expect(
      await reader(async () =>
        JSON.stringify({ before: [item], after: [{ ...item, interfaceMetric: 0 }] }),
      ).read(),
    ).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
  });

  it("canonicalizes IPv6, validates source/next-hop scope and checks the selected subnet contains the target", async () => {
    const item = {
      ...row(),
      targetAddress: "2001:0db8:abcd:0:0:0:0:9",
      sourceAddress: "2001:db8:abcd::2",
      addressFamily: "IPv6",
      destinationPrefix: "2001:0db8:abcd::/48",
      nextHop: "fe80::1%12",
    };
    const result = await reader(
      async () => JSON.stringify({ before: [item], after: [{ ...item, nextHop: "fe80:0:0:0:0:0:0:1%12" }] }),
      { addresses: ["2001:db8:abcd::9"] },
    ).read();
    expect(result).toMatchObject({
      available: true,
      selections: [
        {
          targetAddress: "2001:db8:abcd::9",
          addressFamily: "ipv6",
          destinationPrefix: "2001:db8:abcd::/48",
          nextHop: "fe80::1",
        },
      ],
    });
  });

  it("accepts a specific host route, not just default routes", async () => {
    const data = response();
    data.before[0].destinationPrefix = data.after[0].destinationPrefix = "203.0.113.9/32";
    expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({
      available: true,
      selections: [{ destinationPrefix: "203.0.113.9/32" }],
    });
  });

  it.each([
    "sourceAddress",
    "interfaceGuid",
    "nextHop",
    "routeMetric",
    "interfaceMetric",
    "hardwareInterface",
    "adapterStatus",
    "destinationPrefix",
  ])("rejects %s changes during the batch", async (field) => {
    const data = response();
    const alternatives: Record<string, unknown> = {
      sourceAddress: "192.0.2.11",
      interfaceGuid: "abcd0002-0002-0003-0004-000000000005",
      nextHop: "192.0.2.2",
      routeMetric: 5,
      interfaceMetric: 21,
      hardwareInterface: false,
      adapterStatus: "Down",
      destinationPrefix: "203.0.113.0/24",
    };
    Object.assign(data.after[0], { [field]: alternatives[field] });
    expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({
      available: false,
      reason: "READ_UNAVAILABLE",
    });
  });

  it("represents a later stable route change with a new selection hash instead of returning cached routes", async () => {
    const data = response(),
      run = vi.fn(async () => JSON.stringify(data)),
      current = reader(run);
    const first = await current.read();
    data.before[0].nextHop = data.after[0].nextHop = "192.0.2.2";
    const second = await current.read();
    expect(first.available && second.available).toBe(true);
    if (first.available && second.available) {
      expect(first.scopeHash).toBe(second.scopeHash);
      expect(first.selectionHash).not.toBe(second.selectionHash);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("normalizes input ordering and output ordering without losing any target", async () => {
    const first = row(),
      second = { ...row(), targetAddress: "203.0.113.10" };
    const current = reader(async () => JSON.stringify({ before: [first, second], after: [second, first] }), {
      addresses: ["203.0.113.10", "203.0.113.9"],
    });
    const result = await current.read();
    expect(result).toMatchObject({ available: true });
    if (result.available) expect(result.selections).toHaveLength(2);
  });

  it.each([
    {},
    { addresses: [] },
    { addresses: Array.from({ length: 17 }, (_, i) => `203.0.113.${i + 1}`) },
    { addresses: ["203.0.113.9", "203.0.113.9"] },
    { addresses: ["2001:db8::1", "2001:0db8:0:0:0:0:0:1"] },
    { addresses: ["example.invalid"] },
    { addresses: ["https://example.invalid/"] },
    { addresses: ["203.0.113.9; Get-Secret"] },
    { addresses: ["0.0.0.0"] },
    { addresses: ["::"] },
    { addresses: ["224.0.0.1"] },
    { addresses: ["255.255.255.255"] },
    { addresses: ["fe80::1"] },
    { addresses: ["fe80::1%12"] },
    { addresses: ["ff02::1"] },
    { addresses: ["::ffff:192.0.2.1"] },
    { addresses: [203001139] },
    { addresses: scope.addresses, command: "custom" },
  ])("rejects invalid IP-only scope %# before starting a child", (invalid) => {
    expect(() => new WindowsRouteSelectionReader(invalid as WindowsRouteSelectionScope)).toThrow(
      /^WINDOWS_ROUTE_SCOPE_INVALID$/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    { sourceAddress: "::" },
    { sourceAddress: "2001:db8::2" },
    { nextHop: "2001:db8::1" },
    { interfaceGuid: "not-a-guid" },
    { interfaceGuid: `{${GUID}` },
    { interfaceGuid: `${GUID}}` },
    { interfaceGuid: "00000000-0000-0000-0000-000000000000" },
    { interfaceIndex: 0 },
    { routeMetric: -1 },
    { interfaceMetric: "20" },
    { hardwareInterface: "true" },
    { adapterStatus: "surprise" },
    { routeState: "unknown" },
    { interfaceConnection: "unknown" },
    { destinationPrefix: "203.0.113.1/24" },
    { destinationPrefix: "203.0.114.0/24" },
    { destinationPrefix: "2001:db8::/64" },
    { destinationPrefix: "0.0.0.0/33" },
    { destinationPrefix: "0.0.0.0/00" },
    { targetAddress: "198.51.100.9" },
    { sourceAddress: "192.0.2.1%12" },
    { secret: "synthetic-secret" },
  ])("rejects malformed/unknown/irrelevant route records %#", async (overrides) => {
    const item = { ...row(), ...overrides };
    const result = await reader(async () => JSON.stringify({ before: [item], after: [item] })).read();
    expect(result).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toMatch(/203\.0\.113|192\.0\.2|synthetic-secret/);
  });

  it("rejects wrong IPv6 scope, inconsistent route family and invalid IPv6 prefixes", async () => {
    for (const changed of [
      { nextHop: "fe80::1%15" },
      { destinationPrefix: "::/129" },
      { destinationPrefix: "2001:db8::1/64" },
    ]) {
      const item = {
        ...row(),
        targetAddress: "2001:db8::9",
        sourceAddress: "2001:db8::2",
        addressFamily: "IPv6",
        nextHop: "fe80::1%12",
        destinationPrefix: "::/0",
        ...changed,
      };
      expect(
        await reader(async () => JSON.stringify({ before: [item], after: [item] }), {
          addresses: ["2001:db8::9"],
        }).read(),
      ).toMatchObject({ available: false });
    }
  });

  it.each(["missing", "duplicate", "extra", "too many", "unknown envelope"])(
    "rejects %s result sets",
    async (kind) => {
      let data: unknown = response();
      if (kind === "missing") data = { before: [], after: [row()] };
      if (kind === "duplicate") data = { before: [row(), row()], after: [row(), row()] };
      if (kind === "extra")
        data = { before: [row(), { ...row(), targetAddress: "198.51.100.8" }], after: [row()] };
      if (kind === "too many") data = { before: Array(17).fill(row()), after: [row()] };
      if (kind === "unknown envelope") data = { ...response(), secret: "synthetic-secret" };
      expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({ available: false });
    },
  );
});

describe("WindowsRouteSelectionReader execution and cancellation", () => {
  it("uses one fixed hidden bounded PowerShell command and passes addresses only as stdin data", async () => {
    let input = "";
    const once = vi.fn();
    execFileMock.mockImplementation((_exe, _args, _options, callback) => ({
      stdin: {
        once,
        end: (value: string) => {
          input = value;
          callback(null, JSON.stringify(response()));
        },
      },
      kill: vi.fn(),
    }));
    const current = new WindowsRouteSelectionReader(scope);
    instances.push(current);
    expect(await current.read()).toMatchObject({ available: true });
    const [binary, args, options] = execFileMock.mock.calls[0];
    expect(binary.toLowerCase()).toMatch(/windowspowershell.*powershell.exe$/);
    expect(options).toMatchObject({
      windowsHide: true,
      shell: false,
      timeout: 10000,
      maxBuffer: 384 * 1024,
      signal: expect.any(AbortSignal),
    });
    expect(args.join(" ")).toContain("Find-NetRoute");
    expect(args.join(" ")).toContain("Get-NetAdapter");
    expect(args.join(" ")).toContain("Get-NetIPInterface");
    expect(args.join(" ")).not.toContain("203.0.113.9");
    expect(args.join(" ")).not.toMatch(/Set-Net|New-Net|Remove-Net|Invoke-Expression|Start-Process/);
    expect(JSON.parse(input)).toEqual(scope);
  });

  it("shares active reads and cancels the whole joined batch, never publishing late route records", async () => {
    const gate = deferred<string>();
    let innerSignal: AbortSignal | undefined;
    const run = vi.fn((_input: string, signal: AbortSignal) => {
      innerSignal = signal;
      return gate.promise;
    });
    const current = reader(run),
      first = current.read(),
      cancel = new AbortController(),
      second = current.read(cancel.signal);
    expect(first).toBe(second);
    expect(run).toHaveBeenCalledOnce();
    cancel.abort(new Error("synthetic-secret"));
    expect(innerSignal?.aborted).toBe(true);
    const result = await first;
    expect(result).toMatchObject({ available: false, reason: "READ_CANCELLED" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(await current.read()).toEqual(result);
    expect(run).toHaveBeenCalledOnce();
    gate.resolve(JSON.stringify(response()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await current.read()).toMatchObject({ available: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not run for already-aborted callers or unsupported OS", async () => {
    const run = vi.fn(async () => JSON.stringify(response())),
      cancel = new AbortController();
    cancel.abort();
    expect(await reader(run).read(cancel.signal)).toMatchObject({
      available: false,
      reason: "READ_CANCELLED",
    });
    const other = new WindowsRouteSelectionReader(scope, { runner: run, platform: "linux" });
    instances.push(other);
    expect(await other.read()).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });

  it("times out a stalled adapter without overlapping another batch", async () => {
    const gate = deferred<string>(),
      run = vi.fn(() => gate.promise),
      current = reader(run, scope, 20);
    const result = await current.read();
    expect(result).toMatchObject({ available: false, reason: "READ_TIMEOUT" });
    expect(await current.read()).toEqual(result);
    expect(run).toHaveBeenCalledOnce();
    gate.resolve(JSON.stringify(response()));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("removes old caller abort subscriptions before the next successful batch", async () => {
    const cancel = new AbortController(),
      gate = deferred<string>();
    const run = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(response()))
      .mockImplementationOnce(() => gate.promise);
    const current = reader(run);
    expect(await current.read(cancel.signal)).toMatchObject({ available: true });
    const next = current.read();
    cancel.abort();
    gate.resolve(JSON.stringify(response()));
    expect(await next).toMatchObject({ available: true });
  });

  it("disposal cancels active work and prevents fresh reads", async () => {
    const gate = deferred<string>(),
      run = vi.fn(() => gate.promise),
      current = reader(run),
      pending = current.read();
    current.dispose();
    expect(await pending).toMatchObject({ available: false, reason: "DISPOSED" });
    expect(await current.read()).toMatchObject({ available: false, reason: "DISPOSED" });
    expect(run).toHaveBeenCalledOnce();
    const drained = vi.fn();
    void current.whenIdle().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    gate.resolve(JSON.stringify(response()));
    await current.whenIdle();
    expect(drained).toHaveBeenCalledOnce();
  });

  it.each(["oversized", "malformed", "exception"])(
    "rejects %s runner output without its raw error",
    async (kind) => {
      const current = reader(async () => {
        if (kind === "oversized") return " ".repeat(384 * 1024 + 1);
        if (kind === "malformed") return "synthetic-private-output";
        throw Error("synthetic-private-secret");
      });
      const result = await current.read();
      expect(result).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
    },
  );
});
