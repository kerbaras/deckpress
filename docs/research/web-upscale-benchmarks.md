# Web upscaler benchmarks

Issue [#154](https://github.com/kerbaras/deckpress/issues/154) measures the three Deckpress upscalers on an Apple M4 Pro Mac mini with 12 CPU cores, 24 GiB unified memory and macOS 26.5.2. These are single-tile inference timings, not full exports.

## Mac measurements

| Backend | Model | Warm ms/tile | Load ms | First tile ms | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| Chrome WebGPU | General | 60.3 | 252.3 | 105.9 | 1,043 |
| Chrome WebGPU | Anime | 33.9 | 239.8 | 82.1 | 1,039 |
| Chrome WebGPU | x4plus | 868.6 | 404.3 | 915.7 | 1,279 |
| Chrome WASM, 12 threads | General | 519.0 | 133.3 | 501.7 | 876 |
| Chrome WASM, 12 threads | Anime | 257.0 | 120.1 | 281.9 | 827 |
| Chrome WASM, 12 threads | x4plus | 7,571.2 | 427.3 | 7,520.0 | 2,468 |
| Chrome WASM, 1 thread | General | 3,072.1 | 127.1 | 3,143.0 | 819 |
| Chrome WASM, 1 thread | Anime | 1,573.8 | 112.8 | 1,607.4 | 774 |
| Chrome WASM, 1 thread | x4plus | 46,674.0 | 411.6 | 46,835.6 | 2,432 |
| Native CPU | General | 172.3 | 14.5 | 187.2 | 299 |
| Native CPU | Anime | 87.8 | 8.6 | 106.3 | 291 |
| Native CPU | x4plus | 2,393.6 | 174.9 | 2,545.2 | 2,409 |
| Native Core ML | General | 22.8 | 25,566.3 | 47.4 | 153 |
| Native Core ML | Anime | 15.9 | 16,888.0 | 127.6 | 147 |
| Native Core ML | x4plus | 318.1 | 3,164.1 | 626.9 | 260 |

## Linux VM reference

Steady-state ms/tile from [#150](https://github.com/kerbaras/deckpress/issues/150), on an 8-core VM. These are prior measurements, not a rerun of the Mac fixture. #150 reports 0.6 to 0.8 s load for the two compact models without a per-backend breakdown. It does not report first-tile latency or peak RSS.

| Backend | General | Anime | x4plus |
| --- | ---: | ---: | ---: |
| Chrome WebGPU | No GPU | No GPU | No GPU |
| Chrome WASM, 8 threads | 1,315 | 677 | Not measured |
| Chrome WASM, 4 threads | 1,626 | Not measured | Not measured |
| Chrome WASM, 1 thread | 4,536 | 2,248 | Not measured |
| Native CPU | 1,040 | 664 | Not measured |
| Native Core ML | Not available | Not available | Not available |

## Output correctness

This compares WebGPU and 12-thread WASM outputs from the same FP16 model files, on the same tile. Mean absolute difference (MAD) and maximum absolute difference are across all 3,145,728 float32 RGB values, before clipping or conversion to bytes. The input is normalized to 0–1.

| Model | MAD | Max absolute difference |
| --- | ---: | ---: |
| General | 0.001931 | 0.026924 |
| Anime | 0.000940 | 0.010020 |
| x4plus | 0.001375 | 0.045470 |

The largest difference, on x4plus, is about 12 levels on an 8-bit scale. The x4plus mean is less than one level. This is a numerical check on one crop, not a visual quality test or a bound on differences across cards.

## Export time estimates

A 745×1040 Scryfall PNG takes 4×5 = 20 tiles with the desktop's 256 px tile and 24 px overlap. A 60-card deck with 35 unique arts takes 700 tiles if each art is upscaled once. Multiply the warm median by 20 or 700. These estimates exclude load, downloads, tile blending, resizing and PDF generation. A deck with no repeated art takes 1,200 tiles.

Each cell gives per-card seconds / per-deck minutes.

| Machine and backend | General | Anime | x4plus |
| --- | ---: | ---: | ---: |
| Mac Chrome WebGPU | 1.21 / 0.70 | 0.68 / 0.40 | 17.4 / 10.1 |
| Mac WASM, 12 threads | 10.4 / 6.1 | 5.14 / 3.0 | 151.4 / 88.3 |
| Mac WASM, 1 thread | 61.4 / 35.8 | 31.5 / 18.4 | 933.5 / 544.5 |
| Mac native CPU | 3.4 / 2.0 | 1.8 / 1.0 | 47.9 / 27.9 |
| Mac native Core ML | 0.46 / 0.27 | 0.32 / 0.19 | 6.4 / 3.7 |
| Linux VM WASM, 8 threads | 26.3 / 15.3 | 13.5 / 7.9 | Not measured |
| Linux VM WASM, 4 threads | 32.5 / 19.0 | Not measured | Not measured |
| Linux VM WASM, 1 thread | 90.7 / 52.9 | 45.0 / 26.2 | Not measured |
| Linux VM native CPU | 20.8 / 12.1 | 13.3 / 7.7 | Not measured |

## Recommendation

Default to General when hardware WebGPU with `shader-f16` is available. On this Mac it took about 42 s of inference for 35 unique arts, versus about 6 min on threaded WASM. Anime is a faster option. Keep x4plus opt-in: it took about 10 min even with this GPU.

Start web export at 600 DPI. DPI controls the final raster and PDF size. It does not change the number of inference tiles when using the current 4× models on the original input. Leave 800 and 1200 DPI as explicit choices and measure full-deck memory before making either a default.

Start with one tile per call and one in-flight call in a worker. The models have a fixed batch dimension of one, so increasing tensor batch size requires a different export. Reuse one session, blend each result as it comes back, and cache each finished art across copies in the deck. Measure before allowing concurrent calls: this run measured serial latency, and keeping multiple output tiles or cards live increases memory.

Use Anime if offering AI on the threaded WASM fallback. Without hardware WebGPU or cross-origin isolation, default to non-AI resampling and offer AI as an opt-in. Even Anime on single-thread WASM takes over 18 minutes of inference for the modeled Mac deck.

## Method

- The General and Anime models are the bundled ONNX files in the repo. Only the x4plus model is an asset in `models-v1`. All three files matched [the model manifest](../../packages/core/models.json) by SHA-256. The graphs have FP16 weights and a fixed batch of one, with float32 NCHW input and output.
- Input was the center 256×256 crop of the [Scryfall Alpha Black Lotus PNG](https://cards.scryfall.io/png/front/b/0/b0faa7f2-b547-42c4-a810-839da50dadfe.png), at pixel origin (244, 392). The script drops alpha, converts RGB to planar float32 and divides by 255. Every backend reads the same bytes. The output is 1×3×1024×1024.
- Chrome 158.0.8127.38 ran headless through Playwright with onnxruntime-web 1.23.2. Each backend/model pair starts a new Chrome instance. The local server sets COOP/COEP. Threaded WASM uses 12 threads; single-thread WASM uses one thread on the same isolated page. This isolates the thread setting from hosting differences. Safari 26.5.2 was installed but its WebDriver refused to start without configuration or authentication. No settings were changed.
- Chrome's WebGPU adapter reported `Apple M4 Pro`, vendor `apple`, architecture `metal-3`, Dawn backend `metal`, type `integrated GPU` and `isFallbackAdapter: false`. ORT's device enabled `shader-f16`. An extra untimed tile dispatched 209, 113 and 1,108 GPU compute calls for General, Anime and x4plus respectively. This was hardware WebGPU, not SwiftShader.
- Native runs use Python onnxruntime 1.32.0, 12 intra-op threads and one process per backend/model pair. Core ML uses MLProgram, static shapes, all compute units and FastPrediction, with no ORT model cache configured. ORT can still assign unsupported operators to CPU. The table does not claim an ANE-only measurement.
- Each run records load and first tile separately, runs one more warm-up tile, then takes the median of five sequential tiles. Browser load includes importing the runtime, fetching local assets and creating the session, including requesting the WebGPU adapter. Native load is session construction from the local ONNX file. Neither includes process launch, tile decoding or Internet download. Browser tile time includes bringing the float32 output to CPU memory. Finite-value checks and correctness comparison are outside the timings.
- Browser memory is the highest sampled sum of Chrome browser, renderer and GPU process RSS, sampled at roughly 100 ms intervals from before load through the last timed tile. Native memory is the Python process high-water RSS. Browser shared pages can be counted more than once, short peaks can be missed, and neither method accounts for all GPU or Core ML allocations. Treat the figures as process memory observations, not comparable accelerator-memory totals.

## Reproduce

From the repo root, with logged-in `gh`, Chrome, Node 22 or newer and Python 3.14 on arm64 macOS:

```bash
work="$(mktemp -d "$HOME/deckpress-web-bench.XXXXXX")"
cp docs/research/web-bench/{browser.mjs,native.py} "$work/"
cp apps/desktop/src-tauri/resources/models/realesr-{general-x4v3-dn50,animevideov3}-256.fp16.onnx "$work/"
cd "$work"
gh release download models-v1 -R kerbaras/deckpress -p RealESRGAN_x4plus-256.fp16.onnx
curl -fLSs -o card.png https://cards.scryfall.io/png/front/b/0/b0faa7f2-b547-42c4-a810-839da50dadfe.png
shasum -a 256 *.onnx
npm_config_cache="$PWD/.npm" npm install --no-save --no-package-lock onnxruntime-web@1.23.2 playwright@1.58.2
python3 -m venv .venv
PIP_CACHE_DIR="$PWD/.pip" .venv/bin/pip install onnxruntime==1.32.0 pillow==12.1.1
.venv/bin/python native.py prepare
shasum -a 256 tile.f32

for provider in CPUExecutionProvider CoreMLExecutionProvider; do
  for model in *.onnx; do
    .venv/bin/python native.py bench "$provider" "$model"
  done
done
THREADS=12 node browser.mjs
```

Compare model hashes with the manifest. The input tile SHA-256 was `7bfda2021eeb862b05c3604db4adf652afb1cb121a9fc8fd7bcf21d3b17e3ffa`. Run the commands sequentially on an idle machine. The browser script emits one JSON line per measurement and per correctness comparison. It starts and stops its own loopback server. Set `BACKENDS=threaded,single` to skip WebGPU on a machine without suitable hardware. When finished, remove the temporary work directory.
