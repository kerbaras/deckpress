import { type SetInfo, setInfoSchema } from "../../core/sets.ts";
import {
  type DocumentStore,
  document,
  readDocument,
} from "../store/documents.ts";
import { record, recordList } from "./scryfall-card.ts";

const origin = "https://api.scryfall.com";
export const scryfallCacheKind = "cache";
const cacheTtl = 24 * 60 * 60 * 1000;
const interval = 100;
const backoff = 30_000;

type Identifier =
  | { id: string }
  | { name: string; set?: string }
  | { set: string; collector_number: string };

export interface Scryfall {
  collection(ids: Identifier[]): Promise<Record<string, unknown>[]>;
  exact(
    set: string,
    collectorNumber: string,
    language: string,
  ): Promise<Record<string, unknown>>;
  printing(id: string): Promise<unknown>;
  sets(): Promise<SetInfo[]>;
  search(
    query: string,
    page: number,
  ): Promise<{
    cards: Record<string, unknown>[];
    hasMore: boolean;
    total: number;
  }>;
}

function rateLimiter() {
  let tail = Promise.resolve();
  let next = 0;
  return function enqueue<T>(send: (defer: () => void) => Promise<T>) {
    const pending = tail.then(async () => {
      const wait = next - performance.now();
      if (wait > 0)
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait)));
      next = performance.now() + interval;
      return send(() => {
        next = performance.now() + backoff;
      });
    });
    tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
}

export function scryfallClient(
  cache: Pick<DocumentStore, "get" | "put">,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Scryfall {
  const enqueue = rateLimiter();
  const pendingByKey = new Map<string, Promise<unknown>>();

  function json(
    path: string,
    allowMissing = false,
    body?: string,
  ): Promise<unknown> {
    const key = body ? `${path}\n${body}` : path;
    const pending = pendingByKey.get(key);
    if (pending) return pending;
    const task = (async () => {
      const hit = await cache
        .get(scryfallCacheKind, key)
        .catch(() => undefined);
      if (hit && hit.updatedAt > Date.now() - cacheTtl) {
        return readDocument(hit);
      }
      return enqueue(async (defer) => {
        const headers = { Accept: "application/json" };
        const init = body
          ? {
              method: "POST",
              body,
              headers: { ...headers, "Content-Type": "application/json" },
            }
          : { headers };
        let response: Response;
        try {
          response = await fetcher(origin + path, {
            ...init,
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          throw new Error("Could not reach api.scryfall.com. Try again.");
        }
        if (response.status === 429) {
          defer();
          throw new Error(
            "Scryfall is rate-limiting requests. Wait 30 seconds and try again.",
          );
        }
        const missing = response.status === 404 && allowMissing;
        if (!missing && !response.ok) {
          throw new Error(`Scryfall returned ${response.status}. Try again.`);
        }
        const value: unknown = missing
          ? null
          : await response.json().catch(() => {
              throw new Error("Scryfall returned invalid JSON");
            });
        await cache
          .put(document(scryfallCacheKind, key, value))
          .catch(() => {});
        return value;
      });
    })().finally(() => pendingByKey.delete(key));
    pendingByKey.set(key, task);
    return task;
  }

  return {
    async collection(identifiers) {
      const response = record(
        await json("/cards/collection", false, JSON.stringify({ identifiers })),
      );
      if (!Array.isArray(response.data))
        throw new Error("Unexpected Scryfall collection data");
      return recordList(response.data);
    },
    async exact(set, collectorNumber, language) {
      const path = [set, collectorNumber, language]
        .map(encodeURIComponent)
        .join("/");
      return record(await json(`/cards/${path}`, true));
    },
    printing: (id) => json(`/cards/${encodeURIComponent(id)}`),
    async sets() {
      const response = record(await json("/sets"));
      if (!Array.isArray(response.data))
        throw new Error("Unexpected Scryfall set catalog data");
      return recordList(response.data).map((set) =>
        setInfoSchema.parse({
          code: set.code,
          name: set.name,
          setType: set.set_type,
          parentSetCode: set.parent_set_code ?? null,
          digital: set.digital,
          releasedAt: set.released_at,
          iconSvgUri: set.icon_svg_uri,
          cardCount: set.card_count,
        }),
      );
    },
    async search(query, page) {
      const params = new URLSearchParams({
        q: query,
        unique: "prints",
        include_multilingual: "true",
        order: "released",
        dir: "desc",
        page: String(page),
      });
      const result = record(await json(`/cards/search?${params}`, true));
      return {
        cards: recordList(result.data),
        hasMore: result.has_more === true,
        total: typeof result.total_cards === "number" ? result.total_cards : 0,
      };
    },
  };
}
