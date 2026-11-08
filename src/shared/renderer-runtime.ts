export type RendererRuntimeMode = "desktop" | "preview" | "unavailable";

/** Set by the shell before preload runs, including when preload fails to load. */
export const DESKTOP_RUNTIME_QUERY = "__workbench_runtime";

export function desktopShellUrl(devUrl: string): string {
  const url = new URL(devUrl);
  url.searchParams.set(DESKTOP_RUNTIME_QUERY, "desktop");
  return url.href;
}

/** Presentation routing only. The preload bridge remains the only desktop API transport. */
export function resolveRendererRuntime(input: {
  hasBridge: boolean;
  development: boolean;
  url: string | null;
  userAgent: string;
}): RendererRuntimeMode {
  if (input.hasBridge) return "desktop";
  if (!input.development || !input.url) return "unavailable";
  try {
    const url = new URL(input.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.searchParams.has(DESKTOP_RUNTIME_QUERY) ||
      /\bElectron\//i.test(input.userAgent)
    )
      return "unavailable";
    return "preview";
  } catch {
    return "unavailable";
  }
}
