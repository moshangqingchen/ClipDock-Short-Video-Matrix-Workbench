import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DownloadItem, Session } from "electron";
import {
  NETWORK_TIMING,
  type AccountNetworkState,
  type ExclusiveAccessSnapshot,
  type NetworkReason,
  type NetworkSnapshot,
} from "@shared/network";
import { isCnPlatformId, type CnPlatformId } from "@shared/platforms";
import type { BusinessNetworkController, BusinessNetworkLease } from "./business-access";
import {
  exactOriginKey,
  normalizeExactOrigin,
  resolveOperationCatalog,
  type ExactOrigin,
  type OperationCatalogRequest,
  type ResolvedOperationCatalog,
} from "./operation-catalog";
import { ensureDirectSession, ensureSystemSession } from "./direct-session";
import { proofScopeKey, proofTargetKey, type AccountProofScope, type ProofTarget } from "./direct-proof";
import { EgressGate, type GateRevocation, type RouteDecision } from "./egress-gate";

export type NetworkSession = Pick<
  Session,
  "setProxy" | "closeAllConnections" | "clearHostResolverCache" | "clearStorageData" | "on" | "removeListener"
>;

export interface SessionRegistration {
  session: NetworkSession;
  accountId: string;
  platformId: CnPlatformId;
  contextId: string;
}

/** Only main-process outer business entries declare operations; individual fetches never do. */
export interface RuntimeOperationRequest extends Omit<
  OperationCatalogRequest,
  "platformId" | "activePageOrigin"
> {
  activePageOrigin: ExactOrigin | null;
}

export interface PreparedOperationScope {
  /** Session protection only; this never waits for or implies a DirectProof. */
  ready: Promise<void>;
  contextId: string;
  scopeVersion: string;
}

/** Main-process sampler lifecycle only. No Session, page URL, or credentials are exposed. */
export type RuntimeProofScopeEvent =
  { type: "upsert"; scope: AccountProofScope } | { type: "remove"; accountId: string };

export interface OperationScopeRegistration extends SessionRegistration {
  operations: readonly OperationCatalogRequest[];
  catalogs: readonly ResolvedOperationCatalog[];
}

export interface NetworkRuntimeOptions {
  enforcement: "observe" | "strict";
  /** Session proxy mode. `system` is only used with a reviewed rule-split controller. */
  sessionProxyMode?: "direct" | "system";
  gate?: EgressGate;
  /** Main-owned verified CONNECT transport for domestic accounts in rule mode. */
  ruleSplitTransport?: {
    configureSession(entry: SessionRegistration): Promise<void>;
    allowUrl(platformId: string, url: URL): boolean;
    releaseSession?(accountId: string): void;
  };
  /** Main-process mutually exclusive policy; read is current and acquire owns monotonic expiry. */
  exclusiveAccess?: {
    read(): ExclusiveAccessSnapshot;
    acquire(): BusinessNetworkLease | null;
  };
  /** Explicit test/controlled transport seam. Production uses resolveCatalog, never observed hosts. */
  resolveScope?: (registration: OperationScopeRegistration) => AccountProofScope;
  /** Trusted main-process manifest resolver, normally createOperationCatalogResolver(reviewStore). */
  resolveCatalog?: (selection: OperationCatalogRequest) => ResolvedOperationCatalog;
  /**
   * Optional independently verified actual-family resolver. Without one, both IPv4 and IPv6 must
   * have current permits. A supplied resolver that fails/nulls never falls back to guessed families.
   */
  resolveTarget?: (input: SessionRegistration & { url: URL }) => ProofTarget | null;
  /** Verified main-process family applicability for this exact identity/origin. The same resolver
   * builds operation scopes and checks requests. Null/invalid results stay closed; no I/O or
   * implicit preparation is permitted. Absence retains both possible address families. */
  resolveFamilies?: (
    input: Pick<SessionRegistration, "accountId" | "platformId" | "contextId"> & { origin: ExactOrigin },
  ) => readonly ProofTarget["addressFamily"][] | null;
  /** Current, stable OS network observation. Strict mode defaults closed when absent/unavailable. */
  networkReadiness?: () => boolean;
  onSuspend?: (accountId: string) => void | Promise<void>;
  audit?: (event: {
    type: "GateRevoked" | "SessionProtectionFailed";
    accountId: string;
    reason: NetworkReason;
  }) => void;
}

interface SessionEntry extends SessionRegistration {
  scope: AccountProofScope | null;
  selections: OperationCatalogRequest[];
  catalogs: ResolvedOperationCatalog[];
  /** Sticky operation union is retired only by a new page selection or Session identity. */
  pageSelectionKey: string | null;
  scopeVisible: boolean;
  /** Identity tombstone: keep the Session guard after account deletion/reset. */
  retired: boolean;
  initialized: boolean;
  failed: boolean;
  ready: boolean;
  epoch: number;
  resettingGate: boolean;
  pending: Promise<void>;
  downloads: Set<DownloadItem>;
  exclusiveLeases: Set<() => void>;
  onDownload: (_event: Electron.Event, item: DownloadItem) => void;
}

function defaultScope(
  input: OperationScopeRegistration,
  resolveFamilies: (origin: ExactOrigin) => readonly ProofTarget["addressFamily"][],
): AccountProofScope {
  const origins = new Map<string, ExactOrigin>();
  for (const catalog of input.catalogs)
    for (const origin of catalog.requiredOrigins) origins.set(exactOriginKey(origin)!, origin);
  return {
    accountId: input.accountId,
    platformId: input.platformId,
    contextId: input.contextId,
    catalogVersion:
      "cn-session-operations-v1:" +
      createHash("sha256")
        .update(
          JSON.stringify(
            input.catalogs
              .map((catalog) => [
                catalog.selectionKey,
                catalog.catalogVersion,
                catalog.flowReviewed,
                catalog.executionSupported,
                catalog.requiredOrigins.map(exactOriginKey).sort(),
                catalog.reviewedRequestRange.map(exactOriginKey).sort(),
              ])
              .sort(),
          ),
        )
        .digest("hex"),
    catalogReviewed:
      input.catalogs.length > 0 &&
      input.catalogs.every((catalog) => catalog.flowReviewed && catalog.executionSupported),
    targets: [...origins.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, target]) =>
        resolveFamilies(target).map((addressFamily) => ({
          protocol: target.protocol,
          host: target.host,
          port: target.port,
          addressFamily,
        })),
      ),
  };
}

/** Session lifetime owner; never attach/detach this runtime when merely hiding or disposing a view. */
export class NetworkRuntime extends EventEmitter implements BusinessNetworkController {
  readonly enforcement: "observe" | "strict";
  readonly gate: EgressGate;
  private readonly sessions = new WeakMap<NetworkSession, SessionEntry>();
  private readonly accounts = new Map<string, SessionEntry>();
  private readonly options: NetworkRuntimeOptions;
  private readonly familyResolutions = new Set<SessionEntry>();
  private suspendHandler: (accountId: string) => void | Promise<void>;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private lastObservation: { instanceId: string; sequence: number; readKey: string | null } | null = null;
  private readonly retiredObservers = new Set<string>();
  private readonly scopeListeners = new Set<(event: RuntimeProofScopeEvent) => void>();
  private exclusiveSnapshot: ExclusiveAccessSnapshot | null = null;
  private exclusiveSyncing = false;
  private exclusiveReading = false;
  private exclusiveReadInvalidated = false;
  private readonly onGateState = () => {
    if (!this.options.exclusiveAccess) this.emit("state", this.getAccountStates());
  };
  private readonly onGateRevocation = (event: GateRevocation) => {
    const entry = this.accounts.get(event.accountId);
    if (
      this.options.exclusiveAccess ||
      !entry ||
      entry.resettingGate ||
      !event.enforce ||
      this.enforcement !== "strict"
    )
      return;
    // Gate has already closed and aborted its leases before this callback is entered.
    entry.ready = false;
    this.withdrawScope(entry);
    this.cancelDownloads(entry);
    const suspension = this.notifySuspend(entry);
    this.record("GateRevoked", entry, event.reason);
    this.protect(entry, false, event.reason, suspension);
  };

  constructor(options: NetworkRuntimeOptions) {
    super();
    if (options.resolveFamilies !== undefined && options.resolveTarget !== undefined)
      throw new Error("AMBIGUOUS_NETWORK_FAMILY_RESOLVER");
    this.options = options;
    this.enforcement = options.enforcement;
    this.gate = options.gate ?? new EgressGate({ enforcement: options.enforcement });
    if (this.gate.enforcement !== options.enforcement) throw new Error("Network enforcement mismatch");
    this.suspendHandler = options.onSuspend ?? (() => undefined);
    this.gate.on("state", this.onGateState);
    this.gate.on("revoked", this.onGateRevocation);
  }

  registerSession(
    session: NetworkSession,
    accountId: string,
    platformId: CnPlatformId,
  ): { ready: Promise<void>; contextId: string } {
    if (this.disposed || !accountId || !isCnPlatformId(platformId))
      throw new Error("Invalid domestic Session registration");
    this.syncExclusiveAccess();
    const existing = this.sessions.get(session);
    if (existing) {
      if (existing.accountId !== accountId || existing.platformId !== platformId)
        throw new Error("Session identity cannot be rebound");
      if (existing.retired) {
        // Reusing the same persistent Session after a restore is a new proof context.
        const input = { session, accountId, platformId, contextId: randomUUID() };
        const scope =
          !this.options.exclusiveAccess && this.options.resolveScope
            ? this.resolveAccountScope({ ...input, operations: [], catalogs: [] })
            : null;
        existing.contextId = input.contextId;
        existing.retired = false;
        existing.ready = false;
        existing.scope = scope;
        existing.selections = [];
        existing.catalogs = [];
        existing.pageSelectionKey = null;
        if (scope) this.gate.registerAccount(scope);
        this.protect(existing, false, "CHECKING");
      }
      return { ready: this.waitForProtection(existing), contextId: existing.contextId };
    }
    if (this.accounts.has(accountId)) throw new Error("Account Session cannot be rebound");
    const input: SessionRegistration = { session, accountId, platformId, contextId: randomUUID() };
    // Registration creates no business intent. A fresh Session stays closed until an outer entry
    // declares its real operation; only explicit controlled test scopes opt into the old seam.
    const scope =
      !this.options.exclusiveAccess && this.options.resolveScope
        ? this.resolveAccountScope({ ...input, operations: [], catalogs: [] })
        : null;
    const entry: SessionEntry = {
      ...input,
      scope,
      selections: [],
      catalogs: [],
      pageSelectionKey: null,
      scopeVisible: false,
      retired: false,
      initialized: false,
      failed: false,
      ready: this.enforcement === "observe",
      epoch: 0,
      resettingGate: false,
      pending: Promise.resolve(),
      downloads: new Set(),
      exclusiveLeases: new Set(),
      onDownload: () => undefined,
    };
    this.sessions.set(session, entry);
    this.accounts.set(accountId, entry);
    if (scope) this.gate.registerAccount(scope);
    entry.onDownload = (_event, item) => {
      entry.downloads.add(item);
      item.once("done", () => entry.downloads.delete(item));
      if (entry.retired || (this.enforcement === "strict" && !this.check(accountId).allowed)) {
        try {
          item.cancel();
        } catch {
          /* Protection remains closed even if Chromium already destroyed it. */
        }
        entry.downloads.delete(item);
      }
    };
    session.on("will-download", entry.onDownload);
    if (this.enforcement === "strict") this.protect(entry, true, "CHECKING");
    else {
      entry.initialized = true;
      this.publishScope(entry);
    }
    return { ready: this.waitForProtection(entry), contextId: entry.contextId };
  }

  /** Ready scopes only. A copy cannot widen the account's committed proof or mutate the catalog. */
  listProofScopes(): AccountProofScope[] {
    return [...this.accounts.values()]
      .filter((entry) => entry.scopeVisible && this.canPublishScope(entry))
      .map((entry) => structuredClone(entry.scope!));
  }

  subscribeProofScopes(listener: (event: RuntimeProofScopeEvent) => void): () => void {
    this.scopeListeners.add(listener);
    return () => this.scopeListeners.delete(listener);
  }

  /**
   * Declare once in the outer entry, before its immediate Gate check. Declarations persist for the
   * page epoch: nested collect/profile/probe calls and queue retries do not shrink/reopen authority.
   */
  prepareOperation(accountId: string, input: RuntimeOperationRequest): PreparedOperationScope {
    if (input?.operation?.startsWith("view-")) return this.setPageOperation(accountId, input);
    return this.selectOperation(accountId, input, false);
  }

  /** Same page operation and destination is idempotent. A genuinely new page retires the old union. */
  setPageOperation(accountId: string, input: RuntimeOperationRequest): PreparedOperationScope {
    return this.selectOperation(accountId, input, true);
  }

  /**
   * Call synchronously when the trusted main-process review manifest changes. Every active
   * selection is re-resolved before yielding; no user action or observed host is needed to revoke
   * a removed/stale review. The returned promise waits only for protection, never for new proof.
   */
  refreshOperationCatalogs(accountId?: string): Promise<void> {
    const pending: Promise<void>[] = [];
    let invalid = false;
    for (const entry of this.accounts.values()) {
      if (entry.retired || this.disposed || (accountId !== undefined && entry.accountId !== accountId))
        continue;
      const selection = entry.selections.at(-1);
      if (!selection) continue;
      try {
        pending.push(
          this.prepareOperation(entry.accountId, {
            operation: selection.operation,
            activePageOrigin: selection.activePageOrigin ?? null,
            ...(selection.targetPageOrigin ? { targetPageOrigin: selection.targetPageOrigin } : {}),
          }).ready,
        );
      } catch {
        invalid = true;
      }
    }
    return Promise.allSettled(pending).then((results) => {
      if (invalid || results.some((result) => result.status === "rejected"))
        throw new Error("OPERATION_CATALOG_REFRESH_FAILED");
    });
  }

  setSuspendHandler(handler: (accountId: string) => void | Promise<void>): void {
    this.suspendHandler = handler;
  }

  /** Called on monitor transitions, also rechecked at every business boundary. No I/O or proof issue. */
  syncExclusiveAccess(): void {
    if (!this.options.exclusiveAccess || this.disposed) return;
    if (this.exclusiveReading) {
      this.exclusiveReadInvalidated = true;
      return;
    }
    if (this.exclusiveSyncing) return;
    this.exclusiveSyncing = true;
    const previous = this.exclusiveSnapshot;
    let next: ExclusiveAccessSnapshot;
    this.exclusiveReading = true;
    this.exclusiveReadInvalidated = false;
    try {
      const value = this.options.exclusiveAccess.read();
      if (
        this.exclusiveReadInvalidated ||
        !value ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 0 ||
        (previous !== null && value.generation < previous.generation) ||
        !["checking", "domestic", "dual", "overseas", "unavailable"].includes(value.state) ||
        !["on", "off", "unknown"].includes(value.proxy) ||
        (value.state === "domestic" && value.proxy !== "off") ||
        (value.state === "dual" && (value.proxy !== "on" || !this.options.ruleSplitTransport))
      )
        throw new Error("EXCLUSIVE_ACCESS_UNAVAILABLE");
      next = {
        state: value.state,
        proxy: value.proxy,
        reason: value.reason,
        generation: value.generation,
        checkedAt: value.checkedAt,
        expiresAt: value.expiresAt,
      };
    } catch {
      next = {
        state: "unavailable",
        proxy: "unknown",
        reason: "PROXY_STATE_UNKNOWN",
        generation: previous?.generation ?? 0,
        checkedAt: null,
        expiresAt: null,
      };
    } finally {
      this.exclusiveReading = false;
    }
    try {
      if (this.disposed) return;
      this.exclusiveSnapshot = next;
      const changed =
        !previous ||
        previous.generation !== next.generation ||
        previous.state !== next.state ||
        previous.proxy !== next.proxy;
      if (!changed) return;
      if (this.enforcement === "strict") {
        const entries = [...this.accounts.values()].filter((entry) => !entry.retired);
        // Close every account before calling anything reentrant. Monitor leases already changed;
        // runtime-derived leases additionally close on account reset/removal and Session epochs.
        for (const entry of entries) {
          entry.ready = false;
          this.abortExclusiveLeases(entry);
          this.withdrawScope(entry);
        }
        for (const entry of entries) {
          if (this.disposed || entry.retired) continue;
          this.gate.revoke(entry.accountId, next.reason);
          this.cancelDownloads(entry);
          const suspension = this.notifySuspend(entry);
          this.record("GateRevoked", entry, next.reason);
          this.protect(entry, false, next.reason, suspension);
        }
      }
      this.emit("state", this.getAccountStates());
    } finally {
      this.exclusiveSyncing = false;
    }
  }

  /** Call before wiping a partition/deleting its database row; completion includes network cleanup. */
  removeAccount(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) {
      this.gate.unregisterAccount(accountId);
      return Promise.resolve();
    }
    if (entry.retired) return this.waitForProtection(entry);
    entry.retired = true;
    this.options.ruleSplitTransport?.releaseSession?.(accountId);
    entry.ready = false;
    this.abortExclusiveLeases(entry);
    entry.scope = null;
    entry.selections = [];
    entry.catalogs = [];
    entry.pageSelectionKey = null;
    const registered = this.gate.snapshot(accountId).length > 0;
    this.gate.unregisterAccount(accountId);
    this.withdrawScope(entry);
    // Observation does not enforce network decisions, but explicit account removal still owns teardown.
    if (this.options.exclusiveAccess || !registered || this.enforcement === "observe") {
      this.cancelDownloads(entry);
      const suspension = this.notifySuspend(entry);
      this.protect(entry, false, "GATE_REVOKED", suspension);
    }
    this.emit("state", this.getAccountStates());
    return this.waitForProtection(entry);
  }

  /** Keep the account row, but retire authority until wipe completes and the factory registers again. */
  resetAccount(accountId: string): Promise<void> {
    return this.removeAccount(accountId);
  }

  /** Read-only backup preflight, including identities retained after their database row was deleted. */
  assertAccountIdentities(current: readonly { id: string; platformId: CnPlatformId }[]): void {
    const ids = new Set<string>();
    for (const account of current) {
      if (!account.id || !isCnPlatformId(account.platformId) || ids.has(account.id))
        throw new Error("Invalid domestic account identities");
      ids.add(account.id);
      const owned = this.accounts.get(account.id);
      // Retired rows no longer exist in SQLite, but their persistent Session still has an owner.
      if (owned && owned.platformId !== account.platformId)
        throw new Error("Account Session identity cannot change platform");
    }
  }

  /** Reconcile with authoritative account rows; this never creates a Session or restores a permit. */
  async reconcileAccounts(current: readonly { id: string; platformId: CnPlatformId }[]): Promise<void> {
    const ids = new Map<string, CnPlatformId>();
    for (const account of current) {
      if (!account.id || !isCnPlatformId(account.platformId) || ids.has(account.id))
        throw new Error("Invalid domestic account identities");
      ids.set(account.id, account.platformId);
    }
    const changedIdentity = [...this.accounts.values()].find(
      (entry) => ids.has(entry.accountId) && ids.get(entry.accountId) !== entry.platformId,
    );
    const removed = [...this.accounts.values()].filter(
      (entry) => !ids.has(entry.accountId) || ids.get(entry.accountId) !== entry.platformId,
    );
    const results = await Promise.allSettled(removed.map((entry) => this.removeAccount(entry.accountId)));
    if (changedIdentity) throw new Error("Account Session identity cannot change platform");
    if (results.some((result) => result.status === "rejected"))
      throw new Error("ACCOUNT_SESSION_PROTECTION_FAILED");
  }

  check(accountId: string, url?: string): RouteDecision {
    if (this.options.exclusiveAccess) this.syncExclusiveAccess();
    const entry = this.accounts.get(accountId);
    if (!entry || entry.retired || this.disposed) return this.deny(accountId, "GATE_REVOKED");
    if (this.options.exclusiveAccess) {
      if (entry.failed) return this.deny(accountId, "GATE_REVOKED");
      const decision = this.exclusiveDecision(accountId);
      if (!decision.allowed) return decision;
      if (!entry.ready) return this.deny(accountId, "CHECKING");
      const epoch = entry.epoch;
      if (!this.isNetworkReady()) return this.deny(accountId, "NETWORK_CHANGED");
      if (
        this.disposed ||
        entry.retired ||
        entry.failed ||
        !entry.ready ||
        entry.epoch !== epoch ||
        this.exclusiveSnapshot?.generation !== decision.generation ||
        !this.exclusiveDecision(accountId).allowed
      )
        return this.deny(accountId, "GATE_REVOKED");
      return url ? this.checkExclusiveUrl(entry, url) : decision;
    }
    if (!this.options.exclusiveAccess && !entry.scope) return this.deny(accountId, "CHECKING");
    if (!entry.ready || entry.failed) return this.deny(accountId, entry.failed ? "GATE_REVOKED" : "CHECKING");
    if (!this.isNetworkReady()) return this.deny(accountId, "NETWORK_CHANGED");
    return url ? this.checkExternal(entry, url) : this.gate.checkAction(accountId, entry.contextId);
  }

  acquire(accountId: string): BusinessNetworkLease | null {
    if (!this.check(accountId).allowed) return null;
    const entry = this.accounts.get(accountId)!;
    const epoch = entry.epoch;
    if (this.options.exclusiveAccess) return this.acquireExclusive(entry, epoch);
    const lease = this.gate.acquireLease(accountId, entry.contextId).lease;
    if (!lease) return null;
    return {
      signal: lease.signal,
      isCurrent: () =>
        !this.disposed &&
        !entry.retired &&
        entry.ready &&
        !entry.failed &&
        this.isNetworkReady() &&
        entry.epoch === epoch &&
        lease.isCurrent(),
      release: () => lease.release(),
    };
  }

  checkSessionRequest(session: NetworkSession, rawUrl: string): RouteDecision {
    const entry = this.sessions.get(session);
    if (!entry || entry.retired || this.disposed) return this.deny(entry?.accountId ?? "", "GATE_REVOKED");
    try {
      const url = new URL(rawUrl);
      // These schemes perform no outbound transport by themselves; their subrequests remain guarded.
      if (["about:", "data:", "blob:"].includes(url.protocol)) return this.localDecision(entry.accountId);
    } catch {
      return this.deny(entry.accountId, "UNKNOWN_TARGET");
    }
    return this.check(entry.accountId, rawUrl);
  }

  /** Observe results update controller freshness only. Reachability is never converted to proof. */
  onObservation(snapshot: NetworkSnapshot): void {
    if (this.options.exclusiveAccess) return;
    if (this.disposed) return;
    if (this.retiredObservers.has(snapshot.instanceId)) return;
    const previous = this.lastObservation;
    if (previous?.instanceId === snapshot.instanceId && snapshot.sequence <= previous.sequence) return;
    if (previous && previous.instanceId !== snapshot.instanceId) {
      this.retiredObservers.add(previous.instanceId);
      this.gate.invalidate("NETWORK_CHANGED");
    }
    const networkReady = this.isNetworkReady();
    const readKey = JSON.stringify([
      snapshot.checkedAt,
      snapshot.rulesVersion,
      snapshot.controller,
      networkReady,
    ]);
    this.lastObservation = { instanceId: snapshot.instanceId, sequence: snapshot.sequence, readKey };
    if (previous?.instanceId === snapshot.instanceId && previous.readKey === readKey) return;
    const age = snapshot.checkedAt ? Date.now() - Date.parse(snapshot.checkedAt) : Infinity;
    const readable =
      networkReady &&
      snapshot.controller.readable &&
      !!snapshot.rulesVersion &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < NETWORK_TIMING.proofTtlMs;
    this.gate.setNetworkState(
      {
        controllerReadable: readable,
        mode: snapshot.controller.mode ?? "unknown",
        tun: snapshot.controller.tun === true,
        rulesVersion: readable ? snapshot.rulesVersion : null,
      },
      readable ? age : 0,
    );
  }

  getAccountStates(): AccountNetworkState[] {
    if (this.options.exclusiveAccess) {
      this.syncExclusiveAccess();
      return [...this.accounts.values()]
        .filter((entry) => !entry.retired)
        .map((entry) => {
          const snapshot = this.exclusiveSnapshot;
          const decision = this.check(entry.accountId);
          return {
            accountId: entry.accountId,
            state: decision.allowed ? "allowed" : decision.reason === "CHECKING" ? "checking" : "dormant",
            reason: decision.reason,
            generation: decision.generation,
            checkedAt: snapshot?.checkedAt ?? null,
            proofExpiresAt: decision.allowed ? (snapshot?.expiresAt ?? null) : null,
          };
        });
    }
    const networkReady = this.isNetworkReady();
    const states = new Map(this.gate.snapshot().map((state) => [state.accountId, state]));
    return [...this.accounts.values()]
      .filter((entry) => !entry.retired)
      .map((entry) => {
        const state: AccountNetworkState = states.get(entry.accountId) ?? {
          accountId: entry.accountId,
          state: "checking",
          reason: "CHECKING",
          generation: this.gate.generation,
          checkedAt: null,
          proofExpiresAt: null,
        };
        if (
          this.enforcement === "observe" ||
          (networkReady && entry?.ready && !entry.failed && !entry.retired && !this.disposed)
        )
          return state;
        return {
          ...state,
          state: entry?.failed || this.disposed ? "dormant" : "checking",
          reason:
            entry?.failed || this.disposed ? "GATE_REVOKED" : !networkReady ? "NETWORK_CHANGED" : "CHECKING",
          proofExpiresAt: null,
        };
      });
  }

  private isNetworkReady(): boolean {
    if (this.enforcement === "observe") return true;
    try {
      return this.options.networkReadiness?.() === true;
    } catch {
      return false;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let complete!: () => void;
    this.disposal = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.disposed = true;
    if (this.options.exclusiveAccess) {
      for (const entry of this.accounts.values()) {
        entry.ready = false;
        this.abortExclusiveLeases(entry);
        if (this.enforcement === "strict" && !entry.retired) {
          this.cancelDownloads(entry);
          this.protect(entry, false, "GATE_REVOKED", this.notifySuspend(entry));
        }
      }
    }
    this.gate.dispose(); // Synchronously closes leases and schedules every strict Session cleanup.
    for (const entry of this.accounts.values()) this.withdrawScope(entry);
    void Promise.allSettled([...this.accounts.values()].map((entry) => entry.pending)).then(() => {
      for (const entry of this.accounts.values())
        entry.session.removeListener("will-download", entry.onDownload);
      this.gate.removeListener("state", this.onGateState);
      this.gate.removeListener("revoked", this.onGateRevocation);
      this.scopeListeners.clear();
      this.removeAllListeners();
      complete();
    });
    return this.disposal;
  }

  private checkExternal(entry: SessionEntry, rawUrl: string): RouteDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return this.rejectTarget(entry);
    }
    if (!["https:", "wss:"].includes(url.protocol) || url.username || url.password)
      return this.rejectTarget(entry);
    // Capture the real request before passing a mutable URL to an optional resolver.
    const request = {
      protocol: url.protocol as ProofTarget["protocol"],
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
    };
    let targets: ProofTarget[];
    if (this.options.resolveTarget === undefined) {
      // webRequest has no actual outbound AF. Require every possible branch, rather than guessing.
      try {
        targets = this.resolveOriginFamilies(entry, request).map((addressFamily) => ({
          ...request,
          addressFamily,
        }));
        if (this.options.resolveFamilies !== undefined) {
          const committed = entry.scope?.targets.filter(
            (target) => exactOriginKey(target) === exactOriginKey(request),
          );
          if (
            !committed ||
            JSON.stringify(committed.map(proofTargetKey).sort()) !==
              JSON.stringify(targets.map(proofTargetKey).sort())
          )
            return this.rejectTarget(entry);
        }
      } catch {
        return this.rejectTarget(entry);
      }
    } else {
      let target: ProofTarget | null;
      try {
        target = this.options.resolveTarget({ ...entry, url });
      } catch {
        target = null;
      }
      if (!target) return this.rejectTarget(entry);
      targets = [target];
    }
    if (
      targets.some(
        (target) =>
          !proofTargetKey(target) || proofTargetKey(target) !== proofTargetKey({ ...target, ...request }),
      )
    )
      return this.rejectTarget(entry);
    let decision: RouteDecision | null = null;
    for (const target of targets) {
      decision = this.gate.checkRequest({ accountId: entry.accountId, contextId: entry.contextId, target });
      if (!decision.allowed) return decision;
    }
    return decision!;
  }

  private selectOperation(
    accountId: string,
    input: RuntimeOperationRequest,
    page: boolean,
  ): PreparedOperationScope {
    const entry = this.accounts.get(accountId);
    if (!entry || entry.retired || this.disposed) throw new Error("ACCOUNT_SESSION_NOT_REGISTERED");
    const stillCurrent = this.resolutionGuard(entry);
    let resolved = false;
    try {
      if (
        !input ||
        !Object.prototype.hasOwnProperty.call(input, "activePageOrigin") ||
        (input.activePageOrigin !== null && !normalizeExactOrigin(input.activePageOrigin)) ||
        page !== input.operation.startsWith("view-")
      )
        throw new Error("INVALID_OPERATION_SELECTION");
      // Copy only declared fields. Neither renderer-shaped extras nor a mutable caller URL can
      // introduce a review or change the selected origin after this synchronous boundary.
      const selection: OperationCatalogRequest = {
        platformId: entry.platformId,
        operation: input.operation,
        activePageOrigin:
          input.activePageOrigin === null ? null : normalizeExactOrigin(input.activePageOrigin)!,
        ...(input.targetPageOrigin === undefined
          ? {}
          : { targetPageOrigin: structuredClone(input.targetPageOrigin) }),
      };
      const selected = resolveOperationCatalog(selection);
      if (this.options.exclusiveAccess) {
        if (!stillCurrent()) throw new Error("OPERATION_SCOPE_CHANGED_DURING_RESOLUTION");
        // This validates the platform, operation and navigation origin only. Catalog completeness
        // and address-family proof belong to the unselected route-proof policy, not this switch.
        entry.selections = [structuredClone(selection)];
        if (page) entry.pageSelectionKey = selected.selectionKey;
        return {
          ready: this.waitForProtection(entry),
          contextId: entry.contextId,
          scopeVersion: "exclusive-selection:" + selected.selectionKey,
        };
      }
      const replacePage = page && entry.pageSelectionKey !== selected.selectionKey;
      const prior = replacePage ? [] : entry.selections;
      const selections = [
        ...prior.filter((old) => resolveOperationCatalog(old).selectionKey !== selected.selectionKey),
        selection,
      ];
      const catalogs = selections.map((request) => this.resolveCatalog(request));
      const scope = this.resolveAccountScope({ ...entry, operations: selections, catalogs });
      if (!stillCurrent()) throw new Error("OPERATION_SCOPE_CHANGED_DURING_RESOLUTION");
      // Route proof applies to an exact transport boundary. A separately reviewed same-boundary
      // background probe can join without tearing down a QR page or relabelling old evidence.
      if (!this.options.resolveScope && !replacePage && this.compatibleCatalogExtension(entry, catalogs))
        scope.catalogVersion = entry.scope!.catalogVersion;
      const changed =
        !entry.scope ||
        proofScopeKey(scope) !== proofScopeKey(entry.scope) ||
        scope.catalogReviewed !== entry.scope.catalogReviewed;
      const hadScope = entry.scope !== null;
      resolved = true;
      entry.scope = structuredClone(scope);
      entry.selections = structuredClone(selections);
      entry.catalogs = structuredClone(catalogs);
      if (page) entry.pageSelectionKey = selected.selectionKey;
      if (changed || (replacePage && hadScope)) {
        if (this.enforcement === "strict" && hadScope) entry.ready = false;
        // Suppress the generic handler until both Session identity and new scope are committed.
        entry.resettingGate = true;
        try {
          if (replacePage && hadScope) this.gate.revoke(accountId, "NETWORK_CHANGED");
          this.gate.registerAccount(scope);
        } finally {
          entry.resettingGate = false;
        }
        this.withdrawScope(entry);
        if (this.enforcement === "strict" && hadScope) {
          this.cancelDownloads(entry);
          this.protect(entry, false, "NETWORK_CHANGED", this.notifySuspend(entry));
        } else this.publishScope(entry);
      }
      return {
        ready: this.waitForProtection(entry),
        contextId: entry.contextId,
        scopeVersion: entry.scope.catalogVersion,
      };
    } catch {
      // A synchronous resolver can withdraw or replace this identity/scope. Never overwrite its
      // newer state with the failed outer declaration, including a remove/re-register of one Session.
      if (!resolved && !stillCurrent()) throw new Error("INVALID_BUSINESS_OPERATION_SCOPE");
      // An invalid or throwing manifest/selection cannot retain authority for the previous scope.
      entry.scope = null;
      entry.selections = [];
      entry.catalogs = [];
      entry.pageSelectionKey = null;
      this.gate.unregisterAccount(accountId);
      this.withdrawScope(entry);
      throw new Error("INVALID_BUSINESS_OPERATION_SCOPE");
    }
  }

  private resolveCatalog(selection: OperationCatalogRequest): ResolvedOperationCatalog {
    const source = resolveOperationCatalog(selection);
    const catalog = this.options.resolveCatalog?.(structuredClone(selection)) ?? source;
    const required = catalog.requiredOrigins.map(exactOriginKey);
    const range = catalog.reviewedRequestRange.map(exactOriginKey);
    if (
      catalog.platformId !== source.platformId ||
      catalog.operation !== source.operation ||
      catalog.sourceVersion !== source.sourceVersion ||
      catalog.selectionKey !== source.selectionKey ||
      !catalog.catalogVersion ||
      catalog.executionSupported !== source.executionSupported ||
      typeof catalog.flowReviewed !== "boolean" ||
      required.some((key) => !key) ||
      range.some((key) => !key) ||
      source.requiredOrigins.some((origin) => !required.includes(exactOriginKey(origin))) ||
      (catalog.flowReviewed && required.some((key) => !range.includes(key)))
    )
      throw new Error("INVALID_OPERATION_CATALOG_RESULT");
    return structuredClone(catalog);
  }

  private compatibleCatalogExtension(entry: SessionEntry, catalogs: ResolvedOperationCatalog[]): boolean {
    if (!entry.scope || !entry.catalogs.length) return false;
    const boundary = (
      values: ResolvedOperationCatalog[],
      field: "requiredOrigins" | "reviewedRequestRange",
    ) => JSON.stringify([...new Set(values.flatMap((catalog) => catalog[field].map(exactOriginKey)))].sort());
    if (
      boundary(entry.catalogs, "requiredOrigins") !== boundary(catalogs, "requiredOrigins") ||
      boundary(entry.catalogs, "reviewedRequestRange") !== boundary(catalogs, "reviewedRequestRange")
    )
      return false;
    const catalogKeys = (values: ResolvedOperationCatalog[]) =>
      JSON.stringify(
        values
          .map((catalog) => [
            catalog.selectionKey,
            catalog.catalogVersion,
            catalog.flowReviewed,
            catalog.executionSupported,
          ])
          .sort(),
      );
    if (catalogKeys(entry.catalogs) === catalogKeys(catalogs)) return true;
    if (
      !catalogs.every((catalog) => catalog.flowReviewed && catalog.executionSupported) ||
      entry.catalogs.some(
        (old) =>
          !catalogs.some(
            (next) => next.selectionKey === old.selectionKey && next.catalogVersion === old.catalogVersion,
          ),
      )
    )
      return false;
    return true;
  }

  private resolveAccountScope(input: OperationScopeRegistration): AccountProofScope {
    const scope =
      this.options.resolveScope?.(input) ??
      defaultScope(input, (origin) => this.resolveOriginFamilies(input, origin));
    if (
      scope.accountId !== input.accountId ||
      scope.platformId !== input.platformId ||
      scope.contextId !== input.contextId ||
      !proofScopeKey(scope)
    )
      throw new Error("Proof scope does not match Session identity");
    return structuredClone(scope);
  }

  /** Snapshot the current ownership before invoking trusted, but reentrant, main-process callbacks. */
  private resolutionGuard(entry: SessionEntry): () => boolean {
    const version = this.gate.currentProofVersion();
    const generation = this.gate.generation,
      epoch = entry.epoch,
      contextId = entry.contextId,
      scope = entry.scope,
      selections = entry.selections;
    return () => {
      const currentVersion = this.gate.currentProofVersion();
      return (
        !this.disposed &&
        !entry.retired &&
        this.accounts.get(entry.accountId) === entry &&
        this.sessions.get(entry.session) === entry &&
        entry.contextId === contextId &&
        entry.epoch === epoch &&
        entry.scope === scope &&
        entry.selections === selections &&
        this.gate.generation === generation &&
        currentVersion?.generation === version?.generation &&
        currentVersion?.rulesVersion === version?.rulesVersion
      );
    };
  }

  private resolveOriginFamilies(
    input: Pick<SessionRegistration, "accountId" | "platformId" | "contextId">,
    origin: ExactOrigin,
  ): readonly ProofTarget["addressFamily"][] {
    if (this.options.resolveFamilies === undefined) return ["ipv4", "ipv6"];
    const entry = this.accounts.get(input.accountId);
    const normalized = normalizeExactOrigin(origin);
    if (
      !entry ||
      entry.platformId !== input.platformId ||
      entry.contextId !== input.contextId ||
      !normalized ||
      exactOriginKey(normalized) !== exactOriginKey(origin) ||
      this.familyResolutions.has(entry)
    )
      throw new Error("NETWORK_FAMILIES_UNVERIFIED");
    const stillCurrent = this.resolutionGuard(entry);
    const argument = {
      accountId: input.accountId,
      platformId: input.platformId,
      contextId: input.contextId,
      origin: structuredClone(normalized),
    };
    this.familyResolutions.add(entry);
    try {
      const result = this.options.resolveFamilies(argument);
      if (!Array.isArray(result) || result.length < 1 || result.length > 2)
        throw new Error("NETWORK_FAMILIES_UNVERIFIED");
      const families = Array.from(result);
      if (
        families.some((family) => family !== "ipv4" && family !== "ipv6") ||
        new Set(families).size !== families.length ||
        argument.accountId !== input.accountId ||
        argument.platformId !== input.platformId ||
        argument.contextId !== input.contextId ||
        exactOriginKey(argument.origin) !== exactOriginKey(normalized) ||
        !stillCurrent()
      )
        throw new Error("NETWORK_FAMILIES_UNVERIFIED");
      return families.sort();
    } finally {
      this.familyResolutions.delete(entry);
    }
  }

  private canPublishScope(entry: SessionEntry): boolean {
    return entry.scope !== null && entry.ready && !entry.failed && !entry.retired && !this.disposed;
  }

  private publishScope(entry: SessionEntry): void {
    if (!this.canPublishScope(entry) || entry.scopeVisible) return;
    entry.scopeVisible = true;
    this.notifyScope({ type: "upsert", scope: structuredClone(entry.scope!) });
  }

  private withdrawScope(entry: SessionEntry): void {
    if (!entry.scopeVisible) return;
    // Update visibility before subscribers can synchronously read/revoke this account.
    entry.scopeVisible = false;
    this.notifyScope({ type: "remove", accountId: entry.accountId });
  }

  private notifyScope(event: RuntimeProofScopeEvent): void {
    for (const listener of this.scopeListeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* Sampler failure cannot reopen authority. */
      }
    }
  }

  private deny(accountId: string, reason: NetworkReason): RouteDecision {
    return {
      accountId,
      allowed: false,
      enforce: this.enforcement === "strict",
      cancel: this.enforcement === "strict",
      reason,
      generation: this.options.exclusiveAccess
        ? (this.exclusiveSnapshot?.generation ?? 0)
        : this.gate.generation,
      proofId: null,
    };
  }

  private rejectTarget(entry: SessionEntry): RouteDecision {
    if (this.enforcement === "strict" && this.gate.checkAction(entry.accountId, entry.contextId).allowed)
      this.gate.revoke(entry.accountId, "UNKNOWN_TARGET");
    return this.deny(entry.accountId, "UNKNOWN_TARGET");
  }

  private async waitForProtection(entry: SessionEntry): Promise<void> {
    while (true) {
      const pending = entry.pending;
      await pending;
      if (pending === entry.pending) return;
    }
  }

  private localDecision(accountId: string): RouteDecision {
    return {
      accountId,
      allowed: true,
      enforce: this.enforcement === "strict",
      cancel: false,
      reason: "READY",
      generation: this.options.exclusiveAccess
        ? (this.exclusiveSnapshot?.generation ?? 0)
        : this.gate.generation,
      proofId: null,
    };
  }

  private exclusiveDecision(accountId: string): RouteDecision {
    const state = this.exclusiveSnapshot;
    if (this.exclusiveReading || !state) return this.deny(accountId, "CHECKING");
    return (state.state === "domestic" && state.proxy === "off") ||
      (state.state === "dual" && state.proxy === "on" && !!this.options.ruleSplitTransport)
      ? this.localDecision(accountId)
      : this.deny(accountId, state.reason);
  }

  private checkExclusiveUrl(entry: SessionEntry, rawUrl: string): RouteDecision {
    try {
      const url = new URL(rawUrl);
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password)
        return this.deny(entry.accountId, "UNKNOWN_TARGET");
      if (
        this.exclusiveSnapshot?.state === "dual" &&
        !this.options.ruleSplitTransport?.allowUrl(entry.platformId, url)
      )
        return this.deny(entry.accountId, "UNKNOWN_TARGET");
      // This is the partition request gate, including third-party CAPTCHA/CDN subresources.
      // Top-level destinations remain governed by the browser's original navigation policy.
      return this.localDecision(entry.accountId);
    } catch {
      return this.deny(entry.accountId, "UNKNOWN_TARGET");
    }
  }

  private acquireExclusive(entry: SessionEntry, epoch: number): BusinessNetworkLease | null {
    const generation = this.exclusiveSnapshot?.generation;
    let source: BusinessNetworkLease | null;
    try {
      source = this.options.exclusiveAccess!.acquire();
    } catch {
      return null;
    }
    if (!source) return null;
    const controller = new AbortController();
    let released = false;
    const revoke = () => {
      if (released) return;
      released = true;
      entry.exclusiveLeases.delete(revoke);
      source.signal.removeEventListener("abort", revoke);
      controller.abort();
      try {
        source.release();
      } catch {
        /* The local task is already revoked. */
      }
    };
    const current = () => {
      if (released || controller.signal.aborted || source.signal.aborted) return false;
      try {
        const sourceCurrent = source.isCurrent();
        const allowed = this.check(entry.accountId).allowed;
        return (
          !released &&
          !source.signal.aborted &&
          sourceCurrent &&
          !this.disposed &&
          !entry.retired &&
          entry.ready &&
          !entry.failed &&
          entry.epoch === epoch &&
          this.exclusiveSnapshot?.generation === generation &&
          allowed
        );
      } catch {
        return false;
      }
    };
    entry.exclusiveLeases.add(revoke);
    source.signal.addEventListener("abort", revoke, { once: true });
    if (!current()) {
      revoke();
      return null;
    }
    return {
      signal: controller.signal,
      isCurrent: () => {
        if (current()) return true;
        revoke();
        return false;
      },
      release: revoke,
    };
  }

  private abortExclusiveLeases(entry: SessionEntry): void {
    for (const revoke of [...entry.exclusiveLeases]) {
      try {
        revoke();
      } catch {
        /* A source release error cannot retain another account task's authority. */
      }
    }
  }

  private protect(
    entry: SessionEntry,
    initialize: boolean,
    reason: NetworkReason,
    suspension?: Promise<void>,
  ): void {
    entry.ready = false;
    this.abortExclusiveLeases(entry);
    this.withdrawScope(entry);
    const epoch = ++entry.epoch;
    const prior = entry.pending;
    entry.pending = prior
      .catch(() => undefined)
      .then(async () => {
        const cleanup = async () => {
          if (initialize) {
            if (this.options.ruleSplitTransport)
              await this.options.ruleSplitTransport.configureSession(entry);
            else if (this.options.sessionProxyMode === "system") await ensureSystemSession(entry.session);
            else await ensureDirectSession(entry.session);
            entry.initialized = true;
          } else {
            let failed = false;
            try {
              await entry.session.clearStorageData({ storages: ["serviceworkers"] });
            } catch {
              failed = true;
            }
            try {
              await entry.session.closeAllConnections();
            } catch {
              failed = true;
            }
            if (failed) throw new Error("SESSION_REVOCATION_FAILED");
          }
        };
        // Closing WebContents starts synchronously in notifySuspend. Do not delay the independent
        // worker/connection cleanup behind its completion, and do not declare readiness until both finish.
        const results = await Promise.allSettled([cleanup(), suspension ?? Promise.resolve()]);
        // Old pages can finish a DNS lookup while they are being destroyed. Clear
        // the resolver only after both request sources have stopped, before any
        // new scope becomes visible. Still attempt this if either cleanup failed.
        if (!initialize) await entry.session.clearHostResolverCache();
        if (results.some((result) => result.status === "rejected"))
          throw new Error("SESSION_REVOCATION_FAILED");
        if (entry.failed) throw new Error("SESSION_PROTECTION_PREVIOUSLY_FAILED");
        if (entry.epoch !== epoch || this.disposed || entry.retired) return;
        if (!initialize && this.options.ruleSplitTransport)
          await this.options.ruleSplitTransport.configureSession(entry);
        if (entry.epoch !== epoch || this.disposed || entry.retired) return;
        // Evidence collected before/during proxy initialization or cleanup cannot qualify a rebuilt view.
        entry.resettingGate = true;
        try {
          this.gate.revoke(entry.accountId, reason);
        } finally {
          entry.resettingGate = false;
        }
        entry.ready = entry.initialized;
        this.publishScope(entry);
        this.emit("state", this.getAccountStates());
      })
      .catch(async () => {
        entry.failed = true;
        entry.ready = false;
        this.cancelDownloads(entry);
        // An initialization failure has no preceding suspension callback; still attempt page teardown.
        if (!suspension) await this.notifySuspend(entry).catch(() => undefined);
        this.record("SessionProtectionFailed", entry, "GATE_REVOKED");
        this.emit("state", this.getAccountStates());
        throw new Error("ACCOUNT_SESSION_PROTECTION_FAILED");
      });
    // Callers may not await background revocation; keep rejection handled without hiding ready failure.
    void entry.pending.catch(() => undefined);
  }

  private cancelDownloads(entry: SessionEntry): void {
    for (const item of entry.downloads) {
      try {
        item.cancel();
      } catch {
        /* Continue cancelling the rest. */
      }
    }
    entry.downloads.clear();
  }

  private notifySuspend(entry: SessionEntry): Promise<void> {
    const failure = () => {
      entry.failed = true;
      entry.ready = false;
      this.record("SessionProtectionFailed", entry, "GATE_REVOKED");
      throw new Error("ACCOUNT_PAGE_SUSPENSION_FAILED");
    };
    let completion: Promise<void>;
    try {
      // Calling the handler must remain synchronous: it first stops scheduling and starts wc.close().
      completion = Promise.resolve(this.suspendHandler(entry.accountId)).catch(failure);
    } catch {
      entry.failed = true;
      entry.ready = false;
      this.record("SessionProtectionFailed", entry, "GATE_REVOKED");
      completion = Promise.reject(new Error("ACCOUNT_PAGE_SUSPENSION_FAILED"));
    }
    // The cleanup queue may currently be busy; keep an immediate rejection handled until it joins us.
    void completion.catch(() => undefined);
    return completion;
  }

  private record(
    type: "GateRevoked" | "SessionProtectionFailed",
    entry: SessionEntry,
    reason: NetworkReason,
  ): void {
    try {
      this.options.audit?.({ type, accountId: entry.accountId, reason });
    } catch {
      /* Audit cannot reopen authority or interrupt revocation. */
    }
  }
}
