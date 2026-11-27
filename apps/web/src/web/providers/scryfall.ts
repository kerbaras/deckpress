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
const backoff = 15_000;
const maxBackoff = 30_000;
const opaqueBackoff = 60_000;
const retries = 3;

type Identifier =
  | { id: string }
  | { name: string; set?: string }
  | { set: string; collector_number: string };

export class ScryfallHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Scryfall returned ${status}. Try again.`);
    this.status = status;
  }
}

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
    unique?: "cards" | "prints",
  ): Promise<{
    cards: Record<string, unknown>[];
    hasMore: boolean;
    total: number;
  }>;
}

function rateLimiter() {
  let tail = Promise.resolve();
  let next = 0;
  let retryAfterSeconds: number | undefined;
  const listeners = new Set<() => void>();

  function reportRetry(seconds: number | undefined) {
    if (retryAfterSeconds === seconds) return;
    retryAfterSeconds = seconds;
    for (const listener of listeners) listener();
  }

  async function waitForSlot() {
    const delay = next - performance.now();
    if (delay > interval) reportRetry(Math.ceil(delay / 1000));
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
    reportRetry(undefined);
  }

  function enqueue<T>(
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
  }
  return {
    enqueue,
    getSnapshot: () => retryAfterSeconds,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
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
) {
  const { enqueue, ...retry } = rateLimiter();
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
        let response: Response | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            response = await fetcher(origin + path, {
              ...init,
              signal: AbortSignal.timeout(30_000),
            });
          } catch (error) {
            // Scryfall's throttled responses can omit CORS headers.
            if (!(error instanceof TypeError))
              throw new Error("Could not reach api.scryfall.com. Try again.");
            response = undefined;
          }
          if (response && response.status !== 429) break;
          defer(response ? retryDelay(response, attempt) : opaqueBackoff);
          if (attempt === retries) {
            throw new Error(
              response
                ? "Scryfall is still rate-limiting requests. Try again later."
                : "Scryfall could not be reached after retrying. It may be rate limiting requests. Try again later.",
            );
          }
          await wait();
        }
        const missing = response.status === 404 && allowMissing;
        if (!missing && !response.ok) {
          throw new ScryfallHttpError(response.status);
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
    retry,
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
    async search(query, page, unique = "prints") {
      const params = new URLSearchParams({
        q: query,
        unique,
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
  } satisfies Scryfall & { retry: typeof retry };
}
