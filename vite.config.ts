import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The packaged renderer is loaded through file://; relative asset paths keep
  // the bundle resolvable inside app.asar.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@renderer": fileURLToPath(new URL("./src/renderer", import.meta.url)),
      "@main": fileURLToPath(new URL("./src/main", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    // Build outputs and account/cache files are not source. Watching them can
    // reload the editor while packaging or while Chromium writes profile data.
    watch: {
      ignored: [
        "**/release/**", "**/dist/**", "**/dist-electron/**", "**/output/**",
        "**/backups/**", "**/logs/**", "**/workbench-data/**", "**/.local-data/**", "**/.npm-cache/**",
      ],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome140",
    sourcemap: false,
  },
  test: {
    // Main-process modules run under Node; renderer tests opt into jsdom via
    // a `// @vitest-environment jsdom` docblock.
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/release/**"],
  },
});
