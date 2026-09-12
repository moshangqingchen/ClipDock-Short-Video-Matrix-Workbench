import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsProxyStateReader } from "./windows-proxy-state";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
const readers: WindowsProxyStateReader[] = [];
function pass() {
  return {
    api: { manual: false, pac: false, autoDetect: false },
    registry: {
      keyExists: true,
      manual: false as boolean | null,
      pac: false,
      autoDetect: null as boolean | null,
    },
    network: {
      adapters: [{ index: 12, description: "Physical Ethernet", hardware: true, up: true }],
      interfaces: [{ index: 12, family: "IPv4", connected: true }],
      routes: [
        { index: 12, family: "IPv4", destination: "0.0.0.0/0", nextHop: "192.168.7.1", state: "Alive" },
      ],
    },
  };
}
function output(value: unknown = pass()) {
  return JSON.stringify({ before: value, after: structuredClone(value) });
}
function reader(runner: (signal: AbortSignal) => Promise<string>, timeoutMs = 8000) {
  const item = new WindowsProxyStateReader({ runner, platform: "win32", timeoutMs });
  readers.push(item);
  return item;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function addVirtual(
  data: ReturnType<typeof pass>,
  description: string,
  destination = "10.10.0.0/16",
  nextHop = "0.0.0.0",
) {
  data.network.adapters.push({ index: 59, description, hardware: false, up: true });
  data.network.interfaces.push({ index: 59, family: "IPv4", connected: true });
  data.network.routes.push({ index: 59, family: "IPv4", destination, nextHop, state: "Alive" });
}
afterEach(async () => {
  for (const item of readers.splice(0)) item.dispose();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Windows proxy state current-user and OS evidence", () => {
  it("does not confuse automatic settings detection with an enabled proxy", async () => {
    const data = pass();
    data.api.autoDetect = true;
    data.registry.autoDetect = true;
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "inactive" });
    data.api.manual = true;
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "active" });
  });

  it("reports ordinary physical networking inactive without leaking addresses or adapter labels", async () => {
    const result = await reader(async () => output()).read();
    expect(result).toMatchObject({ state: "inactive", reasons: ["NO_PROXY_DETECTED"] });
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/192\.168|Ethernet|ProxyServer|AutoConfigURL/);
  });

  it.each(["key", "value"])(
    "distinguishes an unset registry %s from access failure when the current-user API confirms off",
    async (kind) => {
      const data = pass();
      data.registry.keyExists = kind !== "key";
      data.registry.manual = null;
      expect(await reader(async () => output(data)).read()).toMatchObject({ state: "inactive" });
    },
  );

  it.each(["api", "registry", "network"])(
    "returns unknown for an unreadable %s rather than pretending off",
    async (kind) => {
      const data = { ...pass(), [kind]: null };
      expect(await reader(async () => output(data)).read()).toMatchObject({
        state: "unknown",
        reasons: [kind === "network" ? "OS_NETWORK_UNAVAILABLE" : "SYSTEM_PROXY_UNAVAILABLE"],
      });
    },
  );

  it.each([
    ["manual", "SYSTEM_PROXY_ENABLED"],
    ["pac", "PAC_CONFIGURED"],
  ] as const)(
    "treats configured %s as active without fetching PAC or proving proxy use per target",
    async (field, reason) => {
      const data = pass();
      data.api[field] = true;
      expect(await reader(async () => output({ ...data, network: null })).read()).toMatchObject({
        state: "active",
        reasons: [reason],
      });
    },
  );

  it("retains enabled registry evidence even if the API failed and deduplicates overlapping observations", async () => {
    const data = pass();
    data.registry.manual = true;
    expect(await reader(async () => output({ ...data, api: null })).read()).toMatchObject({
      state: "active",
      reasons: ["SYSTEM_PROXY_ENABLED"],
    });
    data.api.manual = true;
    expect(await reader(async () => output(data)).read()).toMatchObject({
      state: "active",
      reasons: ["SYSTEM_PROXY_ENABLED"],
    });
  });

  it("uses the supplied current mihomo TUN flag without making its own HTTP request", async () => {
    const current = reader(async () => output());
    expect(await current.read({ mihomoTun: true })).toMatchObject({
      state: "active",
      reasons: ["MIHOMO_TUN_ENABLED"],
    });
    await current.whenIdle();
    expect(await current.read({ mihomoTun: false })).toMatchObject({ state: "inactive" });
    await current.whenIdle();
    expect(await current.read({ mihomoTun: null })).toMatchObject({
      state: "unknown",
      reasons: ["MIHOMO_TUN_UNKNOWN"],
    });
  });

  it.each([
    "Meta Tunnel",
    "Mihomo Tunnel",
    "WireGuard Tunnel",
    "Wintun Userspace Tunnel",
    "TAP-Windows Adapter V9",
  ])("recognizes an Up connected %s instead of examining process existence", async (description) => {
    const data = pass();
    addVirtual(data, description);
    expect(await reader(async () => output(data)).read()).toMatchObject({
      state: "active",
      reasons: ["ACTIVE_TUNNEL"],
    });
    data.network.adapters[1].up = false;
    data.network.interfaces[1].connected = false;
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "inactive" });
  });

  it("does not mistake an isolated Hyper-V private on-link adapter for a proxy", async () => {
    const data = pass();
    addVirtual(data, "Hyper-V Virtual Ethernet Adapter");
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "inactive" });
    data.network.routes[1].destination = "0.0.0.0/0";
    expect(await reader(async () => output(data)).read()).toMatchObject({
      state: "unknown",
      reasons: ["UNSUPPORTED_VIRTUAL_ROUTE"],
    });
  });

  it("does not turn an unrecognised private on-link tunnel into an off result", async () => {
    const data = pass();
    addVirtual(data, "Unidentified VPN Adapter");
    expect(await reader(async () => output(data)).read()).toMatchObject({
      state: "unknown",
      reasons: ["UNSUPPORTED_VIRTUAL_ROUTE"],
    });
  });

  it.each([
    ["0.0.0.0/1", "0.0.0.0"],
    ["203.0.113.0/24", "0.0.0.0"],
    ["10.10.0.0/16", "10.10.0.1"],
  ])("refuses unsupported virtual forwarding %s including split routes", async (destination, nextHop) => {
    const data = pass();
    addVirtual(data, "Unidentified Virtual Adapter", destination, nextHop);
    expect(await reader(async () => output(data)).read()).toMatchObject({
      state: "unknown",
      reasons: ["UNSUPPORTED_VIRTUAL_ROUTE"],
    });
  });

  it("inspects IPv6 defaults and ignores only actual local-only ranges", async () => {
    const data = pass();
    addVirtual(data, "Unidentified Adapter");
    data.network.interfaces[1].family = "IPv6";
    Object.assign(data.network.routes[1], { family: "IPv6", destination: "::/0", nextHop: "::" });
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "unknown" });
    data.network.routes[1].destination = "fe80::/64";
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "inactive" });
    data.network.routes[1].destination = "fe80::/1";
    expect(await reader(async () => output(data)).read()).toMatchObject({ state: "unknown" });
  });

  it("keeps an unclassified active routed interface without an adapter row unknown", async () => {
    const data = pass();
    data.network.adapters = [];
    expect(await reader(async () => output(data)).read()).toMatchObject({
      state: "unknown",
      reasons: ["UNSUPPORTED_VIRTUAL_ROUTE"],
    });
  });

  it("rejects changes between passes, but not harmless table enumeration reordering", async () => {
    const before = pass(),
      after = pass();
    after.api.manual = true;
    expect(await reader(async () => JSON.stringify({ before, after })).read()).toMatchObject({
      state: "unknown",
      reasons: ["SNAPSHOT_CHANGED"],
    });
    const unchanged = pass();
    addVirtual(unchanged, "Hyper-V Virtual Ethernet Adapter");
    const reordered = structuredClone(unchanged);
    reordered.network.adapters.reverse();
    reordered.network.interfaces.reverse();
    reordered.network.routes.reverse();
    expect(
      await reader(async () => JSON.stringify({ before: unchanged, after: reordered })).read(),
    ).toMatchObject({ state: "inactive" });
  });

  it.each(["field", "type", "oversize", "cidr", "duplicate"])(
    "does not accept malformed or incomplete %s evidence",
    async (kind) => {
      const data = pass();
      let raw: string;
      if (kind === "field") raw = output({ ...data, rawSecret: "do-not-return" });
      else if (kind === "type") raw = output({ ...data, api: { ...data.api, manual: "false" } });
      else if (kind === "oversize") raw = " ".repeat(384 * 1024 + 1);
      else {
        if (kind === "cidr") data.network.routes[0].destination = "::/0";
        else data.network.adapters.push({ ...data.network.adapters[0] });
        raw = output(data);
      }
      const result = await reader(async () => raw).read();
      expect(result.state).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("do-not-return");
    },
  );
});

describe("Windows proxy state actual read lifecycle", () => {
  it("shares one OS batch but never shares a stale caller TUN projection", async () => {
    const pending = deferred<string>();
    const run = vi.fn(() => pending.promise);
    const current = reader(run);
    const scope = { mihomoTun: false };
    const first = current.read(scope),
      second = current.read({ mihomoTun: true });
    scope.mihomoTun = true;
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    pending.resolve(output());
    expect(await first).toMatchObject({ state: "inactive" });
    expect(await second).toMatchObject({ state: "active", reasons: ["MIHOMO_TUN_ENABLED"] });
    await current.whenIdle();
  });

  it("timeout returns unknown while holding the real slot and whenIdle until an uncooperative reader ends", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const run = vi.fn(() => pending.promise);
    const current = reader(run, 20);
    const first = current.read();
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toMatchObject({ state: "unknown", reasons: ["READ_TIMEOUT"] });
    const idle = vi.fn();
    void current.whenIdle().then(idle);
    expect(await current.read()).toMatchObject({ reasons: ["READ_TIMEOUT"] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(idle).not.toHaveBeenCalled();
    pending.resolve(output());
    await current.whenIdle();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(await current.read()).toMatchObject({ state: "inactive" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("joined cancellation cancels the batch and late success never becomes inactive", async () => {
    const pending = deferred<string>();
    const run = vi.fn(() => pending.promise);
    const current = reader(run);
    const first = current.read();
    const stop = new AbortController();
    const second = current.read({}, stop.signal);
    await Promise.resolve();
    stop.abort();
    expect(await first).toMatchObject({ state: "unknown", reasons: ["READ_CANCELLED"] });
    expect(await second).toMatchObject({ state: "unknown", reasons: ["READ_CANCELLED"] });
    let idle = false;
    void current.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    pending.resolve(output());
    await current.whenIdle();
  });

  it("disposal drains already started work and forbids replacement reads", async () => {
    const pending = deferred<string>();
    const run = vi.fn(() => pending.promise);
    const current = reader(run);
    const result = current.read();
    await Promise.resolve();
    current.dispose();
    expect(await result).toMatchObject({ reasons: ["DISPOSED"] });
    expect(await current.read()).toMatchObject({ reasons: ["DISPOSED"] });
    pending.reject(new Error("private detail"));
    await current.whenIdle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not call the runner for invalid scopes, an already cancelled caller or unsupported OS", async () => {
    const run = vi.fn(async () => output());
    const current = reader(run);
    expect(await current.read({ mihomoTun: "off" } as never)).toMatchObject({ reasons: ["INPUT_INVALID"] });
    const stop = new AbortController();
    stop.abort();
    expect(await current.read({}, stop.signal)).toMatchObject({ reasons: ["READ_CANCELLED"] });
    const other = new WindowsProxyStateReader({ platform: "linux", runner: run });
    readers.push(other);
    expect(await other.read()).toMatchObject({ reasons: ["UNSUPPORTED_PLATFORM"] });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses fixed hidden read-only commands and waits for native close after an early execFile error", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    let callback!: (error: Error | null, stdout: string) => void;
    execFileMock.mockImplementation((_file, _args, _options, done) => {
      callback = done;
      return child;
    });
    const current = new WindowsProxyStateReader({ platform: "win32" });
    readers.push(current);
    const stopped = new AbortController();
    const result = current.read({}, stopped.signal);
    await vi.advanceTimersByTimeAsync(20);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toMatch(/WindowsPowerShell.*powershell\.exe$/);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).toContain("WinHttpGetIEProxyConfigForCurrentUser");
    expect(args[4]).toContain("GlobalFree");
    expect(args[4]).not.toMatch(/Set-Item|Set-Net|Invoke-WebRequest|Download|WinHttpGetProxyForUrl/);
    expect(options).toMatchObject({ windowsHide: true, shell: false, timeout: 8000, maxBuffer: 768 * 1024 });
    stopped.abort();
    callback(new Error("access denied with private path"), "");
    child.emit("error", new Error("private"));
    expect(await result).toMatchObject({ reasons: ["READ_CANCELLED"] });
    const idle = vi.fn();
    void current.whenIdle().then(idle);
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    child.emit("close", 1);
    await current.whenIdle();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
