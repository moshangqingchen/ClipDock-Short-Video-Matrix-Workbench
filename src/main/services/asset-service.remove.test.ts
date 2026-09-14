import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "@main/db";
import { AssetService } from "./asset-service";

vi.mock("electron", () => ({ dialog: {}, nativeImage: {}, net: {}, protocol: {}, shell: {} }));

it.each(["outside", "other-asset", "source", "owned", "missing"] as const)(
  "removes only the owned thumbnail and preserves source files: %s",
  async (scenario) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sv-asset-remove-"));
    const thumbnailDir = path.join(directory, "thumbnails");
    const store = createStore(":memory:");
    const service = new AssetService(store, thumbnailDir);
    const id = randomUUID();
    const source = path.join(directory, "source.png");
    const owned = path.join(thumbnailDir, `${id}.png`);
    const other = path.join(thumbnailDir, `${randomUUID()}.png`);
    const targets = { outside: source, "other-asset": other, source: owned, owned, missing: owned };
    try {
      fs.writeFileSync(source, "source canary");
      fs.writeFileSync(other, "other asset canary");
      if (scenario !== "missing") fs.writeFileSync(owned, "owned cache canary");
      store.assets.insert({
        id,
        kind: "image",
        filePath:
          scenario === "source" ? (process.platform === "win32" ? owned.toUpperCase() : owned) : source,
        fileName: "source.png",
        sizeBytes: 1,
        thumbnailPath: targets[scenario],
        createdAt: new Date().toISOString(),
      });
      await service.remove(id);
      expect(store.assets.get(id)).toBeUndefined();
      expect(fs.readFileSync(source, "utf8")).toBe("source canary");
      expect(fs.readFileSync(other, "utf8")).toBe("other asset canary");
      expect(fs.existsSync(owned)).toBe(scenario !== "owned" && scenario !== "missing");
    } finally {
      store.close();
      for (const file of [source, owned, other]) if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.rmdirSync(thumbnailDir);
      fs.rmdirSync(directory);
    }
  },
);
