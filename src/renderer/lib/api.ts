import type { WorkbenchApi } from "@shared/ipc";
import { resolveRendererRuntime } from "@shared/renderer-runtime";
import { createPreviewApi } from "./preview-api";
import { createUnavailableApi } from "./unavailable-api";

/**
 * The preload bridge is the only path to the main process. When the shell is
 * opened in an explicit local development browser a deterministic
 * in-memory preview API stands in so UI work does not require the desktop
 * runtime. Nothing in the preview touches real platforms.
 */
export const hasBridge = typeof window !== "undefined" && Boolean(window.workbench);

export const runtimeMode = resolveRendererRuntime({
  hasBridge,
  development: import.meta.env.DEV,
  url: typeof window !== "undefined" ? window.location.href : null,
  userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
});

export const api: WorkbenchApi =
  runtimeMode === "desktop" ? window.workbench!
    : runtimeMode === "preview" ? createPreviewApi()
      : createUnavailableApi();
