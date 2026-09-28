import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api";

/** Local read-model refreshes are bounded and burst notifications share one read. */
export function useMetricResource<T>(load: () => Promise<T>, accountId?: string) {
  const [state, setState] = useState<{
    data: T | null; loading: boolean; error: boolean; ownerLoad: () => Promise<T>; ownerAccount?: string;
  }>({
    data: null, loading: true, error: false, ownerLoad: load, ownerAccount: accountId,
  });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true, sequence = 0, running = false, refreshQueued = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (running) { refreshQueued = true; return; }
      running = true;
      const request = ++sequence;
      clearTimeout(deadline);
      setState(previous => ({
        data: previous.ownerLoad === load && previous.ownerAccount === accountId ? previous.data : null,
        loading: true, error: false, ownerLoad: load, ownerAccount: accountId,
      }));
      deadline = setTimeout(() => {
        if (!active || request !== sequence) return;
        sequence++;
        running = false; refreshQueued = false;
        setState(previous => ({ ...previous, loading: false, error: true }));
      }, 15_000);
      void Promise.resolve().then(load).then(data => {
        if (!active || request !== sequence) return;
        clearTimeout(deadline);
        setState({ data, loading: false, error: false, ownerLoad: load, ownerAccount: accountId });
      }).catch(() => {
        if (!active || request !== sequence) return;
        clearTimeout(deadline);
        setState(previous => ({ ...previous, loading: false, error: true }));
      }).finally(() => {
        if (!active || request !== sequence) return;
        running = false;
        if (refreshQueued) {
          refreshQueued = false;
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 250);
        }
      });
    };
    const schedule = (changed: string) => {
      if (accountId && changed !== accountId) return;
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 250);
    };
    refresh();
    const offMetrics = api.on("metrics-updated", event => schedule(event.accountId));
    const offRun = api.on("collect-run", run => schedule(run.accountId));
    const offAccount = api.on("account-changed", account => schedule(account.id));
    const offReloaded = api.on("accounts-reloaded", () => schedule(accountId ?? ""));
    return () => {
      active = false;
      clearTimeout(debounce); clearTimeout(deadline);
      offMetrics(); offRun(); offAccount(); offReloaded();
    };
  }, [load, accountId, revision]);
  // Filter during render itself: passive effects run after a new account can paint.
  const currentOwner = state.ownerLoad === load && state.ownerAccount === accountId;
  return { data: currentOwner ? state.data : null, loading: currentOwner ? state.loading : true,
    error: currentOwner ? state.error : false, retry };
}
