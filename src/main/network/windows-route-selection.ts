import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { win32 } from "node:path";
import { z } from "zod";

const MAX_BYTES = 384 * 1024;
const MAX_TARGETS = 16;
const TIMEOUT_MS = 10_000;
const indexSchema = z.number().int().min(1).max(0xffff_ffff);
const metricSchema = z.number().int().min(0).max(0xffff_ffff);

function normalizeIp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4) return value;
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : null;
}
function usableTarget(value: string): boolean {
  if (["0.0.0.0", "::", "255.255.255.255"].includes(value)) return false;
  if (isIP(value) === 4) return Number(value.split(".")[0]) < 224;
  // A link-local target needs an explicit interface scope, which this IP-only API does not accept.
  return !/^ff|^fe[89ab]/i.test(value) && !value.startsWith("::ffff:");
}
const ipSchema = z
  .string()
  .max(64)
  .refine((value) => normalizeIp(value) !== null);
const scopeSchema = z.strictObject({
  addresses: z.array(ipSchema).min(1).max(MAX_TARGETS),
  localAddress: ipSchema.optional(),
});

export interface WindowsRouteSelectionScope {
  readonly addresses: readonly string[];
  /** Optional explicit source for a read-only route query, never a request to bind a socket. */
  readonly localAddress?: string;
}

/** Actual Windows query records, retained only in main-process memory; no socket or egress claim. */
export interface WindowsRouteSelection {
  readonly targetAddress: string;
  readonly sourceAddress: string;
  readonly addressFamily: "ipv4" | "ipv6";
  readonly sourceState: "Invalid" | "Tentative" | "Duplicate" | "Deprecated" | "Preferred";
  readonly skipAsSource: boolean;
  readonly interfaceIndex: number;
  /** Normalized adapter GUID, not a binary identity or proof that a particular process used it. */
  readonly interfaceGuid: string;
  readonly interfaceIdentity: string;
  readonly hardwareInterface: boolean;
  readonly adapterStatus: string;
  readonly adapterUp: boolean;
  readonly interfaceConnection: "Connected" | "Disconnected";
  /** Some Windows virtual interfaces return no CIM metric. Missing stays null, never assumed zero. */
  readonly interfaceMetric: number | null;
  readonly destinationPrefix: string;
  readonly nextHop: string;
  readonly routeMetric: number;
  readonly routeState: "Alive" | "Dead" | "Probe";
}

export type WindowsRouteSelectionSnapshot =
  | Readonly<
      {
        available: true;
        socketObserved: false;
        startedAtMono: number;
        completedAtMono: number;
        scopeHash: string;
        selectionHash: string;
        selections: readonly WindowsRouteSelection[];
      } & (
        | { basis: "windows-best-route-query"; localAddress?: never }
        | { basis: "windows-source-route-query"; localAddress: string }
      )
    >
  | Readonly<{
      available: false;
      startedAtMono: number;
      completedAtMono: number;
      reason: "READ_UNAVAILABLE" | "READ_CANCELLED" | "READ_TIMEOUT" | "DISPOSED";
    }>;
type UnavailableReason = Extract<WindowsRouteSelectionSnapshot, { available: false }>["reason"];

// All targets arrive through stdin JSON, never interpolated into PowerShell source or arguments.
// Two passes detect changed selected routes/source addresses/adapter identities within this batch.
const READ_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$clipdockScope = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
function Read-ClipdockSelections {
  $clipdockAdapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
  $clipdockInterfaces = @(Get-NetIPInterface -PolicyStore ActiveStore -ErrorAction Stop)
  foreach ($clipdockTarget in $clipdockScope.addresses) {
    $clipdockEntries = $(if ($null -ne $clipdockScope.localAddress) {
      @(Find-NetRoute -RemoteIPAddress ([string]$clipdockTarget) -LocalIPAddress ([string]$clipdockScope.localAddress) -ErrorAction Stop)
    } else {
      @(Find-NetRoute -RemoteIPAddress ([string]$clipdockTarget) -ErrorAction Stop)
    })
    $clipdockSources = @($clipdockEntries | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetIPAddress' })
    $clipdockRoutes = @($clipdockEntries | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetRoute' })
    if ($clipdockEntries.Count -ne 2 -or $clipdockSources.Count -ne 1 -or $clipdockRoutes.Count -ne 1) { throw 'ROUTE_SELECTION_UNAVAILABLE' }
    $clipdockSource = $clipdockSources[0]
    $clipdockRoute = $clipdockRoutes[0]
    if ($clipdockSource.InterfaceIndex -ne $clipdockRoute.InterfaceIndex -or $clipdockSource.AddressFamily -ne $clipdockRoute.AddressFamily) { throw 'ROUTE_SELECTION_UNAVAILABLE' }
    $clipdockAdapter = @($clipdockAdapters | Where-Object { $_.ifIndex -eq $clipdockRoute.InterfaceIndex })
    $clipdockInterface = @($clipdockInterfaces | Where-Object {
      $_.InterfaceIndex -eq $clipdockRoute.InterfaceIndex -and $_.AddressFamily -eq $clipdockRoute.AddressFamily
    })
    if ($clipdockAdapter.Count -ne 1 -or $clipdockInterface.Count -ne 1) { throw 'ROUTE_SELECTION_UNAVAILABLE' }
    foreach ($clipdockRequired in @($clipdockSource.IPAddress, $clipdockSource.AddressFamily,
      $clipdockSource.AddressState, $clipdockSource.InterfaceIndex, $clipdockRoute.DestinationPrefix,
      $clipdockRoute.NextHop, $clipdockRoute.RouteMetric, $clipdockRoute.State,
      $clipdockAdapter[0].InterfaceGuid, $clipdockAdapter[0].Status,
      $clipdockInterface[0].ConnectionState)) {
      if ($null -eq $clipdockRequired) { throw 'ROUTE_SELECTION_UNAVAILABLE' }
    }
    if ($clipdockSource.SkipAsSource -isnot [bool] -or $clipdockAdapter[0].HardwareInterface -isnot [bool]) { throw 'ROUTE_SELECTION_UNAVAILABLE' }
    [ordered]@{
      targetAddress = [string]$clipdockTarget
      sourceAddress = [string]$clipdockSource.IPAddress
      addressFamily = [string]$clipdockRoute.AddressFamily
      sourceState = [string]$clipdockSource.AddressState
      skipAsSource = [bool]$clipdockSource.SkipAsSource
      interfaceIndex = [long]$clipdockRoute.InterfaceIndex
      interfaceGuid = [string]$clipdockAdapter[0].InterfaceGuid
      hardwareInterface = [bool]$clipdockAdapter[0].HardwareInterface
      adapterStatus = [string]$clipdockAdapter[0].Status
      interfaceConnection = [string]$clipdockInterface[0].ConnectionState
      interfaceMetric = $(if ($null -eq $clipdockInterface[0].InterfaceMetric) { $null } else { [long]$clipdockInterface[0].InterfaceMetric })
      destinationPrefix = [string]$clipdockRoute.DestinationPrefix
      nextHop = [string]$clipdockRoute.NextHop
      routeMetric = [long]$clipdockRoute.RouteMetric
      routeState = [string]$clipdockRoute.State
    }
  }
}
$clipdockBefore = @(Read-ClipdockSelections)
$clipdockAfter = @(Read-ClipdockSelections)
[ordered]@{ before = $clipdockBefore; after = $clipdockAfter } | ConvertTo-Json -Depth 5 -Compress
`;

function runFixedRead(input: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let inputFailed = false;
    const child = execFile(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT],
      {
        windowsHide: true,
        shell: false,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BYTES,
        signal,
      },
      (error, stdout) => {
        if (error || inputFailed) reject(new Error("WINDOWS_ROUTE_READ_UNAVAILABLE"));
        else resolve(stdout);
      },
    );
    if (!child.stdin) {
      inputFailed = true;
      child.kill();
      return;
    }
    child.stdin.once("error", () => {
      inputFailed = true;
      child.kill();
    });
    child.stdin.end(input);
  });
}

const rowSchema = z.strictObject({
  targetAddress: ipSchema,
  sourceAddress: z.string().max(80),
  addressFamily: z.enum(["IPv4", "IPv6"]),
  sourceState: z.enum(["Invalid", "Tentative", "Duplicate", "Deprecated", "Preferred"]),
  skipAsSource: z.boolean(),
  interfaceIndex: indexSchema,
  interfaceGuid: z
    .string()
    .max(38)
    .refine((value) => {
      const unwrapped = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
      return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(unwrapped);
    }),
  hardwareInterface: z.boolean(),
  adapterStatus: z.enum([
    "Up",
    "Down",
    "Disabled",
    "Not Present",
    "LowerLayerDown",
    "Testing",
    "Dormant",
    "Unknown",
  ]),
  interfaceConnection: z.enum(["Connected", "Disconnected"]),
  interfaceMetric: metricSchema.nullable(),
  destinationPrefix: z.string().max(80),
  nextHop: z.string().max(80),
  routeMetric: metricSchema,
  routeState: z.enum(["Alive", "Dead", "Probe"]),
});
const responseSchema = z.strictObject({
  before: z.array(rowSchema).min(1).max(MAX_TARGETS),
  after: z.array(rowSchema).min(1).max(MAX_TARGETS),
});

function scopedAddress(value: string, index: number): string | null {
  const parts = value.split("%");
  if (
    parts.length > 2 ||
    (parts.length === 2 && (!/^[1-9]\d*$/.test(parts[1]) || Number(parts[1]) !== index))
  )
    return null;
  const normalized = normalizeIp(parts[0]);
  if (parts.length === 2 && (!normalized || isIP(normalized) !== 6 || !/^fe[89ab]/i.test(normalized)))
    return null;
  return normalized;
}
function ipBits(address: string): bigint {
  if (isIP(address) === 4) return address.split(".").reduce((bits, part) => (bits << 8n) | BigInt(part), 0n);
  const [left, right] = address.split("::");
  const start = left ? left.split(":") : [],
    end = right ? right.split(":") : [];
  return [...start, ...Array(8 - start.length - end.length).fill("0"), ...end].reduce(
    (bits, part) => (bits << 16n) | BigInt(`0x${part}`),
    0n,
  );
}
function normalizePrefix(value: string, target: string): string | null {
  const match = /^([^/%]+)\/(0|[1-9]\d{0,2})$/.exec(value);
  if (!match) return null;
  const base = normalizeIp(match[1]),
    family = isIP(target),
    width = family === 4 ? 32 : 128;
  const length = Number(match[2]);
  if (!base || isIP(base) !== family || length > width) return null;
  const hostBits = BigInt(width - length),
    prefix = ipBits(base),
    actual = ipBits(target);
  if ((prefix >> hostBits) << hostBits !== prefix || actual >> hostBits !== prefix >> hostBits) return null;
  return `${base}/${length}`;
}

export interface WindowsRouteSelectionReaderOptions {
  /** Test adapters only. Production executes the fixed bounded PowerShell program. */
  runner?: (input: string, signal: AbortSignal) => Promise<string>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/** Each instance owns one fixed target set. Available means readable/stable, never DIRECT/CN. */
export class WindowsRouteSelectionReader {
  private readonly input: string;
  private readonly scopeHash: string;
  private readonly addresses: ReadonlySet<string>;
  private readonly localAddress: string | null;
  private readonly options: Readonly<WindowsRouteSelectionReaderOptions>;
  private readonly timeoutMs: number;
  private pending: Promise<WindowsRouteSelectionSnapshot> | null = null;
  private draining: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private disposed = false;
  private readonly subscriptions = new Map<AbortSignal, () => void>();

  constructor(scope: WindowsRouteSelectionScope, options: WindowsRouteSelectionReaderOptions = {}) {
    this.options = Object.freeze({ ...options });
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    try {
      const parsed = scopeSchema.parse(scope);
      const addresses = parsed.addresses.map((address) => normalizeIp(address)!).sort();
      this.addresses = new Set(addresses);
      this.localAddress = parsed.localAddress === undefined ? null : normalizeIp(parsed.localAddress);
      if (
        this.addresses.size !== addresses.length ||
        addresses.some((address) => !usableTarget(address)) ||
        (this.localAddress !== null &&
          (!usableTarget(this.localAddress) ||
            addresses.some((address) => isIP(address) !== isIP(this.localAddress!)))) ||
        !Number.isInteger(this.timeoutMs) ||
        this.timeoutMs < 1 ||
        this.timeoutMs > TIMEOUT_MS
      )
        throw new Error();
      this.input = JSON.stringify({
        addresses,
        ...(this.localAddress !== null ? { localAddress: this.localAddress } : {}),
      });
      this.scopeHash = createHash("sha256").update(this.input).digest("hex");
    } catch {
      throw new Error("WINDOWS_ROUTE_SCOPE_INVALID");
    }
  }

  /** Joining callers share the batch; cancellation by a joined caller cancels that entire batch. */
  read(signal?: AbortSignal): Promise<WindowsRouteSelectionSnapshot> {
    const startedAtMono = performance.now();
    if (this.disposed || signal?.aborted)
      return Promise.resolve(this.unavailable(startedAtMono, this.disposed ? "DISPOSED" : "READ_CANCELLED"));
    if (this.pending) {
      this.subscribe(signal);
      return this.pending;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.subscribe(signal);
    const timeout = setTimeout(() => controller.abort("READ_TIMEOUT"), this.timeoutMs);
    const cancelled = new Promise<WindowsRouteSelectionSnapshot>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          resolve(
            this.unavailable(
              startedAtMono,
              controller.signal.reason === "READ_TIMEOUT"
                ? "READ_TIMEOUT"
                : this.disposed
                  ? "DISPOSED"
                  : "READ_CANCELLED",
            ),
          ),
        { once: true },
      );
    });
    let finished = false;
    const work = this.readOnce(startedAtMono, controller.signal);
    void work.then(() => {
      finished = true;
    });
    const result = Promise.race([work, cancelled]).finally(() => {
      clearTimeout(timeout);
      if (finished) this.clear(result, controller);
    });
    this.pending = result;
    // Even an injected runner that ignores abort cannot start overlapping work after a timeout.
    this.draining = Promise.allSettled([work, result]).then(() => this.clear(result, controller));
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort("DISPOSED");
    this.clearSubscriptions();
  }

  /** Lets a batch owner retain its slot until the cancelled OS read has actually ended. */
  whenIdle(): Promise<void> {
    return this.draining;
  }

  private subscribe(signal?: AbortSignal): void {
    if (!signal || this.subscriptions.has(signal)) return;
    const abort = () => this.controller?.abort("READ_CANCELLED");
    this.subscriptions.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }
  private clearSubscriptions(): void {
    for (const [signal, callback] of this.subscriptions) signal.removeEventListener("abort", callback);
    this.subscriptions.clear();
  }
  private clear(result: Promise<WindowsRouteSelectionSnapshot>, controller: AbortController): void {
    if (this.pending !== result) return;
    this.pending = null;
    if (this.controller === controller) this.controller = null;
    this.clearSubscriptions();
  }
  private unavailable(startedAtMono: number, reason: UnavailableReason): WindowsRouteSelectionSnapshot {
    return Object.freeze({ available: false, startedAtMono, completedAtMono: performance.now(), reason });
  }
  private async readOnce(startedAtMono: number, signal: AbortSignal): Promise<WindowsRouteSelectionSnapshot> {
    try {
      if ((this.options.platform ?? process.platform) !== "win32" || signal.aborted) throw new Error();
      const raw = await (this.options.runner ?? runFixedRead)(this.input, signal);
      if (signal.aborted || this.disposed || Buffer.byteLength(raw) > MAX_BYTES) throw new Error();
      const response = responseSchema.parse(JSON.parse(raw));
      const project = (rows: z.infer<typeof rowSchema>[]) => {
        if (rows.length !== this.addresses.size) throw new Error();
        const selected = rows
          .map((row): WindowsRouteSelection => {
            const targetAddress = normalizeIp(row.targetAddress)!,
              sourceAddress = scopedAddress(row.sourceAddress, row.interfaceIndex),
              nextHop = scopedAddress(row.nextHop, row.interfaceIndex),
              destinationPrefix = normalizePrefix(row.destinationPrefix, targetAddress),
              family = row.addressFamily === "IPv4" ? 4 : 6;
            if (
              !this.addresses.has(targetAddress) ||
              !sourceAddress ||
              !nextHop ||
              !destinationPrefix ||
              isIP(targetAddress) !== family ||
              isIP(sourceAddress) !== family ||
              isIP(nextHop) !== family ||
              ["0.0.0.0", "::"].includes(sourceAddress) ||
              (this.localAddress !== null && sourceAddress !== this.localAddress)
            )
              throw new Error();
            const interfaceGuid = row.interfaceGuid.replace(/^\{|\}$/g, "").toLowerCase();
            if (interfaceGuid === "00000000-0000-0000-0000-000000000000") throw new Error();
            return Object.freeze({
              targetAddress,
              sourceAddress,
              addressFamily: family === 4 ? "ipv4" : "ipv6",
              sourceState: row.sourceState,
              skipAsSource: row.skipAsSource,
              interfaceIndex: row.interfaceIndex,
              interfaceGuid,
              interfaceIdentity: createHash("sha256").update(interfaceGuid).digest("hex"),
              hardwareInterface: row.hardwareInterface,
              adapterStatus: row.adapterStatus,
              adapterUp: row.adapterStatus === "Up",
              interfaceConnection: row.interfaceConnection,
              interfaceMetric: row.interfaceMetric,
              destinationPrefix,
              nextHop,
              routeMetric: row.routeMetric,
              routeState: row.routeState,
            });
          })
          .sort((a, b) => a.targetAddress.localeCompare(b.targetAddress, "en"));
        if (new Set(selected.map((row) => row.targetAddress)).size !== this.addresses.size) throw new Error();
        return Object.freeze(selected);
      };
      const before = project(response.before),
        after = project(response.after);
      const serialized = JSON.stringify(after);
      if (JSON.stringify(before) !== serialized || signal.aborted || this.disposed) throw new Error();
      return Object.freeze({
        available: true,
        ...(this.localAddress !== null
          ? { basis: "windows-source-route-query" as const, localAddress: this.localAddress }
          : { basis: "windows-best-route-query" as const }),
        socketObserved: false,
        startedAtMono,
        completedAtMono: performance.now(),
        scopeHash: this.scopeHash,
        selectionHash: createHash("sha256").update(serialized).digest("hex"),
        selections: after,
      });
    } catch {
      return this.unavailable(
        startedAtMono,
        this.disposed
          ? "DISPOSED"
          : signal.aborted
            ? signal.reason === "READ_TIMEOUT"
              ? "READ_TIMEOUT"
              : "READ_CANCELLED"
            : "READ_UNAVAILABLE",
      );
    }
  }
}
