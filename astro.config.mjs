// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://shanishvilin.abaye.co",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory", inlineStylesheets: "auto" },
  devToolbar: { enabled: false },
  // No telemetry, no external requests at runtime: everything is bundled and self-hosted.
  vite: {
    server: { fs: { allow: [".."] } },
  },
});
