import { app, BaseWindow, screen, shell, WebContentsView } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampWindowState,
  defaultWindowState,
  readWindowState,
  writeWindowState,
  type WindowState,
} from "./window-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MainWindow {
  window: BaseWindow;
  shell: WebContentsView;
  /** Persist bounds immediately (used on quit). */
  flushState(): void;
  loadShell(): Promise<void>;
}

const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

export function resolveDevUrl(): string | null {
  return process.env.VITE_DEV_SERVER_URL?.trim() || null;
}

export function resolveShellEntry(): string {
  return path.resolve(__dirname, "../dist/index.html");
}

function isTrustedShellUrl(url: string): boolean {
  const dev = resolveDevUrl();
  try {
    const parsed = new URL(url);
    if (dev) {
      const devUrl = new URL(dev);
      return parsed.origin === devUrl.origin;
    }
    return (
      parsed.protocol === "file:" &&
      path.normalize(fileURLToPath(parsed.href)).toLowerCase() ===
        path.normalize(resolveShellEntry()).toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * The shell (React UI) is a WebContentsView filling the BaseWindow. Account
 * views are added by ViewPool *after* it, so they naturally render above the
 * shell inside the pane the renderer measures. Nothing about the shell
 * requires Node access: it talks to the main process only through preload.
 */
export function createMainWindow(userDataPath: string): MainWindow {
  const workArea = screen.getPrimaryDisplay().workArea;
  const stateFile = path.join(userDataPath, "window-state.json");
  const saved = readWindowState(stateFile);
  const initial = clampWindowState(saved ?? defaultWindowState(workArea), workArea, MIN_WIDTH, MIN_HEIGHT);

  const window = new BaseWindow({
    x: initial.bounds.x,
    y: initial.bounds.y,
    width: initial.bounds.width,
    height: initial.bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: "短视频矩阵工作台",
    backgroundColor: "#0f1420",
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "default",
  });
  window.setMenuBarVisibility(false);

  const shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged || process.env.SV_WORKBENCH_DEVTOOLS === "1",
    },
  });
  shellView.setBackgroundColor("#0f1420");
  window.contentView.addChildView(shellView);

  const fitShell = () => {
    const { width, height } = window.getContentBounds();
    shellView.setBounds({ x: 0, y: 0, width, height });
  };
  fitShell();
  window.on("resize", fitShell);
  window.on("maximize", fitShell);
  window.on("unmaximize", fitShell);
  window.on("enter-full-screen", fitShell);
  window.on("leave-full-screen", fitShell);

  // The shell never leaves its own document. Any link it wants to open goes
  // through the explicit `app.openExternal` IPC.
  const wc = shellView.webContents;
  wc.on("will-navigate", (event, url) => {
    if (!isTrustedShellUrl(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Persist bounds (debounced) and restore maximize state.
  let lastNormal = initial.bounds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = (immediate = false) => {
    if (timer) clearTimeout(timer);
    const save = () => {
      if (window.isDestroyed()) return;
      if (!window.isMaximized()) lastNormal = window.getBounds();
      const state: WindowState = { version: 1, bounds: { ...lastNormal }, maximized: window.isMaximized() };
      writeWindowState(stateFile, state);
    };
    if (immediate) save();
    else timer = setTimeout(save, 300);
  };
  window.on("resize", () => persist());
  window.on("move", () => persist());
  window.on("close", () => persist(true));
  if (initial.maximized) window.maximize();

  const loadShell = async () => {
    const dev = resolveDevUrl();
    if (dev) await wc.loadURL(dev);
    else await wc.loadFile(resolveShellEntry());
  };

  wc.once("did-finish-load", () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  });

  return {
    window,
    shell: shellView,
    flushState: () => persist(true),
    loadShell,
  };
}
