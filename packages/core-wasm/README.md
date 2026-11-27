# Deckpress print pipeline for WebAssembly

From the repository root:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm build:wasm
node --test packages/core-wasm/tests/export.test.mjs
```

The build writes an ES module, TypeScript declarations and a WASM binary to
`packages/core-wasm/dist`. The Node test loads that same module, then builds a
native PDF from the same fixtures and compares their geometry with lopdf.
The native reference needs the regular core build prerequisites in [AGENTS.md](../../AGENTS.md).

## Browser use

For example, from a Vite module at `apps/web/src`:

```ts
import init, { buildPdf } from '../../../packages/core-wasm/dist/deckpress_core_wasm.js';

await init();
const pdfBytes = buildPdf(
  JSON.stringify(printSettings),
  JSON.stringify(deck),
  encodedImagesByUrl,
);
```

- `buildPdf` and `buildPngZip` accept Deckpress `PrintSettings` and `Deck`
  JSON plus a `Map<string, Uint8Array>`. Keys are the art's `imageUrl`
  strings, and values are encoded PNG, JPEG, or WebP. The deck controls print
  order, quantities and the face options. No images are fetched by the module.
- Feed the same map with either original images or encoded output from a
  JS upscaler. Preserve the source aspect ratio and any existing bleed, and
  don't add print bleed or rounded corners. Rust still applies the print
  raster. The module ignores `PrintSettings.upscale`; it runs no inference.
- `layoutJson` returns page, slot, guide and registration geometry in PDF
  points from the top-left corner. `scmTemplatesJson` and
  `scmCuttingTemplatesJson` return the vendored catalogs.
- `buildCutSvg` returns a free-layout cutting template as SVG text. As on
  desktop, SCM layouts use their published cutting templates instead.

Exports are synchronous. Run them in a worker to keep the UI responsive.
The module assembles the complete PDF or ZIP in memory.

## PDF export memory

Release build on Linux x86-64, Node 24.18.0 and Rust 1.97.1. Each run used a
fresh Node process and 60 distinct synthetic 2980 × 4160 PNG faces on SCM A4
standard, with 0.5 mm bleed, JPEG quality 92, no backs and no calibration page.
The fixture's encoded inputs total 356.5 MiB and are kept in the JS map.
WASM linear memory only grows, so its final size is its allocated high-water
mark. Peak Node RSS also includes the JS input map, runtime and output copy.

| DPI | PDF size | Peak WASM linear memory | Peak Node RSS | Export time |
| ---: | ---: | ---: | ---: | ---: |
| 600 | 20.5 MiB | 194.9 MiB | 633.7 MiB | 12.38 s |
| 800 | 35.1 MiB | 244.9 MiB | 709.3 MiB | 18.60 s |

The WASM binary is 4,302,830 bytes raw and 1,499,433 bytes gzipped at level 9,
excluding JS glue.

A higher-detail synthetic fixture used 1,653.8 MiB of inputs. At 600 DPI it
exported a 140.9 MiB PDF with 1,140.4 MiB of WASM memory and 2,758.1 MiB peak
RSS. At 800 DPI it reached the existing 250 MiB embedded-image limit before
returning a PDF, at 1,093.8 MiB of WASM memory and 2,808.0 MiB peak RSS.
Use lower DPI or a smaller page range for large exports. For the web
integration, read source images on demand and write PDF page objects to an
OPFS-backed stream rather than holding the whole document in memory.

```sh
node packages/core-wasm/tests/measure.mjs prepare "$HOME/deckpress-wasm-fixtures"
node packages/core-wasm/tests/measure.mjs pdf "$HOME/deckpress-wasm-fixtures" 600
node packages/core-wasm/tests/measure.mjs pdf "$HOME/deckpress-wasm-fixtures" 800
```

Append `stress` to the `prepare` command for the higher-detail fixture.
