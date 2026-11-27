import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildCutDxf,
  buildCutSvg,
  buildPdf,
  buildPngZip,
  initSync,
  layoutJson,
  scmCuttingTemplatesJson,
  scmTemplatesJson,
} from '../dist/deckpress_core_wasm.js';
import { loadFixture, prepareFixture, scmSettings } from './fixture.mjs';

initSync({ module: readFileSync(new URL('../dist/deckpress_core_wasm_bg.wasm', import.meta.url)) });

test('SCM A4 WASM export matches the native PDF geometry', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'deckpress-wasm-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  prepareFixture(dir, 8, 400, 560);
  const { deckJson, images } = loadFixture(dir);
  const settingsJson = JSON.stringify({ ...scmSettings, dpi: 150 });
  writeFileSync(join(dir, 'settings.json'), settingsJson);
  writeFileSync(join(dir, 'wasm.pdf'), buildPdf(settingsJson, deckJson, images));
  writeFileSync(join(dir, 'wasm.zip'), buildPngZip(settingsJson, deckJson, images));

  const result = execFileSync(
    'cargo',
    ['run', '--locked', '-p', 'deckpress-core', '--example', 'wasm_reference', '--', dir],
    { cwd: new URL('../../../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.diagnostic(result.trim());
  assert.throws(() => buildPdf(settingsJson, deckJson, new Map()), /No image bytes for card-1.png/);
  assert.throws(
    () => buildPdf(settingsJson, deckJson, new Map([['card-1.png', 'not bytes']])),
    /must be a Uint8Array/,
  );
  const externalUpscale = JSON.stringify({ ...scmSettings, dpi: 150, upscale: true });
  const pdf = buildPdf(externalUpscale, deckJson, images);
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString('ascii'), '%PDF-');
});

test('layout coordinates, SCM catalog and cut SVG are available', () => {
  const settingsJson = JSON.stringify(scmSettings);
  const scm = JSON.parse(layoutJson(settingsJson));
  assert.equal(scm.slots.length, 8);
  assert.equal(scm.scm.marks.length, 5);
  assert.match(scm.scm.name, /^a4-standard-v/);
  assert.ok(JSON.parse(scmTemplatesJson()).layouts.a4.standard.default);
  assert.ok(JSON.parse(scmCuttingTemplatesJson()).files.some((path) => path.includes('a4-standard')));
  const catalog = JSON.parse(scmCuttingTemplatesJson());
  assert.equal(Object.keys(catalog.exports).length, 190);
  assert.equal(catalog.exceptions.length, 38);
  const cutFile = catalog.exports[`${scm.scm.name}.studio3`];
  assert.ok(catalog.files.includes(cutFile.path));
  assert.match(cutFile.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => buildCutSvg(settingsJson), /Use the SCM .studio3 cutting template/);
  const freeJson = JSON.stringify({ layoutMode: 'free' });
  const free = JSON.parse(layoutJson(freeJson));
  const svg = buildCutSvg(freeJson);
  assert.match(svg, /^<svg /);
  assert.equal(svg.match(/<path /g)?.length, free.slots.length);
});

test('DXF generation works in WASM for Free and SCM fallback layouts', () => {
  const fallback = {
    ...scmSettings,
    scmTemplate: { ...scmSettings.scmTemplate, paper: 'arch_b', variant: 'borderless' },
  };
  for (const settings of [{ layoutMode: 'free' }, fallback]) {
    const settingsJson = JSON.stringify(settings);
    const dxf = buildCutDxf(settingsJson);
    assert.match(dxf, /\$INSUNITS\n70\n4\n/);
    assert.equal(dxf.match(/^LWPOLYLINE$/gm)?.length, JSON.parse(layoutJson(settingsJson)).slots.length);
  }
  assert.throws(() => buildCutDxf(JSON.stringify(scmSettings)), /Use the SCM .studio3 cutting template/);
});
