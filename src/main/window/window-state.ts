import fs from "node:fs";
import path from "node:path";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  version: 1;
  bounds: WindowBounds;
  maximized: boolean;
}

export function defaultWindowState(workArea: WindowBounds): WindowState {
  const width = Math.min(1480, Math.max(1024, Math.round(workArea.width * 0.86)));
  const height = Math.min(920, Math.max(680, Math.round(workArea.height * 0.86)));
  return {
    version: 1,
    bounds: {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    },
    maximized: false,
  };
}

export function readWindowState(file: string): WindowState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as WindowState;
    if (parsed?.version !== 1 || !parsed.bounds) return null;
    const { x, y, width, height } = parsed.bounds;
    if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
    return { version: 1, bounds: { x, y, width, height }, maximized: Boolean(parsed.maximized) };
  } catch {
    return null;
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), "utf8");
  } catch {
    // window state is a convenience; never fail startup/shutdown over it
  }
}

/** Keep the window inside the work area and above minimum size. */
export function clampWindowState(
  state: WindowState,
  workArea: WindowBounds,
  minWidth: number,
  minHeight: number,
): WindowState {
  const width = Math.max(minWidth, Math.min(state.bounds.width, workArea.width));
  const height = Math.max(minHeight, Math.min(state.bounds.height, workArea.height));
  let { x, y } = state.bounds;
  if (x < workArea.x || x + width > workArea.x + workArea.width)
    x = workArea.x + Math.round((workArea.width - width) / 2);
  if (y < workArea.y || y + height > workArea.y + workArea.height)
    y = workArea.y + Math.round((workArea.height - height) / 2);
  return { version: 1, bounds: { x, y, width, height }, maximized: state.maximized };
}
