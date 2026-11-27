import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildCutDxf,
  buildCutSvg,
  buildCutStudio3,
  buildPdf,
  buildPngZip,
  initSync,
  layoutJson,
  prepareUpload,
  scmCuttingTemplatesJson,
  scmTemplatesJson,
  setUploadBleed,
  uploadPreview,
  uploadSnapshot,
} from '../dist/deckpress_core_wasm.js';
import { loadFixture, prepareFixture, scmSettings } from './fixture.mjs';

initSync({ module: readFileSync(new URL('../dist/deckpress_core_wasm_bg.wasm', import.meta.url)) });

const id = 'd04f1cec-448c-4061-a849-5c998e365a4d';
const input = { oracleId: 'card', name: ' My art ', artist: '' };
const date = '2026-11-27T00:00:00.000Z';

function prepare(bytes, meta = input) {
  const prepared = prepareUpload(bytes, JSON.stringify(meta), id, date);
  try {
    return { metadata: prepared.metadata, png: prepared.png };
  } finally {
    prepared.free();
  }
}

function pngDimensions(bytes) {
  const png = Buffer.from(bytes);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('WASM normalizes PNG and JPEG, edits bleed, and renders trim, thumbnails and print preview', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'deckpress-wasm-upload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  prepareFixture(dir, 1, 691, 941);
  const { images } = loadFixture(dir);
  const [inputPng] = images.values();

  const { metadata, png } = prepare(inputPng);
  const { art, bleedAuto } = JSON.parse(metadata);
  assert.deepEqual(pngDimensions(png), [691, 941]);
  assert.equal(bleedAuto, true);
  assert.equal(art.bleedMm, 3.048);
  assert.equal(art.dpi, 254);
  assert.equal(art.name, 'My art');
  assert.equal(art.artist, 'My upload');
  assert.equal(art.imageUrl, `upload://${id}`);

  const artJson = JSON.stringify(art);
  assert.deepEqual(pngDimensions(uploadSnapshot(png, artJson, false)), [631, 881]);
  assert.equal(Math.max(...pngDimensions(uploadSnapshot(png, artJson, true))), 480);
  const edited = JSON.parse(setUploadBleed(png, metadata, 0));
  assert.equal(edited.bleedAuto, false);
  assert.equal(edited.art.bleedMm, 0);
  assert.equal(edited.art.dpi, 272);
  assert.equal(JSON.parse(setUploadBleed(png, JSON.stringify(edited))).art.bleedMm, 3.048);

  const jpeg = uploadPreview(png, artJson, JSON.stringify({ bleedMm: 1 }));
  assert.equal(Buffer.from(jpeg.subarray(0, 2)).toString('hex'), 'ffd8');
  const normalizedJpeg = prepare(jpeg, { ...input, bleedMm: 1 });
  assert.ok(pngDimensions(normalizedJpeg.png)[0] > 300);
  assert.equal(JSON.parse(normalizedJpeg.metadata).art.bleedMm, 1);
  assert.throws(() => setUploadBleed(png, metadata, 11), /Bleed must be between 0 and 10 mm/);
  assert.throws(() => prepare(new Uint8Array([1, 2, 3])), /Use PNG, JPEG or WebP/);
});

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
  const pdf = Buffer.from(buildPdf(externalUpscale, deckJson, images));
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.includes('AI 4x upscaling applied to eligible images'));
  assert.ok(!pdf.includes('Lanczos resizing; source detail unchanged'));
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
  const archive = readFileSync(new URL('../../core/assets/scm/cutting-templates.zip', import.meta.url));
  const studio3 = buildCutStudio3(settingsJson, archive);
  assert.equal(createHash('sha256').update(studio3).digest('hex'), cutFile.sha256);
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
