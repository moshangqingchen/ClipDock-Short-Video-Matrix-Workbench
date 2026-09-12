import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsControllerOwnerReader, type WindowsControllerOwnerScope } from "./windows-controller-owner";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
const instances: WindowsControllerOwnerReader[] = [];
const scope = { controllerUrl: "http://127.0.0.1:9790" };
function owner() {
  return { pid: 401, createdAtTicks: "639244035457234678", executablePath: "C:\\Fixture\\kernel.exe" };
}
function listener() {
  return { ownerPid: 401, address: "127.0.0.1", port: 9790, state: "Listen" };
}
function pass() {
  return { owners: [owner()], listeners: [listener()] };
}
function response() {
  return { before: pass(), after: pass() };
}
function reader(
  run: (input: string, signal: AbortSignal) => Promise<string>,
  selected: WindowsControllerOwnerScope = scope,
  timeoutMs = 6000,
) {
  const current = new WindowsControllerOwnerReader(selected, { runner: run, platform: "win32", timeoutMs });
  instances.push(current);
  return current;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
afterEach(() => {
  instances.splice(0).forEach((current) => current.dispose());
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("WindowsControllerOwnerReader observed lifecycle", () => {
  it("binds a real listener to PID/start/path identity without publishing the raw executable path", async () => {
    const result = await reader(async () => JSON.stringify(response())).read();
    expect(result).toMatchObject({
      available: true,
      basis: "windows-controller-listener",
      owner: { pid: 401, createdAtTicks: owner().createdAtTicks },
      listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port: 9790, coverage: "exact" }],
    });
    if (!result.available) throw Error("fixture unavailable");
    expect(result.kernelEpoch).toMatch(/^[a-f0-9]{64}$/);
    expect(result.owner.executablePathIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.owner)).toBe(true);
    expect(Object.isFrozen(result.listeners)).toBe(true);
    expect(Object.isFrozen(result.listeners[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Fixture");
    expect(JSON.stringify(result)).not.toMatch(/binaryHash|version|DIRECT/);
  });

  it.each(["pid", "start", "path", "scope"])(
    "changes epoch when stable observed %s changes",
    async (kind) => {
      const original = await reader(async () => JSON.stringify(response())).read();
      const changed = response();
      for (const item of [changed.before, changed.after]) {
        if (kind === "pid") {
          item.owners[0].pid = 402;
          item.listeners[0].ownerPid = 402;
        }
        if (kind === "start") item.owners[0].createdAtTicks = "639244035457234679";
        if (kind === "path") item.owners[0].executablePath = "C:\\Fixture\\other.exe";
        if (kind === "scope") item.listeners[0].address = "0.0.0.0";
      }
      const next = await reader(async () => JSON.stringify(changed)).read();
      if (!original.available || !next.available) throw Error("fixture unavailable");
      expect(next.kernelEpoch).not.toBe(original.kernelEpoch);
    },
  );

  it.each(["pid", "start", "path", "scope", "owner exits"])(
    "refuses a %s change between passes",
    async (kind) => {
      const changed = response();
      if (kind === "pid") {
        changed.after.owners[0].pid = 402;
        changed.after.listeners[0].ownerPid = 402;
      }
      if (kind === "start") changed.after.owners[0].createdAtTicks = "639244035457234679";
      if (kind === "path") changed.after.owners[0].executablePath = "C:\\Fixture\\other.exe";
      if (kind === "scope") changed.after.listeners[0].address = "0.0.0.0";
      if (kind === "owner exits") changed.after.owners = [];
      expect(await reader(async () => JSON.stringify(changed)).read()).toMatchObject({
        available: false,
        reason: "READ_UNAVAILABLE",
      });
    },
  );

  it("normalizes Windows path spelling without calling it a binary hash", async () => {
    const data = response();
    data.after.owners[0].executablePath = "c:/fixture/KERNEL.exe";
    expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({ available: true });
  });

  it("retains stable PID/birth/listener lifecycle when the optional path identity is explicitly unknown", async () => {
    const data = response();
    for (const item of [data.before, data.after]) Object.assign(item.owners[0], { executablePath: null });
    const result = await reader(async () => JSON.stringify(data)).read();
    expect(result).toMatchObject({ available: true, owner: { pid: 401, executablePathIdentity: null } });
    if (!result.available) throw Error("fixture unavailable");
    expect(result.kernelEpoch).toMatch(/^[a-f0-9]{64}$/);
    const next = response();
    for (const item of [next.before, next.after])
      Object.assign(item.owners[0], {
        executablePath: null,
        createdAtTicks: "639244035457234679",
      });
    const changed = await reader(async () => JSON.stringify(next)).read();
    if (!changed.available) throw Error("fixture unavailable");
    expect(changed.kernelEpoch).not.toBe(result.kernelEpoch);
  });

  it("does not replace missing path fields with null or allow path readability to change inside a batch", async () => {
    const missing = response();
    Reflect.deleteProperty(missing.before.owners[0], "executablePath");
    expect(await reader(async () => JSON.stringify(missing)).read()).toMatchObject({ available: false });
    const changed = response();
    Object.assign(changed.after.owners[0], { executablePath: null });
    expect(await reader(async () => JSON.stringify(changed)).read()).toMatchObject({ available: false });
  });

  it.each([
    ["http://127.0.0.1:9790", "0.0.0.0", "ipv4"],
    ["http://[::1]:9790", "::", "ipv6"],
  ])("accepts only same-family wildcard coverage for %s", async (controllerUrl, address, family) => {
    const data = response();
    data.before.listeners[0].address = data.after.listeners[0].address = address;
    expect(await reader(async () => JSON.stringify(data), { controllerUrl }).read()).toMatchObject({
      available: true,
      listeners: [{ address, addressFamily: family, coverage: "same-family-wildcard" }],
    });
  });

  it("canonicalizes an exact IPv6 listener", async () => {
    const data = response();
    data.before.listeners[0].address = "0:0:0:0:0:0:0:1";
    data.after.listeners[0].address = "::1";
    expect(
      await reader(async () => JSON.stringify(data), { controllerUrl: "http://[::1]:9790" }).read(),
    ).toMatchObject({ available: true, listeners: [{ address: "::1", coverage: "exact" }] });
  });

  it("does not infer IPv4 dual-stack coverage from a sole :: listener", async () => {
    const data = response();
    data.before.listeners[0].address = data.after.listeners[0].address = "::";
    expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({ available: false });
  });

  it("allows same-owner IPv6 wildcard alongside proven IPv4 coverage, binding both observed scopes", async () => {
    const data = response();
    for (const item of [data.before, data.after]) item.listeners.push({ ...listener(), address: "::" });
    data.after.listeners.reverse();
    const result = await reader(async () => JSON.stringify(data)).read();
    if (!result.available) throw Error("fixture unavailable");
    expect(result.listeners).toContainEqual({
      address: "::",
      addressFamily: "ipv6",
      port: 9790,
      coverage: "cross-family-unverified",
    });
  });

  it.each(["wildcard", "cross-family", "unrelated owner", "unrelated row"])(
    "rejects %s ownership ambiguity",
    async (kind) => {
      const data = response();
      for (const item of [data.before, data.after]) {
        if (kind === "wildcard" || kind === "cross-family") {
          item.listeners.push({
            ...listener(),
            ownerPid: 402,
            address: kind === "wildcard" ? "0.0.0.0" : "::",
          });
          item.owners.push({ ...owner(), pid: 402 });
        }
        if (kind === "unrelated owner") item.owners[0].pid = 999;
        if (kind === "unrelated row") item.listeners.push({ ...listener(), address: "192.0.2.8" });
      }
      expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({ available: false });
    },
  );

  it.each([
    { ownerPid: 0 },
    { ownerPid: null },
    { port: 9791 },
    { port: "9790" },
    { port: 0 },
    { state: "Established" },
    { address: "localhost" },
    { address: "::ffff:127.0.0.1" },
    { address: "::1%1" },
    { address: "127.0.0.2" },
    { secret: "synthetic-private" },
  ])("rejects malformed/out-of-scope listener %j", async (change) => {
    const data = response();
    Object.assign(data.before.listeners[0], change);
    Object.assign(data.after.listeners[0], change);
    const result = await reader(async () => JSON.stringify(data)).read();
    expect(result).toMatchObject({ available: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });

  it.each([
    { pid: 0 },
    { pid: "401" },
    { createdAtTicks: null },
    { createdAtTicks: "0" },
    { createdAtTicks: "9999999999999999999" },
    { executablePath: "kernel.exe" },
    { executablePath: "/kernel.exe" },
    { executablePath: "C:\\Fixture\nsecret.exe" },
    { executablePath: "" },
    { credentials: "synthetic-private" },
  ])("rejects incomplete/malformed process identity %j", async (change) => {
    const data = response();
    Object.assign(data.before.owners[0], change);
    Object.assign(data.after.owners[0], change);
    expect(await reader(async () => JSON.stringify(data)).read()).toMatchObject({ available: false });
  });

  it.each(["none", "duplicate", "too many", "extra owner", "unknown envelope"])(
    "refuses %s records",
    async (kind) => {
      const data = response();
      for (const item of [data.before, data.after]) {
        if (kind === "none") item.listeners = [];
        if (kind === "duplicate") item.listeners.push(listener());
        if (kind === "too many") item.listeners = Array.from({ length: 65 }, listener);
        if (kind === "extra owner") item.owners.push({ ...owner(), pid: 999 });
      }
      const input = kind === "unknown envelope" ? { ...data, unknown: true } : data;
      expect(await reader(async () => JSON.stringify(input)).read()).toMatchObject({ available: false });
    },
  );
});

describe("WindowsControllerOwnerReader bounded command/lifecycle", () => {
  it.each([
    "http://localhost:9790",
    "http://127.1:9790",
    "http://2130706433:9790",
    "http://0x7f000001:9790",
    "http://127.0.0.2:9790",
    "http://192.168.1.1:9790",
    "https://127.0.0.1:9790",
    "http://127.0.0.1:9790/configs",
    "http://127.0.0.1:9790/?x=1",
    "http://127.0.0.1:9790/#x",
    "http://secret@127.0.0.1:9790",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://[::ffff:127.0.0.1]:9790",
    "http://[::1%251]:9790",
    "http://127.0.0.1:9790;Get-Process",
    " http://127.0.0.1:9790",
    "http://127.0.0.1:9790\n",
  ])("rejects non-literal or non-origin input %s before starting any process", (controllerUrl) => {
    expect(() => reader(async () => JSON.stringify(response()), { controllerUrl })).toThrow(
      "WINDOWS_CONTROLLER_SCOPE_INVALID",
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("normalizes explicit/default port 80 without accepting unrelated input fields", async () => {
    const data = response();
    for (const item of [data.before, data.after]) item.listeners[0].port = 80;
    const a = await reader(async () => JSON.stringify(data), { controllerUrl: "http://127.0.0.1" }).read();
    const b = await reader(async () => JSON.stringify(data), {
      controllerUrl: "http://127.0.0.1:80/",
    }).read();
    if (!a.available || !b.available) throw Error("fixture unavailable");
    expect(a.kernelEpoch).toBe(b.kernelEpoch);
    expect(() =>
      reader(async () => "", { ...scope, version: "fake-version" } as WindowsControllerOwnerScope),
    ).toThrow();
  });

  it("uses fixed hidden PowerShell with port/address only on stdin and no network/process mutations", async () => {
    let input = "";
    execFileMock.mockImplementation((_exe, _args, _options, callback) => ({
      stdin: {
        once: vi.fn(),
        end: (value: string) => {
          input = value;
          callback(null, JSON.stringify(response()));
        },
      },
      kill: vi.fn(),
    }));
    const current = new WindowsControllerOwnerReader(scope, { platform: "win32" });
    instances.push(current);
    expect(await current.read()).toMatchObject({ available: true });
    const [binary, args, options] = execFileMock.mock.calls[0];
    expect(binary.toLowerCase()).toMatch(/windowspowershell.*powershell.exe$/);
    expect(options).toMatchObject({
      windowsHide: true,
      shell: false,
      timeout: 6000,
      maxBuffer: 96 * 1024,
      signal: expect.any(AbortSignal),
    });
    expect(args.join(" ")).toContain("[ClipdockNativeTcpTable]::ReadListeners([int]$clipdockScope.port)");
    expect(args.join(" ")).toContain('DllImport("iphlpapi.dll"');
    expect(args.join(" ")).not.toContain("Get-NetTCPConnection");
    expect(args.join(" ")).toContain("GetProcessTimes");
    expect(args.join(" ")).toContain("QueryFullProcessImageNameW");
    expect(args.join(" ")).toContain("OpenProcess(0x1000, false, pid)");
    expect(args.join(" ")).toContain("finally { CloseHandle(handle); }");
    expect(args.join(" ")).not.toMatch(/SeDebug|AdjustTokenPrivileges|PROCESS_ALL_ACCESS/);
    expect(args.join(" ")).not.toContain("9790");
    expect(args.join(" ")).not.toMatch(
      /Set-Net|Remove-Net|New-Net|Invoke-Expression|Start-Process|Stop-Process/,
    );
    expect(JSON.parse(input)).toEqual({ address: "127.0.0.1", port: 9790 });
  });

  it("shares a batch, aborts all joined callers, and never publishes late identity or overlaps the runner", async () => {
    const work = deferred<string>();
    let signal: AbortSignal | undefined;
    const run = vi.fn((_input: string, received: AbortSignal) => {
      signal = received;
      return work.promise;
    });
    const current = reader(run),
      first = current.read(),
      abort = new AbortController(),
      second = current.read(abort.signal);
    expect(first).toBe(second);
    abort.abort("synthetic-private-reason");
    const result = await first;
    expect(result).toMatchObject({ available: false, reason: "READ_CANCELLED" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(signal?.aborted).toBe(true);
    expect(await current.read()).toEqual(result);
    expect(run).toHaveBeenCalledOnce();
    work.resolve(JSON.stringify(response()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await current.read()).toMatchObject({ available: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("times out without permitting overlapping work from an uncooperative adapter", async () => {
    const work = deferred<string>(),
      run = vi.fn(() => work.promise),
      current = reader(run, scope, 20);
    const result = await current.read();
    expect(result).toMatchObject({ available: false, reason: "READ_TIMEOUT" });
    expect(await current.read()).toEqual(result);
    expect(run).toHaveBeenCalledOnce();
    work.resolve(JSON.stringify(response()));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("does not let a pre-aborted caller join and cancel an existing read", async () => {
    const work = deferred<string>(),
      run = vi.fn(() => work.promise),
      current = reader(run),
      pending = current.read();
    const abort = new AbortController();
    abort.abort();
    expect(await current.read(abort.signal)).toMatchObject({ available: false, reason: "READ_CANCELLED" });
    work.resolve(JSON.stringify(response()));
    expect(await pending).toMatchObject({ available: true });
  });

  it("removes prior cancellation subscriptions before fresh reads", async () => {
    const abort = new AbortController(),
      work = deferred<string>();
    const run = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(response()))
      .mockImplementationOnce(() => work.promise);
    const current = reader(run);
    expect(await current.read(abort.signal)).toMatchObject({ available: true });
    const pending = current.read();
    abort.abort();
    work.resolve(JSON.stringify(response()));
    expect(await pending).toMatchObject({ available: true });
  });

  it("disposal aborts pending work and refuses every subsequent read", async () => {
    const work = deferred<string>(),
      run = vi.fn(() => work.promise),
      current = reader(run),
      pending = current.read();
    current.dispose();
    expect(await pending).toMatchObject({ available: false, reason: "DISPOSED" });
    expect(await current.read()).toMatchObject({ available: false, reason: "DISPOSED" });
    expect(run).toHaveBeenCalledOnce();
    const settled = vi.fn();
    const idle = current.whenIdle().then(settled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    work.resolve(JSON.stringify(response()));
    await idle;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("does not start a reader on unsupported OS", async () => {
    const run = vi.fn(async () => JSON.stringify(response()));
    const current = new WindowsControllerOwnerReader(scope, { runner: run, platform: "linux" });
    instances.push(current);
    expect(await current.read()).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["oversized", "malformed", "exception"])("refuses %s output without exposing it", async (kind) => {
    const result = await reader(async () => {
      if (kind === "oversized") return " ".repeat(96 * 1024 + 1);
      if (kind === "malformed") return "synthetic-private-contents";
      throw Error("synthetic-private-error");
    }).read();
    expect(result).toMatchObject({ available: false, reason: "READ_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });
});
