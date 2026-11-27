import type { Scryfall } from "./scryfall.ts";

export function anyOf(terms: readonly string[]) {
  return terms.length <= 1 ? (terms[0] ?? "") : `(${terms.join(" or ")})`;
}

export async function searchBatches(
  api: Pick<Scryfall, "search">,
  terms: Iterable<string>,
  filters: readonly string[],
  visit: (cards: Record<string, unknown>[], batch: string[]) => boolean,
  batchSize = 12,
) {
  const clauses = [...new Set(terms)].sort();
  let complete = true;
  for (let start = 0; start < clauses.length; start += batchSize) {
    const batch = clauses.slice(start, start + batchSize);
    const query = [anyOf(batch), ...filters].join(" ");
    for (let page = 1; ; page++) {
      const result = await api.search(query, page);
      if (visit(result.cards, batch) || !result.hasMore) break;
      if (page === 100) {
        complete = false;
        break;
      }
    }
  }
  return complete;
}
