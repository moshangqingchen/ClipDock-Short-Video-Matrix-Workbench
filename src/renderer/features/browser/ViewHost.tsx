import { useEffect, useRef } from "react";
import type { ViewBounds } from "@shared/types";
import { api } from "@renderer/lib/api";
import { useUi } from "@renderer/store";

function measure(el: HTMLElement): ViewBounds | null {
  const rect = el.getBoundingClientRect();
  const bounds = {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  if (bounds.width < 2 || bounds.height < 2) return null;
  return bounds;
}

/**
 * The native account view is positioned over this element. It never owns the
 * page: show/hide/bounds are the only three operations, so switching accounts
 * or opening a modal costs nothing and never reloads the platform page.
 */
export function ViewHost({ accountId, onError }: { accountId: string; onError?: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayCount = useUi((s) => s.overlayCount);
  const hidden = overlayCount > 0;

  useEffect(() => {
    const el = ref.current;
    if (!el || hidden) return undefined;
    let cancelled = false;
    let frame: number | undefined;
    let lastKey = "";

    const sync = (force = false) => {
      if (cancelled) return;
      const bounds = measure(el);
      if (!bounds) return;
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (!force && key === lastKey) return;
      lastKey = key;
      void api.views.setBounds(accountId, bounds).catch(() => undefined);
    };

    const initial = measure(el) ?? { x: 0, y: 0, width: 1, height: 1 };
    lastKey = `${initial.x},${initial.y},${initial.width},${initial.height}`;
    void api.views.show(accountId, initial).catch((error: Error) => onError?.(error.message));

    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        sync();
      });
    });
    observer.observe(el);
    // Layout transitions (rail collapse, drawer) animate for ~320ms; keep
    // polling briefly so the native view tracks the pane edge smoothly.
    const interval = window.setInterval(() => sync(), 120);
    window.addEventListener("resize", () => sync());

    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      window.clearInterval(interval);
      void api.views.hide(accountId).catch(() => undefined);
    };
  }, [accountId, hidden, onError]);

  return <div ref={ref} data-view-host={accountId} style={{ position: "absolute", inset: 0 }} />;
}
