import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initSync, setCoverage, setFamily } from '../dist/deckpress_core_wasm.js';

initSync({ module: readFileSync(new URL('../dist/deckpress_core_wasm_bg.wasm', import.meta.url)) });

// Also used by the native tests in packages/core/tests/set_family.rs.
const { data } = JSON.parse(readFileSync(new URL(
  '../../core/tests/fixtures/scryfall-set-families.json', import.meta.url,
), 'utf8'));
const catalog = JSON.stringify(data);

test('WASM uses the native ranks for Lorwyn Eclipsed and Foundations Commander', () => {
  assert.deepEqual(JSON.parse(setFamily('ecc', catalog)), [
    ['ecc', 0], ['ecl', 1], ['tecc', 2], ['tecl', 3],
  ]);
  assert.deepEqual(JSON.parse(setFamily('fdc', catalog)), [
    ['fdc', 0], ['fdn', 1], ['tfdc', 2], ['tfdn', 3],
  ]);
  assert.deepEqual(JSON.parse(setFamily('missing', catalog)), [['missing', 0]]);
});

test('WASM coverage includes sibling and token printings once per entry', () => {
  const entries = [['ecc', 'ecc', 'tecc'], ['ecl'], ['fdc', 'fdn'], ['tfdc'], []];
  const rows = JSON.parse(setCoverage(JSON.stringify(entries), catalog));
  const wanted = ['ecc', 'ecl', 'fdc', 'fdn'];
  const families = rows.filter(({ set }) => wanted.includes(set.code));
  assert.deepEqual(families.map(({ set, count, exact, total }) => [set.code, count, exact, total]), [
    ['ecc', 2, 1, 5], ['ecl', 2, 1, 5], ['fdc', 2, 1, 5], ['fdn', 2, 1, 5],
  ]);
});
