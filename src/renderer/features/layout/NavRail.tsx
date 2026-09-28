import {
  BarChart3,
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
import appIcon from "../../../../resources/app-icon.png";

const ITEMS: Array<{ route: Route; label: string; icon: typeof LayoutDashboard }> = [
  { route: "overview", label: "总览", icon: LayoutDashboard },
  { route: "creator", label: "短视频创作者平台", icon: Users },
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
        <img className={styles.brandMark} src={appIcon} alt="短视频矩阵工作台" />
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
            className={cx(
              styles.navItem,
              (route === item.route ||
                (item.route === "creator" && (route === "workspace" || route === "global"))) &&
                styles.active,
            )}
            onClick={() => setRoute(item.route)}
            title={item.label}
            aria-label={item.label}
          >
            <item.icon size={18} strokeWidth={2} />
            <span>{item.label}</span>
            {item.route === "creator" && attention > 0 ? (
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
          title="设置"
          aria-label="设置"
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
