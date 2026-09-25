import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { APP_NAME } from "./shared/brand.ts";

/** Replaces %APP_NAME% in index.html so the product name lives in one place. */
function brand(): Plugin {
  return {
    name: "passage-brand",
    transformIndexHtml: (html) => html.replaceAll("%APP_NAME%", APP_NAME),
  };
}

const apiTarget = process.env.PASSAGE_API_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), brand()],
  server: {
    port: 5173,
    proxy: { "/api": { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: apiTarget, changeOrigin: false } },
  },
  build: {
    outDir: "dist/client",
    sourcemap: true,
    target: "es2022",
  },
});
