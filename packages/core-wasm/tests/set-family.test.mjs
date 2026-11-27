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

test('WASM coverage counts copies and ranks eligible sets by exact coverage first', () => {
  const entries = [
    [32, ['fdc', 'fdc', 'pecl']],
    [1, ['fdc', 'fdn']],
    [1, ['tfdc']],
    [40, ['tecl']],
    [26, ['j25', 'yecl']],
  ];
  const rows = JSON.parse(setCoverage(JSON.stringify(entries), catalog));
  assert.deepEqual(rows.map(({ set, count, exact, total }) => [set.code, count, exact, total]), [
    ['fdc', 34, 33, 100], ['fdn', 34, 1, 100], ['ecc', 40, 0, 100], ['ecl', 40, 0, 100],
  ]);
});
