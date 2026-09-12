import { afterEach, describe, expect, it, vi } from "vitest";
import { executablePathIdentity } from "./connection-evidence";
import {
  WindowsTcpSocketReader,
  correlateControlledTcpSocket,
  type CdpTcpResponse,
  type ControlledTcpProbeWindow,
  type WindowsTcpSocketScope,
  type WindowsTcpSocketSnapshot,
} from "./windows-tcp-sockets";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const scope: WindowsTcpSocketScope = { ownerPids: [99], remotes: [{ address: "127.0.0.1", port: 4567 }] };
const owner = { pid: 99, createdAtTicks: "639000000000000000", executablePath: "D:\\fixture\\electron.exe" };
const row = {
  ownerPid: 99,
  sourceAddress: "127.0.0.1",
  sourcePort: 50000,
  remoteAddress: "127.0.0.1",
  remotePort: 4567,
  state: "Established",
};
const projectedOwner = {
  pid: owner.pid,
  createdAtTicks: owner.createdAtTicks,
  executablePathIdentity: executablePathIdentity(owner.executablePath)!,
};
function rawResponse() {
  return { before: [{ ...owner }], sockets: [{ ...row }], after: [{ ...owner }] };
}
function reader(runner: (input: string) => Promise<string>, selected = scope) {
  return new WindowsTcpSocketReader(selected, { platform: "win32", runner });
}
function baseline(): Extract<WindowsTcpSocketSnapshot, { available: true }> {
  return {
    available: true,
    startedAtMono: 1,
    completedAtMono: 2,
    scopeHash: "a".repeat(64),
    owners: [projectedOwner],
    sockets: [],
  };
}
function observed(): Extract<WindowsTcpSocketSnapshot, { available: true }> {
  return { ...baseline(), startedAtMono: 5, completedAtMono: 6, sockets: [{ ...row }] };
}
function controlled(): ControlledTcpProbeWindow {
  return {
    contextId: "isolated_context",
    generation: 2,
    startedAtMono: 0,
    completedAtMono: 7,
    completeOwnerScope: true,
    ownerTrafficExclusive: true,
    connectionPoolsDrainedBeforeBaseline: true,
    singleRequestWithoutPreconnect: true,
  };
}
function cdp(): CdpTcpResponse {
  return {
    remoteIPAddress: "127.0.0.1",
    remotePort: 4567,
    protocol: "http/1.1",
    connectionReused: false,
    fromDiskCache: false,
    fromServiceWorker: false,
    fromPrefetchCache: false,
    requestServedFromCache: false,
    requestStartedAtMono: 3,
    responseReceivedAtMono: 4,
  };
}

afterEach(() => vi.clearAllMocks());

describe("WindowsTcpSocketReader", () => {
  it("retains sourceAddress and process creation identity but exposes only the executable path hash", async () => {
    const instance = reader(async () => JSON.stringify(rawResponse()));
    const result = await instance.read();
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("Expected available fixture");
    expect(result.sockets).toEqual([row]);
    expect(result.owners).toEqual([projectedOwner]);
    expect(result.completedAtMono).toBeGreaterThanOrEqual(result.startedAtMono);
    expect(result.scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("electron.exe");
    expect(Object.isFrozen(result.sockets[0])).toBe(true);
  });

  it.each([
    { ownerPids: ["99; Invoke-Expression bad"], remotes: scope.remotes },
    { ownerPids: [0], remotes: scope.remotes },
    { ownerPids: [99, 99], remotes: scope.remotes },
    { ownerPids: [99], remotes: [{ address: "example.com", port: 443 }] },
    { ownerPids: [99], remotes: [{ address: "fe80::%adapter", port: 443 }] },
    { ownerPids: [99], remotes: [{ address: "127.0.0.1", port: 65536 }] },
    { ownerPids: [99], remotes: [{ address: "127.0.0.1", port: "443" }] },
    { ownerPids: [99], remotes: [{ address: "0.0.0.0", port: 443 }] },
    { ownerPids: [99], remotes: [] },
    { ownerPids: [99], remotes: scope.remotes, command: "Get-Secret" },
  ])("rejects invalid or expandable scope %# before launching a command", (invalid) => {
    expect(() => new WindowsTcpSocketReader(invalid as unknown as WindowsTcpSocketScope)).toThrow(
      /^WINDOWS_TCP_SCOPE_INVALID$/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("normalizes IPv6 and preserves scope identity independent of PID/remote order", async () => {
    const response = rawResponse();
    response.before.push({ ...owner, pid: 100 });
    response.after.push({ ...owner, pid: 100 });
    response.sockets[0] = { ...row, sourceAddress: "0:0:0:0:0:0:0:1", remoteAddress: "0:0:0:0:0:0:0:1" };
    const firstScope = { ownerPids: [99, 100], remotes: [{ address: "::1", port: 4567 }, ...scope.remotes] };
    const secondScope = {
      ownerPids: [100, 99],
      remotes: [...scope.remotes, { address: "0:0:0:0:0:0:0:1", port: 4567 }],
    };
    const first = await reader(async () => JSON.stringify(response), firstScope).read();
    const second = await reader(async () => JSON.stringify(response), secondScope).read();
    expect(first.available && second.available && first.scopeHash === second.scopeHash).toBe(true);
    expect(first.available && first.sockets[0].sourceAddress).toBe("::1");
  });

  it.each([
    "owner missing",
    "creation changed",
    "path changed",
    "path empty",
    "path null",
    "extra owner",
    "unknown field",
    "unknown state",
    "outside remote",
    "outside owner",
    "duplicate tuple",
    "family mismatch",
    "malformed",
    "oversized",
  ])("fails closed and latches invalidation for %s", async (kind) => {
    const response = rawResponse();
    if (kind === "owner missing") response.after = [];
    if (kind === "creation changed") response.after[0].createdAtTicks = "639000000000000001";
    if (kind === "path changed") response.after[0].executablePath = "D:\\different.exe";
    if (kind === "path empty") response.before[0].executablePath = response.after[0].executablePath = "";
    if (kind === "path null") Object.assign(response.after[0], { executablePath: null });
    if (kind === "extra owner") response.after.push({ ...owner, pid: 100 });
    if (kind === "unknown field") Object.assign(response.sockets[0], { sessionId: "made-up" });
    if (kind === "unknown state") response.sockets[0].state = "Unknown";
    if (kind === "outside remote") response.sockets[0].remotePort++;
    if (kind === "outside owner") response.sockets[0].ownerPid++;
    if (kind === "duplicate tuple") response.sockets.push({ ...row });
    if (kind === "family mismatch") response.sockets[0].sourceAddress = "::1";
    const runner = vi.fn(async () =>
      kind === "malformed"
        ? "private-provider-output"
        : kind === "oversized"
          ? " ".repeat(384 * 1024 + 1)
          : JSON.stringify(response),
    );
    const instance = reader(runner);
    const result = await instance.read();
    expect(result).toEqual({
      available: false,
      startedAtMono: expect.any(Number),
      completedAtMono: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toMatch(/provider|electron|127\.0/);
    await instance.read();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("pins owner creation time across reads and refuses PID reuse even when both sides agree", async () => {
    const response = rawResponse();
    const runner = vi.fn(async () => JSON.stringify(response));
    const instance = reader(runner);
    expect((await instance.read()).available).toBe(true);
    response.before[0].createdAtTicks = response.after[0].createdAtTicks = "639000000000000002";
    expect((await instance.read()).available).toBe(false);
    response.before[0].createdAtTicks = response.after[0].createdAtTicks = owner.createdAtTicks;
    expect((await instance.read()).available).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("rejects an excessive selected table instead of truncating it to a unique candidate", async () => {
    const response = rawResponse();
    response.sockets = Array.from({ length: 1_025 }, (_, index) => ({ ...row, sourcePort: 40_000 + index }));
    const raw = JSON.stringify(response);
    expect(Buffer.byteLength(raw)).toBeLessThan(384 * 1024);
    expect((await reader(async () => raw).read()).available).toBe(false);
  });

  it("shares concurrent reads and does not treat a failed command as an empty successful table", async () => {
    let reject!: (error: Error) => void;
    const work = new Promise<string>((_resolve, no) => {
      reject = no;
    });
    const runner = vi.fn(() => work);
    const instance = reader(runner);
    const first = instance.read();
    expect(instance.read()).toBe(first);
    reject(new Error("private process exit detail"));
    expect((await first).available).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("uses fixed hidden bounded PowerShell source and sends validated scope solely over stdin", async () => {
    const stdin = { once: vi.fn(), end: vi.fn() };
    execFileMock.mockImplementation(
      (_exe, _args, _options, callback: (error: Error | null, stdout: string) => void) => {
        queueMicrotask(() => callback(null, JSON.stringify(rawResponse())));
        return { stdin, kill: vi.fn() };
      },
    );
    const result = await new WindowsTcpSocketReader(scope, { platform: "win32" }).read();
    expect(result.available).toBe(true);
    const [executable, args, options] = execFileMock.mock.calls[0];
    expect(executable).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).toContain("[ClipdockNativeTcpTable]::ReadForOwners([uint32[]]$clipdockScope.ownerPids)");
    expect(args[4]).toContain('DllImport("iphlpapi.dll"');
    expect(args[4]).not.toContain("Get-NetTCPConnection");
    expect(args[4]).toContain("$clipdockScope.ownerPids | ForEach-Object");
    expect(args[4]).toContain("OpenProcess(0x1000, false, pid)");
    expect(args[4]).toContain("QueryFullProcessImageNameW");
    expect(args[4]).toContain("GetProcessTimes");
    expect(args[4]).toContain("DateTime.FromFileTimeUtc(fileTime).Ticks.ToString");
    expect(args[4]).toContain("finally { CloseHandle(handle); }");
    expect(args[4]).not.toMatch(/Get-Process|SeDebug|AdjustTokenPrivileges|PROCESS_ALL_ACCESS/);
    expect(args[4]).not.toMatch(
      /127\.0\.0\.1|4567|SilentlyContinue.*Get-|Invoke-Expression|Set-Net|Remove-Net/,
    );
    expect(stdin.end).toHaveBeenCalledWith(JSON.stringify(scope));
    expect(options).toMatchObject({
      windowsHide: true,
      shell: false,
      timeout: 6000,
      maxBuffer: 384 * 1024,
      encoding: "utf8",
    });
  });

  it("keeps native owner identity with an empty selected table, without inventing a socket", async () => {
    // Native limited-information reads can return this path while Get-Process.Path is empty.
    // The real Windows regression is recorded separately; this verifies the wire contract.
    const nativeOwner = { ...owner, createdAtTicks: "639244035457234678" };
    const response = { before: [nativeOwner], sockets: [], after: [nativeOwner] };
    const instance = reader(async () => JSON.stringify(response));
    const found = await instance.read();
    expect(found.available).toBe(true);
    if (!found.available) throw new Error("Expected native owner fixture");
    expect(found.owners[0]).toEqual({
      pid: nativeOwner.pid,
      createdAtTicks: nativeOwner.createdAtTicks,
      executablePathIdentity: executablePathIdentity(nativeOwner.executablePath),
    });
    expect(found.sockets).toEqual([]);
    expect(
      correlateControlledTcpSocket(
        controlled(),
        cdp(),
        baseline(),
        {
          ...found,
          startedAtMono: 5,
          completedAtMono: 6,
          scopeHash: baseline().scopeHash,
          owners: baseline().owners,
        },
        8,
      ),
    ).toEqual({ matched: false, reason: "NO_MATCH" });
  });
});

describe("correlateControlledTcpSocket", () => {
  it("returns a new controlled-window tuple while explicitly withholding Session ownership proof", () => {
    const result = correlateControlledTcpSocket(controlled(), cdp(), baseline(), observed(), 8);
    expect(result).toEqual({
      matched: true,
      basis: "caller-controlled-cold-window",
      sessionOwnershipProven: false,
      contextId: "isolated_context",
      generation: 2,
      owner: projectedOwner,
      socket: row,
    });
  });

  it.each([
    "completeOwnerScope",
    "ownerTrafficExclusive",
    "connectionPoolsDrainedBeforeBaseline",
    "singleRequestWithoutPreconnect",
  ] as const)("rejects a unique row without caller guarantee %s", (field) => {
    const window = controlled();
    window[field] = false;
    expect(correlateControlledTcpSocket(window, cdp(), baseline(), observed(), 8)).toEqual({
      matched: false,
      reason: "CONTROL_WINDOW_UNPROVEN",
    });
  });

  it.each([
    "connectionReused",
    "fromDiskCache",
    "fromServiceWorker",
    "fromPrefetchCache",
    "requestServedFromCache",
  ] as const)("rejects %s even if the TCP tuple is unique", (field) => {
    const response = cdp();
    response[field] = true;
    expect(correlateControlledTcpSocket(controlled(), response, baseline(), observed(), 8)).toEqual({
      matched: false,
      reason: "UNSUITABLE_RESPONSE",
    });
  });

  it("rejects QUIC or incomplete CDP evidence", () => {
    expect(
      correlateControlledTcpSocket(controlled(), { ...cdp(), protocol: "h3" }, baseline(), observed(), 8)
        .matched,
    ).toBe(false);
    const response = cdp();
    delete (response as Partial<CdpTcpResponse>).fromServiceWorker;
    expect(correlateControlledTcpSocket(controlled(), response, baseline(), observed(), 8).matched).toBe(
      false,
    );
  });

  it("rejects existing and ambiguous sockets rather than choosing one new row", () => {
    const before = { ...baseline(), sockets: [{ ...row, sourcePort: 49999 }] };
    const after = observed();
    expect(correlateControlledTcpSocket(controlled(), cdp(), before, after, 8)).toEqual({
      matched: false,
      reason: "EXISTING_SOCKET",
    });
    const double = { ...after, sockets: [row, { ...row, sourcePort: 50001 }] };
    expect(correlateControlledTcpSocket(controlled(), cdp(), baseline(), double, 8)).toEqual({
      matched: false,
      reason: "AMBIGUOUS_MATCH",
    });
  });

  it("rejects process identity/scope drift and observations outside the control window", () => {
    const after = observed();
    expect(
      correlateControlledTcpSocket(
        controlled(),
        cdp(),
        baseline(),
        { ...after, owners: [{ ...projectedOwner, createdAtTicks: "639000000000000001" }] },
        8,
      ),
    ).toEqual({ matched: false, reason: "CONTEXT_MISMATCH" });
    expect(
      correlateControlledTcpSocket(
        controlled(),
        cdp(),
        baseline(),
        { ...after, scopeHash: "b".repeat(64) },
        8,
      ).matched,
    ).toBe(false);
    expect(
      correlateControlledTcpSocket(controlled(), { ...cdp(), requestStartedAtMono: 1 }, baseline(), after, 8),
    ).toEqual({ matched: false, reason: "STALE_WINDOW" });
    expect(correlateControlledTcpSocket(controlled(), cdp(), baseline(), after, 16000)).toEqual({
      matched: false,
      reason: "STALE_WINDOW",
    });
  });

  it("rejects read failure, a mismatched remote, and a socket that is not established", () => {
    expect(
      correlateControlledTcpSocket(
        controlled(),
        cdp(),
        { available: false, startedAtMono: 1, completedAtMono: 2 },
        observed(),
        8,
      ),
    ).toEqual({ matched: false, reason: "READ_UNAVAILABLE" });
    expect(
      correlateControlledTcpSocket(controlled(), { ...cdp(), remotePort: 4568 }, baseline(), observed(), 8),
    ).toEqual({ matched: false, reason: "NO_MATCH" });
    expect(
      correlateControlledTcpSocket(
        controlled(),
        cdp(),
        baseline(),
        { ...observed(), sockets: [{ ...row, state: "TimeWait" }] },
        8,
      ).matched,
    ).toBe(false);
  });
});
