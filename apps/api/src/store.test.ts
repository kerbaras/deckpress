import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deckSchema } from "@deckpress/core";
import { expect, it } from "vitest";
import { Store } from "./store.ts";

it("persists deck updates across restarts and rejects stale overwrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deckpress-store-"));
  const path = join(dir, "test.sqlite");
  const store = new Store(path);
  const deck = store.createDeck({ name: "Boros Burn", format: "Modern" });
  const updated = store.updateDeck({ ...deck, name: "Burn v2" });
  expect(() => store.updateDeck(deck)).toThrow(/another tab/);
  store.close();
  const reopened = new Store(path);
  try {
    expect(reopened.get("deck", deck.id, deckSchema)).toEqual(updated);
    reopened.removeDeck(deck.id);
    expect(reopened.list("deck", deckSchema)).toEqual([]);
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});
