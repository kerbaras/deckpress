import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../../packages/core/tests/fixtures/scryfall-languages.json";
import setFixture from "../../../../../packages/core/tests/fixtures/scryfall-set-families.json";
import { memoryDocuments } from "../store/memory.test-helper.ts";
import { scryfallClient } from "./scryfall.ts";

afterEach(() => vi.useRealTimers());

it("resumes and caches a batched search after an opaque throttle", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const fakeFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(Response.json({ data: [fixture.exact_fr] }));
  const client = scryfallClient(memoryDocuments(), fakeFetch);
  const progress: (number | undefined)[] = [];
  const unsubscribe = client.retry.subscribe(() =>
    progress.push(client.retry.getSnapshot()),
  );
  const query = "(oracleid:a or oracleid:b) game:paper set:m10";
  const first = client.search(query, 1);
  const duplicate = client.search(query, 1);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(fakeFetch).toHaveBeenCalledTimes(1);
  expect(progress).toEqual([60]);
  await vi.advanceTimersByTimeAsync(1);
  for (const result of [first, duplicate, client.search(query, 1)]) {
    await expect(result).resolves.toMatchObject({ cards: [fixture.exact_fr] });
  }
  expect(fakeFetch).toHaveBeenCalledTimes(2);
  expect(progress).toEqual([60, undefined]);
  unsubscribe();
});

it("stops retrying opaque failures and returns an actionable error", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "Date"] });
  const fakeFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new TypeError("Failed to fetch"));
  const client = scryfallClient(memoryDocuments(), fakeFetch);
  const result = expect(client.search("set:m10", 1)).rejects.toThrow(
    "Scryfall could not be reached after retrying. It may be rate limiting requests.",
  );
  await vi.advanceTimersByTimeAsync(180_000);
  await result;
  expect(fakeFetch).toHaveBeenCalledTimes(4);
  expect(client.retry.getSnapshot()).toBeUndefined();
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
