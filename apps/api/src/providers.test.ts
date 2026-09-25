import { expect, it, vi } from "vitest";
import { validateImageUrl } from "./images.ts";
import { normalizeScryfall, Providers } from "./providers.ts";
import { Store } from "./store.ts";

const rawCard = (name: string, id: string, collector: string) => ({
  id,
  oracle_id: id,
  name,
  set: "tst",
  set_name: "Test set",
  collector_number: collector,
  image_uris: {
    png: `https://cards.scryfall.io/${id}.png`,
    normal: `https://cards.scryfall.io/${id}.jpg`,
  },
});

it("maps collection results by identifier, not response order, and caches repeated requests", async () => {
  const store = new Store(":memory:");
  const first = rawCard("Island", "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240", "1");
  const second = rawCard(
    "Mountain",
    "15d325d4-8b31-4b71-b9b7-a55ecbb39a5c",
    "2",
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ data: [second, first] }));
  const providers = new Providers(store, fetcher, 0);
  try {
    const list = "2 Island (TST) 1\n3 Mountain (TST) 2\n1 Missing";
    const result = await providers.resolve(list);
    expect(
      result.entries.map((entry) => [entry.card.name, entry.quantity]),
    ).toEqual([
      ["Island", 2],
      ["Mountain", 3],
    ]);
    expect(result.issues[0]?.input).toBe("1 Missing");
    await providers.resolve(list);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
  }
});

it("keeps both faces for double-faced cards", () => {
  const { image_uris: _, ...raw } = rawCard(
    "Day // Night",
    "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240",
    "1",
  );
  const card = normalizeScryfall({
    ...raw,
    card_faces: [
      { name: "Day", image_uris: { png: "https://cards.scryfall.io/day.png" } },
      {
        name: "Night",
        image_uris: { png: "https://cards.scryfall.io/night.png" },
      },
    ],
  });
  expect(card.faces.map((face) => face.name)).toEqual(["Day", "Night"]);
  expect(card.faces[0]?.backImageUrl).toBe(card.faces[1]?.imageUrl);
});

it.each([
  "http://127.0.0.1/private",
  "https://cards.scryfall.io.evil.test/a",
  "https://user:pass@cards.scryfall.io/a",
  "https://cards.scryfall.io:8443/a",
  "file:///etc/passwd",
])("rejects unsafe image URL %s", (url) => {
  expect(() => validateImageUrl(url)).toThrow();
});
