import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../../packages/core/tests/fixtures/scryfall-languages.json";
import setFixture from "../../../../../packages/core/tests/fixtures/scryfall-set-families.json";
import { memoryDocuments } from "../store/memory.test-helper.ts";
import { scryfallClient } from "./scryfall.ts";

afterEach(() => vi.useRealTimers());

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
