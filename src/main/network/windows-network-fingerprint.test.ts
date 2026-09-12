import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WindowsNetworkFingerprintReader,
  WindowsNetworkFingerprintWatcher,
  WindowsControllerLifecycleWatcher,
  type WindowsNetworkFingerprint,
} from "./windows-network-fingerprint";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

function configuration() {
  return {
    routes: [
      {
        index: 4,
        family: "IPv4",
        destination: "0.0.0.0/0",
        nextHop: "192.0.2.1",
        metric: 10,
        protocol: "NetMgmt",
        state: "Alive",
      },
      {
        index: 5,
        family: "IPv6",
        destination: "::/0",
        nextHop: "2001:db8::1",
        metric: 20,
        protocol: "NetMgmt",
        state: "Alive",
      },
    ],
    interfaces: [
      {
        index: 4,
        family: "IPv4",
        alias: "test-private-adapter",
        connection: "Connected",
        dhcp: "Enabled",
        forwarding: "Disabled",
        automaticMetric: "Enabled",
        metric: 25,
        mtu: 1_500,
      },
    ],
    dns: [{ index: 4, family: 2, servers: ["192.0.2.53", "192.0.2.54"] }],
  };
}

const address: NetworkInterfaceInfo = {
  family: "IPv4",
  address: "192.0.2.2",
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:01",
  internal: false,
  cidr: "192.0.2.2/24",
};

const addresses = () => ({ "test-private-adapter": [address] });
const UNAVAILABLE: WindowsNetworkFingerprint = { available: false, hash: null };
const A: WindowsNetworkFingerprint = { available: true, hash: "a".repeat(64) };
const B: WindowsNetworkFingerprint = { available: true, hash: "b".repeat(64) };
const watchers: WindowsNetworkFingerprintWatcher[] = [];
const lifecycles: WindowsControllerLifecycleWatcher[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function watcher(read: () => Promise<WindowsNetworkFingerprint>, debounceMs = 50) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const onChange = vi.fn();
  const instance = new WindowsNetworkFingerprintWatcher({
    reader: { read },
    onChange,
    pollMs: 100,
    debounceMs,
  });
  watchers.push(instance);
  return { instance, onChange };
}

afterEach(() => {
  for (const instance of lifecycles.splice(0)) instance.dispose();
  for (const instance of watchers.splice(0)) instance.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("WindowsNetworkFingerprintReader", () => {
  it("joins old work across both APIs with original observation time and unchanged legacy DTO", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const command = deferred<string>();
    const runner = vi.fn(() => command.promise);
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner,
      readInterfaces: addresses,
    });
    const legacy = reader.read();
    await vi.advanceTimersByTimeAsync(75);
    const observation = reader.readObservation();
    expect(reader.read()).toBe(legacy);
    expect(reader.readObservation()).toBe(observation);
    expect(runner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    command.resolve(JSON.stringify(configuration()));
    const result = await observation;
    expect(result).toMatchObject({ available: true, startedAtMono: 0, completedAtMono: 100 });
    expect(await legacy).toEqual({ available: true, hash: result.hash });
    expect(Object.keys(await legacy).sort()).toEqual(["available", "hash"]);
    await vi.advanceTimersByTimeAsync(50);
    const next = await reader.readObservation();
    expect(next).toMatchObject({ available: true, startedAtMono: 150, completedAtMono: 150 });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("shares an observation-first command with later legacy reads without creating another OS process", async () => {
    const command = deferred<string>();
    const runner = vi.fn(() => command.promise);
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner,
      readInterfaces: addresses,
    });
    const observation = reader.readObservation(),
      legacy = reader.read();
    expect(reader.read()).toBe(legacy);
    expect(runner).toHaveBeenCalledTimes(1);
    command.resolve(JSON.stringify(configuration()));
    expect((await legacy).hash).toBe((await observation).hash);
    expect(Object.isFrozen(await observation)).toBe(true);
  });

  it("retains the actual failed observation window without provider error data", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const command = deferred<string>();
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner: () => command.promise,
      readInterfaces: addresses,
    });
    const pending = reader.readObservation();
    await vi.advanceTimersByTimeAsync(50);
    command.resolve("private-invalid-output");
    expect(await pending).toEqual({ available: false, hash: null, startedAtMono: 0, completedAtMono: 50 });
    expect(await reader.read()).toEqual(UNAVAILABLE);
  });
  it("hashes stable configuration regardless of row/property order and exposes no raw network data", async () => {
    const source = configuration();
    const runner = vi.fn(async () => JSON.stringify(source));
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner,
      readInterfaces: addresses,
    });
    const first = await reader.read();
    source.routes.reverse();
    runner.mockResolvedValueOnce(
      JSON.stringify({ dns: source.dns, interfaces: source.interfaces, routes: source.routes }),
    );
    const second = await reader.read();
    expect(first).toEqual(second);
    expect(first).toEqual({ available: true, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.keys(first).sort()).toEqual(["available", "hash"]);
    expect(JSON.stringify(first)).not.toMatch(/192\.0\.2|private-adapter|2001:db8/);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each(["route", "interface", "dns priority", "local address"])(
    "changes its hash when %s changes",
    async (kind) => {
      const source = configuration();
      let currentAddress = address;
      const reader = new WindowsNetworkFingerprintReader({
        platform: "win32",
        runner: async () => JSON.stringify(source),
        readInterfaces: () => ({ adapter: [currentAddress] }),
      });
      const before = await reader.read();
      if (kind === "route") source.routes[0].nextHop = "192.0.2.3";
      if (kind === "interface") source.interfaces[0].connection = "Disconnected";
      if (kind === "dns priority") source.dns[0].servers.reverse();
      if (kind === "local address") currentAddress = { ...address, address: "192.0.2.9" };
      const after = await reader.read();
      expect(before.available).toBe(true);
      expect(after.available).toBe(true);
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it("shares concurrent reads and rejects address changes during the command", async () => {
    const command = deferred<string>();
    let currentAddress = address;
    const runner = vi.fn(() => command.promise);
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner,
      readInterfaces: () => ({ adapter: [currentAddress] }),
    });
    const first = reader.read();
    const second = reader.read();
    expect(second).toBe(first);
    expect(runner).toHaveBeenCalledTimes(1);
    currentAddress = { ...address, address: "192.0.2.8" };
    command.resolve(JSON.stringify(configuration()));
    expect(await first).toEqual(UNAVAILABLE);
    expect(await reader.read()).toMatchObject({ available: true });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("keeps an absent interface metric distinct from zero without inventing route priority", async () => {
    const source = configuration();
    let metric: number | null = null;
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      readInterfaces: addresses,
      runner: async () =>
        JSON.stringify({
          ...source,
          interfaces: source.interfaces.map((row) => ({ ...row, metric })),
        }),
    });
    const missing = await reader.read();
    metric = 0;
    const explicitZero = await reader.read();
    expect(missing.available).toBe(true);
    expect(explicitZero.available).toBe(true);
    expect(missing.hash).not.toBe(explicitZero.hash);
  });

  it.each([
    ["IPv4", "198.51.100.9/32"],
    ["IPv4", "198.51.100.0/24"],
    ["IPv6", "2001:db8:1::9/128"],
    ["IPv6", "2001:db8:1::/64"],
  ])(
    "changes hash for a specific %s target route %s while default routes stay unchanged",
    async (family, destination) => {
      const source = configuration();
      const defaults = structuredClone(source.routes);
      const reader = new WindowsNetworkFingerprintReader({
        platform: "win32",
        runner: async () => JSON.stringify(source),
        readInterfaces: addresses,
      });
      const baseline = await reader.read();
      const specific = { ...source.routes[family === "IPv4" ? 0 : 1], family, destination };
      source.routes.push(specific);
      const added = await reader.read();
      specific.metric++;
      const changed = await reader.read();
      source.routes.pop();
      const removed = await reader.read();
      expect(source.routes).toEqual(defaults);
      expect([baseline, added, changed, removed].every((sample) => sample.available)).toBe(true);
      expect(new Set([baseline.hash, added.hash, changed.hash]).size).toBe(3);
      expect(removed).toEqual(baseline);
    },
  );

  it.each([
    ["IPv4", "192.0.2.0/33"],
    ["IPv6", "2001:db8::/129"],
    ["IPv4", "2001:db8::/24"],
    ["IPv6", "192.0.2.0/24"],
    ["IPv4", "192.0.2.0/024"],
    ["IPv4", "192.0.2.0/-1"],
    ["IPv4", "192.0.2.0/24/0"],
    ["IPv6", "fe80::%adapter/64"],
    ["IPv4", "not-an-address/0"],
  ])("rejects malformed or family-mismatched destination %s %s", async (family, destination) => {
    const source = configuration();
    source.routes[0] = { ...source.routes[0], family, destination };
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner: async () => JSON.stringify(source),
      readInterfaces: addresses,
    });
    expect(await reader.read()).toEqual(UNAVAILABLE);
  });

  it("fails closed when the complete route table exceeds the bounded row count", async () => {
    const source = configuration();
    source.routes = Array.from({ length: 1_025 }, () => ({ ...source.routes[0] }));
    const raw = JSON.stringify(source);
    expect(Buffer.byteLength(raw)).toBeLessThan(256 * 1024);
    const reader = new WindowsNetworkFingerprintReader({
      platform: "win32",
      runner: async () => raw,
      readInterfaces: addresses,
    });
    expect(await reader.read()).toEqual(UNAVAILABLE);
  });

  it.each(["malformed", "oversized", "error", "missing field"])(
    "returns only unavailable for %s output",
    async (kind) => {
      const reader = new WindowsNetworkFingerprintReader({
        platform: "win32",
        readInterfaces: addresses,
        runner: async () => {
          if (kind === "error") throw new Error("private-command-detail 192.0.2.53");
          if (kind === "oversized") return " ".repeat(256 * 1024 + 1);
          if (kind === "missing field") return JSON.stringify({ routes: [], interfaces: [] });
          return "private-invalid-json 192.0.2.53";
        },
      });
      expect(await reader.read()).toEqual(UNAVAILABLE);
    },
  );

  it("does not launch PowerShell on unsupported platforms", async () => {
    const runner = vi.fn();
    const reader = new WindowsNetworkFingerprintReader({ platform: "linux", runner });
    expect(await reader.read()).toEqual(UNAVAILABLE);
    expect(runner).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses a fixed hidden command with timeout and buffer caps, discarding OS errors", async () => {
    execFileMock.mockImplementation(
      (_exe, _args, _options, callback: (error: Error | null, stdout: string) => void) => {
        callback(new Error("private-timeout-detail"), "private-partial-output");
      },
    );
    const reader = new WindowsNetworkFingerprintReader({ platform: "win32", readInterfaces: addresses });
    expect(await reader.read()).toEqual(UNAVAILABLE);
    const [executable, args, options] = execFileMock.mock.calls[0];
    expect(executable).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).toContain("Get-NetRoute -PolicyStore ActiveStore");
    expect(args[4]).not.toContain("Where-Object");
    expect(args[4]).toContain("Get-NetIPInterface -PolicyStore ActiveStore");
    expect(args[4]).toContain("Get-DnsClientServerAddress");
    expect(args[4]).not.toMatch(/\b(?:Set|Remove|New)-Net|Invoke-|Start-Process/);
    expect(options).toMatchObject({
      windowsHide: true,
      shell: false,
      timeout: 8_000,
      maxBuffer: 768 * 1024,
      encoding: "utf8",
    });
  });
});

describe("WindowsNetworkFingerprintWatcher", () => {
  it("confirms startup after one second, then returns to the normal five-second poll", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const read = vi.fn(async () => A);
    const instance = new WindowsNetworkFingerprintWatcher({ reader: { read }, onChange: vi.fn() });
    watchers.push(instance);
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(instance.getSnapshot()).toEqual(A);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("starts unavailable and requires two equal reads after debounce; unchanged reads do not re-emit", async () => {
    const read = vi.fn(async () => A);
    const { instance, onChange } = watcher(read);
    instance.start();
    expect(onChange.mock.calls).toEqual([[UNAVAILABLE]]);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(A);
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange.mock.calls).toEqual([[UNAVAILABLE], [A]]);
  });

  it("invalidates immediately on route changes and debounces recovery rather than revocation", async () => {
    let current = A;
    const { instance, onChange } = watcher(async () => current, 200);
    instance.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(instance.getSnapshot()).toEqual(A);
    current = B;
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    current = A;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(A);
    expect(onChange.mock.calls).toEqual([[UNAVAILABLE], [A], [UNAVAILABLE], [A]]);
  });

  it("invalidates on read rejection and does not recover from one successful sample", async () => {
    let failed = false;
    const { instance } = watcher(async () => {
      if (failed) throw new Error("private-OS-error");
      return A;
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(instance.getSnapshot()).toEqual(A);
    failed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    failed = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(49);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.getSnapshot()).toEqual(A);
  });

  it("never overlaps reads and ignores a pending result from a previous start", async () => {
    const oldRead = deferred<WindowsNetworkFingerprint>();
    const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValue(A);
    const { instance, onChange } = watcher(read);
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    instance.stop();
    instance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    oldRead.resolve(B);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(200);
    expect(instance.getSnapshot()).toEqual(A);
    expect(onChange.mock.calls.flat()).not.toContainEqual(B);
    instance.stop();
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    const count = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(count);
  });
});

function owner(hash: string): WindowsControllerOwnerSnapshot {
  return {
    available: true,
    basis: "windows-controller-listener",
    startedAtMono: 0,
    completedAtMono: 1,
    scopeHash: "c".repeat(64),
    owner: { pid: 4, createdAtTicks: "638990000000000000", executablePathIdentity: null },
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port: 9790, coverage: "exact" }],
    kernelEpoch: hash,
  };
}

describe("WindowsControllerLifecycleWatcher", () => {
  it("binds readiness to the current endpoint even before its next polling tick", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let url = "http://127.0.0.1:9790";
    const first = { read: vi.fn(async () => owner(A.hash!)), dispose: vi.fn() };
    const second = { read: vi.fn(async () => owner(B.hash!)), dispose: vi.fn() };
    const createReader = vi.fn((target: string) => (target === "http://127.0.0.1:9790" ? first : second));
    const changed = vi.fn();
    const instance = new WindowsControllerLifecycleWatcher({
      getControllerUrl: () => url,
      onChange: changed,
      createReader,
      pollMs: 100,
      debounceMs: 50,
    });
    lifecycles.push(instance);
    instance.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(A);
    url = "http://127.0.0.1:9791";
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    instance.configurationChanged();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.read).toHaveBeenCalledTimes(1);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(B);
    expect(changed.mock.calls.flat().at(-1)).toEqual(B);
  });

  it("ignores a pending owner result when settings change during await without a callback", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let url = "http://127.0.0.1:9790";
    const old = deferred<WindowsControllerOwnerSnapshot>();
    const first = { read: vi.fn(() => old.promise), dispose: vi.fn() };
    const second = { read: vi.fn(async () => owner(B.hash!)), dispose: vi.fn() };
    const changed = vi.fn();
    const instance = new WindowsControllerLifecycleWatcher({
      getControllerUrl: () => url,
      onChange: changed,
      createReader: (target) => (target === "http://127.0.0.1:9790" ? first : second),
      pollMs: 100,
      debounceMs: 50,
    });
    lifecycles.push(instance);
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    url = "http://127.0.0.1:9791";
    old.resolve(owner(A.hash!));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    expect(changed.mock.calls.flat()).not.toContainEqual(A);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(B);
  });

  it("cannot revive an old reader when the endpoint changes away and back during its await", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let url = "http://127.0.0.1:9790";
    const old = deferred<WindowsControllerOwnerSnapshot>();
    const first = { read: vi.fn(() => old.promise), dispose: vi.fn() };
    const next = { read: vi.fn(async () => owner(B.hash!)), dispose: vi.fn() };
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(next);
    const changed = vi.fn();
    const instance = new WindowsControllerLifecycleWatcher({
      getControllerUrl: () => url,
      onChange: changed,
      createReader: factory,
      pollMs: 100,
      debounceMs: 50,
    });
    lifecycles.push(instance);
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    url = "http://127.0.0.1:9791";
    instance.configurationChanged();
    url = "http://127.0.0.1:9790";
    instance.configurationChanged();
    old.resolve(owner(A.hash!));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    expect(changed.mock.calls.flat()).not.toContainEqual(A);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(B);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(next.read).toHaveBeenCalledTimes(2);
  });

  it("revokes on owner loss and on same-endpoint process restart and requires two new matching samples", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let current: WindowsControllerOwnerSnapshot = owner(A.hash!);
    const reader = { read: vi.fn(async () => current), dispose: vi.fn() };
    const instance = new WindowsControllerLifecycleWatcher({
      getControllerUrl: () => "http://127.0.0.1:9790",
      onChange: vi.fn(),
      createReader: () => reader,
      pollMs: 100,
      debounceMs: 50,
    });
    lifecycles.push(instance);
    instance.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(instance.getSnapshot()).toEqual(A);
    current = { available: false, startedAtMono: 0, completedAtMono: 1, reason: "READ_UNAVAILABLE" };
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    current = owner(A.hash!);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(50);
    expect(instance.getSnapshot()).toEqual(A);
    current = owner(B.hash!);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(100);
    expect(instance.getSnapshot()).toEqual(B);
    instance.dispose();
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
    instance.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(instance.getSnapshot()).toEqual(UNAVAILABLE);
  });
});
