import { useEffect, useState } from "react";
import type { Account } from "@shared/types";
import { api } from "@renderer/lib/api";

/** Latest follower count per account, refreshed when the main process reports new metrics. */
export function useAccountFollowers(accounts: Account[]): Record<string, number | null> {
  const [values, setValues] = useState<Record<string, number | null>>({});
  const key = accounts.map((a) => a.id).join("|");

  useEffect(() => {
    let cancelled = false;
    const load = async (ids: string[]) => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const view = await api.metrics.account(id, 1);
            return [id, view.metrics.followers?.current ?? null] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      if (!cancelled) setValues((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    };
    void load(key ? key.split("|") : []);
    const off = api.on("metrics-updated", ({ accountId }) => void load([accountId]));
    return () => {
      cancelled = true;
      off();
    };
  }, [key]);

  return values;
}
