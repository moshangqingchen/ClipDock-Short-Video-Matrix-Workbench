import type { WorkbenchApi } from "@shared/ipc";
import { createPreviewApi } from "./preview-api";

/**
 * The preload bridge is the only path to the main process. When the shell is
 * opened in a plain browser (Vite dev without Electron) a deterministic
 * in-memory preview API stands in so UI work does not require the desktop
 * runtime. Nothing in the preview touches real platforms.
 */
export const hasBridge = typeof window !== "undefined" && Boolean(window.workbench);

export const api: WorkbenchApi = hasBridge ? window.workbench! : createPreviewApi();
