import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import models from "../../packages/core/models.json" with { type: "json" };

const web = import.meta.dirname;
const workspace = resolve(web, "../..");
export const pagesBase = "/deckpress/";
export const pagesDir = "dist-pages";

export function stagePages(): Plugin {
  return {
    name: "deckpress-pages",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "link",
          attrs: { rel: "manifest", href: `${pagesBase}manifest.webmanifest` },
          injectTo: "head",
        },
      ];
    },
    async closeBundle() {
      const out = resolve(web, pagesDir);
      const pwa = resolve(web, "src/web/pwa");
      const core = resolve(workspace, "packages/core-wasm/dist");
      const ort = resolve(web, "node_modules/onnxruntime-web");
      const bundled = resolve(web, "../desktop/src-tauri/resources/models");
      await Promise.all(
        ["models", "ort", "print"].map((folder) =>
          mkdir(resolve(out, folder), { recursive: true }),
        ),
      );

      const runtime = [
        "ort.webgpu.min.mjs",
        "ort-wasm-simd-threaded.asyncify.mjs",
        "ort-wasm-simd-threaded.asyncify.wasm",
      ];
      const print = ["deckpress_core_wasm.js", "deckpress_core_wasm_bg.wasm"];
      const cutArchive = "cutting-templates.zip";
      const modelFiles = models.filter(
        ({ bundled, scale, tile }) => bundled && scale === 4 && tile === 256,
      );
      await Promise.all([
        ...runtime.map((file) =>
          copyFile(resolve(ort, "dist", file), resolve(out, "ort", file)),
        ),
        ...print.map((file) =>
          copyFile(resolve(core, file), resolve(out, "print", file)),
        ),
        copyFile(
          resolve(workspace, "packages/core/assets/scm", cutArchive),
          resolve(out, "print", cutArchive),
        ),
        ...modelFiles.map(async ({ file, sha256 }) => {
          const bytes = await readFile(resolve(bundled, file));
          if (createHash("sha256").update(bytes).digest("hex") !== sha256)
            throw new Error(`Wrong SHA-256 for ${file}`);
          await writeFile(resolve(out, "models", file), bytes);
        }),
        ...["manifest.webmanifest", "deckpress.svg"].map((file) =>
          copyFile(resolve(pwa, file), resolve(out, file)),
        ),
        copyFile(
          resolve(web, "src/web/upscale/demo/public/coi-serviceworker.LICENSE"),
          resolve(out, "coi-serviceworker.LICENSE"),
        ),
      ]);

      const worker = await readFile(
        resolve(pwa, "coi-serviceworker.js"),
        "utf8",
      );
      const assets = (await readdir(resolve(out, "assets"))).map(
        (file) => `assets/${file}`,
      );
      const files = [
        "index.html",
        "appearance.js",
        "manifest.webmanifest",
        "deckpress.svg",
        ...assets,
      ].sort();
      const hash = createHash("sha256").update(worker);
      for (const file of [
        ...files,
        ...runtime.map((file) => `ort/${file}`),
        ...print.map((file) => `print/${file}`),
        `print/${cutArchive}`,
      ]) {
        hash.update(file).update(await readFile(resolve(out, file)));
      }
      const build = JSON.stringify({
        version: hash.digest("hex").slice(0, 16),
        files,
      });
      await writeFile(
        resolve(out, "coi-serviceworker.js"),
        worker.replace('/* BUILD */ { version: "dev", files: [] }', build),
      );
    },
  };
}
