import type { GlobalAccount } from "@shared/global-accounts";
import { globalAccountIdSchema } from "@shared/global-accounts";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalWebErrorCode, GlobalWebState } from "@shared/global-web";
import type { GlobalOAuthEligibility } from "@main/api/global-oauth-service";
import {
  claimGlobalBrowserProfile,
  configureGlobalBrowserProfile,
  wipeGlobalBrowserProfile,
  type GlobalBrowserProfile,
} from "@main/browser/global-browser-profile";
import {
  launchGlobalBrowser,
  type GlobalBrowserLaunchInput,
  type ManagedGlobalBrowser,
} from "@main/browser/global-browser-launcher";
import { GlobalWebRelay, type GlobalWebRelayOptions } from "@main/network/global-web-relay";
import { GLOBAL_WEB_ENTRY_URLS, isGlobalWebHost } from "@main/network/global-web-target-policy";
import type { GlobalWebTunnel, GlobalWebTunnelInput } from "@main/network/global-web-tunnel";
import type { ViewBounds } from "@shared/types";
import type { GlobalWebCapability } from "@shared/global-platforms";
import { parseWebObservation } from "@main/data/global-web-observation";
import { webObserveErrorCode, type WebObservation } from "@shared/global-web-observation";

interface Relay {
  start(): Promise<Readonly<{ host: "127.0.0.1"; port: number }>>;
  dispose(): Promise<void>;
}
export interface GlobalWebServiceOptions {
  observations?: {
    get(id: string): WebObservation | null;
    history?(id: string): WebObservation[];
    save(value: WebObservation): void;
  };
  setBrowserEngine?(id: string, engine: "chrome" | "embedded"): void;
  readonly dataDirectory: string;
  /** Main-only website transport. API clients retain their independent verified relay. */
  readonly transport?: "relay" | "system";
  getAccount(id: string): GlobalAccount | undefined;
  acquireEligibility(
    platformId: GlobalPlatformId,
    signal: AbortSignal,
  ): Promise<GlobalOAuthEligibility | null>;
  openTunnel(input: GlobalWebTunnelInput): Promise<GlobalWebTunnel>;
  onChanged?(state: GlobalWebState): void;
  wipeEmbedded?(id: string): Promise<void>;
}
/** Main-only seams for controlled tests. They are never selectable by IPC or settings. */
interface Dependencies {
  claim?: typeof claimGlobalBrowserProfile;
  configure?: typeof configureGlobalBrowserProfile;
  launch?(input: GlobalBrowserLaunchInput): Promise<ManagedGlobalBrowser>;
  launchChrome?(input: GlobalBrowserLaunchInput): Promise<ManagedGlobalBrowser>;
  relay?(options: GlobalWebRelayOptions): Relay;
  wipe?: typeof wipeGlobalBrowserProfile;
}
interface Entry {
  accountId: string;
  platformId: GlobalPlatformId;
  abort: AbortController;
  opening: Promise<void>;
  cleanup: Promise<void> | null;
  stopping: boolean;
  terminal: "closed" | "dormant" | "error";
  errorCode: GlobalWebErrorCode | null;
  eligibility: GlobalOAuthEligibility | null;
  revoke: () => void;
  profile: GlobalBrowserProfile | null;
  relay: Relay | null;
  browser: ManagedGlobalBrowser | null;
  external: boolean;
}
const unavailable = () => new Error("GLOBAL_WEB_UNAVAILABLE");
const initial = (accountId: string): GlobalWebState => ({ accountId, phase: "closed", errorCode: null });

/** Website process state is separate from API authorization. No cookie, URL, process
 * command line or directory is ever returned to the renderer. Network loss revokes
 * the relay synchronously; cleanup completion is a barrier before profile reuse.
 */
export class GlobalWebService {
  private readonly reading = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private readonly history = new Map<string, GlobalWebState>();
  private disposed = false;
  private readonly deleting = new Set<string>();
  constructor(
    private readonly options: GlobalWebServiceOptions,
    private readonly dependencies: Dependencies = {},
  ) {}

  state(id: string): GlobalWebState {
    if (!globalAccountIdSchema.safeParse(id).success || !this.options.getAccount(id)) throw unavailable();
    return { ...(this.history.get(id) ?? initial(id)) };
  }
  observation(id: string): WebObservation | null {
    this.state(id);
    return this.options.observations?.get(id) ?? null;
  }
  observationHistory(id: string): WebObservation[] {
    this.state(id);
    return this.options.observations?.history?.(id) ?? [];
  }
  async readPage(id: string): Promise<WebObservation> {
    this.state(id);
    if (this.reading.has(id)) throw new Error("WEB_OBSERVE_BUSY");
    const entry = this.entries.get(id);
    if (!entry?.browser || this.state(id).phase !== "open") throw new Error("WEB_OBSERVE_CLOSED");
    const browser = entry.browser;
    if (!browser.readPage) throw new Error("WEB_OBSERVE_UNAVAILABLE");
    this.reading.add(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      try {
        this.assertCurrent(entry);
      } catch {
        throw new Error("WEB_OBSERVE_CANCELLED");
      }
      if (this.entries.get(id) !== entry || entry.browser !== browser)
        throw new Error("WEB_OBSERVE_CANCELLED");
    };
    try {
      check();
      const raw = await Promise.race([
        browser.readPage(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("WEB_OBSERVE_UNAVAILABLE")), 6500);
        }),
      ]);
      check();
      const snapshot = parseWebObservation(id, entry.platformId, browser.engine ?? "embedded", raw);
      check();
      this.options.observations?.save(snapshot);
      return snapshot;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Raw website/native errors remain in main.
      throw new Error(webObserveErrorCode(error));
    } finally {
      clearTimeout(timer);
      this.reading.delete(id);
    }
  }
  private publish(entry: Entry, phase: GlobalWebState["phase"], errorCode: GlobalWebErrorCode | null = null) {
    const page = entry.browser?.getPageState?.();
    let displayUrl = "";
    try {
      const url = new URL(page?.url ?? "");
      if (url.protocol === "https:") displayUrl = url.origin + url.pathname;
    } catch {
      /* no committed page yet */
    }
    const state = {
      ...(page
        ? {
            displayUrl,
            title: page.title.slice(0, 200),
            loading: phase === "open" && page.loading,
            canGoBack: page.canGoBack,
            canGoForward: page.canGoForward,
          }
        : {}),
      accountId: entry.accountId,
      phase,
      errorCode,
      ...(entry.browser ? { embedded: !!entry.browser.show } : {}),
      ...(entry.browser?.engine ? { engine: entry.browser.engine } : {}),
    };
    this.history.set(entry.accountId, state);
    try {
      this.options.onChanged?.({ ...state });
    } catch {
      /* Projection cannot grant network access. */
    }
  }
  private assertCurrent(entry: Entry) {
    const account = this.options.getAccount(entry.accountId);
    if (
      this.disposed ||
      entry.stopping ||
      entry.abort.signal.aborted ||
      !account ||
      account.platformId !== entry.platformId ||
      !entry.eligibility ||
      entry.eligibility.signal.aborted ||
      !entry.eligibility.isCurrent()
    )
      throw unavailable();
  }
  async open(id: string, external = false, chrome = false): Promise<GlobalWebState> {
    this.state(id);
    if (this.disposed || this.deleting.has(id)) throw unavailable();
    if (chrome && (this.options.transport !== "system" || !this.dependencies.launchChrome))
      throw unavailable();
    if (this.options.transport === "system" && (external || !this.dependencies.launch)) throw unavailable();
    const existing = this.entries.get(id);
    if (existing) {
      await existing.opening;
      // A revocation or explicit close can race a second open request. Wait for
      // the cleanup barrier before reporting the state so callers cannot observe
      // a still closing profile and immediately try to reuse its Chrome directory.
      const cleanup = existing.cleanup;
      if (cleanup) await cleanup;
      return this.state(id);
    }
    if (this.entries.size >= 6) throw new Error("GLOBAL_WEB_BUSY");
    const account = this.options.getAccount(id)!;
    const entry: Entry = {
      accountId: id,
      platformId: account.platformId,
      abort: new AbortController(),
      opening: Promise.resolve(),
      cleanup: null,
      stopping: false,
      terminal: "closed",
      errorCode: null,
      eligibility: null,
      revoke: () => this.beginClose(entry, "dormant", "GLOBAL_WEB_PROXY_UNVERIFIED"),
      profile: null,
      relay: null,
      browser: null,
      external,
    };
    this.entries.set(id, entry);
    this.publish(entry, "checking");
    entry.opening = Promise.resolve().then(async () => {
      try {
        entry.eligibility = await this.options.acquireEligibility(entry.platformId, entry.abort.signal);
        if (!entry.eligibility || entry.eligibility.signal.aborted || !entry.eligibility.isCurrent()) {
          entry.terminal = "dormant";
          entry.errorCode = "GLOBAL_WEB_PROXY_UNVERIFIED";
          throw unavailable();
        }
        entry.eligibility.signal.addEventListener("abort", entry.revoke, { once: true });
        this.assertCurrent(entry);
        if (this.options.transport === "system") {
          this.publish(entry, "opening");
          entry.browser = await (chrome ? this.dependencies.launchChrome! : this.dependencies.launch!)({
            transport: "system",
            accountId: id,
            platformId: entry.platformId,
            signal: entry.abort.signal,
            assertCurrent: () => this.assertCurrent(entry),
          });
        } else {
          // Avoid opening an error page when even this platform's entry route is unqualified.
          // This probe sends no TLS/HTTP/Cookie; every later browser CONNECT still needs its own permit.
          let preflight: GlobalWebTunnel | undefined;
          try {
            preflight = await this.options.openTunnel({
              platformId: entry.platformId,
              host: new URL(GLOBAL_WEB_ENTRY_URLS[entry.platformId]).hostname,
              signal: entry.abort.signal,
              assertCurrent: () => this.assertCurrent(entry),
            });
          } catch {
            if (!entry.stopping) {
              entry.terminal = "dormant";
              entry.errorCode = "GLOBAL_WEB_PROXY_UNVERIFIED";
            }
            throw unavailable();
          } finally {
            preflight?.close();
            await preflight?.closed;
          }
          this.assertCurrent(entry);
          this.publish(entry, "opening");
          entry.profile = await (this.dependencies.claim ?? claimGlobalBrowserProfile)({
            dataDirectory: this.options.dataDirectory,
            accountId: id,
            platformId: entry.platformId,
          });
          this.assertCurrent(entry);
          await (this.dependencies.configure ?? configureGlobalBrowserProfile)(entry.profile);
          this.assertCurrent(entry);
          const relayOptions: GlobalWebRelayOptions = {
            platformId: entry.platformId,
            signal: entry.abort.signal,
            assertCurrent: () => this.assertCurrent(entry),
            allowTarget: isGlobalWebHost,
            openTunnel: (input) => this.options.openTunnel(input),
          };
          entry.relay = this.dependencies.relay?.(relayOptions) ?? new GlobalWebRelay(relayOptions);
          const endpoint = await entry.relay.start();
          this.assertCurrent(entry);
          entry.browser = await (
            external ? launchGlobalBrowser : (this.dependencies.launch ?? launchGlobalBrowser)
          )({
            platformId: entry.platformId,
            profile: entry.profile,
            endpoint,
            signal: entry.abort.signal,
            assertCurrent: () => this.assertCurrent(entry),
          });
        }
        void entry.browser.closed.then(
          () => this.beginClose(entry, "closed"),
          () => this.beginClose(entry, "error", "GLOBAL_WEB_BROWSER_UNAVAILABLE"),
        );
        this.assertCurrent(entry);
        entry.browser.onPageState?.(() => {
          if (this.entries.get(id) !== entry || entry.stopping) return;
          try {
            this.assertCurrent(entry);
            this.publish(entry, "open");
          } catch {
            /* revoked */
          }
        });
        this.options.setBrowserEngine?.(id, chrome ? "chrome" : "embedded");
        this.publish(entry, "open");
      } catch (error) {
        if (!entry.stopping) {
          const code: GlobalWebErrorCode =
            entry.errorCode ??
            (error instanceof Error &&
            /GLOBAL_BROWSER_(?:PROFILE_BUSY|PROCESS_UNAVAILABLE)/.test(error.message)
              ? "GLOBAL_WEB_PROFILE_BUSY"
              : "GLOBAL_WEB_BROWSER_UNAVAILABLE");
          this.beginClose(entry, entry.terminal === "dormant" ? "dormant" : "error", code);
        }
      }
    });
    await entry.opening;
    await entry.cleanup;
    return this.state(id);
  }
  private beginClose(
    entry: Entry,
    terminal: Entry["terminal"],
    errorCode: GlobalWebErrorCode | null = null,
  ): void {
    if (entry.stopping) return;
    entry.stopping = true;
    entry.terminal = terminal;
    entry.errorCode = errorCode;
    entry.abort.abort(); // Closes the relay/streams before any asynchronous cleanup.
    this.publish(entry, "closing", errorCode);
    this.cleanup(entry);
  }
  private cleanup(entry: Entry): void {
    if (entry.cleanup) return;
    entry.cleanup = Promise.resolve()
      .then(async () => {
        await entry.opening;
        entry.eligibility?.signal.removeEventListener("abort", entry.revoke);
        entry.eligibility?.release();
        const results = await Promise.allSettled([entry.relay?.dispose(), entry.browser?.stop()]);
        let failed = results.some((result) => result.status === "rejected");
        if (!failed && entry.profile) {
          try {
            await entry.profile.release();
          } catch {
            failed = true;
          }
        }
        if (failed) {
          this.publish(entry, "error", "GLOBAL_WEB_CLEANUP_FAILED");
          return; // Retain the claimed profile and handles for an explicit cleanup retry.
        }
        this.entries.delete(entry.accountId);
        this.publish(entry, entry.terminal, entry.errorCode);
      })
      .catch(() => {
        this.publish(entry, "error", "GLOBAL_WEB_CLEANUP_FAILED");
      })
      .finally(() => {
        entry.cleanup = null;
      });
  }
  async close(id: string): Promise<GlobalWebState> {
    this.state(id);
    const entry = this.entries.get(id);
    if (entry) {
      if (!entry.stopping) this.beginClose(entry, "closed");
      else this.cleanup(entry);
      await entry.cleanup;
      if (this.entries.has(id)) throw new Error("GLOBAL_WEB_CLEANUP_FAILED");
    }
    return this.state(id);
  }
  async beforeDelete(id: string): Promise<void> {
    if (!this.options.getAccount(id)) return;
    if (this.deleting.has(id)) throw unavailable();
    this.deleting.add(id);
    try {
      await this.close(id);
      await this.options.wipeEmbedded?.(id);
      await (this.dependencies.wipe ?? wipeGlobalBrowserProfile)(
        this.options.dataDirectory,
        id,
        this.options.getAccount(id)!.platformId,
      );
      this.history.delete(id);
    } finally {
      this.deleting.delete(id);
    }
  }
  async ensureOpen(id: string): Promise<GlobalWebState> {
    const state = this.state(id);
    if (state.phase === "open") return state;
    const account = this.options.getAccount(id)!;
    return account.browserEngine === "chrome" ? this.openChrome(id) : this.open(id);
  }
  async withBrowser<T>(
    id: string,
    run: (browser: ManagedGlobalBrowser, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry?.browser || this.state(id).phase !== "open") throw new Error("WEB_OBSERVE_CLOSED");
    const browser = entry.browser;
    const check = () => {
      this.assertCurrent(entry);
      if (entry.browser !== browser || this.entries.get(id) !== entry)
        throw new Error("WEB_OBSERVE_CANCELLED");
    };
    check();
    const result = await run(browser, check);
    check();
    return result;
  }
  async resetEnvironment(id: string): Promise<void> {
    await this.beforeDelete(id);
  }
  async openExternal(id: string): Promise<GlobalWebState> {
    if (this.options.transport === "system") throw unavailable();
    await this.close(id);
    return this.open(id, true);
  }
  async openChrome(id: string): Promise<GlobalWebState> {
    if (this.options.transport !== "system" || !this.dependencies.launchChrome) throw unavailable();
    if (this.state(id).phase === "open" && this.state(id).engine === "chrome") return this.state(id);
    await this.close(id);
    return this.open(id, false, true);
  }
  show(id: string, bounds: ViewBounds): void {
    this.state(id);
    const entry = this.entries.get(id);
    if (entry?.browser?.show) {
      this.assertCurrent(entry);
      entry.browser.show(bounds);
    }
  }
  hide(id: string): void {
    this.entries.get(id)?.browser?.hide?.();
  }
  async go(id: string, capability: GlobalWebCapability): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.browser?.go) throw new Error("GLOBAL_WEB_ROUTE_UNAVAILABLE");
    this.assertCurrent(entry);
    await entry.browser.go(capability);
  }
  command(id: string, command: "back" | "forward" | "reload"): void | Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.browser?.command) throw unavailable();
    this.assertCurrent(entry);
    return entry.browser.command(command);
  }
  invalidate(): void {
    for (const entry of this.entries.values())
      this.beginClose(entry, "dormant", "GLOBAL_WEB_PROXY_UNVERIFIED");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
    if (results.some((result) => result.status === "rejected") || this.entries.size)
      throw new Error("GLOBAL_WEB_CLEANUP_FAILED");
  }
}
