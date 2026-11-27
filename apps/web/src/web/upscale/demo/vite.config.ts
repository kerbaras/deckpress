import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "../../../..");

export default defineConfig({
  root,
  base: "./",
  publicDir: resolve(root, "node_modules/.cache/upscale-public"),
  build: {
    outDir: resolve(root, "node_modules/.cache/upscale-demo"),
    emptyOutDir: true,
    rolldownOptions: { input: resolve(root, "upscale-demo.html") },
  },
  worker: { format: "es" },
});
