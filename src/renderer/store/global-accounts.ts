import { create } from "zustand";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalWebState } from "@shared/global-web";
import type { WebIdentity } from "@shared/global-workspace";
import { api } from "@renderer/lib/api";

interface GlobalAccountsState {
  accounts: GlobalAccount[];
  states: Record<string, GlobalWebState>;
  identities: Record<string, WebIdentity | null>;
  loaded: boolean;
  error: string | null;
  load(): Promise<void>;
  refreshIdentity(id: string): Promise<void>;
  upsert(account: GlobalAccount): void;
  setBrowser(state: GlobalWebState): void;
}
let revision = 0;
const browserRevisions: Record<string, number> = {};
export const useGlobalAccounts = create<GlobalAccountsState>((set, get) => ({
  accounts: [],
  states: {},
  identities: {},
  loaded: false,
  error: null,
  async load() {
    const current = ++revision;
    try {
      const accounts = await api.globalAccounts.list();
      if (current !== revision) return;
      set((value) => ({
        accounts,
        loaded: true,
        error: null,
        states: Object.fromEntries(
          Object.entries(value.states).filter(([id]) => accounts.some((a) => a.id === id)),
        ),
        identities: Object.fromEntries(
          Object.entries(value.identities).filter(([id]) => accounts.some((a) => a.id === id)),
        ),
      }));
      await Promise.all(
        accounts.map(async (account) => {
          const previous = browserRevisions[account.id] ?? 0;
          const [state, identity] = await Promise.all([
            api.globalWeb.state(account.id).catch(() => null),
            api.globalWorkspace?.identity(account.id).catch(() => null),
          ]);
          if (current !== revision || !get().accounts.some((row) => row.id === account.id)) return;
          set((value) => ({
            identities: { ...value.identities, [account.id]: identity ?? null },
            states:
              state && previous === (browserRevisions[account.id] ?? 0)
                ? { ...value.states, [account.id]: state }
                : value.states,
          }));
        }),
      );
    } catch {
      if (current === revision) set({ loaded: true, error: "账号读取失败，请重试" });
    }
  },
  async refreshIdentity(id) {
    const identity = await api.globalWorkspace.identity(id).catch(() => null);
    if (get().accounts.some((account) => account.id === id))
      set((value) => ({ identities: { ...value.identities, [id]: identity } }));
  },
  upsert(account) {
    revision++;
    set((value) => ({
      accounts: [...value.accounts.filter((row) => row.id !== account.id), account].sort(
        (a, b) => a.platformId.localeCompare(b.platformId) || a.createdAt.localeCompare(b.createdAt),
      ),
      loaded: true,
    }));
  },
  setBrowser(state) {
    browserRevisions[state.accountId] = (browserRevisions[state.accountId] ?? 0) + 1;
    if (get().accounts.some((account) => account.id === state.accountId))
      set((value) => ({ states: { ...value.states, [state.accountId]: state } }));
  },
}));

export function subscribeGlobalAccounts(): () => void {
  const off = api.globalWeb.onChanged((state) => useGlobalAccounts.getState().setBrowser(state));
  const changed = () => void useGlobalAccounts.getState().load();
  const offData =
    api.globalWorkspace?.onChanged((id) => {
      void useGlobalAccounts.getState().refreshIdentity(id);
    }) ?? (() => undefined);
  window.addEventListener("clipdock:global-accounts-changed", changed);
  return () => {
    off();
    offData();
    window.removeEventListener("clipdock:global-accounts-changed", changed);
  };
}
