import { z } from "zod";
import { resolvedEntry } from "./resolve.ts";
import type { Scryfall } from "./scryfall.ts";
import { recordList, usableCard } from "./scryfall-card.ts";

const collectionBatch = 75;
const uuid = z.uuid();

export async function relatedTokens(api: Scryfall, cardIds: string[]) {
  if (cardIds.length > 1000)
    throw new Error("Decklists are limited to 1000 lines");
  if (cardIds.some((id) => !uuid.safeParse(id).success))
    throw new Error("Invalid card ID");

  async function collectionById(ids: string[]) {
    const ordered = [...new Set(ids)].sort();
    const cards: Record<string, unknown>[] = [];
    for (let offset = 0; offset < ordered.length; offset += collectionBatch) {
      cards.push(
        ...(await api.collection(
          ordered.slice(offset, offset + collectionBatch).map((id) => ({ id })),
        )),
      );
    }
    return cards;
  }

  const sources = await collectionById(cardIds);
  const ids = sources.flatMap((card) =>
    recordList(card.all_parts).flatMap((part) => {
      const qualifies =
        part.component === "token" ||
        (part.component === "combo_piece" &&
          typeof part.type_line === "string" &&
          part.type_line.startsWith("Emblem"));
      const id = uuid.safeParse(part.id);
      return qualifies && id.success ? [id.data] : [];
    }),
  );
  const seen = new Set<string>();
  return (await collectionById(ids))
    .flatMap((raw) => {
      const card = usableCard(raw);
      if (!card || seen.has(card.oracleId)) return [];
      seen.add(card.oracleId);
      return [
        resolvedEntry(crypto.randomUUID(), card, {
          quantity: 1,
          zone: "tokens",
        }),
      ];
    })
    .sort((a, b) =>
      a.card.name < b.card.name ? -1 : a.card.name > b.card.name ? 1 : 0,
    );
}
