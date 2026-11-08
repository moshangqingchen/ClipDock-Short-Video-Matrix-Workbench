import { ChevronRight, Moon, Sun } from "lucide-react";
import { IconButton } from "@renderer/components/ui";
import { runtimeMode } from "@renderer/lib/api";
import { useSettings, useToasts, useUi, type Route } from "@renderer/store";
import styles from "./layout.module.css";

const TITLES: Record<Route, string> = {
  overview: "创作总览", creator: "创作者平台", workspace: "账号工作区", global: "国际账号",
  metrics: "数据观测", assets: "灵感素材库", publish: "发布助手", settings: "工作台设置",
};

export function WorkspaceHeader() {
  const route = useUi(s => s.route);
  const theme = useUi(s => s.theme);
  const toggleTheme = () => {
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    void useSettings.getState().patch({ theme: dark ? "light" : "dark" }).catch(() => {
      useToasts.getState().push({ kind: "error", title: "主题保存失败，请重试" });
    });
  };
  return <header className={styles.header}>
    <div className={styles.breadcrumbs}><span>我的工作空间</span><ChevronRight size={12} /><strong>{TITLES[route]}</strong></div>
    <div className={styles.headerMeta}>
      {runtimeMode === "preview" && <span className={styles.previewLabel}>界面预览 · 演示数据</span>}
      <button type="button" className={styles.headerSearch} onClick={() => useUi.getState().setSearchOpen(true)} aria-label="搜索账号与功能">
        搜索账号与功能 <kbd>Ctrl K</kbd>
      </button>
      <IconButton icon={theme === "dark" ? Sun : Moon} label="切换明暗主题" onClick={toggleTheme} />
    </div>
  </header>;
}
