import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import type { DeckEntry } from "./core/index.ts";

export function useScryfallPrints(
  card: DeckEntry["card"],
  face: number,
  language: string,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: ["art", "scryfall", card.oracleId, face, language],
    queryFn: ({ pageParam, signal }) =>
      api.art(
        "scryfall",
        card.oracleId,
        card.name,
        face,
        pageParam,
        signal,
        language || undefined,
      ),
    initialPageParam: 1,
    getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
    enabled,
    staleTime: 86_400_000,
    retry: false,
  });
}
