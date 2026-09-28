/**
 * Electron's default user agent advertises both the app name/version and the
 * Electron version, e.g.
 *
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   short-video-matrix-workbench/1.0.0 Chrome/140.0.0.0 Electron/43.3.0 Safari/537.36
 *
 * Keep the actual Chromium version while omitting the application and Electron
 * wrapper tokens. Installed application versions can contain prerelease and
 * build suffixes; matching only digits leaves those product tokens in the UA.
 * This normalization alone does not establish website login compatibility.
 */
export function toChromeUserAgent(fallback: string): string {
  return (
    fallback
      .replace(/\sElectron\/\S+/i, "")
      // The product token can be any string (including non-ASCII app names).
      .replace(/\s[^\s/]+\/\S+(?=\sChrome\/)/, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

export function chromeMajorVersion(userAgent: string): string {
  const match = /Chrome\/(\d+)/.exec(userAgent);
  return match?.[1] ?? "140";
}

/**
 * Client Hints are left exactly as Chromium emits them ("Chromium" + grease
 * brand). Rewriting the `Sec-CH-UA` header to claim "Google Chrome" would
 * contradict `navigator.userAgentData.brands` inside the page, and a
 * header/JS mismatch is a stronger automation signal than a plain Chromium
 * identity, which is what Brave, Vivaldi and ungoogled builds present.
 */
export function describeIdentity(userAgent: string): { userAgent: string; chromeMajor: string } {
  return { userAgent, chromeMajor: chromeMajorVersion(userAgent) };
}
