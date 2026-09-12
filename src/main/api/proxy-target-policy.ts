import type { GlobalPlatformId } from "@shared/platforms";

export const OFFICIAL_API_HOSTS: Readonly<Record<GlobalPlatformId, readonly string[]>> = Object.freeze({
  youtube: Object.freeze(["www.googleapis.com", "youtube.googleapis.com", "oauth2.googleapis.com"]),
  tiktok: Object.freeze(["open.tiktokapis.com"]),
  x: Object.freeze(["api.x.com", "api.twitter.com", "upload.twitter.com"]),
});
/** Reviewed upload origins from TikTok's upload reference and media transfer guide. */
export const TIKTOK_UPLOAD_HOSTS = Object.freeze(["open-upload.tiktokapis.com", "upload.us.tiktokapis.com"]);
export function isOfficialProxyHost(platform: string, host: string): boolean {
  return (
    !!OFFICIAL_API_HOSTS[platform as GlobalPlatformId]?.includes(host) ||
    (platform === "tiktok" && TIKTOK_UPLOAD_HOSTS.includes(host))
  );
}

export interface TikTokUploadTarget {
  readonly kind: "tiktok-upload";
}
const targets = new WeakMap<
  TikTokUploadTarget,
  { url: string; expiresAtMono: number; assertCurrent(): void }
>();
export function validTikTokUploadUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 256 || /[\s\\]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      TIKTOK_UPLOAD_HOSTS.includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      url.pathname === "/video/" &&
      url.searchParams.getAll("upload_id").length === 1 &&
      !!url.searchParams.get("upload_id") &&
      url.searchParams.getAll("upload_token").length === 1 &&
      !!url.searchParams.get("upload_token") &&
      [...url.searchParams.keys()].every((key) => key === "upload_id" || key === "upload_token") &&
      url.href === raw
    );
  } catch {
    return false;
  }
}
/** Main-only: issue after a verified official init response, or a matching encrypted saved session.
 * An IPC object, copied marker or arbitrary URL can never be a transport capability. */
export function issueTikTokUploadTarget(
  url: string,
  expiresAtMono: number,
  assertCurrent: () => void,
): TikTokUploadTarget {
  if (
    !validTikTokUploadUrl(url) ||
    !Number.isFinite(expiresAtMono) ||
    expiresAtMono <= performance.now() ||
    expiresAtMono > performance.now() + 3_600_000 ||
    typeof assertCurrent !== "function"
  )
    throw new Error("UPLOAD_TARGET_INVALID");
  assertCurrent();
  const target = Object.freeze({ kind: "tiktok-upload" as const });
  targets.set(target, { url, expiresAtMono, assertCurrent });
  return target;
}
export function assertTikTokUploadTarget(target: TikTokUploadTarget, url: string): number {
  const saved = target && targets.get(target);
  if (!saved || saved.url !== url || performance.now() >= saved.expiresAtMono)
    throw new Error("UPLOAD_TARGET_INVALID");
  saved.assertCurrent();
  if (performance.now() >= saved.expiresAtMono) throw new Error("UPLOAD_TARGET_INVALID");
  return saved.expiresAtMono;
}
