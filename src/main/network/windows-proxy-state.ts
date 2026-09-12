import { windowsReadBatch } from "./windows-read-batch";
import { isIP } from "node:net";
import { z } from "zod";

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 384 * 1024;
const index = z.number().int().min(1).max(0xffff_ffff);
const family = z.enum(["IPv4", "IPv6"]);
const apiSchema = z.strictObject({
  manual: z.boolean(),
  pac: z.boolean(),
  autoDetect: z.boolean(),
});
const registrySchema = z.strictObject({
  keyExists: z.boolean(),
  manual: z.boolean().nullable(),
  pac: z.boolean(),
  autoDetect: z.boolean().nullable(),
});
const adapterSchema = z.strictObject({
  index,
  description: z.string().max(1024),
  hardware: z.boolean(),
  up: z.boolean(),
});
const interfaceSchema = z.strictObject({ index, family, connected: z.boolean() });
const routeSchema = z
  .strictObject({
    index,
    family,
    destination: z.string().max(64),
    nextHop: z.string().max(64),
    state: z.enum(["Alive", "Dead", "Probe"]),
  })
  .refine((route) => {
    const match = /^([^/%]+)\/(0|[1-9]\d{0,2})$/.exec(route.destination);
    const version = route.family === "IPv4" ? 4 : 6;
    return (
      !!match &&
      isIP(match[1]) === version &&
      Number(match[2]) <= (version === 4 ? 32 : 128) &&
      isIP(route.nextHop) === version &&
      !route.nextHop.includes("%")
    );
  });
const networkSchema = z.strictObject({
  adapters: z.array(adapterSchema).max(256),
  interfaces: z.array(interfaceSchema).max(512),
  routes: z.array(routeSchema).max(1024),
});
const passSchema = z.strictObject({
  // Null means a read error. A missing registry key is represented by keyExists:false instead.
  api: apiSchema.nullable(),
  registry: registrySchema.nullable(),
  network: networkSchema.nullable(),
});
const responseSchema = z.strictObject({ before: passSchema, after: passSchema });
const scopeSchema = z.strictObject({ mihomoTun: z.boolean().nullable().optional() });
type Pass = z.infer<typeof passSchema>;
type Route = z.infer<typeof routeSchema>;

export type WindowsProxyReason =
  | "SYSTEM_PROXY_ENABLED"
  | "PAC_CONFIGURED"
  | "AUTO_DETECT_ENABLED"
  | "MIHOMO_TUN_ENABLED"
  | "ACTIVE_TUNNEL"
  | "MIHOMO_TUN_UNKNOWN"
  | "SYSTEM_PROXY_UNAVAILABLE"
  | "OS_NETWORK_UNAVAILABLE"
  | "UNSUPPORTED_VIRTUAL_ROUTE"
  | "SNAPSHOT_CHANGED"
  | "NO_PROXY_DETECTED"
  | "READ_UNAVAILABLE"
  | "READ_CANCELLED"
  | "READ_TIMEOUT"
  | "UNSUPPORTED_PLATFORM"
  | "INPUT_INVALID"
  | "DISPOSED";

export interface WindowsProxyStateScope {
  /** Current caller-owned observation, not a stored setting. Omit if no mihomo observation is supplied. */
  readonly mihomoTun?: boolean | null;
}
export interface WindowsProxyStateSnapshot {
  /** Configured/observed activity, not a claim that every request is proxied or that inactive is CN. */
  readonly state: "active" | "inactive" | "unknown";
  readonly reasons: readonly WindowsProxyReason[];
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}
export interface WindowsProxyStateReaderOptions {
  /** Isolated tests only. Production runs a fixed read-only program and never evaluates caller input. */
  runner?: (signal: AbortSignal) => Promise<string>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

// WinHttpGetIEProxyConfigForCurrentUser reads the active connection's current-user settings;
// it neither fetches PAC nor performs WPAD. Native strings are freed without exporting their content.
// https://learn.microsoft.com/windows/win32/api/winhttp/nf-winhttp-winhttpgetieproxyconfigforcurrentuser
const READ_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public sealed class ClipdockUserProxyFlags {
  public bool Manual; public bool Pac; public bool AutoDetect;
}
public static class ClipdockUserProxyRead {
  [StructLayout(LayoutKind.Sequential)] private struct Config {
    [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
    public IntPtr AutoConfigUrl; public IntPtr Proxy; public IntPtr Bypass;
  }
  [DllImport("winhttp.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool WinHttpGetIEProxyConfigForCurrentUser(ref Config config);
  [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr value);
  private static bool Nonempty(IntPtr value) { return value != IntPtr.Zero && Marshal.ReadInt16(value) != 0; }
  public static ClipdockUserProxyFlags Read() {
    var config = new Config();
    try {
      if (!WinHttpGetIEProxyConfigForCurrentUser(ref config)) throw new InvalidOperationException("PROXY_READ_UNAVAILABLE");
      return new ClipdockUserProxyFlags { Manual = Nonempty(config.Proxy), Pac = Nonempty(config.AutoConfigUrl), AutoDetect = config.AutoDetect };
    } finally {
      if (config.AutoConfigUrl != IntPtr.Zero) GlobalFree(config.AutoConfigUrl);
      if (config.Proxy != IntPtr.Zero) GlobalFree(config.Proxy);
      if (config.Bypass != IntPtr.Zero) GlobalFree(config.Bypass);
    }
  }
}
'@
function Read-ClipdockRegistryProxy {
  $clipdockKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Internet Settings', $false)
  if ($null -eq $clipdockKey) { return [ordered]@{ keyExists = $false; manual = $null; pac = $false; autoDetect = $null } }
  try {
    $clipdockFlags = @{}
    foreach ($clipdockName in @('ProxyEnable', 'AutoDetect')) {
      $clipdockValue = $clipdockKey.GetValue($clipdockName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -eq $clipdockValue) { $clipdockFlags[$clipdockName] = $null; continue }
      if ($clipdockKey.GetValueKind($clipdockName) -ne [Microsoft.Win32.RegistryValueKind]::DWord -or $clipdockValue -notin @(0, 1)) { throw 'PROXY_READ_UNAVAILABLE' }
      $clipdockFlags[$clipdockName] = ($clipdockValue -eq 1)
    }
    $clipdockPac = $clipdockKey.GetValue('AutoConfigURL', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $clipdockPac -and $clipdockPac -isnot [string]) { throw 'PROXY_READ_UNAVAILABLE' }
    [ordered]@{ keyExists = $true; manual = $clipdockFlags['ProxyEnable']; pac = ($null -ne $clipdockPac -and $clipdockPac.Length -gt 0); autoDetect = $clipdockFlags['AutoDetect'] }
  } finally { $clipdockKey.Dispose() }
}
function Read-ClipdockProxyNetwork {
  $clipdockAdapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
  $clipdockInterfaces = @(Get-NetIPInterface -PolicyStore ActiveStore -ErrorAction Stop)
  $clipdockRoutes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop)
  if ($clipdockAdapters.Count -gt 256 -or $clipdockInterfaces.Count -gt 512 -or $clipdockRoutes.Count -gt 1024) { throw 'NETWORK_READ_UNAVAILABLE' }
  [ordered]@{
    adapters = @($clipdockAdapters | ForEach-Object {
      if ($null -eq $_.ifIndex -or $null -eq $_.InterfaceDescription -or $null -eq $_.Status -or $_.HardwareInterface -isnot [bool]) { throw 'NETWORK_READ_UNAVAILABLE' }
      [ordered]@{ index = [long]$_.ifIndex; description = [string]$_.InterfaceDescription; hardware = [bool]$_.HardwareInterface; up = ($_.Status -eq 'Up') }
    })
    interfaces = @($clipdockInterfaces | ForEach-Object {
      if ($null -eq $_.InterfaceIndex -or $null -eq $_.AddressFamily -or $_.ConnectionState -notin @('Connected', 'Disconnected')) { throw 'NETWORK_READ_UNAVAILABLE' }
      [ordered]@{ index = [long]$_.InterfaceIndex; family = [string]$_.AddressFamily; connected = ($_.ConnectionState -eq 'Connected') }
    })
    routes = @($clipdockRoutes | ForEach-Object {
      if ($null -eq $_.InterfaceIndex -or $null -eq $_.AddressFamily -or $null -eq $_.DestinationPrefix -or $null -eq $_.NextHop -or $null -eq $_.State) { throw 'NETWORK_READ_UNAVAILABLE' }
      [ordered]@{ index = [long]$_.InterfaceIndex; family = [string]$_.AddressFamily; destination = [string]$_.DestinationPrefix; nextHop = [string]$_.NextHop; state = [string]$_.State }
    })
  }
}
function Read-ClipdockProxyPass {
  $clipdockApi = $null; $clipdockRegistry = $null; $clipdockNetwork = $null
  try { $clipdockRead = [ClipdockUserProxyRead]::Read(); $clipdockApi = [ordered]@{ manual = $clipdockRead.Manual; pac = $clipdockRead.Pac; autoDetect = $clipdockRead.AutoDetect } } catch {}
  try { $clipdockRegistry = Read-ClipdockRegistryProxy } catch {}
  # Explicit manual/PAC configuration already proves proxy-on. Re-read these
  # flags in the second pass, but avoid expensive adapter/route enumeration.
  # Proxy-off still requires the complete network/tunnel observations.
  if (-not ($clipdockApi.manual -or $clipdockApi.pac -or $clipdockRegistry.manual -or $clipdockRegistry.pac)) {
    try { $clipdockNetwork = Read-ClipdockProxyNetwork } catch {}
  }
  [ordered]@{ api = $clipdockApi; registry = $clipdockRegistry; network = $clipdockNetwork }
}
$clipdockBefore = Read-ClipdockProxyPass
$clipdockAfter = Read-ClipdockProxyPass
[ordered]@{ before = $clipdockBefore; after = $clipdockAfter } | ConvertTo-Json -Depth 7 -Compress
`;

function runFixedRead(signal: AbortSignal): Promise<string> {
  return windowsReadBatch.read(READ_SCRIPT, signal);
}

function snapshot(
  state: WindowsProxyStateSnapshot["state"],
  reasons: WindowsProxyReason[],
  startedAtMono: number,
  completedAtMono = performance.now(),
): WindowsProxyStateSnapshot {
  return Object.freeze({
    state,
    reasons: Object.freeze([...new Set(reasons)]),
    startedAtMono,
    completedAtMono,
  });
}
function passKey(pass: Pass): string {
  const network = pass.network;
  const sorted = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
  return JSON.stringify({
    ...pass,
    network: network && {
      adapters: sorted(network.adapters),
      interfaces: sorted(network.interfaces),
      routes: sorted(network.routes),
    },
  });
}
function localOnly(route: Route): boolean {
  const [address, length] = route.destination.split("/");
  const bits = Number(length);
  if (route.family === "IPv4") {
    const first = Number(address.split(".")[0]);
    return (
      (first === 127 && bits >= 8) ||
      (first >= 224 && bits >= 4) ||
      (address.startsWith("169.254.") && bits >= 16)
    );
  }
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return (
    (canonical === "::1" && bits === 128) ||
    (/^ff/i.test(canonical) && bits >= 8) ||
    (/^fe[89ab]/i.test(canonical) && bits >= 10)
  );
}
function privateOnLink(route: Route): boolean {
  if (!["0.0.0.0", "::"].includes(route.nextHop)) return false;
  const [address, length] = route.destination.split("/");
  const bits = Number(length);
  if (route.family === "IPv6") return /^f[cd]/i.test(address) && bits >= 7;
  const [first, second] = address.split(".").map(Number);
  return (
    (first === 10 && bits >= 8) ||
    (first === 172 && second >= 16 && second <= 31 && bits >= 12) ||
    (first === 192 && second === 168 && bits >= 16)
  );
}
function project(
  pass: Pass,
  scope: WindowsProxyStateScope,
  started: number,
  completed: number,
): WindowsProxyStateSnapshot {
  const active: WindowsProxyReason[] = [];
  const unknown: WindowsProxyReason[] = [];
  if (scope.mihomoTun === true) active.push("MIHOMO_TUN_ENABLED");
  if (scope.mihomoTun === null) unknown.push("MIHOMO_TUN_UNKNOWN");
  if (pass.api?.manual || pass.registry?.manual) active.push("SYSTEM_PROXY_ENABLED");
  if (pass.api?.pac || pass.registry?.pac) active.push("PAC_CONFIGURED");
  // Windows' automatic detection checkbox alone does not enable a proxy.
  // Explicit manual/PAC settings and active tunnel interfaces decide the switch.
  if (!pass.api || !pass.registry) unknown.push("SYSTEM_PROXY_UNAVAILABLE");
  const network = pass.network;
  if (!network) unknown.push("OS_NETWORK_UNAVAILABLE");
  else {
    const adapters = new Map(network.adapters.map((row) => [row.index, row]));
    const interfaces = new Map(network.interfaces.map((row) => [`${row.index}/${row.family}`, row]));
    if (adapters.size !== network.adapters.length || interfaces.size !== network.interfaces.length)
      unknown.push("OS_NETWORK_UNAVAILABLE");
    else {
      // Names only identify known tunnel clues; arbitrary virtual NICs are never labelled proxy solely by existence.
      const known =
        /(?:^|[^a-z])(?:wintun|wireguard|tap-windows|openvpn|mihomo|clash|meta[ -]+tunnel)(?:[^a-z]|$)/i;
      for (const adapter of network.adapters) {
        if (
          !adapter.hardware &&
          adapter.up &&
          known.test(adapter.description) &&
          network.interfaces.some((item) => item.index === adapter.index && item.connected)
        )
          active.push("ACTIVE_TUNNEL");
      }
      for (const route of network.routes) {
        if (route.state === "Dead" || localOnly(route)) continue;
        const iface = interfaces.get(`${route.index}/${route.family}`);
        if (!iface) {
          unknown.push("OS_NETWORK_UNAVAILABLE");
          continue;
        }
        if (!iface.connected) continue;
        const adapter = adapters.get(route.index);
        if (!adapter) {
          unknown.push("UNSUPPORTED_VIRTUAL_ROUTE");
          continue;
        }
        if (!adapter.up) {
          unknown.push("OS_NETWORK_UNAVAILABLE");
          continue;
        }
        // An unrecognised VPN can itself use private on-link routes. The benign exception is
        // limited to the ordinary Hyper-V adapter shape, not every virtual NIC without a default.
        const isolatedHyperV =
          /^Hyper-V Virtual Ethernet Adapter(?: #\d+)?$/i.test(adapter.description) && privateOnLink(route);
        if (!adapter.hardware && !known.test(adapter.description) && !isolatedHyperV)
          unknown.push("UNSUPPORTED_VIRTUAL_ROUTE");
      }
    }
  }
  return active.length
    ? snapshot("active", active, started, completed)
    : unknown.length
      ? snapshot("unknown", unknown, started, completed)
      : snapshot("inactive", ["NO_PROXY_DETECTED"], started, completed);
}

type RawResult = { value: Pass; started: number; completed: number } | { failure: WindowsProxyStateSnapshot };

/** Main-process only. No caching, PAC execution, controller HTTP or settings mutation. */
export class WindowsProxyStateReader {
  private readonly options: Readonly<WindowsProxyStateReaderOptions>;
  private readonly timeoutMs: number;
  private pending: Promise<RawResult> | null = null;
  private controller: AbortController | null = null;
  private readonly draining = new Set<Promise<void>>();
  private readonly subscriptions = new Map<AbortSignal, () => void>();
  private disposed = false;

  constructor(options: WindowsProxyStateReaderOptions = {}) {
    this.options = Object.freeze({ ...options });
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > TIMEOUT_MS)
      throw new Error("WINDOWS_PROXY_OPTIONS_INVALID");
  }

  /** Joined reads share OS work; supplied mihomo observations are independently snapshotted. Any caller abort cancels the batch. */
  read(scope: WindowsProxyStateScope = {}, signal?: AbortSignal): Promise<WindowsProxyStateSnapshot> {
    const started = performance.now();
    if (this.disposed || signal?.aborted)
      return Promise.resolve(snapshot("unknown", [this.disposed ? "DISPOSED" : "READ_CANCELLED"], started));
    const parsed = scopeSchema.safeParse(scope);
    if (!parsed.success) return Promise.resolve(snapshot("unknown", ["INPUT_INVALID"], started));
    if ((this.options.platform ?? process.platform) !== "win32")
      return Promise.resolve(snapshot("unknown", ["UNSUPPORTED_PLATFORM"], started));
    if (!this.pending) this.start(started);
    this.subscribe(signal);
    const batchController = this.controller;
    return this.pending!.then((result) => {
      if (this.disposed || signal?.aborted)
        return snapshot("unknown", [this.disposed ? "DISPOSED" : "READ_CANCELLED"], started);
      if (batchController?.signal.aborted)
        return snapshot(
          "unknown",
          [batchController.signal.reason === "READ_TIMEOUT" ? "READ_TIMEOUT" : "READ_CANCELLED"],
          started,
        );
      return "failure" in result
        ? result.failure
        : project(result.value, parsed.data, result.started, result.completed);
    });
  }
  dispose(): void {
    this.disposed = true;
    this.controller?.abort("DISPOSED");
  }
  async whenIdle(): Promise<void> {
    while (this.draining.size) await Promise.allSettled([...this.draining]);
  }
  private subscribe(signal?: AbortSignal): void {
    if (!signal || this.subscriptions.has(signal)) return;
    const abort = () => this.controller?.abort("READ_CANCELLED");
    this.subscriptions.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  private start(started: number): void {
    const controller = new AbortController();
    this.controller = controller;
    const cancellation = new Promise<RawResult>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          resolve({
            failure: snapshot(
              "unknown",
              [
                this.disposed
                  ? "DISPOSED"
                  : controller.signal.reason === "READ_TIMEOUT"
                    ? "READ_TIMEOUT"
                    : "READ_CANCELLED",
              ],
              started,
            ),
          }),
        { once: true },
      );
    });
    const timeout = setTimeout(() => controller.abort("READ_TIMEOUT"), this.timeoutMs);
    // Defer DI invocation until the pending slot and drain reservation have been installed.
    const work = Promise.resolve().then(async (): Promise<RawResult> => {
      try {
        if (controller.signal.aborted) throw new Error();
        const raw = await (this.options.runner ?? runFixedRead)(controller.signal);
        if (controller.signal.aborted || this.disposed) throw new Error();
        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error();
        const response = responseSchema.parse(JSON.parse(raw));
        if (passKey(response.before) !== passKey(response.after))
          return { failure: snapshot("unknown", ["SNAPSHOT_CHANGED"], started) };
        return { value: response.after, started, completed: performance.now() };
      } catch {
        return {
          failure: snapshot(
            "unknown",
            [
              this.disposed
                ? "DISPOSED"
                : controller.signal.aborted
                  ? controller.signal.reason === "READ_TIMEOUT"
                    ? "READ_TIMEOUT"
                    : "READ_CANCELLED"
                  : "READ_UNAVAILABLE",
            ],
            started,
          ),
        };
      }
    });
    const pending = Promise.race([work, cancellation]).finally(() => clearTimeout(timeout));
    this.pending = pending;
    const drain = Promise.allSettled([work, pending]).then(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.controller = null;
        for (const [signal, callback] of this.subscriptions) signal.removeEventListener("abort", callback);
        this.subscriptions.clear();
      }
    });
    this.draining.add(drain);
    void drain.then(() => this.draining.delete(drain));
  }
}
