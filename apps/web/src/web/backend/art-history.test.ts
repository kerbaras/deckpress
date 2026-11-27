import { expect, it, vi } from "vitest";
import fixture from "../../../../../packages/core/tests/fixtures/scryfall-art-policy.json";
import type { ArtChange, PrintLanguagePreferences } from "../../api.ts";
import {
  type Art,
  type DeckEntry,
  entrySchema,
  frontArt,
} from "../../core/index.ts";
import * as coreWasm from "../core-wasm.ts";
import { type Printing, policyPrinting } from "../providers/printings.ts";
import { normalizeScryfall } from "../providers/scryfall-card.ts";
import { deckStore } from "../store/decks.ts";
import { memoryDocuments } from "../store/memory.test-helper.ts";
import { artHistory } from "./art-history.ts";
import * as setMatching from "./set-matching.ts";

function raw(set: string, lang = "en") {
  const card = fixture.find((item) => item.set === set && item.lang === lang);
  if (!card) throw new Error(`Missing fixture: ${set}/${lang}`);
  return card;
}

const prints = fixture.flatMap((value) => policyPrinting(value) ?? []);
function fromFixture(set: string, lang = "en") {
  const print = policyPrinting(raw(set, lang));
  if (!print) throw new Error("Invalid fixture");
  return print;
}

function entry(set: string, artPinned = false) {
  return entrySchema.parse({
    id: crypto.randomUUID(),
    quantity: 1,
    zone: "main",
    card: normalizeScryfall(raw(set)),
    artPinned,
  });
}

function change(entry: DeckEntry, after: Art | null, kind: ArtChange["kind"]) {
  return {
    entryId: entry.id,
    name: entry.card.name,
    quantity: entry.quantity,
    before: frontArt(entry),
    after,
    kind,
    reason: "",
  };
}

function mockPolicyPlan(
  entries: DeckEntry[],
  results: (Art[] | "pinned" | null)[],
) {
  const planDeckArtPolicy = vi.fn(() =>
    JSON.stringify({
      changes: entries.map((entry, index) => {
        const scans = results[index];
        return change(
          entry,
          Array.isArray(scans) ? (scans[0] ?? null) : null,
          scans === "pinned" ? "pinned" : scans ? "changed" : "unmatched",
        );
      }),
      updates: entries.flatMap((entry, index) => {
        const scans = results[index];
        return Array.isArray(scans)
          ? [
              {
                id: entry.id,
                policyArt: scans,
                languageAnchor: null,
                requestedLanguages: entry.requestedLanguages ?? ["en"],
              },
            ]
          : [];
      }),
    }),
  );
  vi.spyOn(coreWasm, "loadCoreWasm");
  vi.mocked(coreWasm.loadCoreWasm, { partial: true }).mockResolvedValue({
    planDeckArtPolicy,
  });
  return planDeckArtPolicy;
}

function mockLocalization(entry: DeckEntry, result: Printing) {
  const scan = result.scans?.[0];
  if (!scan) throw new Error("Missing scan fixture");
  const planPrintLocalization = vi.fn(
    (_, _anchor, inventory, preferred, language) => {
      const match =
        language === scan.language &&
        (JSON.parse(inventory) as Printing[]).some(
          ({ id }) => id === result.id,
        );
      const fallback = language === "en";
      return JSON.stringify(
        match
          ? {
              change: change(entry, scan, fallback ? "fallback" : "changed"),
              update: {
                selectedArt: { ...scan, englishFallback: fallback },
                selectedBack: null,
                artPinned: true,
                requestedLanguages: JSON.parse(preferred),
              },
            }
          : { change: change(entry, null, "unmatched"), update: null },
      );
    },
  );
  vi.spyOn(coreWasm, "loadCoreWasm");
  vi.mocked(coreWasm.loadCoreWasm, { partial: true }).mockResolvedValue({
    planPrintLocalization,
  });
  return planPrintLocalization;
}

async function setup(entries = [entry("m11")]) {
  const decks = deckStore(memoryDocuments());
  const deck = await decks.create({
    name: "Fixture",
    format: "Modern",
    entries,
  });
  let prefs: PrintLanguagePreferences = {
    languages: ["es"],
    policy: "fallback-to-english",
  };
  const provider = {
    sets: vi.fn(async () => []),
    anchors: vi.fn(async () => new Map<string, Printing>()),
    inventoryBatch: vi.fn(async () => new Map<string, Printing[]>()),
    get: vi.fn(async (artId: string) =>
      prints.find(({ id }) => artId === `scryfall:${id}:0`),
    ),
    exact: vi.fn(async (anchor, lang) =>
      prints.find(
        (p) =>
          p.set === anchor.set &&
          p.collector === anchor.collector &&
          p.language === lang,
      ),
    ),
    inventory: vi.fn(async (_oracleId, lang?) =>
      prints.filter((p) => !lang || p.language === lang),
    ),
  } satisfies Parameters<typeof artHistory>[1];
  return {
    decks,
    deck,
    provider,
    preferences: (value: PrintLanguagePreferences) => {
      prefs = value;
    },
    history: artHistory(decks, provider, async () => prefs),
  };
}

it("localizes around unusable exact scans without changing illustrations, then persists and undoes", async () => {
  const initial = entry("m11");
  const { decks, deck, history, provider } = await setup([initial]);
  mockLocalization(initial, fromFixture("m10", "es"));
  const preview = await history.previewLocalization(
    deck.id,
    0,
    initial.id,
    frontArt(initial).id,
  );
  expect(provider.exact).toHaveBeenCalledWith(
    expect.objectContaining({ set: "m11" }),
    "es",
  );
  expect(preview).toMatchObject({
    canApply: true,
    changes: [{ kind: "changed", after: { set: "m10", language: "es" } }],
  });
  expect(await decks.get(deck.id)).toEqual(deck);
  const applied = await history.apply(deck.id, 0, preview.previewId);
  expect(applied).toMatchObject({
    revision: 1,
    entries: [
      {
        artPinned: true,
        selectedArt: { language: "es" },
        requestedLanguages: ["es"],
      },
    ],
  });
  expect(await decks.get(deck.id)).toEqual(applied);
  const undone = await history.undo(deck.id, 1);
  expect(undone.revision).toBe(2);
  expect(undone.entries).toEqual(deck.entries);
  await expect(history.undo(deck.id, 2)).rejects.toThrow(
    "There is no art change to undo.",
  );
});

it("stages a language override, saves it without pinning and keeps web upload metadata through undo", async () => {
  const original = entry("lea");
  const upload = {
    ...entry("m11"),
    selectedArt: {
      ...frontArt(original),
      id: "upload:protected",
      provider: "upload" as const,
      contentHash: "a".repeat(64),
      filename: "custom-art.png",
    },
  };
  const { deck, decks, history, provider } = await setup([original, upload]);
  const printing = fromFixture("m10", "es");
  const scan = printing.scans?.[0];
  if (!scan) throw new Error("Missing Spanish scan");
  const anchor = frontArt(original);
  const update = {
    id: original.id,
    policyArt: [scan],
    requestedLanguages: ["es"],
    languageAnchor: anchor.id,
    languageChoices: {},
  };
  const change = {
    entryId: original.id,
    name: original.card.name,
    quantity: original.quantity,
    before: anchor,
    after: scan,
    kind: "changed",
    tier: "sameArt",
    reason: "",
  };
  const override = { ...update, languageChoices: { es: printing.id } };
  vi.spyOn(coreWasm, "loadCoreWasm");
  vi.mocked(coreWasm.loadCoreWasm, { partial: true }).mockResolvedValue({
    deckLanguageLookups: () =>
      JSON.stringify({
        anchorIds: [original.card.id],
        oracleIds: [original.card.oracleId],
      }),
    planDeckLanguage: () =>
      JSON.stringify({ updates: [update], changes: [change] }),
    overrideDeckLanguagePrint: () =>
      JSON.stringify({
        update: override,
        change: { ...change, tier: "override" },
      }),
  });
  const preview = await history.previewLanguage(deck.id, 0, "es");
  expect(preview).toMatchObject({ language: "es", canApply: true });
  await expect(
    history.overrideLanguage(deck.id, 0, preview.previewId, upload.id, scan.id),
  ).rejects.toThrow("protected");
  expect(provider.get).not.toHaveBeenCalled();
  const changed = await history.overrideLanguage(
    deck.id,
    0,
    preview.previewId,
    original.id,
    scan.id,
  );
  expect(changed).toMatchObject({ tier: "override" });
  expect(await decks.get(deck.id)).toEqual(deck);
  const applied = await history.apply(deck.id, 0, preview.previewId);
  expect(applied.entries[0]).toMatchObject({ ...override, selectedArt: null });
  expect(applied.entries[1]).toEqual(deck.entries[1]);
  expect((await decks.get(deck.id)).printLanguage).toBe("es");
  const undone = await history.undo(deck.id, applied.revision);
  expect(undone.printLanguage).toBeUndefined();
  expect(undone.entries).toEqual(deck.entries);
});

it("reports empty translations in strict mode and marks English fallback when allowed", async () => {
  const initial = entry("lea");
  const { deck, history, preferences } = await setup([initial]);
  mockLocalization(initial, fromFixture("lea"));
  preferences({ languages: ["es"], policy: "strict" });
  const args = [deck.id, 0, initial.id, frontArt(initial).id] as const;
  const strict = await history.previewLocalization(...args);
  expect(strict).toMatchObject({
    canApply: false,
    changes: [{ kind: "unmatched", after: null }],
  });
  await expect(history.apply(deck.id, 0, strict.previewId)).rejects.toThrow(
    "expired",
  );
  preferences({ languages: ["es"], policy: "fallback-to-english" });
  const fallback = await history.previewLocalization(...args);
  expect(fallback.changes).toMatchObject([
    { kind: "fallback", after: { set: "lea", language: "en" } },
  ]);
  await expect(
    history.apply(deck.id, 0, fallback.previewId),
  ).resolves.toMatchObject({
    entries: [{ selectedArt: { englishFallback: true } }],
  });
});

it("stages policy updates and rejects invalid and stale previews", async () => {
  const { deck, decks, history, provider, preferences } = await setup([
    entry("lea"),
    entry("lea", true),
  ]);
  preferences({ languages: ["en"], policy: "strict" });
  const high = fromFixture("m11");
  provider.inventoryBatch.mockResolvedValue(new Map([[high.oracleId, [high]]]));
  mockPolicyPlan(deck.entries, [high.scans ?? [], "pinned"]);
  await expect(
    Promise.resolve().then(() =>
      history.previewPolicy(deck.id, 0, { kind: "matchSet", set: "bad code" }),
    ),
  ).rejects.toThrow("Enter a valid set code.");
  const preview = await history.previewPolicy(deck.id, 0, { kind: "latest" });
  expect(preview.changes).toMatchObject([
    { kind: "changed", after: { set: "m11" } },
    { kind: "pinned", after: null },
  ]);
  const replacement = await history.previewPolicy(deck.id, 0, {
    kind: "latest",
  });
  await expect(history.apply(deck.id, 0, preview.previewId)).rejects.toThrow(
    "expired",
  );
  const result = await history.apply(deck.id, 0, replacement.previewId);
  expect(result).toMatchObject({
    artPolicy: { kind: "latest" },
    entries: [{ policyArt: [{ set: "m11" }] }, { artPinned: true }],
  });
  await decks.save(result);
  await expect(history.undo(deck.id, 1)).rejects.toThrow("The deck changed.");
  await expect(history.undo(deck.id, 2)).rejects.toThrow(
    "Undo would overwrite",
  );
});

it("passes copy quantities and keeps pinned copies in the coverage total", async () => {
  const eligible = { ...entry("lea"), quantity: 3 };
  const pinned = { ...entry("lea", true), quantity: 2 };
  const { deck, provider } = await setup([eligible, pinned]);
  provider.inventoryBatch.mockResolvedValue(
    new Map([[eligible.card.oracleId, [fromFixture("m11")]]]),
  );
  const setCoverage = vi.fn(() => "[]");
  const wasm = vi.spyOn(coreWasm, "loadCoreWasm");
  vi.mocked(coreWasm.loadCoreWasm, { partial: true }).mockResolvedValue({
    setCoverage,
  });
  try {
    await setMatching.setCoverage(provider, deck);
    expect(provider.inventoryBatch).toHaveBeenCalledExactlyOnceWith([
      eligible.card.oracleId,
    ]);
    expect(setCoverage).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify([
        [3, ["m11"]],
        [2, []],
      ]),
      "[]",
    );
  } finally {
    wasm.mockRestore();
  }
});

it.each([false, undefined])(
  "batches the exact set for matchSet policies with family=%s",
  async (family) => {
    const matching = { ...entry("lea"), requestedLanguages: ["es"] };
    const unmatched = entry("lea");
    unmatched.card.oracleId = crypto.randomUUID();
    const { deck, decks, history, provider, preferences } = await setup([
      matching,
      unmatched,
    ]);
    preferences({ languages: ["en"], policy: "strict" });
    const spanish = fromFixture("m10", "es");
    const scans = spanish.scans?.map((scan) => ({ ...scan, set: "m11" })) ?? [];
    const inventory = new Map([
      [
        matching.card.oracleId,
        [fromFixture("m11"), { ...spanish, set: "m11", scans }],
      ],
      [unmatched.card.oracleId, [fromFixture("m10")]],
    ]);
    provider.inventoryBatch.mockResolvedValue(inventory);
    const plan = mockPolicyPlan(deck.entries, [scans, null]);
    const preview = await history.previewPolicy(deck.id, deck.revision, {
      kind: "matchSet",
      set: "m11",
      ...(family === false && { family }),
    });
    expect(preview).toMatchObject({
      canApply: true,
      changes: [
        { kind: "changed", after: { set: "m11", language: "es" } },
        { kind: "unmatched", after: null },
      ],
    });
    expect(provider.inventoryBatch).toHaveBeenCalledExactlyOnceWith(
      [matching.card.oracleId, unmatched.card.oracleId],
      undefined,
      ["m11"],
    );
    expect(provider.inventory).not.toHaveBeenCalled();
    expect(provider.sets).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(await decks.get(deck.id)),
      JSON.stringify({
        kind: "matchSet",
        set: "m11",
        ...(family === false && { family }),
      }),
      JSON.stringify({ languages: ["en"], policy: "strict" }),
      "null",
      JSON.stringify(Object.fromEntries(inventory)),
    );
    const applied = await history.apply(deck.id, 0, preview.previewId);
    expect(applied.entries[0]?.requestedLanguages).toEqual(["es"]);
  },
);

it.each([
  ["fdc", "fdn", "tfdc"],
  ["ecc", "ecl", "tecc"],
])(
  "previews, applies and undoes the %s family policy",
  async (chosen, sibling, token) => {
    const scenarios = [
      [token, sibling, chosen, "m11"],
      [token, sibling],
      [token],
      ["m11"],
      [],
    ].map((sets, i) => {
      const initial = entry("lea", i === 4);
      return {
        sets,
        initial: {
          ...initial,
          card: { ...initial.card, oracleId: crypto.randomUUID() },
        },
      };
    });
    const entries = scenarios.map(({ initial }) => initial);
    const ids = entries.map(({ card }) => card.oracleId);
    const { deck, decks, history, provider, preferences } =
      await setup(entries);
    preferences({ languages: ["en"], policy: "strict" });
    // The WASM suite checks the ranks against the same Scryfall fixture as Rust.
    vi.spyOn(setMatching, "setFamilyRanks").mockResolvedValue(
      new Map([
        [chosen, 0],
        [sibling, 1],
        [token, 2],
      ]),
    );
    const printing = fromFixture("m11");
    const scans = printing.scans ?? [];
    mockPolicyPlan(deck.entries, [
      scans.map((scan) => ({ ...scan, set: chosen })),
      scans.map((scan) => ({ ...scan, set: sibling })),
      scans.map((scan) => ({ ...scan, set: token })),
      null,
      "pinned",
    ]);
    provider.inventoryBatch.mockResolvedValue(
      new Map(
        scenarios.map(
          ({
            initial: {
              card: { oracleId },
            },
            sets,
          }) => [
            oracleId,
            sets.map((set, index) => ({
              ...printing,
              oracleId,
              set,
              date: `2026-01-0${5 - index}`,
              scans: scans.map((scan) => ({ ...scan, set })),
            })),
          ],
        ),
      ),
    );
    const policy = { kind: "matchSet", set: chosen, family: true } as const;
    const preview = await history.previewPolicy(deck.id, deck.revision, policy);
    expect(preview.changes).toMatchObject([
      { kind: "changed", after: { set: chosen } },
      { kind: "changed", after: { set: sibling } },
      { kind: "changed", after: { set: token } },
      { kind: "unmatched", after: null },
      { kind: "pinned", after: null },
    ]);
    expect(provider.inventoryBatch).toHaveBeenCalledExactlyOnceWith(
      ids.slice(0, 4),
      undefined,
      [chosen, sibling, token],
    );
    expect(provider.inventory).not.toHaveBeenCalled();
    expect(await decks.get(deck.id)).toEqual(deck);
    const applied = await history.apply(
      deck.id,
      deck.revision,
      preview.previewId,
    );
    expect(applied.artPolicy).toEqual(policy);
    expect(applied.entries.map((value) => frontArt(value).set)).toEqual([
      chosen,
      sibling,
      token,
      "lea",
      "lea",
    ]);
    const undone = await history.undo(deck.id, applied.revision);
    expect(undone.entries).toEqual(deck.entries);
    expect(undone.artPolicy).toEqual(deck.artPolicy);
  },
);
