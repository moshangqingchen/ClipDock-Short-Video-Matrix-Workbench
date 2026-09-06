import { create } from "zustand";
import type { Account, AppSettings, ViewState } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/types";
import type { ToastEvent } from "@shared/ipc";
import type { PlatformId } from "@shared/platforms";
import { api } from "@renderer/lib/api";
import type { ToastItem } from "@renderer/components/ui";

export type Route = "overview" | "workspace" | "metrics" | "assets" | "publish" | "settings";

/* ---------------- accounts ---------------- */

interface AccountsState {
  accounts: Account[];
  loaded: boolean;
  load(): Promise<void>;
  upsert(account: Account): void;
  byId(id: string): Account | undefined;
}

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  loaded: false,
  async load() {
    const accounts = await api.accounts.list();
    set({ accounts, loaded: true });
  },
  upsert(account) {
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
    set((s) => ({ states: { ...s.states, [state.accountId]: state } }));
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
  activeAccountId: string | null;
  metricsPlatform: PlatformId | null;
  railCollapsed: boolean;
  sidebarHidden: boolean;
  drawerOpen: boolean;
  /** Any overlay that must hide the native account view (modals, menus). */
  overlayCount: number;
  addAccountOpen: boolean;
  searchOpen: boolean;
  theme: AppSettings["theme"];
  setRoute(route: Route): void;
  openAccount(id: string): void;
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
  activeAccountId: null,
  metricsPlatform: null,
  railCollapsed: false,
  sidebarHidden: false,
  drawerOpen: false,
  overlayCount: 0,
  addAccountOpen: false,
  searchOpen: false,
  theme: "system",
  setRoute: (route) => set({ route }),
  openAccount: (id) => set({ activeAccountId: id, route: "workspace" }),
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
    api.on("accounts-reloaded", () => void useAccounts.getState().load()),
    api.on("view-state", (state) => useViews.getState().set(state)),
    api.on("toast", toastFromEvent),
  ];
  return () => {
    subscribed = false;
    offs.forEach((off) => off());
  };
}
