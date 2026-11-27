import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../../packages/core/tests/fixtures/scryfall-languages.json";
import setFixture from "../../../../../packages/core/tests/fixtures/scryfall-set-families.json";
import { memoryDocuments } from "../store/memory.test-helper.ts";
import { policyProvider } from "./printings.ts";
import { scryfallClient } from "./scryfall.ts";

afterEach(() => vi.useRealTimers());

it("resumes and caches a batched search after an opaque throttle", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const fakeFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(new Response())
    .mockResolvedValueOnce(Response.json({ data: [fixture.exact_fr] }));
  const client = scryfallClient(memoryDocuments(), fakeFetch);
  const progress: (number | undefined)[] = [];
  const unsubscribe = client.retry.subscribe(() =>
    progress.push(client.retry.getSnapshot()),
  );
  const query = "(oracleid:a or oracleid:b) game:paper set:m10";
  const first = client.search(query, 1);
  const duplicate = client.search(query, 1);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(fakeFetch).toHaveBeenCalledTimes(2);
  expect(fakeFetch.mock.calls[1]?.[1]?.method).toBe("HEAD");
  expect(progress).toEqual([15]);
  await vi.advanceTimersByTimeAsync(1);
  for (const result of [first, duplicate, client.search(query, 1)]) {
    await expect(result).resolves.toMatchObject({ cards: [fixture.exact_fr] });
  }
  expect(fakeFetch).toHaveBeenCalledTimes(3);
  expect(progress).toEqual([15, undefined]);
  unsubscribe();
});

it("fails fast when the browser is online but the Scryfall probe fails", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const fakeFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new TypeError("Failed to fetch"));
  const client = scryfallClient(memoryDocuments(), fakeFetch);
  const result = expect(client.search("set:m10", 1)).rejects.toThrow(
    "Could not reach Scryfall. Check your internet connection and try again.",
  );
  await vi.advanceTimersByTimeAsync(100);
  await result;
  expect(fakeFetch).toHaveBeenCalledTimes(2);
  expect(client.retry.getSnapshot()).toBeUndefined();
});

it("caps backoff at 75 seconds for CORS-hidden collection throttles", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const starts: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.method === "HEAD") return new Response();
    expect(options?.method).toBe("POST");
    starts.push(performance.now());
    throw new TypeError("Failed to fetch");
  });
  const client = scryfallClient(memoryDocuments(), fetcher);
  const failure = expect(
    client.collection([{ name: "Sol Ring" }]),
  ).rejects.toThrow("Scryfall is still rate-limiting requests.");
  await vi.advanceTimersByTimeAsync(74_999);
  expect(starts).toEqual([0, 15_000, 45_000]);
  await vi.advanceTimersByTimeAsync(101);
  await failure;
  expect(starts).toEqual([0, 15_000, 45_000, 75_000]);
});

it("fails immediately offline, even during a shared Retry-After", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const online = vi.spyOn(navigator, "onLine", "get");
  online.mockReturnValue(true);
  const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
  const client = scryfallClient(memoryDocuments(), fetcher);
  const first = expect(client.sets()).rejects.toThrow("You are offline.");
  await vi.advanceTimersByTimeAsync(0);
  expect(client.retry.getSnapshot()).toBe(15);
  online.mockReturnValue(false);
  window.dispatchEvent(new Event("offline"));
  await first;
  await expect(client.search("set:m10", 1)).rejects.toThrow("You are offline.");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(client.retry.getSnapshot()).toBeUndefined();
});

it("preserves a shared request and its cached result when one subscriber aborts", async () => {
  const live = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<AbortSignal>();
  const fetcher = vi.fn<typeof fetch>((_, init) => {
    if (init?.signal) started.resolve(init.signal);
    return live.promise;
  });
  const store = memoryDocuments();
  const client = scryfallClient(store, fetcher);
  const preview = new AbortController();
  const first = client.search("set:m10", 1, { signal: preview.signal });
  const second = client.search("set:m10", 1, { background: true });
  const requestSignal = await started.promise;
  preview.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(requestSignal.aborted).toBe(false);
  live.resolve(Response.json({ data: [fixture.exact_fr] }));
  await expect(second).resolves.toMatchObject({ cards: [fixture.exact_fr] });
  await expect(
    scryfallClient(store, fetcher).search("set:m10", 1),
  ).resolves.toMatchObject({
    cards: [fixture.exact_fr],
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("aborts an unshared fetch and lets a fresh request use the same cache key", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      (_, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected a signal");
          started.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    )
    .mockResolvedValueOnce(Response.json({ data: [] }));
  const client = scryfallClient(memoryDocuments(), fetcher);
  const preview = new AbortController();
  const first = client.search("set:m10", 1, { signal: preview.signal });
  const requestSignal = await started.promise;
  preview.abort();
  const replacement = client.search("set:m10", 1);
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(requestSignal.aborted).toBe(true);
  await expect(replacement).resolves.toMatchObject({ cards: [] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("starts a queued preview before retrying a throttled suggestion", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const starts: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    starts.push(new URL(String(url)).searchParams.get("q") ?? "");
    return starts.length === 1
      ? new Response(null, { status: 429 })
      : Response.json({ data: [] });
  });
  const client = scryfallClient(memoryDocuments(), fetcher);
  const suggestion = client.search("suggestions", 1, { background: true });
  await vi.advanceTimersByTimeAsync(0);
  const preview = client.search("preview", 1);
  await vi.advanceTimersByTimeAsync(15_100);
  await Promise.all([suggestion, preview]);
  expect(starts).toEqual(["suggestions", "preview", "suggestions"]);
});

it("honors Retry-After before retrying a throttled search and caches the result", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const fakeFetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [fixture.exact_fr] })),
    );
  const client = scryfallClient(memoryDocuments(), fakeFetch);
  const pending = client.search("set:m10", 1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fakeFetch).toHaveBeenCalledTimes(1);
  expect(client.retry.getSnapshot()).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ cards: [fixture.exact_fr] });
  expect(client.retry.getSnapshot()).toBeUndefined();
  await expect(client.search("set:m10", 1)).resolves.toMatchObject({
    cards: [fixture.exact_fr],
  });
  expect(fakeFetch).toHaveBeenCalledTimes(2);
});

it("fails a headerless throttle after 75 seconds of backoff", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const starts: number[] = [];
  const fakeFetch = vi.fn(async () => {
    starts.push(performance.now());
    return new Response(null, { status: 429 });
  });
  const client = scryfallClient(memoryDocuments(), fakeFetch);
  const failure = expect(client.search("set:m10", 1)).rejects.toThrow(
    "Scryfall is still rate-limiting requests. Try again later.",
  );
  await vi.advanceTimersByTimeAsync(74_999);
  expect(starts).toEqual([0, 15_000, 45_000]);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(starts).toEqual([0, 15_000, 45_000, 75_000]);
});

it("serializes requests, spaces their starts by 100 ms, and uses cached responses including 404", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const starts: number[] = [];
  const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
    starts.push(performance.now());
    return String(url).endsWith("/es")
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify(fixture.exact_fr));
  });
  const store = memoryDocuments();
  const client = scryfallClient(store, fakeFetch);
  const first = client.exact("m10", "146", "es");
  const second = client.exact("m10", "146", "fr");
  await vi.advanceTimersByTimeAsync(99);
  expect(starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(first).resolves.toEqual({});
  await expect(second).resolves.toEqual(fixture.exact_fr);
  const restarted = scryfallClient(store, fakeFetch);
  await expect(restarted.exact("m10", "146", "es")).resolves.toEqual({});
  await expect(restarted.exact("m10", "146", "fr")).resolves.toEqual(
    fixture.exact_fr,
  );
  expect(starts).toEqual([0, 100]);
});

it("loads and caches the shared Scryfall set catalog", async () => {
  const fakeFetch = vi.fn(async () => Response.json(setFixture));
  const store = memoryDocuments();
  const client = scryfallClient(store, fakeFetch);
  const sets = await client.sets();
  expect(sets.find(({ code }) => code === "fdc")).toMatchObject({
    code: "fdc",
    name: "Foundations Commander",
    setType: "commander",
    parentSetCode: "fdn",
  });
  expect(sets.find(({ code }) => code === "fdn")?.parentSetCode).toBeNull();
  await expect(scryfallClient(store, fakeFetch).sets()).resolves.toEqual(sets);
  expect(fakeFetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.scryfall.com/sets",
    expect.anything(),
  );
});

it("batches suggestions with only non-promo paper family sets and one language per printing", async () => {
  const urls: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    urls.push(new URL(String(url)));
    return Response.json({ data: [], has_more: urls.length === 1 });
  });
  const client = scryfallClient(memoryDocuments(), fetcher);
  const ids = Array.from({ length: 19 }, () => crypto.randomUUID());
  await policyProvider(client).coverageInventory([...ids, ids[0] ?? ""]);
  expect(urls.map((url) => url.searchParams.get("page"))).toEqual([
    "1",
    "2",
    "1",
  ]);
  expect(
    urls.map((url) => url.searchParams.get("q")?.match(/oracleid:/g)?.length),
  ).toEqual([18, 18, 1]);
  for (const { searchParams } of urls) {
    expect(searchParams.get("q")).toContain(
      "game:paper -is:promo (st:expansion or st:core or st:commander or st:token)",
    );
    expect(searchParams.get("include_multilingual")).toBe("false");
  }
});
