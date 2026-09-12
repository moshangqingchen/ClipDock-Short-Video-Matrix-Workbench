export { useGlobalAccounts } from "./global-accounts";
import { create } from "zustand";
import type { Account, AppSettings, ViewState } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/types";
import type { ToastEvent } from "@shared/ipc";
import type { PlatformId } from "@shared/platforms";
import { api } from "@renderer/lib/api";
import type { ToastItem } from "@renderer/components/ui";

export type Route =
  "overview" | "creator" | "workspace" | "global" | "metrics" | "assets" | "publish" | "settings";

/* ---------------- accounts ---------------- */

interface AccountsState {
  accounts: Account[];
  loaded: boolean;
  loadError: string | null;
  load(): Promise<void>;
  upsert(account: Account): void;
  byId(id: string): Account | undefined;
}

let accountsRevision = 0;
let listRevision = 0;
const changedAccounts = new Map<string, number>();
export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  loaded: false,
  loadError: null,
  async load() {
    const request = ++listRevision;
    const revision = accountsRevision;
    let accounts: Account[];
    try {
      try {
        accounts = await api.accounts.list();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (request !== listRevision) return;
        accounts = await api.accounts.list();
      }
    } catch (error) {
      if (request === listRevision) set({ loadError: "账号列表加载失败，已有资料已保留，请点击刷新重试" });
      throw error;
    }
    if (request !== listRevision) return;
    const local = new Map(get().accounts.map((account) => [account.id, account]));
    const merged = accounts.map((account) =>
      (changedAccounts.get(account.id) ?? -1) > revision ? (local.get(account.id) ?? account) : account,
    );
    const present = new Set(merged.map((account) => account.id));
    for (const account of local.values())
      if (!present.has(account.id) && (changedAccounts.get(account.id) ?? -1) > revision)
        merged.push(account);
    set({ accounts: merged, loaded: true, loadError: null });
  },
  upsert(account) {
    accountsRevision++;
    changedAccounts.set(account.id, accountsRevision);
    set((state) => {
      const index = state.accounts.findIndex((a) => a.id === account.id);
      const next = [...state.accounts];
      if (index >= 0) next[index] = account;
      else next.push(account);
      next.sort(
        (a, b) =>
          a.platformId.localeCompare(b.platformId) ||
          a.sortOrder - b.sortOrder ||
          a.createdAt.localeCompare(b.createdAt),
      );
      return { accounts: next };
    });
  },
  byId(id) {
    return get().accounts.find((a) => a.id === id);
  },
}));

/* ---------------- views ---------------- */

interface ViewsState {
  states: Record<string, ViewState>;
  set(state: ViewState): void;
  remove(id: string): void;
}

export const useViews = create<ViewsState>((set) => ({
  states: {},
  set(state) {
    set((s) => {
      if ((s.states[state.accountId]?.revision ?? -1) > (state.revision ?? 0)) return s;
      return { states: { ...s.states, [state.accountId]: state } };
    });
  },
  remove(id) {
    set((s) => {
      const next = { ...s.states };
      delete next[id];
      return { states: next };
    });
  },
}));

/* ---------------- ui ---------------- */

interface UiState {
  route: Route;
  creatorMode: "domestic" | "global";
  activeAccountId: string | null;
  /** Re-entering even the selected account opens its default platform homepage. */
  accountEntryRevision: number;
  /** Explicit work navigation; ordinary account entry always clears this target. */
  accountEntryUrl: string | null;
  activeGlobalAccountId: string | null;
  selectGlobalAccount(id: string | null): void;
  openGlobalAccount(id: string): void;
  metricsAccountId: string | null;
  setMetricsAccountId(id: string | null): void;
  globalMetricsDetail: boolean;
  setGlobalMetricsDetail(value: boolean): void;
  metricsPlatform: PlatformId | null;
  railCollapsed: boolean;
  sidebarHidden: boolean;
  drawerOpen: boolean;
  /** Any overlay that must hide the native account view (modals, menus). */
  selectedAssetIds: string[];
  selectAssets(ids: string[]): void;
  overlayCount: number;
  addAccountOpen: boolean;
  searchOpen: boolean;
  theme: AppSettings["theme"];
  setRoute(route: Route): void;
  setCreatorMode(mode: "domestic" | "global"): void;
  selectAccount(id: string): void;
  openAccount(id: string): void;
  openWork(id: string, url: string): void;
  setMetricsPlatform(id: PlatformId | null): void;
  toggleRail(): void;
  toggleSidebar(): void;
  toggleDrawer(open?: boolean): void;
  pushOverlay(): void;
  popOverlay(): void;
  setAddAccountOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setTheme(theme: AppSettings["theme"]): void;
}

export const useUi = create<UiState>((set) => ({
  route: "overview",
  creatorMode: "domestic",
  activeAccountId: null,
  accountEntryRevision: 0,
  accountEntryUrl: null,
  activeGlobalAccountId: null,
  selectGlobalAccount: (id) =>
    set((state) => ({
      activeGlobalAccountId: id,
      ...(state.route === "metrics" ? { globalMetricsDetail: true } : {}),
    })),
  openGlobalAccount: (id) => set({ activeGlobalAccountId: id, creatorMode: "global", route: "creator" }),
  metricsAccountId: null,
  setMetricsAccountId: (id) => set({ metricsAccountId: id, ...(id ? { activeAccountId: id } : {}) }),
  globalMetricsDetail: true,
  setGlobalMetricsDetail: (value) => set({ globalMetricsDetail: value }),
  metricsPlatform: null,
  railCollapsed: false,
  sidebarHidden: false,
  drawerOpen: false,
  selectedAssetIds: [],
  selectAssets: (ids) => set({ selectedAssetIds: ids }),
  overlayCount: 0,
  addAccountOpen: false,
  searchOpen: false,
  theme: "system",
  setRoute: (route) => set({ route }),
  setCreatorMode: (creatorMode) =>
    set((state) => ({
      creatorMode,
      route: state.route === "workspace" || state.route === "global" ? "creator" : state.route,
    })),
  selectAccount: (id) =>
    set((state) => ({
      activeAccountId: id,
      accountEntryRevision: state.accountEntryRevision + 1,
      accountEntryUrl: null,
      ...(state.route === "metrics" ? { metricsAccountId: id } : {}),
    })),
  openAccount: (id) => set((state) => ({
    activeAccountId: id,
    accountEntryRevision: state.accountEntryRevision + 1,
    accountEntryUrl: null,
    creatorMode: "domestic",
    route: "creator",
  })),
  openWork: (id, url) => set((state) => ({
    activeAccountId: id,
    accountEntryRevision: state.accountEntryRevision + 1,
    accountEntryUrl: url,
    creatorMode: "domestic",
    route: "creator",
  })),
  setMetricsPlatform: (id) => set({ metricsPlatform: id }),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  toggleSidebar: () => set((s) => ({ sidebarHidden: !s.sidebarHidden })),
  toggleDrawer: (open) => set((s) => ({ drawerOpen: open ?? !s.drawerOpen })),
  pushOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  popOverlay: () => set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
  setAddAccountOpen: (open) => set({ addAccountOpen: open }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setTheme: (theme) => set({ theme }),
}));

/* ---------------- settings ---------------- */

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load(): Promise<void>;
  patch(patch: Partial<AppSettings>): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  async load() {
    const settings = await api.settings.get();
    set({ settings, loaded: true });
    useUi.setState({ theme: settings.theme, railCollapsed: settings.sidebarCollapsed });
  },
  async patch(patch) {
    const settings = await api.settings.set(patch);
    set({ settings });
    if (patch.theme) useUi.setState({ theme: settings.theme });
    void get;
  },
}));

/* ---------------- toasts ---------------- */

interface ToastState {
  items: ToastItem[];
  push(toast: Omit<ToastItem, "id">): void;
  dismiss(id: number): void;
}

let toastSeq = 1;
export const useToasts = create<ToastState>((set) => ({
  items: [],
  push(toast) {
    const id = toastSeq++;
    set((s) => ({ items: [...s.items.slice(-4), { ...toast, id }] }));
    setTimeout(
      () => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
      toast.kind === "error" ? 8000 : 4500,
    );
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
  },
}));

export function toastFromEvent(event: ToastEvent): void {
  useToasts.getState().push({ kind: event.kind, title: event.title, message: event.message });
}

/* ---------------- bootstrap subscriptions ---------------- */

let subscribed = false;
export function subscribeToMain(): () => void {
  if (subscribed) return () => undefined;
  subscribed = true;
  const offs = [
    api.on("account-changed", (account) => useAccounts.getState().upsert(account)),
    api.on("accounts-reloaded", () => void useAccounts.getState().load().catch(() => undefined)),
    api.on("view-state", (state) => useViews.getState().set(state)),
    api.on("toast", toastFromEvent),
  ];
  return () => {
    subscribed = false;
    offs.forEach((off) => off());
  };
}
