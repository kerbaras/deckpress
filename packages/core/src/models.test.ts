import { expect, it } from "vitest";
import {
  artSchema,
  type DeckEntry,
  mergeImport,
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
