import { windowsReadBatch } from "./windows-read-batch";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { WindowsControllerOwnerReader } from "./windows-controller-owner";

/** Internal configuration observations only: availability never proves a DIRECT route. */
export type WindowsNetworkFingerprint =
  Readonly<{ available: true; hash: string }> | Readonly<{ available: false; hash: null }>;

/** Actual command window, including joined reads; these times are never refreshed by a caller. */
export type WindowsNetworkObservation = WindowsNetworkFingerprint &
  Readonly<{
    startedAtMono: number;
    completedAtMono: number;
  }>;

const UNAVAILABLE: WindowsNetworkFingerprint = Object.freeze({ available: false, hash: null });
const READ_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

// Fixed, read-only commands. Never interpolate addresses, adapter names or caller input.
// Lifetimes, byte counters and timestamps are deliberately excluded from the fingerprint.
const READ_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$clipdockRoutes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop |
  ForEach-Object { [ordered]@{
    index = [int]$_.InterfaceIndex; family = [string]$_.AddressFamily
    destination = [string]$_.DestinationPrefix; nextHop = [string]$_.NextHop
    metric = [int]$_.RouteMetric; protocol = [string]$_.Protocol; state = [string]$_.State
  } })
$clipdockInterfaces = @(Get-NetIPInterface -PolicyStore ActiveStore -ErrorAction Stop |
  ForEach-Object { [ordered]@{
    index = [int]$_.InterfaceIndex; family = [string]$_.AddressFamily
    alias = [string]$_.InterfaceAlias; connection = [string]$_.ConnectionState
    dhcp = [string]$_.Dhcp; forwarding = [string]$_.Forwarding
    automaticMetric = [string]$_.AutomaticMetric
    metric = $(if ($null -eq $_.InterfaceMetric) { $null } else { [int]$_.InterfaceMetric })
    mtu = [long]$_.NlMtu
  } })
$clipdockDns = @(Get-DnsClientServerAddress -ErrorAction Stop |
  ForEach-Object { [ordered]@{
    index = [int]$_.InterfaceIndex; family = [int]$_.AddressFamily
    servers = @($_.ServerAddresses | ForEach-Object { [string]$_ })
  } })
[ordered]@{ routes = $clipdockRoutes; interfaces = $clipdockInterfaces; dns = $clipdockDns } |
  ConvertTo-Json -Depth 6 -Compress
`;

const safeString = z.string().max(1_024);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function isDestinationPrefix(destination: string, family: "IPv4" | "IPv6"): boolean {
  const match = /^([^/%]+)\/(0|[1-9]\d{0,2})$/.exec(destination);
  if (!match) return false;
  const version = family === "IPv4" ? 4 : 6;
  return isIP(match[1]) === version && Number(match[2]) <= (version === 4 ? 32 : 128);
}

const configurationSchema = z.strictObject({
  routes: z
    .array(
      z
        .strictObject({
          index: nonnegativeInteger,
          family: z.enum(["IPv4", "IPv6"]),
          destination: safeString,
          nextHop: safeString,
          metric: nonnegativeInteger,
          protocol: safeString,
          state: safeString,
        })
        .refine((route) => isDestinationPrefix(route.destination, route.family)),
    )
    .max(1_024),
  interfaces: z
    .array(
      z.strictObject({
        index: nonnegativeInteger,
        family: z.enum(["IPv4", "IPv6"]),
        alias: safeString,
        connection: safeString,
        dhcp: safeString,
        forwarding: safeString,
        automaticMetric: safeString,
        // Some live tunnel interfaces omit this CIM field. Preserve null distinctly from zero;
        // this fingerprint observes changes and does not infer which route wins.
        metric: nonnegativeInteger.nullable(),
        mtu: nonnegativeInteger,
      }),
    )
    .max(1_024),
  dns: z
    .array(
      z.strictObject({
        index: nonnegativeInteger,
        family: z.union([z.literal(2), z.literal(23)]),
        servers: z.array(safeString).max(64),
      }),
    )
    .max(1_024),
});

/** maxBuffer bounds both captured streams; provider output/errors never escape this module. */
async function runFixedWindowsRead(): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), READ_TIMEOUT_MS);
  try {
    return await windowsReadBatch.read(READ_SCRIPT, abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

function sortedRows(rows: readonly unknown[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function localAddresses(readInterfaces: typeof networkInterfaces): string {
  return JSON.stringify(
    Object.entries(readInterfaces())
      .sort(([first], [second]) => first.localeCompare(second, "en"))
      .map(([name, addresses]) => [
        name,
        sortedRows(
          (addresses ?? []).map((address) => ({
            family: address.family,
            address: address.address,
            netmask: address.netmask,
            internal: address.internal,
            scopeid: "scopeid" in address ? address.scopeid : null,
          })),
        ),
      ]),
  );
}

export interface WindowsNetworkFingerprintReaderOptions {
  /** Dependency injection for isolated tests. Production always uses the fixed bounded command. */
  runner?: () => Promise<string>;
  readInterfaces?: typeof networkInterfaces;
  platform?: NodeJS.Platform;
}

export class WindowsNetworkFingerprintReader {
  private pending: Promise<WindowsNetworkObservation> | null = null;
  private projection: {
    source: Promise<WindowsNetworkObservation>;
    value: Promise<WindowsNetworkFingerprint>;
  } | null = null;

  constructor(private readonly options: WindowsNetworkFingerprintReaderOptions = {}) {}

  /** Concurrent callers share one read; no successful sample is cached for subsequent reads. */
  read(): Promise<WindowsNetworkFingerprint> {
    const source = this.readObservation();
    if (this.projection?.source === source) return this.projection.value;
    const value = source.then((observation): WindowsNetworkFingerprint =>
      observation.available ? Object.freeze({ available: true, hash: observation.hash }) : UNAVAILABLE,
    );
    this.projection = { source, value };
    void value.then(() => {
      if (this.projection?.value === value) this.projection = null;
    });
    return value;
  }

  /** Shares read()'s real sampling slot; a late joiner receives the original command timestamps. */
  readObservation(): Promise<WindowsNetworkObservation> {
    if (this.pending) return this.pending;
    const startedAtMono = performance.now();
    const project = (value: WindowsNetworkFingerprint): WindowsNetworkObservation =>
      Object.freeze({ ...value, startedAtMono, completedAtMono: performance.now() });
    const pending = this.readOnce().then(project, () => project(UNAVAILABLE));
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    return pending;
  }

  private async readOnce(): Promise<WindowsNetworkFingerprint> {
    if ((this.options.platform ?? process.platform) !== "win32") return UNAVAILABLE;
    try {
      const readInterfaces = this.options.readInterfaces ?? networkInterfaces;
      const addressesBefore = localAddresses(readInterfaces);
      const raw = await (this.options.runner ?? runFixedWindowsRead)();
      // Apply the same cap to injected runners and reject truncated/malformed command output.
      if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) return UNAVAILABLE;
      const configuration = configurationSchema.parse(JSON.parse(raw));
      const addressesAfter = localAddresses(readInterfaces);
      if (addressesBefore !== addressesAfter) return UNAVAILABLE;
      const canonical = JSON.stringify({
        routes: sortedRows(configuration.routes),
        interfaces: sortedRows(configuration.interfaces),
        // DNS server order carries priority and must remain significant inside each row.
        dns: sortedRows(configuration.dns),
        addresses: addressesAfter,
      });
      return Object.freeze({
        available: true,
        hash: createHash("sha256").update(canonical).digest("hex"),
      });
    } catch {
      // No command output, adapter addresses, DNS addresses or OS errors cross the boundary.
      return UNAVAILABLE;
    }
  }
}

export interface WindowsNetworkFingerprintWatcherOptions {
  onChange: (snapshot: WindowsNetworkFingerprint) => void;
  reader?: Pick<WindowsNetworkFingerprintReader, "read">;
  pollMs?: number;
  debounceMs?: number;
}

/**
 * A polling invalidation signal, not an atomic route lock. A changed/lost observation revokes
 * availability immediately. Only recovery is debounced, with at least two matching reads.
 */
export class WindowsNetworkFingerprintWatcher {
  private readonly reader: Pick<WindowsNetworkFingerprintReader, "read">;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private running = false;
  private revision = 0;
  private snapshot: WindowsNetworkFingerprint = UNAVAILABLE;
  private candidate: { hash: string; since: number } | null = null;

  constructor(private readonly options: WindowsNetworkFingerprintWatcherOptions) {
    this.reader = options.reader ?? new WindowsNetworkFingerprintReader();
    this.pollMs = options.pollMs ?? 5_000;
    this.debounceMs = options.debounceMs ?? 1_000;
    if (
      !Number.isInteger(this.pollMs) ||
      this.pollMs < 1 ||
      this.pollMs > 60_000 ||
      !Number.isInteger(this.debounceMs) ||
      this.debounceMs < 0 ||
      this.debounceMs > 60_000
    )
      throw new Error("WINDOWS_NETWORK_WATCHER_CONFIG_INVALID");
  }

  getSnapshot(): WindowsNetworkFingerprint {
    return this.snapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.revision++;
    this.candidate = null;
    this.snapshot = UNAVAILABLE;
    // Startup/restart must invalidate any old projection before the first OS read completes.
    this.options.onChange(UNAVAILABLE);
    this.schedule(0);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.candidate = null;
    this.publish(UNAVAILABLE);
  }

  private schedule(delay: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    // Also protects stop/start while an old, bounded child process is still exiting.
    if (this.pending) {
      this.schedule(this.pollMs);
      return;
    }
    const revision = this.revision;
    const work = (async () => {
      let observation: WindowsNetworkFingerprint;
      try {
        observation = await this.reader.read();
      } catch {
        observation = UNAVAILABLE;
      }
      if (!this.running || revision !== this.revision) return;
      if (!observation.available) {
        this.candidate = null;
        this.publish(UNAVAILABLE);
        return;
      }
      if (this.snapshot.available && this.snapshot.hash === observation.hash) return;
      this.publish(UNAVAILABLE);
      if (!this.candidate || this.candidate.hash !== observation.hash) {
        this.candidate = { hash: observation.hash, since: performance.now() };
        return;
      }
      if (performance.now() - this.candidate.since >= this.debounceMs) {
        this.candidate = null;
        this.publish(observation);
      }
    })();
    this.pending = work;
    try {
      await work;
    } finally {
      if (this.pending === work) this.pending = null;
      // Confirm a new candidate as soon as its stability window ends. The
      // normal five-second interval is for steady-state monitoring only.
      const delay = this.candidate
        ? Math.min(this.pollMs, Math.max(1, this.debounceMs - (performance.now() - this.candidate.since)))
        : this.pollMs;
      this.schedule(delay);
    }
  }

  private publish(snapshot: WindowsNetworkFingerprint): void {
    if (this.snapshot.available === snapshot.available && this.snapshot.hash === snapshot.hash) return;
    this.snapshot = snapshot;
    this.options.onChange(snapshot);
  }
}

export interface WindowsControllerLifecycleWatcherOptions {
  getControllerUrl: () => string;
  onChange: (snapshot: WindowsNetworkFingerprint) => void;
  /** Tests use isolated owner observations. Production creates the bounded Windows reader. */
  createReader?: (controllerUrl: string) => Pick<WindowsControllerOwnerReader, "read" | "dispose">;
  pollMs?: number;
  debounceMs?: number;
}

/** Controller lifetime availability is bound to the currently configured literal endpoint. */
export class WindowsControllerLifecycleWatcher {
  private readonly watcher: WindowsNetworkFingerprintWatcher;
  private reader: Pick<WindowsControllerOwnerReader, "read" | "dispose"> | null = null;
  private readerUrl: string | null = null;
  private verifiedUrl: string | null = null;
  private revision = 0;
  private running = false;
  private disposed = false;

  constructor(private readonly options: WindowsControllerLifecycleWatcherOptions) {
    this.watcher = new WindowsNetworkFingerprintWatcher({
      pollMs: options.pollMs,
      debounceMs: options.debounceMs,
      reader: { read: () => this.readOwner() },
      onChange: (snapshot) => {
        if (!snapshot.available) this.verifiedUrl = null;
        options.onChange(this.getSnapshot());
      },
    });
  }

  getSnapshot(): WindowsNetworkFingerprint {
    try {
      return this.running &&
        !this.disposed &&
        this.verifiedUrl !== null &&
        this.verifiedUrl === this.options.getControllerUrl() &&
        this.readerUrl === this.verifiedUrl
        ? this.watcher.getSnapshot()
        : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.revision++;
    this.verifiedUrl = null;
    this.watcher.start();
  }
  stop(): void {
    this.running = false;
    this.revision++;
    this.verifiedUrl = null;
    this.watcher.stop();
    this.retireReader();
  }
  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  /** Called synchronously after settings commit and before an observer may publish the new API read. */
  configurationChanged(): void {
    const restart = this.running && !this.disposed;
    this.stop();
    if (restart) this.start();
  }

  private retireReader(): void {
    const previous = this.reader;
    this.reader = null;
    this.readerUrl = null;
    previous?.dispose();
  }
  private async readOwner(): Promise<WindowsNetworkFingerprint> {
    try {
      if (!this.running || this.disposed) return UNAVAILABLE;
      const url = this.options.getControllerUrl(),
        revision = this.revision;
      if (url !== this.readerUrl) {
        this.verifiedUrl = null;
        this.retireReader();
        this.readerUrl = url;
      }
      const reader = (this.reader ??=
        this.options.createReader?.(url) ?? new WindowsControllerOwnerReader({ controllerUrl: url }));
      const owner = await reader.read();
      if (
        !this.running ||
        this.disposed ||
        revision !== this.revision ||
        reader !== this.reader ||
        url !== this.readerUrl ||
        url !== this.options.getControllerUrl() ||
        !owner.available
      )
        return UNAVAILABLE;
      this.verifiedUrl = url;
      return Object.freeze({ available: true, hash: owner.kernelEpoch });
    } catch {
      return UNAVAILABLE;
    }
  }
}
