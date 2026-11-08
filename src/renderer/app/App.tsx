import { GlobalMetricsPage } from "@renderer/features/global/GlobalMetricsPage";
import { GlobalAccountModalHost } from "@renderer/features/global/GlobalAccountModalHost";
import { useGlobalAccounts, subscribeGlobalAccounts } from "@renderer/store/global-accounts";
import { useEffect } from "react";
import { Button, ToastStack, cx } from "@renderer/components/ui";
import { api, runtimeMode } from "@renderer/lib/api";
import { Unplug } from "lucide-react";
import { subscribeToMain, useAccounts, useSettings, useToasts, useUi } from "@renderer/store";
import { NavRail } from "@renderer/features/layout/NavRail";
import { AccountSidebar } from "@renderer/features/layout/AccountSidebar";
import { GlobalAccountSidebar } from "@renderer/features/layout/GlobalAccountSidebar";
import { AccountWorkspace } from "@renderer/features/browser/AccountWorkspace";
import { OverviewPage } from "@renderer/features/dashboard/OverviewPage";
import { MetricsPage } from "@renderer/features/metrics/MetricsPage";
import { AssetsPage } from "@renderer/features/assets/AssetsPage";
import { PublishPage } from "@renderer/features/publish/PublishPage";
import { SettingsPage } from "@renderer/features/settings/SettingsPage";
import { GlobalAccountsPage } from "@renderer/features/global/GlobalAccountsPage";
import { CreatorPlatformPage } from "@renderer/features/creator/CreatorPlatformPage";
import { AddAccountModal } from "@renderer/features/accounts/AddAccountModal";
import { NetworkStatus } from "@renderer/features/network/NetworkStatus";
import { WorkspaceHeader } from "@renderer/features/layout/WorkspaceHeader";
import { CommandPalette } from "@renderer/features/command/CommandPalette";
import { startNetworkSubscription } from "@renderer/store/network";
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
    let cancelled = false;
    let navigated = false;
    const markNavigation = useUi.subscribe((state, previous) => {
      if (state.route !== previous.route || state.creatorMode !== previous.creatorMode) navigated = true;
    });
    const off = subscribeToMain();
    const offGlobal = subscribeGlobalAccounts();
    void Promise.all([loadSettings(), loadAccounts(), useGlobalAccounts.getState().load()]).then(() => {
      if (cancelled || navigated) return;
      const { settings } = useSettings.getState();
      const { accounts } = useAccounts.getState();
      const remembered =
        settings.lastActiveAccountId && accounts.some((a) => a.id === settings.lastActiveAccountId)
          ? settings.lastActiveAccountId
          : null;
      const route = settings.lastRoute as ReturnType<typeof useUi.getState>["route"] | null;
      const creatorMode = settings.accountScope ?? (route === "global" ? "global" : "domestic");
      const globalAccounts = useGlobalAccounts.getState().accounts;
      useUi.setState({
        activeAccountId: remembered ?? accounts[0]?.id ?? null,
        creatorMode,
        activeGlobalAccountId: globalAccounts.some((a) => a.id === settings.lastGlobalAccountId)
          ? settings.lastGlobalAccountId!
          : (globalAccounts[0]?.id ?? null),
        route:
          route &&
          ["overview", "creator", "workspace", "global", "metrics", "assets", "publish", "settings"].includes(
            route,
          )
            ? route === "workspace" || route === "global"
              ? "creator"
              : route
            : "overview",
      });
    }).catch(() => {
      // The account sidebar exposes the failed load and retains any existing list.
    });
    return () => {
      cancelled = true;
      markNavigation();
      off();
      offGlobal();
    };
  }, [loadAccounts, loadSettings]);
}

function usePersistLocation() {
  const route = useUi((s) => s.route);
  const creatorMode = useUi((s) => s.creatorMode);
  const activeAccountId = useUi((s) => s.activeAccountId);
  const activeGlobalAccountId = useUi((s) => s.activeGlobalAccountId);
  const loaded = useSettings((s) => s.loaded);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(
      () =>
        void api.settings
          .set({
            lastRoute: route === "creator" && creatorMode === "global" ? "global" : route,
            lastActiveAccountId: activeAccountId,
            lastGlobalAccountId: activeGlobalAccountId,
            accountScope: creatorMode,
          })
          .catch(() => undefined),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [route, creatorMode, activeAccountId, activeGlobalAccountId, loaded]);
}

function useHideViewsOffWorkspace() {
  const route = useUi((s) => s.route);
  const creatorMode = useUi((s) => s.creatorMode);
  useEffect(() => {
    if (route !== "workspace" && !(route === "creator" && creatorMode === "domestic"))
      void api.views.hideAll().catch(() => undefined);
  }, [route, creatorMode]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const { accounts } = useAccounts.getState();
      const ui = useUi.getState();
      if (ui.overlayCount > 0 || ui.addAccountOpen || ui.searchOpen ||
          (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true']"))) return;
      if (/^[1-9]$/.test(event.key)) {
        if (ui.creatorMode === "global") {
          const account = useGlobalAccounts.getState().accounts[Number(event.key) - 1];
          if (account) {
            event.preventDefault();
            ui.selectGlobalAccount(account.id);
          }
          return;
        }
        const account = accounts[Number(event.key) - 1];
        if (account) {
          event.preventDefault();
          ui.selectAccount(account.id);
        }
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        ui.toggleRail();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (ui.creatorMode === "global")
          window.dispatchEvent(new CustomEvent("clipdock:focus-global-create"));
        else ui.setAddAccountOpen(true);
      } else if (event.key.toLowerCase() === "d" && (ui.route === "workspace" || ui.route === "creator")) {
        event.preventDefault();
        if (ui.creatorMode === "global") ui.setRoute("metrics");
        else ui.toggleDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  if (runtimeMode === "unavailable") return <main className={layout.connectionFailure}>
    <Unplug size={38} strokeWidth={1.4} />
    <h1>桌面连接不可用</h1>
    <p>未能连接本机服务，暂时无法读取账号与业务数据。</p>
    <p>请尝试重新加载；如果仍未恢复，请关闭并重新启动工作台。</p>
    <Button variant="primary" onClick={() => window.location.reload()}>重新加载工作台</Button>
  </main>;
  return <ConnectedApp />;
}

function ConnectedApp() {
  useEffect(() => startNetworkSubscription(), []);
  useTheme();
  useBootstrap();
  usePersistLocation();
  useHideViewsOffWorkspace();
  useShortcuts();

  const route = useUi((s) => s.route);
  const railCollapsed = useUi((s) => s.railCollapsed);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const creatorMode = useUi((s) => s.creatorMode);
  const toasts = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  const showAccountSidebar = !sidebarHidden && ["creator", "workspace", "global", "metrics", "publish"].includes(route);

  return (
    <div
      className={cx(
        layout.shell,
        railCollapsed && layout.railCollapsed,
        !showAccountSidebar && layout.sidebarHidden,
      )}
    >
      <NavRail />
      {showAccountSidebar ? (creatorMode === "global" ? <GlobalAccountSidebar /> : <AccountSidebar />) : <div aria-hidden="true" />}
      <main className={layout.main}>
        <WorkspaceHeader />
        <NetworkStatus />
        {route === "overview" ? (
          creatorMode === "global" ? (
            <GlobalMetricsPage overview />
          ) : (
            <OverviewPage />
          )
        ) : null}
        {route === "workspace" ? <AccountWorkspace /> : null}
        {route === "global" ? <GlobalAccountsPage /> : null}
        {route === "creator" ? <CreatorPlatformPage /> : null}
        {route === "metrics" ? creatorMode === "global" ? <GlobalMetricsPage /> : <MetricsPage /> : null}
        {route === "assets" ? <AssetsPage /> : null}
        {route === "publish" ? <PublishPage /> : null}
        {route === "settings" ? <SettingsPage /> : null}
      </main>
      <AddAccountModal />
      <GlobalAccountModalHost />
      <CommandPalette />
      <ToastStack items={toasts} onDismiss={dismiss} />
    </div>
  );
}
