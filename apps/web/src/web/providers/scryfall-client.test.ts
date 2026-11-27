import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../../packages/core/tests/fixtures/scryfall-languages.json";
import { memoryDocuments } from "../store/memory.test-helper.ts";
import { scryfallClient } from "./scryfall.ts";

afterEach(() => vi.useRealTimers());

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
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ cards: [fixture.exact_fr] });
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
