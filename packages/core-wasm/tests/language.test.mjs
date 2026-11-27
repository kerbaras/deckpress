import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  deckLanguageLookups, initSync, overrideDeckLanguagePrint, planDeckArtPolicy, planDeckLanguage, planPrintLocalization,
} from '../dist/deckpress_core_wasm.js';

initSync({ module: readFileSync(new URL('../dist/deckpress_core_wasm_bg.wasm', import.meta.url)) });

const { data: sets } = JSON.parse(readFileSync(new URL(
  '../../core/tests/fixtures/scryfall-set-families.json', import.meta.url,
), 'utf8'));
const uuid = (number) => `04eec835-d89a-4900-8781-${String(number).padStart(12, '0')}`;
const oracle = uuid(1);
const tokenOracle = uuid(2);

function printing(number, set, language, illustrations, oracleId = oracle) {
  const id = uuid(number);
  return {
    id, set, language, illustrations, oracleId,
    collector: '1', date: '2024-11-15', frame: '2015', border: 'black',
    fullArt: false, showcase: false, treatments: [], paper: true, promo: false,
    scans: illustrations.map((illustrationId, face) => ({
      id: `scryfall:${id}:${face}`, provider: 'scryfall', set, language, illustrationId,
      collectorNumber: '1',
      imageUrl: `https://cards.example/${id}/${face}.png`,
      thumbnailUrl: `https://cards.example/${id}/${face}-small.png`,
    })),
  };
}

function entry(number, printing, zone = 'main') {
  const { id, oracleId, scans } = printing;
  return { id: uuid(number), quantity: 1, zone, card: { id, oracleId, name: 'Fixture', faces: scans } };
}

const english = printing(3, 'fdc', 'en', [uuid(4), uuid(5)]);
const spanish = printing(6, 'fdn', 'es', [uuid(7), uuid(8)]);
const sameArt = printing(9, 'ecc', 'es', english.illustrations);
const token = entry(10, printing(11, 'tfdc', 'en', [uuid(12)], tokenOracle), 'tokens');
const original = entry(13, english);
const pinned = { ...entry(14, english), artPinned: true };
const uploaded = {
  ...entry(15, english),
  selectedArt: { ...english.scans[0], id: 'upload:test', provider: 'upload' },
};
const deck = {
  id: uuid(16), name: 'Language fixture', format: 'Commander', revision: 0,
  createdAt: '', updatedAt: '', entries: [original, pinned, uploaded, token],
};
const anchors = { [english.id]: english, [token.card.id]: printing(11, 'tfdc', 'en', [uuid(12)], tokenOracle) };
const candidates = { [oracle]: [sameArt, spanish] };
const stringify = JSON.stringify;

function plan(forDeck, language, candidates, missing = 'fallback-to-english', fallback) {
  return JSON.parse(planDeckLanguage(
    stringify(forDeck), language, stringify(missing),
    stringify({ sets, anchors, candidates }), fallback && stringify(fallback),
  ));
}

test('the WASM deck planner uses native family tiers, carries both faces and protects manual art', () => {
  assert.deepEqual(JSON.parse(deckLanguageLookups(stringify(deck), 'es')), {
    anchorIds: [english.id, token.card.id], oracleIds: [oracle, tokenOracle],
  });
  const preview = plan({ ...deck, artPolicy: { kind: 'matchSet', set: 'fdc', family: true } }, 'es', candidates);
  assert.deepEqual(preview.changes.map(({ tier }) => tier), ['sameSet', 'pinned', 'pinned', 'keptEnglish']);
  assert.equal(preview.changes[0].afterBack.id, spanish.scans[1].id);
  assert.deepEqual(preview.updates.map(({ id }) => id), [original.id, token.id]);
  assert.equal(preview.updates[1].policyArt[0].englishFallback, true);
  const strict = plan({ ...deck, artPolicy: { kind: 'matchSet', set: 'fdc', family: false } }, 'es', candidates, 'strict');
  assert.equal(strict.changes[0].tier, 'keptCurrent');
  assert.equal(strict.changes[3].tier, 'keptCurrent');
});

test('target-language overrides remember the choice without changing the original English anchor', () => {
  const { updates: [update] } = plan(deck, 'es', candidates);
  const proposed = { ...original, ...update };
  const chosen = JSON.parse(overrideDeckLanguagePrint(stringify(original), stringify(proposed), stringify(sameArt), 'es'));
  assert.equal(chosen.change.tier, 'override');
  assert.equal(chosen.change.afterBack.id, sameArt.scans[1].id);
  assert.deepEqual(chosen.update.languageChoices, { es: sameArt.id });
  assert.equal(chosen.update.languageAnchor, english.scans[0].id);
  const spanishDeck = { ...deck, entries: [{ ...proposed, ...chosen.update }] };
  const restored = plan(spanishDeck, 'en', { [oracle]: [english] });
  assert.equal(restored.changes[0].tier, 'samePrinting');
  assert.deepEqual(restored.updates[0].policyArt.map(({ id }) => id), english.scans.map(({ id }) => id));
  assert.throws(() => overrideDeckLanguagePrint(stringify(original), stringify(proposed), stringify(english), 'es'), /requested language/);
  assert.throws(() => overrideDeckLanguagePrint(stringify(uploaded), stringify(uploaded), stringify(sameArt), 'es'), /protected/);
});

test('English inventory is requested only for unresolved non-English entries when enabled', () => {
  const current = { ...original, policyArt: spanish.scans, languageAnchor: english.scans[0].id };
  const localized = { ...deck, entries: [current, token] };
  assert.deepEqual(plan(localized, 'ja', {}), { englishOracleIds: [oracle] });
  const englishFallback = { ...english, set: spanish.set };
  const result = plan(localized, 'ja', {}, 'fallback-to-english', { [oracle]: [englishFallback] });
  assert.deepEqual(result.changes.map(({ tier }) => tier), ['keptEnglish', 'keptEnglish']);
  assert.equal(result.changes[0].after.language, 'en');
  assert.equal(plan(localized, 'ja', {}, 'strict').changes[0].after.language, 'es');
});

test('art policy uses each entry language and only chooses same-illustration scans', () => {
  const samePrintingEs = printing(17, 'fdc', 'es', english.illustrations);
  const siblingEs = printing(18, 'fdn', 'es', english.illustrations);
  const exact = { kind: 'matchSet', set: 'fdc', family: false };
  const family = { ...exact, family: true };
  const localized = { ...original, requestedLanguages: ['es'], policyArt: sameArt.scans,
    languageAnchor: english.scans[0].id, languageChoices: { es: sameArt.id } };
  const explicitlyEnglish = { ...entry(19, english), requestedLanguages: ['en'] };
  const legacy = entry(20, english);
  const fixture = { ...deck, printLanguage: 'es', entries: [localized, explicitlyEnglish, legacy, pinned, uploaded] };
  const run = (policy, options, missing = 'strict') => JSON.parse(planDeckArtPolicy(
    stringify(fixture), stringify(policy),
    stringify({ languages: ['en'], policy: missing }),
    stringify(policy.family ? { fdc: 0, fdn: 1 } : null),
    stringify({ [oracle]: options }),
  ));
  const exactPreview = run(exact, [english, samePrintingEs, siblingEs]);
  assert.deepEqual(exactPreview.changes.map(({ kind }) => kind),
    ['changed', 'unchanged', 'changed', 'pinned', 'pinned']);
  assert.deepEqual(exactPreview.updates.map(({ requestedLanguages }) => requestedLanguages),
    [['es'], ['en'], ['es']]);
  assert.deepEqual(exactPreview.updates[0].policyArt.map(({ id }) => id), samePrintingEs.scans.map(({ id }) => id));
  assert.equal(exactPreview.updates[0].languageAnchor, null);
  assert.deepEqual(run(exact, [english, siblingEs]).changes.map(({ kind }) => kind),
    ['unmatched', 'unchanged', 'unmatched', 'pinned', 'pinned']);
  assert.equal(run(family, [english, spanish, siblingEs]).changes[0].after.id, siblingEs.scans[0].id);
  const fallback = run(family, [english, spanish], 'fallback-to-english');
  assert.equal(fallback.changes[0].kind, 'fallback');
  assert.deepEqual(fallback.updates[0].requestedLanguages, ['es']);
});

test('manual localization requires complete, ordered illustrations for distinct printings', () => {
  const candidate = printing(17, 'fdc', 'es', english.illustrations);
  function localize(anchor, candidate, language = 'es') {
    return JSON.parse(planPrintLocalization(
      stringify(original), stringify(anchor), stringify([candidate]), stringify(['es']), language,
    ));
  }
  const result = localize(english, candidate);
  assert.equal(result.update.selectedArt.id, candidate.scans[0].id);
  assert.equal(result.update.selectedBack.id, candidate.scans[1].id);
  assert.equal(result.update.artPinned, true);
  assert.equal(localize(english, { ...candidate, illustrations: [...candidate.illustrations].reverse() }).update, null);
  const unknown = { ...english, illustrations: [english.illustrations[0], null] };
  assert.equal(localize(unknown, { ...candidate, illustrations: unknown.illustrations }).update, null);
  assert.equal(localize(unknown, unknown, 'en').change.kind, 'fallback');
});
