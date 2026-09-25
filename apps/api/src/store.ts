import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Deck, deckSchema, printSettingsSchema } from "@deckpress/core";
import type { z } from "zod";
import { AppError } from "./errors.ts";

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id)) STRICT;",
    );
  }

  get<T>(kind: string, id: string, schema: z.ZodType<T>): T | null {
    const row = this.db
      .prepare("SELECT json FROM documents WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? schema.parse(JSON.parse(String(row.json))) : null;
  }

  list<T>(kind: string, schema: z.ZodType<T>): T[] {
    return this.db
      .prepare(
        "SELECT json FROM documents WHERE kind = ? ORDER BY updated_at DESC",
      )
      .all(kind)
      .map((row) => schema.parse(JSON.parse(String(row.json))));
  }

  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO documents (kind, id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(kind, id, JSON.stringify(value), Date.now());
  }

  cached(key: string): unknown {
    const row = this.db
      .prepare(
        "SELECT json FROM documents WHERE kind = 'cache' AND id = ? AND updated_at > ?",
      )
      .get(key, Date.now() - 86_400_000);
    return row ? JSON.parse(String(row.json)) : undefined;
  }

  createDeck(
    input: Pick<Deck, "name" | "format"> &
      Partial<
        Pick<Deck, "entries" | "notes" | "printSettings" | "coverEntryId">
      >,
  ): Deck {
    const now = new Date().toISOString();
    const deck = deckSchema.parse({
      id: randomUUID(),
      entries: [],
      notes: "",
      coverEntryId: "",
      printSettings: printSettingsSchema.parse({}),
      ...input,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.put("deck", deck.id, deck);
    return deck;
  }

  updateDeck(input: Deck): Deck {
    const old = this.get("deck", input.id, deckSchema);
    if (!old) throw new AppError("Deck not found", 404);
    const deck = deckSchema.parse({
      ...input,
      createdAt: old.createdAt,
      updatedAt: new Date().toISOString(),
      revision: input.revision + 1,
    });
    const result = this.db
      .prepare(
        "UPDATE documents SET json = ?, updated_at = ? WHERE kind = 'deck' AND id = ? AND json_extract(json, '$.revision') = ?",
      )
      .run(JSON.stringify(deck), Date.now(), input.id, input.revision);
    if (!result.changes)
      throw new AppError(
        "This deck changed in another tab. Reload it before saving.",
        409,
      );
    return deck;
  }

  removeDeck(id: string) {
    this.db
      .prepare("DELETE FROM documents WHERE kind = 'deck' AND id = ?")
      .run(id);
  }

  close() {
    this.db.close();
  }
}
