// Format the supplied artwork for Electron and Windows; never redraw the icon.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.versions.electron) {
  const { default: electronPath } = await import("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronPath, [fileURLToPath(import.meta.url)], {
    env, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, nativeImage } = await import("electron");
try {
  const source = nativeImage.createFromPath(path.join(root, "resources/app-icon-source.png"));
  if (source.isEmpty()) throw new Error("Application icon source is missing or invalid");
  const { width, height } = source.getSize();
  const side = Math.max(width, height);
  const bitmap = source.toBitmap();
  const square = Buffer.alloc(side * side * 4);
  const left = Math.floor((side - width) / 2);
  const top = Math.floor((side - height) / 2);
  for (let row = 0; row < height; row++) {
    bitmap.copy(square, ((top + row) * side + left) * 4, row * width * 4, (row + 1) * width * 4);
  }
  const icon = nativeImage.createFromBitmap(square, { width: side, height: side });
  const pngAt = (size) => icon.resize({ width: size, height: size, quality: "best" }).toPNG();
  const png = pngAt(256);
  fs.writeFileSync(path.join(root, "resources/app-icon.png"), png);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(pngAt);
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  fs.writeFileSync(path.join(root, "resources/app-icon.ico"), Buffer.concat([directory, ...images]));
  fs.writeFileSync(path.join(root, "src/main/window/app-icon.ts"),
    `// Generated from resources/app-icon-source.png by scripts/generate-app-icons.mjs.\nexport const appIconPng = "${png.toString("base64")}";\n`);
  console.log("Updated application PNG, Windows ICO, and bundled runtime icon.");
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
