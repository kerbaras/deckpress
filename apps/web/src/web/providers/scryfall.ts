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
const backoff = 15_000;
const maxBackoff = 30_000;
const retries = 3;

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
  async function waitForSlot() {
    for (
      let wait = next - performance.now();
      wait > 0;
      wait = next - performance.now()
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(Math.ceil(wait), 2_147_483_647)),
      );
    }
    next = performance.now() + interval;
  }
  return function enqueue<T>(
    send: (
      defer: (delay: number) => void,
      wait: () => Promise<void>,
    ) => Promise<T>,
  ) {
    const pending = tail.then(async () => {
      await waitForSlot();
      return send((delay) => {
        next = Math.max(next, performance.now() + delay);
      }, waitForSlot);
    });
    tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
}

function retryDelay(response: Response, attempt: number) {
  const header = response.headers.get("Retry-After")?.trim();
  if (header) {
    const milliseconds = /^\d+$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - Date.now();
    if (Number.isSafeInteger(milliseconds)) return Math.max(0, milliseconds);
  }
  return Math.min(backoff * 2 ** attempt, maxBackoff);
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
      return enqueue(async (defer, wait) => {
        const headers = { Accept: "application/json" };
        const init = body
          ? {
              method: "POST",
              body,
              headers: { ...headers, "Content-Type": "application/json" },
            }
          : { headers };
        let response: Response;
        for (let attempt = 0; ; attempt++) {
          try {
            response = await fetcher(origin + path, {
              ...init,
              signal: AbortSignal.timeout(30_000),
            });
          } catch {
            throw new Error("Could not reach api.scryfall.com. Try again.");
          }
          if (response.status !== 429) break;
          defer(retryDelay(response, attempt));
          if (attempt === retries) {
            throw new Error(
              "Scryfall is still rate-limiting requests. Try again later.",
            );
          }
          await wait();
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
