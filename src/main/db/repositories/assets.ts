import type { Asset } from "@shared/types";
import type { Database } from "../database";

interface AssetRow extends Record<string, unknown> {
  id: string;
  kind: string;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  sha256: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  thumbnail_path: string | null;
  created_at: string;
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    kind: row.kind as Asset["kind"],
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    thumbnailPath: row.thumbnail_path,
    createdAt: row.created_at,
  };
}

export class AssetsRepository {
  constructor(private readonly db: Database) {}

  list(): Asset[] {
    return this.db.all<AssetRow>("SELECT * FROM assets ORDER BY created_at DESC").map(toAsset);
  }

  get(id: string): Asset | undefined {
    const row = this.db.get<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    return row ? toAsset(row) : undefined;
  }

  findBySha(sha256: string): Asset | undefined {
    const row = this.db.get<AssetRow>("SELECT * FROM assets WHERE sha256 = ?", [sha256]);
    return row ? toAsset(row) : undefined;
  }

  insert(asset: Asset): Asset {
    this.db.run(
      `INSERT INTO assets (id, kind, file_path, file_name, mime_type, size_bytes, sha256, duration_ms, width, height, thumbnail_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, file_name = excluded.file_name, thumbnail_path = excluded.thumbnail_path`,
      [
        asset.id,
        asset.kind,
        asset.filePath,
        asset.fileName,
        asset.mimeType ?? null,
        asset.sizeBytes,
        asset.sha256 ?? null,
        asset.durationMs ?? null,
        asset.width ?? null,
        asset.height ?? null,
        asset.thumbnailPath ?? null,
        asset.createdAt,
      ],
    );
    return this.get(asset.id)!;
  }

  setThumbnail(id: string, thumbnailPath: string | null): void {
    this.db.run("UPDATE assets SET thumbnail_path = ? WHERE id = ?", [thumbnailPath, id]);
  }

  remove(id: string): boolean {
    return this.db.run("DELETE FROM assets WHERE id = ?", [id]).changes > 0;
  }
}
