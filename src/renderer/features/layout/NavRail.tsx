import {
  BarChart3,
  Clapperboard,
  FolderOpen,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Settings,
  Users,
} from "lucide-react";
import { cx } from "@renderer/components/ui";
import { useAccounts, useSettings, useUi, type Route } from "@renderer/store";
import styles from "./layout.module.css";

const ITEMS: Array<{ route: Route; label: string; icon: typeof LayoutDashboard }> = [
  { route: "overview", label: "总览", icon: LayoutDashboard },
  { route: "workspace", label: "账号", icon: Users },
  { route: "metrics", label: "数据观测", icon: BarChart3 },
  { route: "assets", label: "素材库", icon: FolderOpen },
  { route: "publish", label: "发布助手", icon: Send },
];

export function NavRail() {
  const route = useUi((s) => s.route);
  const collapsed = useUi((s) => s.railCollapsed);
  const setRoute = useUi((s) => s.setRoute);
  const toggleRail = useUi((s) => s.toggleRail);
  const patch = useSettings((s) => s.patch);
  const attention = useAccounts(
    (s) =>
      s.accounts.filter(
        (a) => a.status === "offline" || a.status === "needs_verification" || a.status === "expiring",
      ).length,
  );

  const onToggle = () => {
    toggleRail();
    void patch({ sidebarCollapsed: !collapsed });
  };

  return (
    <nav className={cx(styles.rail, collapsed && styles.railCollapsed)} aria-label="主导航">
      <div className={styles.brand}>
        <div className={styles.brandMark}>
          <Clapperboard size={18} strokeWidth={2.4} />
        </div>
        <div className={styles.brandText}>
          <strong>矩阵工作台</strong>
          <span>MATRIX OPS</span>
        </div>
      </div>
      <div className={styles.navList}>
        {ITEMS.map((item) => (
          <button
            key={item.route}
            type="button"
            className={cx(styles.navItem, route === item.route && styles.active)}
            onClick={() => setRoute(item.route)}
            title={collapsed ? item.label : undefined}
          >
            <item.icon size={18} strokeWidth={2} />
            <span>{item.label}</span>
            {item.route === "workspace" && attention > 0 ? (
              <span className={styles.navCount}>{attention}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className={styles.railSpacer} />
      <div className={styles.railFoot}>
        <button
          type="button"
          className={cx(styles.navItem, route === "settings" && styles.active)}
          onClick={() => setRoute("settings")}
          title={collapsed ? "设置" : undefined}
        >
          <Settings size={18} strokeWidth={2} />
          <span>设置</span>
        </button>
        <button
          type="button"
          className={styles.railToggle}
          onClick={onToggle}
          title={collapsed ? "展开导航" : "收起导航"}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
    </nav>
  );
}
