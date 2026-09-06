import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { dialog, nativeImage, net, protocol, shell, type BaseWindow } from "electron";
import type { Asset, AssetKind } from "@shared/types";
import type { Store } from "@main/db";

export const ASSET_SCHEME = "sv-asset";

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv", ".wmv"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg"]);
const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

export function registerAssetSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

function kindOf(ext: string): AssetKind {
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "other";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

/**
 * Local media library. Files stay where the operator keeps them; the library
 * stores a reference plus hash, size, dimensions and a generated thumbnail.
 * The shell reads media through the `sv-asset://` scheme so previews work in
 * both dev (http) and packaged (file) builds without exposing arbitrary paths.
 */
export class AssetService {
  constructor(
    private readonly store: Store,
    private readonly thumbnailDir: string,
  ) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
  }

  list(): Asset[] {
    return this.store.assets.list();
  }

  get(id: string): Asset | undefined {
    return this.store.assets.get(id);
  }

  async importFromDialog(window: BaseWindow): Promise<Asset[]> {
    const result = await dialog.showOpenDialog(window, {
      title: "导入素材",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "视频与图片", extensions: [...VIDEO_EXT, ...IMAGE_EXT].map((e) => e.slice(1)) },
        { name: "视频", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) },
        { name: "图片", extensions: [...IMAGE_EXT].map((e) => e.slice(1)) },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled) return [];
    const imported: Asset[] = [];
    for (const filePath of result.filePaths) {
      try {
        imported.push(await this.importFile(filePath));
      } catch {
        // skip unreadable files; continue with the rest
      }
    }
    return imported;
  }

  async importFile(filePath: string): Promise<Asset> {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error("not-a-file");
    const sha256 = await sha256File(filePath);
    const existing = this.store.assets.findBySha(sha256);
    if (existing && fs.existsSync(existing.filePath)) return existing;

    const ext = path.extname(filePath).toLowerCase();
    const kind = kindOf(ext);
    const id = existing?.id ?? randomUUID();
    let width: number | null = null;
    let height: number | null = null;
    let thumbnailPath: string | null = null;
    if (kind === "image") {
      try {
        const image = nativeImage.createFromPath(filePath);
        if (!image.isEmpty()) {
          const size = image.getSize();
          width = size.width;
          height = size.height;
          const thumb = image.resize({ width: 480 });
          thumbnailPath = path.join(this.thumbnailDir, `${id}.png`);
          await fs.promises.writeFile(thumbnailPath, thumb.toPNG());
        }
      } catch {
        thumbnailPath = null;
      }
    }
    const asset: Asset = {
      id,
      kind,
      filePath,
      fileName: path.basename(filePath),
      mimeType: MIME[ext] ?? null,
      sizeBytes: stats.size,
      sha256,
      durationMs: null,
      width,
      height,
      thumbnailPath,
      createdAt: new Date().toISOString(),
    };
    return this.store.assets.insert(asset);
  }

  async remove(id: string): Promise<void> {
    const asset = this.store.assets.get(id);
    if (asset?.thumbnailPath) await fs.promises.unlink(asset.thumbnailPath).catch(() => undefined);
    this.store.assets.remove(id);
  }

  reveal(id: string): void {
    const asset = this.store.assets.get(id);
    if (asset) shell.showItemInFolder(asset.filePath);
  }

  thumbnailUrl(id: string): string | null {
    const asset = this.store.assets.get(id);
    if (!asset) return null;
    if (asset.thumbnailPath) return `${ASSET_SCHEME}://thumb/${id}`;
    if (asset.kind === "video" || asset.kind === "image") return `${ASSET_SCHEME}://file/${id}`;
    return null;
  }

  /** Serve `sv-asset://file/<id>` and `sv-asset://thumb/<id>` to the shell. */
  registerProtocol(): void {
    protocol.handle(ASSET_SCHEME, (request) => {
      try {
        const url = new URL(request.url);
        const [, id] = url.pathname.split("/");
        const asset = id ? this.store.assets.get(id) : undefined;
        if (!asset) return new Response("not found", { status: 404 });
        const target = url.hostname === "thumb" ? (asset.thumbnailPath ?? asset.filePath) : asset.filePath;
        if (!target || !fs.existsSync(target)) return new Response("not found", { status: 404 });
        return net.fetch(pathToFileURL(target).href, { headers: request.headers });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    });
  }
}
