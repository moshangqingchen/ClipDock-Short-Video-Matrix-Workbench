/** Exact upload origin/path reviewed against YouTube's resumable upload guide. */
export function validYouTubeUploadUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 16_384 || /[\s\\]/.test(raw)) return false;
  try {
    const url = new URL(raw),
      params = url.searchParams;
    return (
      url.protocol === "https:" &&
      url.hostname === "www.googleapis.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === "/upload/youtube/v3/videos" &&
      url.href === raw &&
      params.getAll("uploadType").length === 1 &&
      params.get("uploadType") === "resumable" &&
      params.getAll("upload_id").length === 1 &&
      /^[A-Za-z0-9._~-]{1,4096}$/.test(params.get("upload_id") ?? "") &&
      params.getAll("part").length === 1 &&
      params.get("part") === "snippet,status" &&
      params.getAll("notifySubscribers").length <= 1 &&
      (!params.has("notifySubscribers") || ["true", "false"].includes(params.get("notifySubscribers")!)) &&
      [...params.keys()].every((key) =>
        ["uploadType", "upload_id", "part", "notifySubscribers"].includes(key),
      )
    );
  } catch {
    return false;
  }
}
export interface YouTubeUploadTarget {
  readonly kind: "youtube-upload";
}
const targets = new WeakMap<
  YouTubeUploadTarget,
  { url: string; expiresAtMono: number; assertCurrent(): void }
>();
export function issueYouTubeUploadTarget(
  url: string,
  expiresAtMono: number,
  assertCurrent: () => void,
): YouTubeUploadTarget {
  // Local maximum only; the provider may expire its URL sooner.
  if (
    !validYouTubeUploadUrl(url) ||
    !Number.isFinite(expiresAtMono) ||
    expiresAtMono <= performance.now() ||
    expiresAtMono > performance.now() + 86_400_000 ||
    typeof assertCurrent !== "function"
  )
    throw new Error("UPLOAD_TARGET_INVALID");
  assertCurrent();
  const target = Object.freeze({ kind: "youtube-upload" as const });
  targets.set(target, { url, expiresAtMono, assertCurrent });
  return target;
}
export function assertYouTubeUploadTarget(target: YouTubeUploadTarget, url: string): number {
  const value = target && targets.get(target);
  if (!value || value.url !== url || performance.now() >= value.expiresAtMono)
    throw new Error("UPLOAD_TARGET_INVALID");
  value.assertCurrent();
  if (performance.now() >= value.expiresAtMono) throw new Error("UPLOAD_TARGET_INVALID");
  return value.expiresAtMono;
}
