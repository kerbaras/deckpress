import { expect, it } from "vitest";
import {
  artSchema,
  type Deck,
  type DeckEntry,
  entrySchema,
  mergeImport,
  printableEntries,
  printSettingsSchema,
} from "./models.ts";

const id = "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240";
const art = artSchema.parse({
  id: "chosen",
  provider: "scryfall",
  name: "Bolt",
  imageUrl: "https://cards.scryfall.io/bolt.png",
  thumbnailUrl: "https://cards.scryfall.io/bolt.png",
  source: "Test",
});
const entry: DeckEntry = {
  id,
  card: {
    id,
    oracleId: id,
    name: "Bolt",
    typeLine: "Instant",
    manaValue: 1,
    manaCost: "{R}",
    colors: ["R"],
    faces: [art],
  },
  quantity: 2,
  zone: "main",
  selectedArt: art,
  selectedBack: null,
  excluded: false,
};

it("retains per-copy art allocations on re-import, including a changed printing, without duplicating IDs", () => {
  const other = {
    ...entry,
    id: "15d325d4-8b31-4b71-b9b7-a55ecbb39a5c",
    selectedArt: { ...art, id: "second-art" },
  };
  const incoming = {
    ...entry,
    id: "a0b6babc-e1ea-419f-b99b-9df8dbf12e3b",
    quantity: 4,
    selectedArt: null,
  };
  const result = mergeImport([entry, other], [incoming], true);
  expect(result.map((item) => [item.quantity, item.selectedArt?.id])).toEqual([
    [2, "chosen"],
    [2, "second-art"],
  ]);
  const changed = {
    ...incoming,
    id: "0326aebd-6115-4bc6-82c4-80281c957244",
    card: { ...incoming.card, id: "0326aebd-6115-4bc6-82c4-80281c957244" },
  };
  const newPrinting = mergeImport([entry], [changed], true);
  expect(newPrinting[0]).toMatchObject({
    id: entry.id,
    card: { id: changed.card.id },
    selectedArt: art,
  });
  const distinct = mergeImport([entry], [incoming, changed], true);
  expect(new Set(distinct.map((item) => item.id)).size).toBe(distinct.length);
  expect(
    mergeImport([entry, other], [incoming], false).reduce(
      (total, item) => total + item.quantity,
      0,
    ),
  ).toBe(8);
});

it("defaults new print settings to mirrored bleed and keeps stored modes", () => {
  expect(printSettingsSchema.parse({}).bleedMode).toBe("mirror");
  expect(printSettingsSchema.parse({ bleedMode: "solid" }).bleedMode).toBe(
    "solid",
  );
});

it("keeps named boards separate on append and when retaining art on replace", () => {
  const previous = {
    ...entry,
    zone: "maybe",
    board: "Considering",
  } satisfies DeckEntry;
  const incoming = {
    ...previous,
    id: "a0b6babc-e1ea-419f-b99b-9df8dbf12e3b",
    board: "Maybeboard",
    selectedArt: null,
  };
  expect(mergeImport([previous], [incoming], false)).toEqual([
    previous,
    incoming,
  ]);
  const changedPrinting = {
    ...incoming,
    card: { ...incoming.card, id: incoming.id },
  };
  expect(mergeImport([previous], [changedPrinting], true)).toEqual([
    changedPrinting,
  ]);
  expect(
    mergeImport([previous], [{ ...incoming, board: previous.board }], true),
  ).toEqual([previous]);
});

it("does not inherit non-preferred art when a localized print is imported", () => {
  const old = { ...entry, selectedArt: { ...art, language: "en" } };
  const incoming = {
    ...entry,
    id: "0326aebd-6115-4bc6-82c4-80281c957244",
    card: { ...entry.card, faces: [{ ...art, language: "es" }] },
    selectedArt: null,
    requestedLanguages: ["es"],
  };
  const [replaced] = mergeImport([old], [incoming], true);
  expect(replaced).toMatchObject({ id: old.id, selectedArt: null });
  expect(
    mergeImport([{ ...old, requestedLanguages: ["es"] }], [incoming], false),
  ).toEqual([{ ...old, requestedLanguages: ["es"] }, incoming]);
});

it("preserves the original printing and language choices on replace for the same card", () => {
  const previous = entrySchema.parse({
    ...entry,
    selectedArt: null,
    languageAnchor: `scryfall:${id}:0`,
    languageChoices: { es: "35a60469-b610-4139-98b1-ed2d5fd2cb65" },
  });
  const incoming = {
    ...entry,
    id: "0326aebd-6115-4bc6-82c4-80281c957244",
    selectedArt: null,
    requestedLanguages: ["es"],
  };
  const expected = {
    id: previous.id,
    languageAnchor: previous.languageAnchor,
    languageChoices: previous.languageChoices,
  };
  expect(mergeImport([previous], [incoming], true)[0]).toMatchObject(expected);

  const localized = {
    ...incoming,
    card: {
      ...incoming.card,
      id: incoming.id,
      faces: [{ ...art, language: "es" }],
    },
    quantity: 3,
  };
  const [matched, added] = mergeImport([previous], [localized], true);
  expect(matched).toMatchObject({ ...expected, quantity: 2 });
  expect(added).toEqual({ ...localized, quantity: 1 });
  const other = {
    ...localized,
    card: { ...localized.card, oracleId: localized.id },
  };
  expect(mergeImport([previous], [other], true)).toEqual([other]);
});

it("prints companions by default like the commander and keeps them through the deck schema", () => {
  const companion = { ...entry, zone: "companion" } satisfies DeckEntry;
  const deck = { entries: [companion] } as unknown as Deck;
  const settings = printSettingsSchema.parse({});
  expect(settings.includeSideboard).toBe(false);
  expect(printableEntries(deck, settings)).toEqual([companion]);
  expect(
    printableEntries(
      { ...deck, entries: [{ ...companion, excluded: true }] },
      settings,
    ),
  ).toEqual([]);
  expect(entrySchema.parse(companion).zone).toBe("companion");
});
