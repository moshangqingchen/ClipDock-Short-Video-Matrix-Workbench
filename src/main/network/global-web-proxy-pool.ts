import { ProxyTunnelReader } from "@main/api/proxy-tunnel-reader";
import { ProxyTunnelAuthorizer, type ProxyTunnelAuthorityState } from "@main/api/proxy-tunnel-authorizer";
import type { ProxyTransportLease, ProxyTunnelContext } from "@main/api/proxy-transport";
import {
  GlobalWebTunnelTransport,
  GlobalWebTunnelError,
  type GlobalWebTunnel,
  type GlobalWebTunnelInput,
} from "./global-web-tunnel";
import { isDomesticWebHost } from "./domestic-web-target-policy";
import { isGlobalWebHost } from "./global-web-target-policy";
import type { WindowsTunnelOwnership } from "./windows-tunnel-ownership";

interface ProofSession {
  authorize(context: ProxyTunnelContext, signal: AbortSignal): Promise<ProxyTransportLease | null>;
  renew(
    context: ProxyTunnelContext,
    previous: ProxyTransportLease,
    signal: AbortSignal,
  ): Promise<ProxyTransportLease | null>;
  invalidate(): void;
  whenIdle(): Promise<void>;
  dispose(): Promise<void>;
}
export interface GlobalWebProxyPoolOptions {
  domesticDirect?: boolean;
  ownership?: WindowsTunnelOwnership;
  proxy: Readonly<{ host: string; port: number }>;
  controllerUrl: string;
  getSecret(): string | null;
  readVersion(): { generation: number; revision: string } | null;
  readAuthority(): ProxyTunnelAuthorityState | null;
  subscribe(listener: () => void): () => void;
  /** Controlled tests only. Production always constructs the scoped real reader and authorizer. */
  createProofSession?(): ProofSession;
}
interface Entry {
  context: ProxyTunnelContext;
  signal: AbortSignal;
  source: ProofSession;
  stop(): void;
  stopped: boolean;
  retired?: Promise<void>;
}
const fail = () => new Error("GLOBAL_WEB_PROOF_UNAVAILABLE");

/** Each live browser CONNECT has its own scoped reader. Initial/renewal reads for
 * that connection stay serialized without blocking other page resources, API work
 * or anonymous egress renewal. All streams still share the runtime's current authority.
 */
export class GlobalWebProxyPool {
  private readonly options: Readonly<GlobalWebProxyPoolOptions>;
  private readonly entries = new Map<string, Entry>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly transport: GlobalWebTunnelTransport;
  private stopped = false;
  private faulted = false;

  constructor(options: GlobalWebProxyPoolOptions) {
    this.options = Object.freeze({ ...options, proxy: Object.freeze({ ...options.proxy }) });
    this.transport = new GlobalWebTunnelTransport({
      proxy: this.options.proxy,
      allowTarget: options.domesticDirect ? isDomesticWebHost : isGlobalWebHost,
      concurrency: options.domesticDirect ? 32 : 16,
      authorize: (context, signal) => this.authorize(context, signal),
      renew: (context, previous, signal) => {
        const entry = this.entries.get(context.id);
        if (
          this.stopped ||
          this.faulted ||
          !entry ||
          entry.stopped ||
          entry.context !== context ||
          entry.signal !== signal ||
          signal.aborted
        )
          return Promise.resolve(null);
        return entry.source.renew(context, previous, signal);
      },
      // A closed socket releases its own slot after its own proof has drained.
      // Waiting for unrelated live page renewals here can exhaust every CONNECT slot.
      whenAuthorizerIdle: (context) => (context ? this.whenSourceIdle(context.id) : Promise.resolve()),
    });
  }

  async open(input: GlobalWebTunnelInput): Promise<GlobalWebTunnel> {
    const deadline = performance.now() + 4_000;
    for (;;) {
      if (this.stopped || this.faulted || input.signal.aborted) throw fail();
      input.assertCurrent();
      try {
        return await this.transport.open(input);
      } catch (error) {
        if (
          !this.options.domesticDirect ||
          !(error instanceof GlobalWebTunnelError) ||
          error.code !== "BUSY" ||
          performance.now() >= deadline
        )
          throw error;
        // Absorb bounded browser preconnect bursts; every eventual open still obtains its own proof.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async authorize(
    context: ProxyTunnelContext,
    signal: AbortSignal,
  ): Promise<ProxyTransportLease | null> {
    if (
      this.stopped ||
      this.faulted ||
      signal.aborted ||
      this.entries.has(context.id) ||
      this.entries.size >= (this.options.domesticDirect ? 32 : 16)
    )
      return null;
    const source = this.options.createProofSession?.() ?? this.createProofSession();
    const entry: Entry = { context, signal, source, stopped: false, stop: () => this.retire(entry) };
    this.entries.set(context.id, entry);
    signal.addEventListener("abort", entry.stop, { once: true });
    if (signal.aborted || this.stopped || this.faulted) {
      entry.stop();
      return null;
    }
    return source.authorize(context, signal);
  }

  private retire(entry: Entry): void {
    if (entry.stopped) return;
    entry.stopped = true;
    entry.signal.removeEventListener("abort", entry.stop);
    let complete!: () => void;
    const retired = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.retiring.add(retired);
    entry.retired = retired;
    try {
      entry.source.invalidate();
    } catch {
      this.trip();
    }
    void Promise.resolve()
      .then(() => entry.source.dispose())
      .catch(() => this.trip())
      .finally(() => {
        this.entries.delete(entry.context.id);
        this.retiring.delete(retired);
        complete();
      });
  }

  private trip(): void {
    this.faulted = true;
    this.invalidate();
  }

  private async whenSourcesIdle(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.entries.values()].map((entry) => entry.source.whenIdle()),
    );
    while (this.retiring.size) await Promise.all([...this.retiring]);
    if (outcomes.some((outcome) => outcome.status === "rejected")) this.trip();
    if (this.faulted) throw fail();
  }
  private async whenSourceIdle(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      await entry.source.whenIdle();
      await entry.retired;
    } catch {
      this.trip();
      throw fail();
    }
    if (this.faulted) throw fail();
  }

  invalidate(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.stop();
    void this.transport.dispose().catch(() => {
      this.faulted = true;
    });
  }

  async dispose(): Promise<void> {
    this.invalidate();
    const outcomes = await Promise.allSettled([this.transport.dispose(), this.whenSourcesIdle()]);
    if (this.faulted || outcomes.some((outcome) => outcome.status === "rejected")) throw fail();
  }

  private createProofSession(): ProofSession {
    const reader = new ProxyTunnelReader(
      {
        targetScope: this.options.domesticDirect ? "domestic" : "website",
        controllerUrl: this.options.controllerUrl,
        proxy: this.options.proxy,
        getSecret: this.options.getSecret,
        readVersion: this.options.readVersion,
      },
      this.options.ownership
        ? {
            controllerOwner: this.options.ownership.controller(this.options.controllerUrl),
            createAcceptedSocketReader: (scope) => this.options.ownership!.accepted(scope),
          }
        : undefined,
    );
    const authorizer = new ProxyTunnelAuthorizer({
      targetScope: this.options.domesticDirect ? "domestic" : "website",
      leaseTtlMs: this.options.domesticDirect ? 10_000 : undefined,
      readState: this.options.readAuthority,
      subscribeState: this.options.subscribe,
      readTunnel: reader.readTunnel,
      whenIdle: () => reader.whenIdle(),
    });
    return {
      authorize: authorizer.authorizeTunnel,
      renew: authorizer.renewTunnel,
      invalidate: () => {
        authorizer.invalidate();
        reader.invalidate();
      },
      whenIdle: async () => {
        await authorizer.whenIdle();
        await reader.whenIdle();
      },
      dispose: async () => {
        const outcomes = await Promise.allSettled([authorizer.dispose(), reader.dispose()]);
        if (outcomes.some((outcome) => outcome.status === "rejected")) throw fail();
      },
    };
  }
}
