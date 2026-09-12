// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  windows: [] as unknown[],
  trays: [] as unknown[],
  menus: [] as Array<Array<{ label?: string; click?: () => void }>>,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    BaseWindow: { getAllWindows: () => mocks.windows },
    nativeImage: { createFromBuffer: (buffer: Buffer) => buffer },
    Menu: {
      buildFromTemplate: (menu: (typeof mocks.menus)[number]) => {
        mocks.menus.push(menu);
        return menu;
      },
    },
    Tray: class extends EventEmitter {
      destroyed = false;
      constructor() {
        super();
        mocks.trays.push(this);
      }
      setToolTip = vi.fn();
      setContextMenu = vi.fn();
      displayBalloon = vi.fn();
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
    },
  };
});
import { app, type BaseWindow } from "electron";
import { createWorkbenchTray } from "./tray";
class Window extends EventEmitter {
  visible = true;
  minimized = false;
  destroyed = false;
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isDestroyed() {
    return this.destroyed;
  }
  hide = vi.fn(() => {
    this.visible = false;
    this.emit("hide");
  });
  show = vi.fn(() => {
    this.visible = true;
    this.emit("show");
  });
  showInactive = vi.fn(() => this.show());
  restore = vi.fn(() => {
    this.minimized = false;
  });
  focus = vi.fn();
}
function setup() {
  const window = new Window();
  mocks.windows.push(window);
  let quitting = false;
  const quit = vi.fn(() => {
    quitting = true;
  });
  const controller = createWorkbenchTray(window as unknown as BaseWindow, {
    isQuitting: () => quitting,
    quit,
  });
  const tray = mocks.trays[0] as EventEmitter & {
    destroyed: boolean;
    displayBalloon: ReturnType<typeof vi.fn>;
  };
  return { window, controller, tray, quit };
}
beforeEach(() => {
  mocks.windows.length = 0;
  mocks.trays.length = 0;
  mocks.menus.length = 0;
  app.removeAllListeners();
});
describe("Windows tray lifecycle", () => {
  it("close preserves the window; clicking the tray restores the same minimized window", () => {
    const { window, controller, tray, quit } = setup();
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    expect(window.destroyed).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    window.minimized = true;
    tray.emit("click");
    expect(window.visible).toBe(true);
    expect(window.minimized).toBe(false);
    expect(window.focus).toHaveBeenCalled();
    window.emit("close", event);
    expect(tray.displayBalloon).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it("explicit Quit permits closing instead of hiding again, and blocks reopening", () => {
    const { window, controller, quit } = setup();
    mocks.menus[0].find((item) => item.label === "退出软件")!.click!();
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(quit).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    controller.show();
    expect(window.show).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("keeps auxiliary windows hidden, including popups opened while in the background", () => {
    const { window, controller } = setup();
    const existing = new Window(),
      alreadyHidden = new Window();
    alreadyHidden.visible = false;
    mocks.windows.push(existing, alreadyHidden);
    window.emit("close", { preventDefault: vi.fn() });
    expect(existing.visible).toBe(false);
    const later = new Window();
    later.visible = false;
    app.emit("browser-window-created", {}, later);
    later.show();
    expect(later.visible).toBe(false);
    controller.show();
    expect(existing.visible).toBe(true);
    expect(later.visible).toBe(true);
    expect(alreadyHidden.visible).toBe(false);
    controller.dispose();
  });
  it("does not intercept Windows session shutdown", () => {
    const { window, controller } = setup();
    window.emit("query-session-end");
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("does not hide an inaccessible window if the tray was destroyed", () => {
    const { window, tray, controller } = setup();
    tray.destroyed = true;
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("removes lifecycle listeners and the icon on disposal", () => {
    const { window, controller, tray } = setup();
    controller.dispose();
    controller.dispose();
    expect(tray.destroyed).toBe(true);
    expect(window.listenerCount("close")).toBe(0);
    expect(app.listenerCount("browser-window-created")).toBe(0);
  });
});
