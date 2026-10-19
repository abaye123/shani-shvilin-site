import { defineConfig } from "vite";

// Frontend of the Tauri PC installer. Everything is bundled; nothing is loaded at runtime.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [".."] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
