import { expect, it, vi } from "vitest";
import delver from "../../../../../packages/core/tests/fixtures/scryfall-art-policy-dfc.json";
import fixture from "../../../../../packages/core/tests/fixtures/scryfall-languages.json";
import type { ImportLine } from "../../core/index.ts";
import { betterScan, searchArt } from "./art.ts";
import { policyProvider } from "./printings.ts";
import { resolveCards } from "./resolve.ts";
import { type Scryfall, scryfallClient } from "./scryfall.ts";
import { normalizeScryfall } from "./scryfall-card.ts";
import { relatedTokens } from "./tokens.ts";

const printLine: ImportLine = {
  name: "Lightning Bolt",
  quantity: 1,
  zone: "main",
  set: "m11",
  collectorNumber: "149",
};
const spanish = { languages: ["es"], policy: "strict" } as const;
const emptyPage = { cards: [], hasMore: false, total: 0 };

function mockScryfall(overrides: Partial<Scryfall> = {}): Scryfall {
  return {
    collection: async () => [],
    exact: async () => ({}),
    search: async () => emptyPage,
    printing: async () => undefined,
    sets: async () => [],
    ...overrides,
  };
}

it("batches distinct oracle IDs, pages each group and preserves its family and language filters", async () => {
  const ids = Array.from({ length: 19 }, () => crypto.randomUUID()).sort();
  const first = ids[0];
  const last = ids.at(-1);
  if (!first || !last) throw new Error("Invalid test IDs");
  const search = vi.fn(async (query: string, page: number) => {
    const id = query.includes(first) ? first : last;
    return {
      cards: [{ ...delver[0], oracle_id: id, lang: "en" }],
      hasMore: id === first && page === 1,
      total: 1,
    };
  });
  const onProgress = vi.fn();
  const prints = await policyProvider(mockScryfall({ search })).inventoryBatch(
    [...ids, first, "invalid"],
    "en",
    ["ecc", "ecl", "tecc"],
    { onProgress },
  );
  expect(search.mock.calls.map(([, page]) => page)).toEqual([1, 2, 1]);
  expect(
    search.mock.calls.map(([query]) => query.match(/oracleid:/g)?.length),
  ).toEqual([18, 18, 1]);
  for (const [query] of search.mock.calls)
    expect(query).toContain(
      "game:paper (set:ecc or set:ecl or set:tecc) lang:en",
    );
  expect(prints.get(first)).toHaveLength(2);
  expect(prints.get(last)).toHaveLength(1);
  expect(onProgress.mock.calls).toEqual([
    [0, 19],
    [18, 19],
    [19, 19],
  ]);
});

it("maps double-faced scans, Scryfall metadata and placeholder errors", () => {
  const card = normalizeScryfall(delver[0]);
  expect(card.faces).toHaveLength(2);
  expect(card.faces[0]).toMatchObject({
    id: `scryfall:${card.id}:0`,
    artist: "Nils Hamm",
    scanQuality: "highres_scan",
    illustrationId: "1c2fee9b-89ea-4ab1-a751-451c3cd65a88",
    backImageUrl: card.faces[1]?.imageUrl,
    tags: ["sunmoondfc"],
  });
  expect(() => normalizeScryfall(fixture.placeholder_exact_es)).toThrow(
    "no usable scan",
  );
  expect(() => normalizeScryfall({})).toThrow("Unexpected Scryfall card data");
});

it("batches full-name fallback across collection batches without substituting a different split card", async () => {
  const [englishDelver] = delver;
  if (!englishDelver) throw new Error("Missing English print in fixture");
  const print = (name: string, set = "m11") => ({
    ...fixture.usable_exact_en,
    name,
    set,
  });
  const fire = { ...print("Fire // Ice", "mh2"), collector_number: "290" };
  const collection = vi
    .fn<Scryfall["collection"]>()
    .mockResolvedValueOnce([
      englishDelver,
      print("Bind"),
      print("Lightning Bolt"),
    ])
    .mockResolvedValueOnce([print("Armed")]);
  const search = vi.fn(async () => ({
    ...emptyPage,
    cards: [
      print("Bind // Liberate", "cmb2"),
      print("Armed // Dangerous", "dgm"),
      fire,
    ],
  }));
  const line = (
    name: string,
    set = "",
    zone: ImportLine["zone"] = "main",
  ): ImportLine => ({
    name,
    set,
    zone,
    quantity: 2,
    collectorNumber: "",
  });
  const first = [
    line("Delver of Secrets"),
    line("Bind // Liberate"),
    { ...line("Fire/Ice"), collectorNumber: "290" },
    ...Array.from({ length: 72 }, () => line("Lightning Bolt")),
  ];
  const second = [
    line("Armed // Dangerous"),
    line("Fire & Ice", "mh2", "side"),
    line("Fire & Wrong Face"),
  ];
  const result = await resolveCards(
    mockScryfall({ collection, search }),
    [...first, ...second],
    {
      languages: ["en"],
      policy: "strict",
    },
  );
  expect(collection.mock.calls).toEqual([
    [
      [
        { name: "Delver of Secrets" },
        { name: "Bind" },
        { name: "Fire/Ice" },
        ...Array.from({ length: 72 }, () => ({ name: "Lightning Bolt" })),
      ],
    ],
    [
      [
        { name: "Armed" },
        { name: "Fire & Ice", set: "mh2" },
        { name: "Fire & Wrong Face" },
      ],
    ],
  ]);
  expect(search.mock.calls).toEqual([
    [
      '((!"Armed // Dangerous") or (!"Bind // Liberate") or (!"Fire // Ice" cn="290")) include:extras',
      1,
      { unique: "cards" },
    ],
    [
      '((!"Fire // Ice" set:mh2) or (!"Fire // Wrong Face")) include:extras',
      1,
      { unique: "cards" },
    ],
  ]);
  expect(result.entries.slice(0, 3)).toMatchObject([
    { card: { name: "Delver of Secrets // Insectile Aberration" } },
    { card: { name: "Bind // Liberate" } },
    { card: { name: "Fire // Ice" } },
  ]);
  expect(result.entries.slice(-2)).toMatchObject([
    { card: { name: "Armed // Dangerous" } },
    { card: { name: "Fire // Ice" }, quantity: 2, zone: "side" },
  ]);
  expect(result.issues).toMatchObject([
    { line: 78, input: "2 Fire & Wrong Face", kind: "notFound" },
  ]);
});

it.each([400, 404])(
  "keeps Fire & Ice and reports 20 row misses when another fallback gets HTTP %i",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const { pathname, searchParams } = new URL(String(input));
      if (pathname === "/cards/collection") return Response.json({ data: [] });
      if (!searchParams.get("q")?.includes("Fire // Ice"))
        return Response.json({ object: "error" }, { status });
      return Response.json({
        data: [{ ...fixture.usable_exact_en, name: "Fire // Ice" }],
        has_more: true,
        next_page: "https://api.scryfall.com/cards/search?page=2",
        total_cards: 1,
      });
    });
    const lines: ImportLine[] = [
      "Fire & Ice",
      ...Array.from({ length: 20 }, (_, i) => `ZZ Test ${i}/Miss`),
    ].map((name) => ({
      name,
      quantity: 1,
      zone: "main",
      set: "",
      collectorNumber: "",
    }));
    const api = scryfallClient(
      { get: async () => undefined, put: async () => {} },
      fetcher,
    );
    const result = await resolveCards(api, lines, {
      languages: ["en"],
      policy: "strict",
    });
    expect(
      fetcher.mock.calls.map(([input, init]) => {
        const { pathname, searchParams } = new URL(String(input));
        if (pathname === "/cards/collection") return [pathname, init?.method];
        return [
          pathname,
          searchParams.get("q")?.match(/!"/g)?.length,
          searchParams.get("page"),
          searchParams.get("unique"),
        ];
      }),
    ).toEqual([
      ["/cards/collection", "POST"],
      ["/cards/search", 19, "1", "cards"],
      ["/cards/search", 2, "1", "cards"],
    ]);
    expect(result.entries).toMatchObject([{ card: { name: "Fire // Ice" } }]);
    expect(result.issues).toMatchObject(
      lines.slice(1).map(({ name }, i) => ({
        line: i + 2,
        input: `1 ${name}`,
        kind: "notFound",
      })),
    );
  },
);

it.each([
  { set: "mh2", prefix: "", lengths: [9, 9, 3] },
  { set: "", prefix: "é".repeat(50), lengths: [5, 5, 5, 5, 1] },
])(
  "budgets fallback filters and encoded URL length ($lengths)",
  async ({ set, prefix, lengths }) => {
    const search = vi.fn<Scryfall["search"]>(async () => emptyPage);
    const lines: ImportLine[] = Array.from({ length: 21 }, (_, i) => ({
      name: `${prefix}${i}/Miss`,
      quantity: 1,
      zone: "main",
      set,
      collectorNumber: "",
    }));
    const result = await resolveCards(mockScryfall({ search }), lines, {
      languages: ["en"],
      policy: "strict",
    });
    expect(result.issues).toHaveLength(21);
    expect(
      search.mock.calls.map(([query, page, options]) => {
        expect(
          new URLSearchParams({ q: query }).toString().length,
        ).toBeLessThanOrEqual(1700);
        expect(
          query.match(/!"|set:|include:extras/g)?.length,
        ).toBeLessThanOrEqual(20);
        expect([page, options]).toEqual([1, { unique: "cards" }]);
        return query.match(/!"/g)?.length;
      }),
    ).toEqual(lengths);
  },
);

it("keeps literal slash and ampersand names and prefers a full match over another row's face", async () => {
  const bolt = fixture.usable_exact_en;
  const split = {
    ...bolt,
    name: "Bind // Liberate",
    set: "cmb2",
    collector_number: "88",
    card_faces: [{ name: "Bind" }, { name: "Liberate" }],
  };
  const collection = vi.fn(async () => [
    split,
    { ...bolt, name: "Bind" },
    { ...bolt, name: "Summon: Choco/Mog" },
    { ...bolt, name: "Krang & Shredder" },
  ]);
  const search = vi.fn(async () => emptyPage);
  const input = [
    {
      ...printLine,
      name: "Bind // Liberate",
      set: "cmb2",
      collectorNumber: "88",
    },
    ...["Bind", "Summon: Choco/Mog", "Krang & Shredder"].map((name) => ({
      ...printLine,
      name,
      set: "",
      collectorNumber: "",
    })),
  ];
  const result = await resolveCards(
    mockScryfall({ collection, search }),
    input,
    {
      languages: ["en"],
      policy: "strict",
    },
  );
  expect(collection).toHaveBeenCalledExactlyOnceWith([
    { set: "cmb2", collector_number: "88" },
    { name: "Bind" },
    { name: "Summon: Choco/Mog" },
    { name: "Krang & Shredder" },
  ]);
  expect(search).not.toHaveBeenCalled();
  expect(result.entries.map(({ card }) => card.name)).toEqual(
    input.map(({ name }) => name),
  );
  expect(result.issues).toEqual([]);
});

it("resolves both Spanish split faces and batches localization after a front-face collision", async () => {
  const fireOracle = "00000000-0000-4000-8000-000000000001";
  const bindOracle = "00000000-0000-4000-8000-000000000002";
  const fire = {
    ...fixture.usable_exact_en,
    name: "Fire // Ice",
    oracle_id: fireOracle,
  };
  const fuego = {
    ...fire,
    lang: "es",
    card_faces: [
      { name: "Fire", printed_name: "Fuego" },
      { name: "Ice", printed_name: "Hielo" },
    ],
  };
  const bind = {
    ...fixture.usable_exact_en,
    name: "Bind // Liberate",
    oracle_id: bindOracle,
    card_faces: [{ name: "Bind" }, { name: "Liberate" }],
  };
  const collection = vi.fn(async () => [
    fire,
    { ...fixture.usable_exact_en, name: "Bind" },
    {
      ...fuego,
      name: "Fire // Heat",
      card_faces: [
        { name: "Fire", printed_name: "Fuego" },
        { name: "Heat", printed_name: "Calor" },
      ],
    },
  ]);
  const search = vi.fn(async (query: string) => ({
    ...emptyPage,
    cards: query.endsWith("include:extras") ? [bind, fuego] : [fuego],
  }));
  const input = ["Fire // Ice", "Fuego // Hielo", "Bind // Liberate"].map(
    (name) => ({ ...printLine, name, set: "", collectorNumber: "" }),
  );

  const result = await resolveCards(
    mockScryfall({ collection, search }),
    input,
    {
      languages: ["es"],
      policy: "fallback-to-english",
    },
  );

  expect(collection).toHaveBeenCalledExactlyOnceWith([
    { name: "Fire" },
    { name: "Fuego" },
    { name: "Bind" },
  ]);
  expect(search.mock.calls).toEqual([
    [
      '((!"Bind // Liberate") or (!"Fuego // Hielo")) include:extras',
      1,
      { unique: "cards" },
    ],
    [
      `(oracleid:${fireOracle} or oracleid:${bindOracle}) game:paper lang:es`,
      1,
    ],
  ]);
  expect(result.issues).toEqual([]);
  expect(
    result.entries.map(({ card }) => [card.name, card.faces[0]?.language]),
  ).toEqual([
    ["Fire // Ice", "es"],
    ["Fire // Ice", "es"],
    ["Bind // Liberate", "en"],
  ]);
});

it("reports a missing exact scan in strict mode and falls back to the English printing only when allowed", async () => {
  const exact = vi.fn(async (_set: string, _number: string, lang: string) =>
    lang === "es" ? fixture.placeholder_exact_es : fixture.usable_exact_en,
  );
  const provider = mockScryfall({
    collection: async () => [fixture.usable_exact_en],
    exact,
  });
  const strict = await resolveCards(provider, [printLine], {
    ...spanish,
    languages: ["es"],
  });
  expect(strict).toMatchObject({
    entries: [],
    issues: [
      {
        line: 1,
        kind: "noUsableScan",
        printLookup: { set: "m11", collectorNumber: "149", languages: ["es"] },
      },
    ],
    missingPrints: [{ input: "1 Lightning Bolt (m11) 149", languages: ["es"] }],
  });
  const fallback = await resolveCards(provider, [printLine], {
    languages: ["es"],
    policy: "fallback-to-english",
  });
  expect(exact).toHaveBeenCalledWith("m11", "149", "es");
  expect(fallback).toMatchObject({
    entries: [
      {
        card: { id: fixture.usable_exact_en.id, faces: [{ language: "en" }] },
        requestedLanguages: ["es"],
      },
    ],
    issues: [],
    missingPrints: [],
  });
});

it("uses localized name search, preserves line numbers for misses, and skips requests for an empty decklist", async () => {
  const collection = vi.fn(async () => fixture.collection.data);
  const search = vi.fn(async (query: string) =>
    query.includes("oracleid:4457ed35")
      ? { cards: fixture.search_es.data, hasMore: false, total: 1 }
      : emptyPage,
  );
  const provider = mockScryfall({ collection, search });
  const preference = { ...spanish, languages: ["es"] };
  await expect(resolveCards(provider, [], preference)).resolves.toEqual({
    entries: [],
    issues: [],
    missingPrints: [],
  });
  expect(collection).not.toHaveBeenCalled();
  const result = await resolveCards(
    provider,
    [
      { ...printLine, name: "Unknown card", set: "", collectorNumber: "" },
      {
        ...printLine,
        set: "",
        collectorNumber: "",
        zone: "side",
        board: "Test board",
      },
    ],
    preference,
  );
  expect(result).toMatchObject({
    entries: [
      {
        zone: "side",
        board: "Test board",
        card: {
          id: fixture.search_es.data[0]?.id,
          faces: [{ language: "es" }],
        },
      },
    ],
    issues: [{ line: 1, kind: "notFound" }],
    missingPrints: [],
  });
});

it("batches a hundred Spanish names and oracles without changing their printings", async () => {
  const englishSample = fixture.collection.data[0];
  const spanishSample = fixture.search_es.data[0];
  if (!englishSample || !spanishSample) throw new Error("Missing scan fixture");
  const cards = Array.from({ length: 100 }, (_, index) => {
    const suffix = String(index).padStart(12, "0");
    const oracle_id = `00000000-0000-4000-8000-${suffix}`;
    const name = `English Card ${index}`;
    const printed_name = `Carta ${index}`;
    return {
      en: { ...englishSample, name, oracle_id },
      es: {
        ...spanishSample,
        id: `00000001-0000-4000-8000-${suffix}`,
        oracle_id,
        name,
        printed_name,
      },
    };
  });
  const collection = vi.fn<Scryfall["collection"]>(async (ids) =>
    cards.flatMap(({ en }) =>
      ids.some((id) => "name" in id && id.name === en.name) ? [en] : [],
    ),
  );
  const search = vi.fn<Scryfall["search"]>(async (query) => ({
    ...emptyPage,
    cards: cards.flatMap(({ es }) =>
      query.includes(`oracleid:${es.oracle_id}`) ||
      query.includes(`!"${es.printed_name}"`)
        ? [es]
        : [],
    ),
  }));
  const result = await resolveCards(
    mockScryfall({ collection, search }),
    cards.map(({ es }, index) => ({
      ...printLine,
      name: index % 2 === 0 ? es.name : es.printed_name,
      set: "",
      collectorNumber: "",
    })),
    { ...spanish, languages: ["es"] },
  );
  expect(result.issues).toEqual([]);
  expect(result.entries.map(({ card }) => card.id)).toEqual(
    cards.map(({ es }) => es.id),
  );
  expect(collection).toHaveBeenCalledTimes(2);
  expect(search).toHaveBeenCalledTimes(10);
  expect(search.mock.calls.every(([query]) => query.endsWith(" lang:es"))).toBe(
    true,
  );
});

it("filters print results by oracle, language, and face; better scans match the same art and language", async () => {
  const [english, spanishPrint] = delver;
  const card = normalizeScryfall(spanishPrint);
  const selected = card.faces[0];
  if (!selected) throw new Error("Missing front face in fixture");
  const highRes = { ...spanishPrint, image_status: "highres_scan" };
  const provider = mockScryfall({
    search: async () => ({
      cards: [english ?? {}, spanishPrint ?? {}, highRes],
      hasMore: true,
      total: 3,
    }),
  });
  const result = await searchArt(provider, card.oracleId, 1, 1, "es");
  expect(result).toMatchObject({ page: 1, total: 3, hasMore: true });
  expect(result.items.map((art) => art.name)).toEqual([
    "Insectile Aberration",
    "Insectile Aberration",
  ]);
  await expect(
    betterScan(provider, selected, card.oracleId, 0),
  ).resolves.toMatchObject({
    language: "es",
    scanQuality: "highres_scan",
    illustrationId: selected.illustrationId,
  });
  await expect(
    searchArt(provider, card.oracleId, 1, 1, "invalid"),
  ).rejects.toThrow("Unsupported print language");
});

it("returns deduplicated token entries and skips unrelated parts", async () => {
  const print = fixture.usable_exact_en;
  const collection = vi
    .fn()
    .mockResolvedValueOnce([
      {
        all_parts: [
          { id: print.id, component: "token" },
          { id: print.id, component: "token" },
          {
            id: fixture.exact_es.id,
            component: "combo_piece",
            type_line: "Instant",
          },
        ],
      },
    ])
    .mockResolvedValueOnce([print]);
  const provider = mockScryfall({ collection });
  await expect(relatedTokens(provider, [])).resolves.toEqual([]);
  await expect(relatedTokens(provider, ["bad-id"])).rejects.toThrow(
    "Invalid card ID",
  );
  await expect(
    relatedTokens(provider, [fixture.exact_es.id, fixture.exact_es.id]),
  ).resolves.toMatchObject([
    { quantity: 1, zone: "tokens", card: { id: print.id } },
  ]);
  expect(collection.mock.calls).toEqual([
    [[{ id: fixture.exact_es.id }]],
    [[{ id: print.id }]],
  ]);
});
