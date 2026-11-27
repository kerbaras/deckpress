import { createScmLayout, type Deck, deckSchema } from "../../core/index.ts";
import { type DocumentStore, document, readDocument } from "./documents.ts";

const newDeckSchema = deckSchema
  .omit({ id: true, revision: true, createdAt: true, updatedAt: true })
  .extend({
    entries: deckSchema.shape.entries.default([]),
    printSettings: deckSchema.shape.printSettings.prefault({}),
  });

function validateDeck(deck: Deck): Deck {
  if (
    deck.entries.some(
      (entry) =>
        entry.policyArt && entry.policyArt.length !== entry.card.faces.length,
    )
  ) {
    throw new Error("Policy art must match the card's faces");
  }
  if (deck.printSettings.layoutMode === "scm") {
    createScmLayout(deck.printSettings);
  }
  if (deck.missingPrints?.length === 0) delete deck.missingPrints;
  return deck;
}

export function newDeck(input: unknown, id: string, now: string): Deck {
  return validateDeck({
    ...newDeckSchema.parse(input),
    id,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  });
}

function revisedDeck(input: Deck, old: Deck, now: string): Deck {
  if (input.revision !== old.revision) {
    throw new Error("This deck changed elsewhere. Reload it before saving.");
  }
  return {
    ...input,
    createdAt: old.createdAt,
    updatedAt: now,
    revision: input.revision + 1,
  };
}

const kind = "deck";

export function deckStore(
  documents: DocumentStore,
  now = Date.now,
  newId = () => crypto.randomUUID(),
) {
  async function create(input: unknown) {
    const timestamp = now();
    const deck = newDeck(input, newId(), new Date(timestamp).toISOString());
    await documents.put(document(kind, deck.id, deck, timestamp));
    return deck;
  }

  return {
    create,
    async restore(contents: string) {
      let input: unknown;
      try {
        input = newDeckSchema.parse(JSON.parse(contents));
      } catch {
        throw new Error("Invalid deck backup");
      }
      return { deck: await create(input), updatedUploads: 0 };
    },
    async get(id: string) {
      const row = await documents.get(kind, id);
      if (!row) throw new Error("Deck not found");
      return deckSchema.parse(readDocument(row));
    },
    async list() {
      return (await documents.list(kind)).flatMap((row) => {
        const result = deckSchema.safeParse(readDocument(row));
        return result.success ? [result.data] : [];
      });
    },
    async save(value: unknown) {
      const input = validateDeck(deckSchema.parse(value));
      const saved = await documents.change(kind, input.id, (old) => {
        if (!old) throw new Error("Deck not found");
        const timestamp = now();
        return document(
          kind,
          input.id,
          revisedDeck(
            input,
            deckSchema.parse(readDocument(old)),
            new Date(timestamp).toISOString(),
          ),
          timestamp,
        );
      });
      return deckSchema.parse(readDocument(saved));
    },
    remove: (id: string) => documents.remove(kind, id),
  };
}
