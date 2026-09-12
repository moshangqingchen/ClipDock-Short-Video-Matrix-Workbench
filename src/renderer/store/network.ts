import { create } from "zustand";
import { api } from "@renderer/lib/api";
import { checkingNetworkSnapshot, NETWORK_TIMING, type NetworkSnapshot } from "@shared/network";

interface NetworkState {
  snapshot: NetworkSnapshot;
  /** Startup presentation only; never grants account/network access. */
  startupPending: boolean;
  refreshing: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

interface Subscription {
  active: boolean;
  revision: number;
  instanceId: string;
  sequence: number;
  retiredInstances: Set<string>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  stop(): void;
}

let subscription: Subscription | undefined;

/** UI availability only; the main process still validates each proxy operation. */
export function isGlobalProxyEnabled(switching: NetworkSnapshot["switching"]): boolean {
  return switching?.proxy === "on" && (switching.state === "overseas" || switching.state === "dual");
}

/** Public display data only. No persisted cache and never a source of permission. */
export const useNetwork = create<NetworkState>(() => ({
  snapshot: checkingNetworkSnapshot(),
  startupPending: true,
  refreshing: false,
  error: null,
  refresh: () => requestSnapshot("refresh"),
}));

function expiredSnapshot(snapshot: NetworkSnapshot): NetworkSnapshot {
  return {
    ...checkingNetworkSnapshot(),
    instanceId: snapshot.instanceId,
    sequence: snapshot.sequence,
    enforcement: snapshot.enforcement,
    checkedAt: snapshot.checkedAt,
    reason: "PROOF_EXPIRED",
    ...(snapshot.policy === "exclusive" || snapshot.policy === "rule-split"
      ? {
          policy: snapshot.policy,
          switching: {
            state: "checking" as const,
            proxy: "unknown" as const,
            reason: "PROOF_EXPIRED" as const,
            generation: snapshot.switching?.generation ?? 0,
            checkedAt: snapshot.switching?.checkedAt ?? null,
            expiresAt: null,
          },
        }
      : {}),
    accounts: snapshot.accounts.map((account) => ({
      accountId: account.accountId,
      state: "checking",
      reason: "PROOF_EXPIRED",
      generation: account.generation,
      checkedAt: account.checkedAt,
      proofExpiresAt: null,
    })),
  };
}

function expiresAt(snapshot: NetworkSnapshot): number {
  const checked =
    snapshot.policy === "exclusive" || snapshot.policy === "rule-split"
      ? snapshot.switching?.checkedAt
      : snapshot.checkedAt;
  const checkedAt = checked ? Date.parse(checked) : NaN;
  if (!Number.isFinite(checkedAt)) return 0;
  let deadline = checkedAt + NETWORK_TIMING.proofTtlMs;
  if (snapshot.policy === "exclusive" || snapshot.policy === "rule-split") {
    const switching = snapshot.switching;
    const switchCheckedAt = switching?.checkedAt ? Date.parse(switching.checkedAt) : NaN;
    const switchExpiry = switching?.expiresAt ? Date.parse(switching.expiresAt) : NaN;
    if (
      !Number.isFinite(switchCheckedAt) ||
      !Number.isFinite(switchExpiry) ||
      switchExpiry <= switchCheckedAt
    )
      return 0;
    deadline = Math.min(deadline, switchExpiry);
  }
  for (const account of snapshot.accounts) {
    if (account.state !== "allowed") continue;
    const proofExpiry = account.proofExpiresAt ? Date.parse(account.proofExpiresAt) : NaN;
    if (!Number.isFinite(proofExpiry)) return 0;
    deadline = Math.min(deadline, proofExpiry);
  }
  return deadline;
}

function receiveSnapshot(current: Subscription, snapshot: NetworkSnapshot, requestRevision?: number): void {
  if (!current.active || subscription !== current) return;
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) return;
  if (current.retiredInstances.has(snapshot.instanceId)) return;
  if (current.instanceId === snapshot.instanceId && snapshot.sequence <= current.sequence) return;
  if (
    current.instanceId !== snapshot.instanceId &&
    requestRevision !== undefined &&
    requestRevision !== current.revision
  )
    return; // A push from a new main process already superseded this response.

  if (current.instanceId && current.instanceId !== snapshot.instanceId)
    current.retiredInstances.add(current.instanceId);
  current.instanceId = snapshot.instanceId;
  current.sequence = snapshot.sequence;
  current.revision += 1;
  if (current.expiryTimer) clearTimeout(current.expiryTimer);

  const deadline = expiresAt(snapshot);
  if (snapshot.state !== "checking" && deadline <= Date.now()) {
    useNetwork.setState({ snapshot: expiredSnapshot(snapshot), startupPending: false, error: null });
    return;
  }
  const reason = snapshot.switching?.reason ?? snapshot.reason;
  const startupPending =
    useNetwork.getState().startupPending &&
    snapshot.state === "checking" &&
    (reason === "CHECKING" || reason === "NETWORK_CHANGED");
  useNetwork.setState({ snapshot, startupPending, error: null });
  if (deadline > Date.now()) {
    current.expiryTimer = setTimeout(() => {
      if (current.active && subscription === current)
        useNetwork.setState({ snapshot: expiredSnapshot(snapshot), startupPending: false });
    }, deadline - Date.now());
  }
}

async function requestSnapshot(method: "snapshot" | "refresh"): Promise<void> {
  const current = subscription;
  if (!current?.active) return;
  const revision = current.revision;
  useNetwork.setState({ refreshing: true, error: null });
  try {
    const snapshot = await api.network[method]();
    receiveSnapshot(current, snapshot, revision);
  } catch {
    if (current.active && subscription === current && current.revision === revision) {
      if (current.expiryTimer) clearTimeout(current.expiryTimer);
      useNetwork.setState({
        snapshot:
          useNetwork.getState().snapshot.policy !== undefined
            ? expiredSnapshot(useNetwork.getState().snapshot)
            : checkingNetworkSnapshot(),
        error: "无法获取主进程网络状态，请重试",
        startupPending: false,
      });
    }
  } finally {
    if (current.active && subscription === current) useNetwork.setState({ refreshing: false });
  }
}

/** Subscribe before loading, so a late initial response cannot overwrite a push. */
export function startNetworkSubscription(): () => void {
  subscription?.stop();
  useNetwork.setState({
    snapshot: checkingNetworkSnapshot(),
    startupPending: true,
    refreshing: false,
    error: null,
  });
  const current: Subscription = {
    active: true,
    revision: 0,
    instanceId: "",
    sequence: -1,
    retiredInstances: new Set(),
    stop: () => undefined,
  };
  subscription = current;
  const unsubscribe = api.on("network-state", (snapshot) => receiveSnapshot(current, snapshot));
  current.stop = () => {
    if (!current.active) return;
    current.active = false;
    unsubscribe();
    if (current.expiryTimer) clearTimeout(current.expiryTimer);
    if (subscription === current) {
      subscription = undefined;
      useNetwork.setState({
        snapshot: checkingNetworkSnapshot(),
        startupPending: true,
        refreshing: false,
        error: null,
      });
    }
  };
  void requestSnapshot("snapshot");
  return current.stop;
}
