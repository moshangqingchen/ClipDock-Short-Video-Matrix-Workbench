import { NETWORK_REASON_TEXT, type NetworkReason } from "@shared/network";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DomesticOperation, ExactOrigin } from "./operation-catalog";

/** Selected only at a main-process business entry, never from renderer proof or observed-host data. */
export interface BusinessOperationSelection {
  operation: DomesticOperation;
  activePageOrigin: ExactOrigin | null;
  targetPageOrigin?: ExactOrigin;
}

export interface BusinessNetworkLease {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}

/** Main-process adapter for the single gate; never accepts renderer-supplied proof. */
export interface BusinessNetworkController {
  readonly enforcement: "observe" | "strict";
  check(accountId: string, url?: string): { allowed: boolean; reason: NetworkReason };
  acquire(accountId: string): BusinessNetworkLease | null;
  prepareOperation?(
    accountId: string,
    selection: BusinessOperationSelection,
  ): { ready: Promise<void>; contextId: string; scopeVersion: string };
}

let controller: BusinessNetworkController | null = null;
const pageAccounts = new WeakMap<object, string>();
const taskSignals = new AsyncLocalStorage<AbortSignal>();

export class BusinessTaskCancelledError extends Error {
  constructor() {
    super("采集任务已取消");
    this.name = "AbortError";
  }
}

export function withBusinessTaskSignal<T>(signal: AbortSignal, task: () => T): T {
  return taskSignals.run(signal, task);
}

export function bindAccountWebContents(contents: object, accountId: string): () => void {
  pageAccounts.set(contents, accountId);
  return () => {
    if (pageAccounts.get(contents) === accountId) pageAccounts.delete(contents);
  };
}

export function accountForWebContents(contents: object): string {
  const accountId = pageAccounts.get(contents);
  if (!accountId) throw new NetworkDormantError("CONTEXT_UNVERIFIED");
  return accountId;
}

export class NetworkDormantError extends Error {
  readonly code = "NETWORK_DORMANT";
  constructor(readonly reason: NetworkReason = "CHECKING") {
    super(`等待国内网络：${NETWORK_REASON_TEXT[reason]}`);
    this.name = "NetworkDormantError";
  }
}

export function isNetworkDormantError(error: unknown): error is NetworkDormantError {
  return error instanceof NetworkDormantError;
}

/** Installed before any account session or scheduler is constructed. Unset means closed. */
export function installBusinessNetwork(next: BusinessNetworkController): () => void {
  controller = next;
  return () => {
    if (controller === next) controller = null;
  };
}

export function isStrictBusinessNetwork(): boolean {
  return controller?.enforcement !== "observe";
}

/**
 * Declare the outer activity before checking permission. This only changes the required scope;
 * it never waits for proof, authorizes a request or replays the activity after network recovery.
 */
export function prepareBusinessOperation(accountId: string, selection: BusinessOperationSelection): void {
  try {
    if (!controller?.prepareOperation) {
      if (controller?.enforcement === "observe") return;
      throw new NetworkDormantError("CONTEXT_UNVERIFIED");
    }
    const pending = controller.prepareOperation(accountId, selection);
    // Runtime retains cleanup failure and prevents readiness; this caller must return promptly.
    void pending.ready.catch(() => undefined);
  } catch (error) {
    if (controller?.enforcement === "observe") return;
    if (isNetworkDormantError(error)) throw error;
    throw new NetworkDormantError("CATALOG_UNVERIFIED");
  }
}

/** Only extracts an actual page's origin. Permission and platform membership remain Runtime's job. */
export function businessPageOrigin(rawUrl: string | null | undefined): ExactOrigin | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return { protocol: "https:", host: url.hostname, port: url.port ? Number(url.port) : 443 };
  } catch {
    return null;
  }
}

export function assertBusinessNetwork(accountId: string, url?: string): void {
  if (controller?.enforcement === "observe") return;
  const decision = controller?.check(accountId, url);
  if (!decision?.allowed) throw new NetworkDormantError(decision?.reason);
}

export function canUseBusinessNetwork(accountId: string, url?: string): boolean {
  try {
    assertBusinessNetwork(accountId, url);
    return true;
  } catch (error) {
    if (isNetworkDormantError(error)) return false;
    throw error;
  }
}

export interface BusinessOperation extends BusinessNetworkLease {
  assertCurrent(): void;
}

export function beginBusinessOperation(accountId: string, url?: string): BusinessOperation {
  const taskSignal = taskSignals.getStore();
  if (taskSignal?.aborted) throw new BusinessTaskCancelledError();
  assertBusinessNetwork(accountId, url);
  const issuingController = controller;
  const lease = controller?.enforcement === "observe" ? observationLease() : controller?.acquire(accountId);
  if (!lease) throw new NetworkDormantError();
  const signal = taskSignal ? AbortSignal.any([lease.signal, taskSignal]) : lease.signal;
  return {
    signal,
    isCurrent: () => controller === issuingController && lease.isCurrent() && !signal.aborted,
    release: () => lease.release(),
    assertCurrent: () => {
      if (controller !== issuingController || !lease.isCurrent() || lease.signal.aborted)
        throw new NetworkDormantError("GATE_REVOKED");
      if (taskSignal?.aborted) throw new BusinessTaskCancelledError();
      assertBusinessNetwork(accountId, url);
    },
  };
}

function observationLease(): BusinessNetworkLease {
  const abort = new AbortController();
  let released = false;
  return {
    signal: abort.signal,
    isCurrent: () => !released,
    release: () => {
      released = true;
    },
  };
}
