import { expect, it } from "vitest";
import backup from "../../../../../packages/core/tests/fixtures/deck-backup-before-board-names.json";
import { deckStore } from "./decks.ts";
import { memoryDocuments } from "./memory.test-helper.ts";
import { exportFileName, settingsStore } from "./settings.ts";

const time = 1_800_000_000_000;
const id = "3aa57318-68b9-45ed-b289-f085f8202184";
const input = { name: "  Example   ", format: "Modern" };

it("creates a deck at 600 DPI, trims its name and persists a JSON document", async () => {
  const documents = memoryDocuments();
  const decks = deckStore(
    documents,
    () => time,
    () => id,
  );
  expect(await decks.list()).toEqual([]);
  const created = await decks.create(input);
  expect(created).toMatchObject({
    id,
    name: "Example",
    notes: "",
    entries: [],
    revision: 0,
    createdAt: new Date(time).toISOString(),
    updatedAt: new Date(time).toISOString(),
    printSettings: { paper: "a4", dpi: 600, cardWidthMm: 63, cardHeightMm: 88 },
  });
  expect(await deckStore(documents).get(id)).toEqual(created);
  await expect(decks.create({ ...input, name: "   " })).rejects.toThrow();
});

it("atomically rejects stale saves and preserves creation time", async () => {
  let now = time;
  const decks = deckStore(
    memoryDocuments(),
    () => now,
    () => id,
  );
  const original = await decks.create(input);
  now += 1000;
  const saved = await decks.save({
    ...original,
    name: " Updated  ",
    createdAt: new Date(now).toISOString(),
  });
  expect(saved).toMatchObject({
    name: "Updated",
    createdAt: original.createdAt,
    updatedAt: new Date(now).toISOString(),
    revision: 1,
  });
  await expect(decks.save(original)).rejects.toThrow(
    "This deck changed elsewhere",
  );
  expect(await decks.list()).toEqual([saved]);
  await decks.remove(id);
  await expect(decks.get(id)).rejects.toThrow("Deck not found");
  await expect(decks.save(saved)).rejects.toThrow("Deck not found");
});

it("restores an older Rust backup as a new deck and preserves its DPI", async () => {
  const decks = deckStore(
    memoryDocuments(),
    () => time,
    () => id,
  );
  const restored = await decks.restore(JSON.stringify(backup));
  expect(restored).toMatchObject({
    updatedUploads: 0,
    deck: { id, name: backup.name, revision: 0, entries: [{ quantity: 2 }] },
  });
  await expect(decks.restore("{")).rejects.toThrow("Invalid deck backup");
  const explicit = {
    ...backup,
    printSettings: { ...restored.deck.printSettings, dpi: 800 },
  };
  expect(
    (await decks.restore(JSON.stringify(explicit))).deck.printSettings.dpi,
  ).toBe(800);
  const uploads = structuredClone(restored.deck);
  const first = uploads.entries[0];
  const front = first?.card.faces[0];
  if (!first || !front)
    throw new Error("Backup fixture requires a front image");
  first.selectedArt = { ...front, provider: "mpc" };
  await expect(decks.restore(JSON.stringify(uploads))).rejects.toThrow(
    "Backups with MPC art",
  );
});

it("stores preferences, including ordered languages and normalized art labels", async () => {
  const documents = memoryDocuments();
  const decks = deckStore(
    documents,
    () => time,
    () => id,
  );
  const settings = settingsStore(documents, decks.list);
  expect(await settings.printLanguage()).toEqual({
    languages: ["en"],
    policy: "fallback-to-english",
  });
  await decks.restore(JSON.stringify(backup));
  const deck = await decks.get(id);
  const artId = deck.entries[0]?.card.faces[0]?.id ?? "";
  expect(
    await settings.savePreference(artId, {
      tags: [" warm ", "", "warm"],
      rating: 4,
    }),
  ).toEqual({
    tags: ["warm"],
    rating: 4,
    favorite: false,
  });
  expect(await settings.preferences()).toMatchObject({
    preferences: { [artId]: { tags: ["warm"], rating: 4 } },
    usage: { [artId]: 2 },
  });
  const choice = { languages: ["es", "fr"], policy: "strict" };
  await expect(settings.savePrintLanguage(choice)).resolves.toEqual(choice);
  await expect(
    settings.savePrintLanguage({ ...choice, languages: ["es", "es"] }),
  ).rejects.toThrow("without duplicates");
  await expect(
    settings.savePrintLanguage({ ...choice, languages: [] }),
  ).rejects.toThrow("at least one");
  expect(await settingsStore(documents, decks.list).printLanguage()).toEqual(
    choice,
  );
  await expect(settings.saveAppearance("dark")).resolves.toBeNull();
  expect(await documents.get("settings", "appearance")).toHaveProperty(
    "json",
    '"dark"',
  );
});

it("creates, updates, and deletes printer profiles", async () => {
  const settings = settingsStore(memoryDocuments(), async () => []);
  const input = {
    name: "  My printer ",
    backOffsetXmm: 0.5,
    backOffsetYmm: 0,
    backRotationDeg: 0,
  };
  expect(await settings.profiles()).toEqual([]);
  const profile = await settings.saveProfile(null, input);
  expect(profile.name).toBe("My printer");
  await expect(
    settings.saveProfile(profile.id, { ...input, backOffsetXmm: 11 }),
  ).rejects.toThrow();
  await settings.saveProfile(profile.id, { ...input, backOffsetYmm: 1 });
  expect(await settings.profiles()).toMatchObject([
    { id: profile.id, backOffsetYmm: 1 },
  ]);
  await settings.removeProfile(profile.id);
  await expect(settings.saveProfile(profile.id, input)).rejects.toThrow(
    "Printer profile not found",
  );
});

it("matches the byte-capped Rust export stem rule", () => {
  expect(exportFileName(" Deck // Test! ", ".xml")).toBe("Deck----Test.xml");
  expect(exportFileName("!?👋", ".xml")).toBe("deck.xml");
  expect(exportFileName(`${"あ".repeat(49)} ! あ`, ".xml")).toBe(
    `${"あ".repeat(49)}.xml`,
  );
});
