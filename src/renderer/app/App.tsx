import { useEffect } from "react";
import { ToastStack, cx } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { subscribeToMain, useAccounts, useSettings, useToasts, useUi } from "@renderer/store";
import { NavRail } from "@renderer/features/layout/NavRail";
import { AccountSidebar } from "@renderer/features/layout/AccountSidebar";
import { AccountWorkspace } from "@renderer/features/browser/AccountWorkspace";
import { OverviewPage } from "@renderer/features/dashboard/OverviewPage";
import { MetricsPage } from "@renderer/features/metrics/MetricsPage";
import { AssetsPage } from "@renderer/features/assets/AssetsPage";
import { PublishPage } from "@renderer/features/publish/PublishPage";
import { SettingsPage } from "@renderer/features/settings/SettingsPage";
import { AddAccountModal } from "@renderer/features/accounts/AddAccountModal";
import layout from "@renderer/features/layout/layout.module.css";

function useTheme() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

function useBootstrap() {
  const loadAccounts = useAccounts((s) => s.load);
  const loadSettings = useSettings((s) => s.load);
  useEffect(() => {
    const off = subscribeToMain();
    void Promise.all([loadSettings(), loadAccounts()]).then(() => {
      const { settings } = useSettings.getState();
      const { accounts } = useAccounts.getState();
      const remembered =
        settings.lastActiveAccountId && accounts.some((a) => a.id === settings.lastActiveAccountId)
          ? settings.lastActiveAccountId
          : null;
      const route = settings.lastRoute as ReturnType<typeof useUi.getState>["route"] | null;
      useUi.setState({
        activeAccountId: remembered ?? accounts[0]?.id ?? null,
        route:
          route && ["overview", "workspace", "metrics", "assets", "publish", "settings"].includes(route)
            ? route
            : "overview",
      });
    });
    return off;
  }, [loadAccounts, loadSettings]);
}

function usePersistLocation() {
  const route = useUi((s) => s.route);
  const activeAccountId = useUi((s) => s.activeAccountId);
  const loaded = useSettings((s) => s.loaded);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(
      () =>
        void api.settings
          .set({ lastRoute: route, lastActiveAccountId: activeAccountId })
          .catch(() => undefined),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [route, activeAccountId, loaded]);
}

function useHideViewsOffWorkspace() {
  const route = useUi((s) => s.route);
  useEffect(() => {
    if (route !== "workspace") void api.views.hideAll().catch(() => undefined);
  }, [route]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const { accounts } = useAccounts.getState();
      const ui = useUi.getState();
      if (/^[1-9]$/.test(event.key)) {
        const account = accounts[Number(event.key) - 1];
        if (account) {
          event.preventDefault();
          ui.openAccount(account.id);
        }
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        ui.toggleRail();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        ui.setAddAccountOpen(true);
      } else if (event.key.toLowerCase() === "d" && ui.route === "workspace") {
        event.preventDefault();
        ui.toggleDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  useTheme();
  useBootstrap();
  usePersistLocation();
  useHideViewsOffWorkspace();
  useShortcuts();

  const route = useUi((s) => s.route);
  const railCollapsed = useUi((s) => s.railCollapsed);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const toasts = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div
      className={cx(
        layout.shell,
        railCollapsed && layout.railCollapsed,
        sidebarHidden && layout.sidebarHidden,
      )}
    >
      <NavRail />
      <AccountSidebar />
      <main className={layout.main}>
        {route === "overview" ? <OverviewPage /> : null}
        {route === "workspace" ? <AccountWorkspace /> : null}
        {route === "metrics" ? <MetricsPage /> : null}
        {route === "assets" ? <AssetsPage /> : null}
        {route === "publish" ? <PublishPage /> : null}
        {route === "settings" ? <SettingsPage /> : null}
      </main>
      <AddAccountModal />
      <ToastStack items={toasts} onDismiss={dismiss} />
    </div>
  );
}
