# Browser upscale proof

Run these commands from the repo root after installing the workspace dependencies:

```sh
public=apps/web/node_modules/.cache/upscale-public
mkdir -p "$public/models" "$public/ort"
cp apps/web/src/web/upscale/demo/public/coi-serviceworker.* "$public/"
cp apps/desktop/src-tauri/resources/models/realesr-*.onnx "$public/models/"
ort=apps/web/node_modules/onnxruntime-web/dist
cp "$ort/ort.webgpu.min.mjs" "$ort/ort-wasm-simd-threaded.asyncify.mjs" \
  "$ort/ort-wasm-simd-threaded.asyncify.wasm" "$public/ort/"
pnpm --filter @deckpress/web exec vite build --config src/web/upscale/demo/vite.config.ts
pnpm --filter @deckpress/web exec vite preview --config src/web/upscale/demo/vite.config.ts
```

Open `/upscale-demo.html` on the preview server. The demo build is separate
from Tauri's `apps/web/dist`. For a static host, publish
`apps/web/node_modules/.cache/upscale-demo` to its own site or subdirectory.
Use HTTPS or localhost. The demo reloads once when the service worker first
takes control; if isolation is unavailable the upscaler can use single-threaded
WASM. Run the selected model once online before reloading offline. The page,
worker and runtime files are cached by the service worker. Model files use
a separate cache and are checked against `packages/core/models.json` on each use.

The compact and fast models ship with the repo. To offer the quality model,
download the release asset listed in the manifest and stage it in
`"$public/models/"` under its manifest filename before building. Do not commit
the model or point the browser at the GitHub release URL; the browser needs a
same-origin copy.

## Chrome proof

The [Alpha Black Lotus Scryfall PNG](https://cards.scryfall.io/png/front/b/0/b0faa7f2-b547-42c4-a810-839da50dadfe.png)
went from 745 × 1040 to 2980 × 4160 in Chrome using the compact general x4v3
model. Compared with the same model through native `deckpress-core` on CPU,
the mean absolute RGB differences were 0.40206/255, 0.40214/255, and 0.40116/255.
The browser downloaded the model once. A reload with the network disabled
produced pixel-identical output without another model request.

On the 8-core test VM, Chrome reported 1561 ms/tile online and 1652 ms/tile
after the offline reload. Blocking service workers verified the 1-thread
fallback in Chrome: 2799 ms/tile with the fast model. The VM has no usable
WebGPU adapter; only selection and fallback logic were tested for WebGPU.
