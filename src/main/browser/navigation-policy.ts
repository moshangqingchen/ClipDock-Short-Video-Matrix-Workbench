import { shell } from "electron";
import type { WebContents } from "electron";
import { getPlatform, hostMatches, type PlatformId } from "@shared/platforms";

export type NavigationDecision =
  { action: "allow"; url: string } | { action: "external"; url: string } | { action: "deny"; reason: string };

export interface NavigationPolicyOptions {
  allowNetwork?: () => boolean;
  onExternal?: (url: string) => void;
  onDenied?: (url: string, reason: string) => void;
}

const DENIED_SCHEMES = new Set(["javascript:", "file:", "data:", "blob:", "chrome:", "devtools:", "about:"]);
const EXTERNAL_HANDOFF_SCHEMES = new Set([
  "mailto:",
  "tel:",
  "weixin:",
  "snssdk1128:",
  "kwai:",
  "bilibili:",
  "baiduboxapp:",
]);

/**
 * Decide what to do with a *top-level* navigation inside an account view.
 *
 * - First-party hosts (creator console, passport, static CDNs, captcha hosts)
 *   stay in the account's own view so cookies/partition are preserved.
 * - Any other http(s) destination is opened in the system browser. The user
 *   clicked it intentionally; refusing silently produced the "button does
 *   nothing" experience.
 * - Dangerous schemes are denied outright.
 * - Plain `http:` on a first-party host is upgraded to https when possible
 *   (Baijiahao occasionally redirects through an insecure hop).
 */
export function decideTopLevelNavigation(platformId: PlatformId, rawUrl: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: "deny", reason: "malformed-url" };
  }
  if (url.href === "about:blank") return { action: "allow", url: url.href };
  if (DENIED_SCHEMES.has(url.protocol)) return { action: "deny", reason: `scheme:${url.protocol}` };
  if (EXTERNAL_HANDOFF_SCHEMES.has(url.protocol)) return { action: "external", url: url.href };
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { action: "deny", reason: `scheme:${url.protocol}` };
  if (url.username || url.password) return { action: "deny", reason: "embedded-credentials" };

  const { topLevelHosts, verificationHosts } = getPlatform(platformId).login;
  const firstParty =
    topLevelHosts.some((h) => hostMatches(url.hostname, h)) ||
    verificationHosts.some((h) => hostMatches(url.hostname, h));
  if (!firstParty) return { action: "external", url: url.href };

  if (url.protocol === "http:") {
    url.protocol = "https:";
    if (url.port === "80") url.port = "";
  }
  return { action: "allow", url: url.href };
}

function openExternalSafely(url: string): void {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      EXTERNAL_HANDOFF_SCHEMES.has(parsed.protocol)
    ) {
      void shell.openExternal(parsed.href).catch(() => undefined);
    }
  } catch {
    // ignore
  }
}

/**
 * Wire the policy onto a WebContents. Sub-frame navigations are intentionally
 * untouched: captcha widgets, passport iframes and third-party analytics load
 * in frames and must not be interfered with.
 */
export function installNavigationPolicy(
  contents: WebContents,
  platformId: PlatformId,
  options: NavigationPolicyOptions = {},
): () => void {
  const handleTopLevel = (event: { preventDefault(): void }, url: string) => {
    if (options.allowNetwork && !options.allowNetwork()) {
      event.preventDefault();
      return;
    }
    const decision = decideTopLevelNavigation(platformId, url);
    if (decision.action === "allow") {
      if (decision.url !== url) {
        // Protocol upgrade: cancel the http navigation and reissue as https.
        event.preventDefault();
        void contents.loadURL(decision.url).catch(() => undefined);
      }
      return;
    }
    event.preventDefault();
    if (decision.action === "external") {
      openExternalSafely(decision.url);
      options.onExternal?.(decision.url);
    } else {
      options.onDenied?.(url, decision.reason);
    }
  };

  const onWillNavigate = (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>) => {
    handleTopLevel(event, event.url);
  };
  const onWillRedirect = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
    handleTopLevel(event, event.url);
  };

  contents.on("will-navigate", onWillNavigate);
  contents.on("will-redirect", onWillRedirect);

  // window.open(): first-party targets (passport login popups, upload preview
  // windows) are navigated in-place so the same partition handles them;
  // anything else goes to the system browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (options.allowNetwork && !options.allowNetwork()) return { action: "deny" };
    const decision = decideTopLevelNavigation(platformId, url);
    if (decision.action === "allow" && decision.url !== "about:blank") {
      void contents.loadURL(decision.url).catch(() => undefined);
    } else if (decision.action === "external") {
      openExternalSafely(decision.url);
      options.onExternal?.(decision.url);
    } else if (decision.action === "deny") {
      options.onDenied?.(url, decision.reason);
    }
    return { action: "deny" };
  });

  const onAttachWebview = (event: Electron.Event) => event.preventDefault();
  contents.on("will-attach-webview", onAttachWebview);

  return () => {
    contents.removeListener("will-navigate", onWillNavigate);
    contents.removeListener("will-redirect", onWillRedirect);
    contents.removeListener("will-attach-webview", onAttachWebview);
    try {
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
    } catch {
      // contents may already be destroyed
    }
  };
}
