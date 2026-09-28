import { BaseWindow, type WebContentsView } from "electron";

/** A native layout host only: it owns no extra WebContents and is never shown. */
export class HomepageCheckHost {
  private window: BaseWindow | null = null;
  private readonly views = new Set<WebContentsView>();

  attach(view: WebContentsView): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BaseWindow({
        show: false, width: 1280, height: 800, frame: false,
        focusable: false, skipTaskbar: true,
      });
    }
    this.window.contentView.addChildView(view);
    this.views.add(view);
    // On Windows a detached/invisible WebContentsView has a zero CSS viewport.
    // The child needs visibility for layout; its native parent stays hidden.
    try {
      view.setVisible(true);
    } catch (error) {
      this.detach(view);
      throw error;
    }
  }

  detach(view: WebContentsView): void {
    if (!this.views.delete(view)) return;
    try { view.setVisible(false); } catch { /* The renderer/native view may already be destroyed. */ }
    try {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    } catch { /* Removal is idempotent during native shutdown. */ }
  }

  dispose(): void {
    for (const view of [...this.views]) this.detach(view);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
