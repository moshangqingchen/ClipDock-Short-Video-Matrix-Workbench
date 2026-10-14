import { useEffect, useRef } from "react";
import type { ViewBounds } from "@shared/types";
import { api } from "@renderer/lib/api";
import { useUi } from "@renderer/store";
import { useNetwork } from "@renderer/store/network";

// Native views paint above the renderer. Finish a cancelled show (including
// its hide) before another host can show, even when an IPC reply arrives late.
let showTransition: Promise<void> = Promise.resolve();

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
 * page: the pool opens the official entry only when no live page exists.
 * Account switches, modal restoration and repeated selection reuse that page.
 */
export function ViewHost({ accountId, initialUrl, onError }: {
  accountId: string;
  initialUrl?: string | null;
  onError?: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enteredAccount = useRef<string | null>(null);
  const overlayCount = useUi((s) => s.overlayCount);
  const hidden = overlayCount > 0;
  const networkReady = useNetwork(
    (s) => s.snapshot.accounts.find((a) => a.accountId === accountId)?.state === "allowed",
  );

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
    showTransition = showTransition
      .then(async () => {
        if (cancelled) return;
        try {
          const newEntry = enteredAccount.current !== accountId;
          const enterHomepage = newEntry && !initialUrl;
          // Claim the foreground before a work load, so background collectors
          // cannot borrow this account view and redirect it to management.
          const state = await api.views.show(accountId, measure(el) ?? initial, enterHomepage);
          if (newEntry && initialUrl && !state.recoveryRequired) {
            if (cancelled) return;
            await api.views.navigate(accountId, initialUrl);
          }
          // A completed entry counts even if a modal hid the host while the IPC
          // was pending. A failed work navigation remains pending for retry.
          enteredAccount.current = accountId;
          if (!cancelled) onError?.(state.recoveryRequired ? state.recoveryMessage ?? "页面已中断，请选择入口重新打开" : "");
        } catch (error) {
          if (!cancelled) onError?.(error instanceof Error ? error.message : String(error));
        } finally {
          if (cancelled) await api.views.hide(accountId).catch(() => undefined);
        }
      })
      .catch(() => undefined);

    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        sync();
      });
    });
    observer.observe(el);
    // Follow moving ancestors during the ~320ms layout transition, then stop.
    // A perpetual 120ms layout read wastes renderer work even when the pane is idle.
    let interval: number | undefined;
    let settleTimer: number | undefined;
    const trackTransition = () => {
      if (interval === undefined) interval = window.setInterval(() => sync(), 60);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        window.clearInterval(interval);
        interval = undefined;
        sync();
      }, 500);
    };
    trackTransition();
    window.addEventListener("transitionrun", trackTransition, true);
    window.addEventListener("transitionend", trackTransition, true);
    const resize = () => sync();
    window.addEventListener("resize", resize);

    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      window.clearInterval(interval);
      window.clearTimeout(settleTimer);
      window.removeEventListener("transitionrun", trackTransition, true);
      window.removeEventListener("transitionend", trackTransition, true);
      window.removeEventListener("resize", resize);
      void api.views.hide(accountId).catch(() => undefined);
    };
  }, [accountId, initialUrl, hidden, onError, networkReady]);

  return <div ref={ref} data-view-host={accountId} style={{ position: "absolute", inset: 0 }} />;
}
