import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsSystemHostsReader } from "./windows-system-hosts";

const io = vi.hoisted(() => ({ open: vi.fn(), lstat: vi.fn(), realpath: vi.fn(), data: Buffer.alloc(0) }));
vi.mock("node:fs/promises", () => ({ open: io.open, lstat: io.lstat, realpath: io.realpath }));
const instances: WindowsSystemHostsReader[] = [];
const selected = "C:\\fixture\\hosts";
const target = "api.bilibili.com";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function stat(data = io.data) {
  return {
    dev: 1n,
    ino: 8n,
    size: BigInt(data.length),
    mtimeNs: 100n,
    ctimeNs: 100n,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}
function file(data = Buffer.from(io.data)) {
  return {
    stat: vi.fn(async () => stat(data)),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: data.copy(buffer, offset, position, position + length),
    })),
    close: vi.fn(async () => undefined),
  };
}
function reader(options: ConstructorParameters<typeof WindowsSystemHostsReader>[0] = {}) {
  const value = new WindowsSystemHostsReader({ hostsPath: selected, platform: "win32", ...options });
  instances.push(value);
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  io.data = Buffer.from("# synthetic comments\r\n127.0.0.1 localhost\r\n");
  io.realpath.mockImplementation(async (value: string) => value);
  io.lstat.mockImplementation(async () => stat());
  io.open.mockImplementation(async (_value, flags) => {
    expect(flags).toBe("r");
    return file();
  });
});
afterEach(() => {
  instances.splice(0).forEach((instance) => instance.dispose());
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("WindowsSystemHostsReader exact current file targets", () => {
  it("maps every exact alias and both families, normalizes case/dot, and emits no unrelated contents", async () => {
    io.data = Buffer.from(
      [
        "\uFEFF# 私密注释不出报告",
        "192.0.2.8 API.BILIBILI.COM. unrelated.secret.test # private-token=fixture",
        "192.0.2.8 api.bilibili.com",
        "192.0.2.9 canonical.private.test api.bilibili.com",
        "2001:0DB8:0:0::8 api.bilibili.com",
        "0.0.0.0 blocked.example.com",
        "127.0.0.1 localhost",
      ].join("\r\n"),
    );
    const current = reader();
    const output = await current.read([
      "API.BILIBILI.COM.",
      target,
      "absent.example.com",
      "blocked.example.com",
    ]);
    expect(output).toMatchObject({
      available: true,
      kind: "windows-system-hosts-targets",
      source: "explicit-test-hosts-file",
      resolutionProven: false,
      fileHash: sha(io.data),
      hosts: [
        { host: "absent.example.com", ipv4: [], ipv6: [] },
        { host: target, ipv4: ["192.0.2.8", "192.0.2.9"], ipv6: ["2001:db8::8"] },
        { host: "blocked.example.com", ipv4: ["0.0.0.0"], ipv6: [] },
      ],
    });
    if (!output.available) throw Error("fixture failed");
    expect(output.fileIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(output.scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.completedAtMono).toBeGreaterThanOrEqual(output.startedAtMono);
    expect(Object.isFrozen(output.hosts[1].ipv4)).toBe(true);
    for (const secret of [selected, "private-token", "unrelated.secret", "canonical.private", "私密注释"])
      expect(JSON.stringify(output)).not.toContain(secret);
    expect(io.open).toHaveBeenCalledTimes(2);
    await current.whenIdle();
  });
  it("uses only the fixed SystemRoot location by default and labels it separately from tests", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const current = reader({ hostsPath: undefined });
    expect(await current.read([target])).toMatchObject({
      available: true,
      source: "windows-system-hosts-file",
    });
    expect(io.open.mock.calls.map(([value]) => value)).toEqual([
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
    ]);
  });
  it.each([
    "",
    "relative",
    "\\\\server\\Windows",
    "\\\\?\\C:\\Windows",
    "C:\\Windows:stream",
    "C:\\bad.\\Windows",
  ])("refuses an ambiguous/unavailable SystemRoot without reading a substitute: %s", async (value) => {
    vi.stubEnv("SystemRoot", value);
    expect(await reader({ hostsPath: undefined }).read([target])).toMatchObject({
      available: false,
      reason: "PATH_UNAVAILABLE",
    });
    expect(io.open).not.toHaveBeenCalled();
  });
  it("does not inspect files on unsupported platforms", async () => {
    expect(await reader({ platform: "linux" }).read([target])).toMatchObject({
      reason: "UNSUPPORTED_PLATFORM",
    });
    expect(io.realpath).not.toHaveBeenCalled();
  });
  it.each([
    [],
    Array(65).fill(target),
    ["api.bilibili.com/path"],
    ["*.bilibili.com"],
    ["127.0.0.1"],
    ["api.bilibili.com.."],
    ["api.bilibili.com\n"],
    ["localhost"],
  ])("refuses invalid or excessive target scope %j", async (hosts) => {
    expect(await reader().read(hosts)).toMatchObject({ available: false, reason: "INPUT_INVALID" });
    expect(io.open).not.toHaveBeenCalled();
  });
  it("normalizes IDN target input to its literal ASCII file alias", async () => {
    io.data = Buffer.from("192.0.2.1 xn--fsqu00a.xn--0zwm56d\n");
    expect(await reader().read(["例子.测试"])).toMatchObject({
      available: true,
      hosts: [{ host: "xn--fsqu00a.xn--0zwm56d", ipv4: ["192.0.2.1"], ipv6: [] }],
    });
  });
  it.each([Buffer.alloc(0), Buffer.from("# comments only\r\n\t# optional empty file\r\n")])(
    "accepts a verified empty or comment-only file as no target entries",
    async (bytes) => {
      io.data = bytes;
      expect(await reader().read([target])).toMatchObject({
        available: true,
        fileHash: sha(bytes),
        hosts: [{ host: target, ipv4: [], ipv6: [] }],
      });
    },
  );
  it.each([
    "include another-file",
    "192.0.2.1 *.example.com",
    "192.0.2.1/32 unrelated.example.com",
    "192.0.2.1 unrelated.example.com ; ignored?",
    "192.0.2.1 例子.测试",
    "192.0.2.1",
    "fe80::1%12 unrelated.example.com",
    "192.168.001.1 unrelated.example.com",
    "192.0.2.1 unrelated.example.com\0",
  ])("refuses unknown syntax even when the questionable line is unrelated: %s", async (line) => {
    io.data = Buffer.from(line);
    const result = await reader().read([target]);
    expect(result).toMatchObject({ available: false, reason: "SYNTAX_UNVERIFIED" });
    expect(JSON.stringify(result)).not.toContain(line);
  });
  it.each([Buffer.from([0xff, 0xfe, 0x41, 0x00]), Buffer.from([0xc0, 0xaf])])(
    "refuses unreviewed/broken encodings",
    async (data) => {
      io.data = data;
      expect(await reader().read([target])).toMatchObject({ available: false, reason: "SYNTAX_UNVERIFIED" });
    },
  );
  it("does not treat missing/unreadable files as empty", async () => {
    io.open.mockRejectedValue(Error("private path and OS message"));
    const output = await reader().read([target]);
    expect(output).toMatchObject({ available: false, reason: "FILE_UNAVAILABLE" });
    expect(JSON.stringify(output)).not.toContain("private");
  });
  it("refuses a symlink or canonical directory redirection", async () => {
    io.lstat.mockResolvedValueOnce({ ...stat(), isSymbolicLink: () => true });
    expect(await reader().read([target])).toMatchObject({ reason: "PATH_UNAVAILABLE" });
    io.realpath.mockResolvedValueOnce("C:\\other\\hosts");
    expect(await reader().read([target])).toMatchObject({ reason: "PATH_UNAVAILABLE" });
    expect(io.open).not.toHaveBeenCalled();
  });
  it("compares file content twice even when stat identity does not change", async () => {
    io.data = Buffer.from(`192.0.2.1 ${target}\n`);
    io.open.mockResolvedValueOnce(file()).mockResolvedValueOnce(file(Buffer.from(`192.0.2.2 ${target}\n`)));
    expect(await reader().read([target])).toMatchObject({ reason: "FILE_CHANGED" });
  });
  it("rejects replacement/in-place modification and closes the opened handle", async () => {
    const handle = file();
    handle.stat.mockResolvedValueOnce(stat()).mockResolvedValueOnce({ ...stat(), mtimeNs: 101n });
    io.open.mockResolvedValueOnce(handle);
    expect(await reader().read([target])).toMatchObject({ reason: "FILE_CHANGED" });
    expect(handle.close).toHaveBeenCalledOnce();
  });
  it("refuses a file exceeding the byte bound before allocating/reading its contents", async () => {
    const oversized = { ...stat(), size: 1048577n };
    const handle = file();
    io.lstat.mockResolvedValueOnce(oversized);
    handle.stat.mockResolvedValue(oversized);
    io.open.mockResolvedValueOnce(handle);
    expect(await reader().read([target])).toMatchObject({ reason: "FILE_TOO_LARGE" });
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });
  it("bounds per-target mapping cardinality instead of returning a truncated subset", async () => {
    io.data = Buffer.from(Array.from({ length: 129 }, (_, index) => `192.0.2.${index} ${target}`).join("\n"));
    expect(await reader().read([target])).toMatchObject({ reason: "FILE_TOO_LARGE" });
  });
  it.each(["invalidate", "dispose"] as const)(
    "%s returns promptly but whenIdle waits for the actual opened-file work",
    async (action) => {
      const wait = deferred<ReturnType<typeof file>>();
      io.open.mockImplementationOnce(() => wait.promise);
      const current = reader(),
        pending = current.read([target]);
      await tick();
      current[action]();
      expect(await pending).toMatchObject({ reason: action === "dispose" ? "DISPOSED" : "INVALIDATED" });
      const done = vi.fn(),
        idle = current.whenIdle().then(done);
      await tick();
      expect(done).not.toHaveBeenCalled();
      expect((await current.read([target])).available).toBe(false);
      expect(io.open).toHaveBeenCalledOnce();
      const handle = file();
      wait.resolve(handle);
      await idle;
      expect(done).toHaveBeenCalledOnce();
      expect(handle.close).toHaveBeenCalledOnce();
      expect(handle.read).not.toHaveBeenCalled();
      if (action === "invalidate") expect((await current.read([target])).available).toBe(true);
    },
  );
  it("shares a normalized scope, refuses other scopes while busy, and joined abort cancels the real batch", async () => {
    const wait = deferred<string>();
    io.realpath.mockImplementationOnce(() => wait.promise);
    const current = reader(),
      abort = new AbortController(),
      pending = current.read([target]);
    expect(current.read(["API.BILIBILI.COM."], abort.signal)).toBe(pending);
    expect(await current.read(["other.example.com"])).toMatchObject({ reason: "READ_BUSY" });
    abort.abort();
    expect(await pending).toMatchObject({ reason: "READ_CANCELLED" });
    const done = vi.fn(),
      idle = current.whenIdle().then(done);
    await tick();
    expect(done).not.toHaveBeenCalled();
    wait.resolve(selected);
    await idle;
    expect(io.open).not.toHaveBeenCalled();
  });
  it("timeouts retain real I/O and pre-aborted requests never start or cancel a running read", async () => {
    const wait = deferred<string>();
    io.realpath.mockImplementationOnce(() => wait.promise);
    const current = reader({ timeoutMs: 20 }),
      pending = current.read([target]);
    const abort = new AbortController();
    abort.abort();
    expect(await current.read([target], abort.signal)).toMatchObject({ reason: "READ_CANCELLED" });
    expect(await pending).toMatchObject({ reason: "READ_TIMEOUT" });
    const done = vi.fn(),
      idle = current.whenIdle().then(done);
    await tick();
    expect(done).not.toHaveBeenCalled();
    expect(io.realpath).toHaveBeenCalledOnce();
    wait.resolve(selected);
    await idle;
    expect(done).toHaveBeenCalledOnce();
    expect(io.open).not.toHaveBeenCalled();
  });
});
