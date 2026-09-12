import { app, BaseWindow, Menu, nativeImage, Tray, type Event } from "electron";
import { trayIconPng } from "./tray-icon";

export interface WorkbenchTray {
  show(): void;
  dispose(): void;
}

/** Keep the same runtime and sessions alive; only explicit Quit tears them down. */
export function createWorkbenchTray(
  window: BaseWindow,
  options: { isQuitting(): boolean; quit(): void },
): WorkbenchTray {
  const tray = new Tray(nativeImage.createFromBuffer(Buffer.from(trayIconPng, "base64")));
  let disposed = false;
  let sessionEnding = false;
  let explained = false;
  const hiddenWindows = new Set<BaseWindow>();
  const watched = new Map<BaseWindow, () => void>();
  const hideAuxiliary = (other: BaseWindow) => {
    if (other !== window && !other.isDestroyed() && other.isVisible() && !window.isVisible()) {
      hiddenWindows.add(other);
      other.hide();
    }
  };
  const watch = (other: BaseWindow) => {
    if (other === window || watched.has(other)) return;
    const hideIfBackground = () => hideAuxiliary(other);
    watched.set(other, hideIfBackground);
    other.on("show", hideIfBackground);
    other.once("closed", () => {
      hiddenWindows.delete(other);
      watched.delete(other);
    });
    hideIfBackground();
  };
  const onCreated = (_event: Event, other: BaseWindow) => watch(other);
  const onHide = () => {
    tray.setToolTip("短视频矩阵工作台 · 后台运行");
    for (const other of BaseWindow.getAllWindows()) {
      watch(other);
      hideAuxiliary(other);
    }
  };
  const onShow = () => {
    tray.setToolTip("短视频矩阵工作台");
    for (const other of hiddenWindows) if (!other.isDestroyed()) other.showInactive();
    hiddenWindows.clear();
  };
  const show = () => {
    if (disposed || options.isQuitting() || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const onClose = (event: Event) => {
    if (disposed || sessionEnding || options.isQuitting() || tray.isDestroyed()) return;
    event.preventDefault();
    window.hide();
    if (!explained) {
      explained = true;
      try {
        tray.displayBalloon({
          title: "工作台已在后台运行",
          content: "点击托盘图标重新打开；右键选择“退出软件”可彻底退出。",
          iconType: "info",
          noSound: true,
        });
      } catch {
        // Notification delivery is optional; the tray remains the restore entry.
      }
    }
  };
  const onSessionEnd = () => {
    sessionEnding = true;
  };
  tray.setToolTip("短视频矩阵工作台");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "短视频矩阵工作台", enabled: false },
      { type: "separator" },
      { label: "打开工作台", click: show },
      {
        label: "退出软件",
        click: () => {
          if (!options.isQuitting()) options.quit();
        },
      },
    ]),
  );
  tray.on("click", show);
  tray.on("double-click", show);
  tray.on("balloon-click", show);
  window.on("close", onClose);
  window.on("hide", onHide);
  window.on("show", onShow);
  window.on("query-session-end", onSessionEnd);
  window.on("session-end", onSessionEnd);
  app.on("browser-window-created", onCreated);
  for (const other of BaseWindow.getAllWindows()) watch(other);
  return {
    show,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeListener("close", onClose);
      window.removeListener("hide", onHide);
      window.removeListener("show", onShow);
      window.removeListener("query-session-end", onSessionEnd);
      window.removeListener("session-end", onSessionEnd);
      app.removeListener("browser-window-created", onCreated);
      for (const [other, listener] of watched) other.removeListener("show", listener);
      watched.clear();
      hiddenWindows.clear();
      tray.destroy();
    },
  };
}
