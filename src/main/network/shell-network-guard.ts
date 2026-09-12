import type { Session } from "electron";
import { isIP } from "node:net";
import { isStrictBusinessNetwork } from "./business-access";

const installed = new WeakSet<Session>();

/** Only an explicitly configured literal loopback origin may serve the development shell. */
function developmentOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = raw.trim();
    if ([...value].some((character) => character.charCodeAt(0) <= 32 || character === "\\")) return null;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (!authority) return null;
    const literal = authority.startsWith("[")
      ? authority.slice(1, authority.indexOf("]"))
      : authority.split(":")[0];
    // Validate the original spelling: URL normalizes aliases such as 127.1 or decimal IPv4.
    const loopback =
      (isIP(literal) === 4 && literal.startsWith("127.") && url.hostname === literal) ||
      (isIP(literal) === 6 && url.hostname === "[::1]");
    return loopback ? url.origin : null;
  } catch {
    return null;
  }
}

function isLocalRequest(raw: string, devOrigin: string | null): boolean {
  const url = new URL(raw);
  if (url.username || url.password) return false;
  switch (url.protocol) {
    case "file:": {
      // file://server/share and file:////server/share both address UNC resources on Windows.
      const pathname = decodeURIComponent(url.pathname).replace(/\\/g, "/");
      return url.hostname === "" && !pathname.startsWith("//");
    }
    case "data:":
    case "blob:":
      // These schemes do not themselves dial a remote host; any subrequest is checked separately.
      return true;
    case "about:":
      return url.pathname === "blank" || url.pathname === "srcdoc";
    case "sv-asset:":
      return url.hostname === "file" || url.hostname === "thumb" || url.hostname === "remote";
    case "http:":
    case "https:":
      return devOrigin !== null && url.origin === devOrigin;
    case "ws:":
    case "wss:":
      url.protocol = url.protocol === "ws:" ? "http:" : "https:";
      return devOrigin !== null && url.origin === devOrigin;
    default:
      return false;
  }
}

/**
 * The shell's default Session owns this listener for its lifetime. Account and diagnostic
 * partitions have separate Sessions and guards. Call before the shell's first load; do not
 * uninstall on view disposal or replace this Session's onBeforeRequest listener elsewhere.
 */
export function ensureShellNetworkGuard(session: Session, devServerUrl: string | null): void {
  if (installed.has(session)) return;
  const devOrigin = developmentOrigin(devServerUrl);
  session.webRequest.onBeforeRequest((details, callback) => {
    let cancel = true;
    try {
      cancel = isStrictBusinessNetwork() && !isLocalRequest(details.url, devOrigin);
    } catch {
      // Never expose the URL/error: even avatar and cover addresses can contain credentials.
    } finally {
      callback({ cancel });
    }
  });
  // Pin the boot configuration; recreating a shell cannot silently widen the local exception.
  installed.add(session);
}
