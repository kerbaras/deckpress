import { describe, expect, it } from "vitest";
import type { BuilderFormat, BuilderTheme } from "./api.ts";
import { artSchema, type Card } from "./core/index.ts";
import {
  addCard,
  blocker,
  commanderEntry,
  copiesOf,
  deckFormatOf,
  defaultDeckName,
  emptyState,
  fitEntries,
  mergeEntries,
  orderEntries,
  scorePercent,
  setQuantity,
  stepsFor,
  toSpec,
} from "./deck-builder-model.ts";

const card = (name: string, typeLine: string, manaValue = 1): Card => ({
  id: crypto.randomUUID(),
  oracleId: crypto.randomUUID(),
  name,
  typeLine,
  manaCost: manaValue ? `{${manaValue}}` : "",
  manaValue,
  colors: [],
  faces: [
    artSchema.parse({
      id: `scryfall:${name}`,
      provider: "scryfall",
      name,
      imageUrl: "https://cards.scryfall.io/x.png",
      thumbnailUrl: "https://cards.scryfall.io/x.jpg",
      source: "Test",
    }),
  ],
});

const format = (patch: Partial<BuilderFormat>): BuilderFormat => ({
  id: "standard",
  name: "Standard",
  deckFormat: "Standard",
  deckSize: 60,
  landTarget: 24,
  singleton: false,
  maxCopies: 4,
  commander: false,
  needsSet: false,
  description: "",
  ...patch,
});
const commander = format({
  id: "commander",
  name: "Commander",
  deckFormat: "Commander",
  deckSize: 100,
  landTarget: 37,
  singleton: true,
  maxCopies: 1,
  commander: true,
});
const limited = format({
  id: "limited",
  name: "Draft / Limited",
  deckFormat: "Casual",
  deckSize: 40,
  landTarget: 17,
  needsSet: true,
});
const theme = (patch: Partial<BuilderTheme>): BuilderTheme => ({
  id: "counters",
  name: "+1/+1 counters",
  description: "",
  needsTribe: false,
  cues: [],
  typeCues: [],
  ...patch,
});
const themes = [
  theme({}),
  theme({ id: "typal", name: "Tribal / typal", needsTribe: true }),
];

const bolt = card("Lightning Bolt", "Instant");
const forest = card("Forest", "Basic Land — Forest", 0);
const atraxa = card("Atraxa, Praetors' Voice", "Legendary Creature — Angel", 4);

describe("wizard steps", () => {
  it("skips the colour step for Commander and derives colours from the commander", () => {
    expect(stepsFor(null)).toEqual(["format", "colors", "style", "cards"]);
    expect(stepsFor(commander)).toEqual([
      "format",
      "commander",
      "style",
      "cards",
    ]);
    const spec = toSpec({
      ...emptyState,
      format: commander,
      colors: ["R"],
      commander: { ...atraxa, colors: ["B", "G", "U", "W"] },
      style: "midrange",
      theme: "counters",
    });
    expect(spec?.colors).toEqual(["B", "G", "U", "W"]);
    expect(spec?.format).toBe("commander");
  });

  it("explains what blocks each step", () => {
    expect(blocker(emptyState, "format", themes)).toMatch(/choose a format/i);
    expect(
      blocker({ ...emptyState, format: limited }, "format", themes),
    ).toMatch(/set/i);
    expect(
      blocker({ ...emptyState, format: limited, set: "blb" }, "format", themes),
    ).toBeNull();
    expect(
      blocker({ ...emptyState, format: commander }, "commander", themes),
    ).toMatch(/commander/i);
    const styled = {
      ...emptyState,
      format: format({}),
      style: "aggro",
      theme: "typal",
    };
    expect(blocker(styled, "style", themes)).toMatch(/creature type/i);
    expect(blocker({ ...styled, tribe: "Elf" }, "style", themes)).toBeNull();
  });

  it("maps builder formats onto deck formats the store accepts", () => {
    expect(deckFormatOf(commander)).toBe("Commander");
    expect(deckFormatOf(limited)).toBe("Casual");
    expect(deckFormatOf(format({ deckFormat: "Limited" }))).toBe("Casual");
  });
});

describe("deck entries", () => {
  it("merges copies up to the format limit", () => {
    let entries = addCard([], bolt, 4);
    entries = addCard(entries, bolt, 4);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quantity).toBe(2);
    entries = setQuantity(entries, entries[0]?.id ?? "", 9, 4);
    expect(entries[0]?.quantity).toBe(4);
    const capped = addCard(entries, bolt, 4);
    expect(capped).toBe(entries);
  });

  it("keeps singleton formats to one copy but lets basics stack", () => {
    const entries = addCard(addCard([], bolt, 1), bolt, 1);
    expect(copiesOf(entries, bolt)).toBe(1);
    let lands = addCard([], forest, 1);
    for (let i = 0; i < 9; i++) lands = addCard(lands, forest, 1);
    expect(copiesOf(lands, forest)).toBe(10);
  });

  it("counts the commander towards the singleton limit", () => {
    const entries = [commanderEntry(atraxa)];
    expect(addCard(entries, atraxa, 1)).toBe(entries);
  });

  it("removes an entry when its quantity reaches zero", () => {
    const entries = addCard([], bolt, 4);
    expect(setQuantity(entries, entries[0]?.id ?? "", 0, 4)).toEqual([]);
  });

  it("merges filled slots into existing entries", () => {
    const entries = addCard([], forest, 4);
    const filled = mergeEntries(entries, [
      ...addCard([], forest, 4).map((entry) => ({ ...entry, quantity: 6 })),
      ...addCard([], bolt, 4),
    ]);
    expect(filled).toHaveLength(2);
    expect(copiesOf(filled, forest)).toBe(7);
  });

  it("drops picked cards that stop fitting the wizard settings", () => {
    const red = { ...bolt, colors: ["R"] };
    const green = {
      ...card("Llanowar Elves", "Creature — Elf"),
      colors: ["G"],
    };
    const picked = [...addCard([], red, 4), ...addCard([], green, 4)];
    const rg = { ...emptyState, format: format({}), colors: ["R", "G"] };
    expect(fitEntries(picked, rg, rg)).toEqual(picked);
    expect(
      fitEntries(picked, rg, { ...rg, colors: ["R"] }).map((e) => e.card.name),
    ).toEqual(["Lightning Bolt"]);
    expect(fitEntries(picked, rg, { ...rg, format: commander })).toEqual([]);

    const wubg = { ...rg, format: commander, colors: [], commander: atraxa };
    const withCommander = [commanderEntry(atraxa), ...picked];
    const other = { ...atraxa, id: crypto.randomUUID(), colors: ["G"] };
    const swapped = fitEntries(withCommander, wubg, {
      ...wubg,
      commander: other,
    });
    expect(swapped.map((e) => e.card.name)).toEqual(["Llanowar Elves"]);

    const drafted = { ...rg, format: limited, set: "blb", colors: [] };
    const inSet: Card = {
      ...green,
      faces: green.faces.map((face) => ({ ...face, set: "blb" })),
    };
    const kept = fitEntries(
      [
        ...addCard([], inSet, 4),
        ...addCard([], red, 4),
        ...addCard([], forest, 4),
      ],
      drafted,
      drafted,
    );
    expect(kept.map((e) => e.card.name)).toEqual(["Llanowar Elves", "Forest"]);
  });

  it("orders commander first, then spells by mana value, lands last", () => {
    const entries = orderEntries([
      ...addCard([], forest, 4),
      ...addCard([], card("Wrath", "Sorcery", 4), 4),
      ...addCard([], bolt, 4),
      commanderEntry(atraxa),
    ]);
    expect(entries.map((entry) => entry.card.name)).toEqual([
      "Atraxa, Praetors' Voice",
      "Lightning Bolt",
      "Wrath",
      "Forest",
    ]);
  });
});

describe("labels", () => {
  it("names decks after the commander or the format and theme", () => {
    expect(
      defaultDeckName(
        { ...emptyState, format: commander, commander: atraxa },
        "Midrange",
        "+1/+1 counters",
      ),
    ).toBe("Atraxa +1/+1 counters");
    expect(
      defaultDeckName(
        { ...emptyState, format: format({}), theme: "typal", tribe: "Elf" },
        "Aggro",
        "Tribal / typal",
      ),
    ).toBe("Standard Aggro Elf");
  });

  it("clamps scores to a percentage", () => {
    expect(scorePercent(0.734)).toBe("73");
    expect(scorePercent(1.4)).toBe("100");
  });
});
