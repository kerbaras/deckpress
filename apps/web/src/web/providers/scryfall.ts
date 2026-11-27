import { type SetInfo, setInfoSchema } from "../../core/sets.ts";
import {
  type DocumentStore,
  document,
  readDocument,
} from "../store/documents.ts";
import { record, recordList } from "./scryfall-card.ts";
import { scryfallQueue } from "./scryfall-queue.ts";

const origin = "https://api.scryfall.com";
export const scryfallCacheKind = "cache";
const cacheTtl = 24 * 60 * 60 * 1000;
const backoff = 15_000;
const maxBackoff = 30_000;
const retries = 3;

type Identifier =
  | { id: string }
  | { name: string; set?: string }
  | { set: string; collector_number: string };

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  background?: boolean;
}

export interface SearchOptions extends RequestOptions {
  includeMultilingual?: boolean;
}

export interface Scryfall {
  collection(ids: Identifier[]): Promise<Record<string, unknown>[]>;
  exact(
    set: string,
    collectorNumber: string,
    language: string,
    options?: RequestOptions,
  ): Promise<Record<string, unknown>>;
  printing(id: string, options?: RequestOptions): Promise<unknown>;
  sets(options?: RequestOptions): Promise<SetInfo[]>;
  search(
    query: string,
    page: number,
    options?: SearchOptions,
  ): Promise<{
    cards: Record<string, unknown>[];
    hasMore: boolean;
    total: number;
  }>;
}

function offlineError() {
  return new Error("You are offline. Reconnect to the internet and try again.");
}

function networkError() {
  return new Error(
    "Could not reach Scryfall. Check your internet connection and try again.",
  );
}

function retryDelay(response: Response | undefined, attempt: number) {
  const header = response?.headers.get("Retry-After")?.trim();
  if (header) {
    const milliseconds = /^\d+$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - Date.now();
    if (Number.isSafeInteger(milliseconds)) return Math.max(0, milliseconds);
  }
  return Math.min(backoff * 2 ** attempt, maxBackoff);
}

interface Pending {
  controller: AbortController;
  task: Promise<unknown>;
  subscribers: number;
  foreground: number;
}

export function scryfallClient(
  cache: Pick<DocumentStore, "get" | "put">,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Scryfall & {
  retry: Pick<ReturnType<typeof scryfallQueue>, "getSnapshot" | "subscribe">;
} {
  const { enqueue, defer, ...retry } = scryfallQueue();
  const pendingByKey = new Map<string, Pending>();
  let throttleUntil = 0;

  async function request(
    path: string,
    key: string,
    allowMissing: boolean,
    body: string | undefined,
    pending: Pending,
  ) {
    const hit = await cache.get(scryfallCacheKind, key).catch(() => undefined);
    const { signal: sharedSignal } = pending.controller;
    sharedSignal.throwIfAborted();
    if (hit && hit.updatedAt > Date.now() - cacheTtl) return readDocument(hit);

    const connectivity = new AbortController();
    const offline = () => connectivity.abort(offlineError());
    const signal = AbortSignal.any([sharedSignal, connectivity.signal]);
    const background = () => pending.foreground === 0;
    const headers = { Accept: "application/json" };
    const init = body
      ? {
          method: "POST",
          body,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      : { headers };
    globalThis.addEventListener("offline", offline);
    try {
      if (navigator.onLine === false) offline();
      for (let attempt = 0; ; attempt++) {
        const response = await enqueue(signal, background, async () => {
          if (navigator.onLine === false) offline();
          signal.throwIfAborted();
          let response: Response;
          try {
            response = await fetcher(origin + path, {
              ...init,
              signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            });
          } catch (error) {
            if (navigator.onLine === false) offline();
            signal.throwIfAborted();
            if (!(error instanceof TypeError)) throw networkError();
            if (performance.now() >= throttleUntil)
              return { failedAt: performance.now() };
            defer(retryDelay(undefined, attempt));
            return undefined;
          }
          if (response.status !== 429) return response;
          const delay = retryDelay(response, attempt);
          defer(delay);
          throttleUntil = performance.now() + delay + maxBackoff;
          return undefined;
        });
        if (response && !("failedAt" in response)) {
          const missing = response.status === 404 && allowMissing;
          if (!missing && !response.ok)
            throw new Error(`Scryfall returned ${response.status}. Try again.`);
          const value: unknown = missing
            ? null
            : await response.json().catch(() => {
                signal.throwIfAborted();
                throw new Error("Scryfall returned invalid JSON");
              });
          signal.throwIfAborted();
          await cache
            .put(document(scryfallCacheKind, key, value))
            .catch(() => {});
          return value;
        }

        if (response) {
          // A CORS failure can hide a 429. A short, CORS-readable probe
          // distinguishes a reachable API from a connection failure.
          await enqueue(signal, background, async () => {
            try {
              if (navigator.onLine === false) offline();
              signal.throwIfAborted();
              const probe = await fetcher(`${origin}/sets`, {
                method: "HEAD",
                cache: "no-store",
                headers,
                signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
              });
              if (!probe.ok && probe.status !== 429) throw networkError();
              const delay = retryDelay(
                probe.status === 429 ? probe : undefined,
                attempt,
              );
              defer(
                probe.status === 429 && probe.headers.has("Retry-After")
                  ? delay
                  : response.failedAt + delay - performance.now(),
              );
              if (probe.status === 429)
                throttleUntil = performance.now() + delay + maxBackoff;
            } catch {
              if (navigator.onLine === false) offline();
              signal.throwIfAborted();
              throw networkError();
            }
          });
        }
        if (attempt === retries)
          throw new Error(
            "Scryfall is still rate-limiting requests. Try again later.",
          );
      }
    } finally {
      globalThis.removeEventListener("offline", offline);
    }
  }

  async function json(
    path: string,
    allowMissing = false,
    body?: string,
    { signal, background = false }: RequestOptions = {},
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const key = body ? `${path}\n${body}` : path;
    let pending = pendingByKey.get(key);
    if (!pending) {
      const entry: Pending = {
        controller: new AbortController(),
        subscribers: 0,
        foreground: 0,
        task: Promise.resolve(),
      };
      entry.task = request(path, key, allowMissing, body, entry).finally(() => {
        if (pendingByKey.get(key) === entry) pendingByKey.delete(key);
      });
      pending = entry;
      pendingByKey.set(key, entry);
    }
    const entry = pending;
    entry.subscribers++;
    if (!background) entry.foreground++;
    return new Promise((resolve, reject) => {
      function release() {
        signal?.removeEventListener("abort", abort);
        entry.subscribers--;
        if (!background) entry.foreground--;
      }
      function abort() {
        release();
        if (entry.subscribers === 0 && pendingByKey.get(key) === entry) {
          pendingByKey.delete(key);
          entry.controller.abort();
        }
        reject(signal?.reason);
      }
      signal?.addEventListener("abort", abort, { once: true });
      void entry.task.then(
        (value) => {
          if (signal?.aborted) return;
          release();
          resolve(value);
        },
        (error: unknown) => {
          if (signal?.aborted) return;
          release();
          reject(error);
        },
      );
    });
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
    async exact(set, collectorNumber, language, options) {
      const path = [set, collectorNumber, language]
        .map(encodeURIComponent)
        .join("/");
      return record(await json(`/cards/${path}`, true, undefined, options));
    },
    printing: (id, options) =>
      json(`/cards/${encodeURIComponent(id)}`, false, undefined, options),
    async sets(options) {
      const response = record(await json("/sets", false, undefined, options));
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
    async search(query, page, options) {
      const params = new URLSearchParams({
        q: query,
        unique: "prints",
        include_multilingual: String(options?.includeMultilingual ?? true),
        order: "released",
        dir: "desc",
        page: String(page),
      });
      const result = record(
        await json(`/cards/search?${params}`, true, undefined, options),
      );
      return {
        cards: recordList(result.data),
        hasMore: result.has_more === true,
        total: typeof result.total_cards === "number" ? result.total_cards : 0,
      };
    },
  };
}
