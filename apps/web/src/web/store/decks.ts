import { z } from "zod";
import {
  type Art,
  createScmLayout,
  type Deck,
  type DeckEntry,
  deckSchema,
} from "../../core/index.ts";
import { type DocumentStore, document, readDocument } from "./documents.ts";
import { uploadId } from "./upload-files.ts";
import { uploadStore } from "./uploads.ts";

const newDeckSchema = deckSchema
  .omit({ id: true, revision: true, createdAt: true, updatedAt: true })
  .extend({
    entries: deckSchema.shape.entries.default([]),
    printSettings: deckSchema.shape.printSettings
      .extend({
        dpi: deckSchema.shape.printSettings.shape.dpi.default(600),
      })
      .prefault({}),
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

const backupReferences = z.object({
  entries: z
    .array(
      z.object({
        card: z.object({ faces: z.array(z.unknown()) }),
        selectedArt: z.unknown().optional(),
        selectedBack: z.unknown().optional(),
      }),
    )
    .default([]),
});
const uploadReference = z.object({
  provider: z.literal("upload"),
  imageUrl: z.string(),
  bleedMm: z.number(),
});

function references<T>(entry: {
  card: { faces: T[] };
  selectedArt?: T | null;
  selectedBack?: T | null;
}) {
  return [...entry.card.faces, entry.selectedArt, entry.selectedBack];
}

function backupBleeds(backup: unknown) {
  const bleeds = new Map<string, number>();
  for (const entry of backupReferences.parse(backup).entries) {
    for (const art of references(entry)) {
      const result = uploadReference.safeParse(art);
      if (!result.success) continue;
      const id = uploadId(result.data.imageUrl);
      if (id && !bleeds.has(id)) bleeds.set(id, result.data.bleedMm);
    }
  }
  return bleeds;
}

export function deckStore(
  documents: DocumentStore,
  now = Date.now,
  newId = () => crypto.randomUUID(),
  uploads = uploadStore(documents),
) {
  async function refresh(
    deck: Deck,
    edits = new Map<string, Art>(),
    existing = new Map<string, Promise<Art | undefined>>(),
  ): Promise<Deck> {
    async function update<T extends Art | null>(art: T): Promise<T> {
      const id = art?.provider === "upload" && uploadId(art.imageUrl);
      if (!id) return art;
      let stored = edits.get(id);
      if (!stored) {
        const pending =
          existing.get(id) ?? uploads.get(id).then((row) => row?.art);
        existing.set(id, pending);
        stored = await pending;
      }
      return stored
        ? { ...art, bleedMm: stored.bleedMm, dpi: stored.dpi }
        : art;
    }

    async function updateEntry(entry: DeckEntry) {
      const [faces, selectedArt, selectedBack] = await Promise.all([
        Promise.all(entry.card.faces.map(update)),
        update(entry.selectedArt),
        update(entry.selectedBack),
      ]);
      return {
        ...entry,
        card: { ...entry.card, faces },
        selectedArt,
        selectedBack,
      };
    }

    return {
      ...deck,
      entries: await Promise.all(deck.entries.map(updateEntry)),
    };
  }

  async function create(input: unknown) {
    const timestamp = now();
    const deck = await refresh(
      newDeck(input, newId(), new Date(timestamp).toISOString()),
    );
    await documents.put(document(kind, deck.id, deck, timestamp));
    return deck;
  }

  return {
    create,
    async restore(contents: string) {
      let backup: unknown;
      let input: ReturnType<typeof newDeckSchema.parse>;
      try {
        backup = JSON.parse(contents);
        input = newDeckSchema.parse(backup);
      } catch {
        throw new Error("Invalid deck backup");
      }
      if (
        input.entries.some((entry) =>
          [...references(entry), ...(entry.policyArt ?? [])].some(
            (art) => art?.provider === "mpc",
          ),
        )
      ) {
        throw new Error("Backups with MPC art require the desktop app.");
      }
      const timestamp = now();
      const deck = newDeck(input, newId(), new Date(timestamp).toISOString());
      const edits = await uploads.restoreBleeds(backupBleeds(backup));
      const restored = await refresh(
        deck,
        new Map(edits.map(({ row, art }) => [row.id, art])),
      );
      await documents.putMany([
        document(kind, restored.id, restored, timestamp),
        ...edits.map(({ row }) => row),
      ]);
      return { deck: restored, updatedUploads: edits.length };
    },
    async get(id: string) {
      const row = await documents.get(kind, id);
      if (!row) throw new Error("Deck not found");
      return refresh(deckSchema.parse(readDocument(row)));
    },
    async list() {
      const decks = (await documents.list(kind)).flatMap((row) => {
        const result = deckSchema.safeParse(readDocument(row));
        return result.success ? [result.data] : [];
      });
      const existing = new Map<string, Promise<Art | undefined>>();
      return Promise.all(
        decks.map((deck) => refresh(deck, undefined, existing)),
      );
    },
    async save(value: unknown) {
      const input = await refresh(validateDeck(deckSchema.parse(value)));
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
