import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadFixture, prepareFixture, scmSettings } from './fixture.mjs';

const [command, dir, resolution] = process.argv.slice(2);
assert.ok(dir, 'Usage: node measure.mjs prepare DIR [stress] | pdf DIR DPI');

if (command === 'prepare') {
  mkdirSync(dir, { recursive: true });
  prepareFixture(dir, 60, 2980, 4160, resolution === 'stress');
} else {
  assert.equal(command, 'pdf');
  const dpi = Number(resolution);
  assert.ok(dpi === 600 || dpi === 800);
  const { buildPdf, initSync } = await import('../dist/deckpress_core_wasm.js');
  const wasm = readFileSync(new URL('../dist/deckpress_core_wasm_bg.wasm', import.meta.url));
  const { memory } = initSync({ module: wasm });
  const { deckJson, images } = loadFixture(dir);
  const start = performance.now();
  let pdf;
  let error;
  try {
    pdf = buildPdf(JSON.stringify({ ...scmSettings, dpi }), deckJson, images);
  } catch (failure) {
    error = failure.message;
    process.exitCode = 1;
  }
  const seconds = (performance.now() - start) / 1000;
  const { maxRSS } = process.resourceUsage();
  console.log(
    JSON.stringify({
      dpi,
      cards: images.size,
      encodedInputBytes: [...images.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      pdfBytes: pdf?.length ?? null,
      error,
      seconds: Number(seconds.toFixed(2)),
      wasmPeakBytes: memory.buffer.byteLength,
      processPeakRssKiB: maxRSS,
      wasmBytes: wasm.length,
      wasmGzipBytes: gzipSync(wasm, { level: 9 }).length,
    }),
  );
}
