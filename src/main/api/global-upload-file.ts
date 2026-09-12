import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Asset } from "@shared/types";
import { GlobalUploadError, tiktokChunks } from "./tiktok-draft-adapter";
import { youtubeUploadPlan } from "./youtube-upload-adapter";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
};
export function uploadAssetMime(asset: Asset, platform: "tiktok" | "youtube" = "tiktok"): string {
  const mime = MIME[path.extname(asset.fileName).toLowerCase()];
  if (
    asset.kind !== "video" ||
    !mime ||
    (platform === "tiktok" && !["video/mp4", "video/quicktime", "video/webm"].includes(mime)) ||
    asset.mimeType !== mime ||
    !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")
  )
    throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_UNSUPPORTED");
  (platform === "youtube" ? youtubeUploadPlan : tiktokChunks)(asset.sizeBytes);
  return mime;
}
/** One pinned file handle; verify the library hash before any upload and each prepared part again on use. */
export async function prepareUploadFile(
  asset: Asset,
  assertCurrent: () => void,
  platform: "tiktok" | "youtube" = "tiktok",
) {
  const mime = uploadAssetMime(asset, platform),
    plan = (platform === "youtube" ? youtubeUploadPlan : tiktokChunks)(asset.sizeBytes);
  let handle: FileHandle | undefined;
  try {
    assertCurrent();
    handle = await open(asset.filePath, "r");
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.size !== BigInt(asset.sizeBytes))
      throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
    const hashes: string[] = [];
    const read = async (index: number) => {
      assertCurrent();
      const part = plan.parts[index];
      if (!part) throw new GlobalUploadError("GLOBAL_UPLOAD_INVALID");
      const before = await handle!.stat({ bigint: true });
      if (
        before.size !== initial.size ||
        before.mtimeNs !== initial.mtimeNs ||
        before.ino !== initial.ino ||
        before.dev !== initial.dev
      )
        throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
      const buffer = Buffer.alloc(part.end - part.start + 1);
      let offset = 0;
      while (offset < buffer.length) {
        assertCurrent();
        const got = await handle!.read(buffer, offset, buffer.length - offset, part.start + offset);
        if (!got.bytesRead) throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
        offset += got.bytesRead;
      }
      assertCurrent();
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (hashes[index] && hashes[index] !== hash) throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
      hashes[index] = hash;
      return buffer;
    };
    const all = createHash("sha256");
    for (let i = 0; i < plan.count; i++) all.update(await read(i));
    if (all.digest("hex") !== asset.sha256) throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
    assertCurrent();
    const readRange = async (start: number, length: number) => {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(length) ||
        start < 0 ||
        length < 1 ||
        length > 16 * 1024 ** 2 ||
        start + length > plan.size
      )
        throw new GlobalUploadError("GLOBAL_UPLOAD_INVALID");
      const result = Buffer.alloc(length),
        end = start + length;
      const first = Math.min(Math.floor(start / plan.chunkSize), plan.count - 1),
        last = Math.min(Math.floor((end - 1) / plan.chunkSize), plan.count - 1);
      let copied = 0;
      for (let index = first; index <= last; index++) {
        const bytes = await read(index),
          part = plan.parts[index];
        const from = Math.max(start, part.start),
          to = Math.min(end, part.end + 1);
        copied += bytes.copy(result, from - start, from - part.start, to - part.start);
      }
      assertCurrent();
      if (copied !== length) throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
      return result;
    };
    return { mime, plan, read, readRange, close: () => handle!.close() };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof GlobalUploadError) throw error;
    throw new GlobalUploadError("GLOBAL_UPLOAD_FILE_CHANGED");
  }
}
