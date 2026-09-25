import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Art,
  artSchema,
  type Card,
  type DeckEntry,
  type ImportIssue,
  type ImportLine,
  parseDecklist,
} from "@deckpress/core";
import { z } from "zod";
import { AppError } from "./errors.ts";
import type { Store } from "./store.ts";

const imagesSchema = z.object({
  png: z.string().optional(),
  large: z.string().optional(),
  normal: z.string().optional(),
  art_crop: z.string().optional(),
});
const faceSchema = z.object({
  name: z.string(),
  artist: z.string().optional(),
  image_uris: imagesSchema.optional(),
});
const scryfallCardSchema = z.object({
  id: z.uuid(),
  oracle_id: z.uuid().optional(),
  name: z.string(),
  type_line: z.string().default(""),
  mana_cost: z.string().default(""),
  cmc: z.number().default(0),
  color_identity: z.array(z.string()).default([]),
  image_uris: imagesSchema.optional(),
  card_faces: z.array(faceSchema).optional(),
  artist: z.string().default("Unknown"),
  set: z.string(),
  set_name: z.string(),
  collector_number: z.string(),
  lang: z.string().default("en"),
  released_at: z.string().default(""),
  scryfall_uri: z.string().default(""),
  border_color: z.string().default("black"),
  frame: z.string().default(""),
  frame_effects: z.array(z.string()).default([]),
  full_art: z.boolean().default(false),
  textless: z.boolean().default(false),
  promo: z.boolean().default(false),
});

export function normalizeScryfall(value: unknown): Card {
  const card = scryfallCardSchema.parse(value);
  const rawFaces = card.image_uris
    ? [{ name: card.name, artist: card.artist, image_uris: card.image_uris }]
    : (card.card_faces ?? []);
  const faces: Art[] = rawFaces
    .filter((face) => face.image_uris?.png || face.image_uris?.large)
    .map((face, index) => {
      const images = face.image_uris;
      const imageUrl = images?.png ?? images?.large ?? "";
      return artSchema.parse({
        id: `scryfall:${card.id}:${index}`,
        provider: "scryfall",
        name: face.name,
        imageUrl,
        thumbnailUrl: images?.normal ?? imageUrl,
        artCropUrl: images?.art_crop ?? "",
        sourceUrl: card.scryfall_uri,
        source: card.set_name,
        artist: face.artist ?? card.artist,
        set: card.set,
        collectorNumber: card.collector_number,
        language: card.lang,
        releasedAt: card.released_at,
        dpi: 300,
        tags: [
          ...card.frame_effects,
          ...(card.border_color === "borderless" ? ["borderless"] : []),
          ...(card.full_art ? ["full art"] : []),
          ...(card.textless ? ["textless"] : []),
          ...(card.promo ? ["promo"] : []),
          ...(card.frame === "1993" || card.frame === "1997"
            ? ["retro frame"]
            : []),
        ],
      });
    });
  if (!faces[0])
    throw new AppError(`No printable scan available for ${card.name}`, 422);
  if (faces[1]) {
    faces[0].backImageUrl = faces[1].imageUrl;
    faces[0].backThumbnailUrl = faces[1].thumbnailUrl;
  }
  return {
    id: card.id,
    oracleId: card.oracle_id ?? card.id,
    name: card.name,
    typeLine: card.type_line,
    manaCost: card.mana_cost,
    manaValue: card.cmc,
    colors: card.color_identity,
    faces,
  };
}

const mpcSourceSchema = z.object({ pk: z.number(), name: z.string() });
const mpcCardSchema = z.object({
  identifier: z.string(),
  name: z.string(),
  downloadLink: z.string(),
  mediumThumbnailUrl: z.string(),
  smallThumbnailUrl: z.string(),
  source: z.string(),
  dpi: z.number(),
  tags: z.array(z.string()).default([]),
  language: z.string().default("EN"),
});
export interface ArtPage {
  items: Art[];
  page: number;
  hasMore: boolean;
  total: number;
}

export class Providers {
  private scryfallTail: Promise<void> = Promise.resolve();
  private nextRequest = 0;
  private readonly pending = new Map<string, Promise<unknown>>();
  readonly store: Store;
  readonly fetcher: typeof fetch;
  readonly interval: number;

  constructor(store: Store, fetcher: typeof fetch = fetch, interval = 550) {
    this.store = store;
    this.fetcher = fetcher;
    this.interval = interval;
  }

  async json(url: string, body?: unknown): Promise<unknown> {
    const key = createHash("sha256")
      .update(url + JSON.stringify(body ?? null))
      .digest("hex");
    const cached = this.store.cached(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = async () => {
      const scryfall = new URL(url).hostname === "api.scryfall.com";
      if (scryfall) {
        const previous = this.scryfallTail;
        let release = () => {};
        this.scryfallTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          await delay(Math.max(0, this.nextRequest - Date.now()));
          this.nextRequest = Date.now() + this.interval;
        } finally {
          release();
        }
      }
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "User-Agent": "Deckpress/0.1 (local playtest tool)",
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
      });
      if (response.status === 429) {
        if (scryfall) this.nextRequest = Date.now() + 30_000;
        throw new AppError(
          "The art provider is rate limiting requests. Wait 30 seconds and retry.",
          429,
        );
      }
      if (!response.ok)
        throw new AppError(
          `Provider returned ${response.status}. Try again or import an exported decklist instead.`,
          502,
        );
      const json: unknown = await response.json();
      this.store.put("cache", key, json);
      return json;
    };
    const promise = request().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async resolve(text: string) {
    const parsed = parseDecklist(text);
    const entries: DeckEntry[] = [];
    const issues: ImportIssue[] = [...parsed.issues];
    for (let start = 0; start < parsed.entries.length; start += 75) {
      const batch = parsed.entries.slice(start, start + 75);
      const identifiers = batch.map((entry) =>
        entry.set && entry.collectorNumber
          ? { set: entry.set, collector_number: entry.collectorNumber }
          : { name: entry.name, ...(entry.set ? { set: entry.set } : {}) },
      );
      const response = z.object({ data: z.array(z.unknown()) }).parse(
        await this.json("https://api.scryfall.com/cards/collection", {
          identifiers,
        }),
      );
      const cards: Card[] = [];
      for (const item of response.data) {
        try {
          cards.push(normalizeScryfall(item));
        } catch {
          issues.push({
            line: 0,
            input: "Card without a printable scan",
            message: "Scryfall returned a card without supported imagery",
          });
        }
      }
      const normalize = (name: string) =>
        name.normalize("NFKC").toLowerCase().trim();
      for (const entry of batch) {
        const card = cards.find((candidate) => {
          const front = candidate.faces[0];
          if (entry.set && front?.set !== entry.set) return false;
          if (entry.collectorNumber)
            return front?.collectorNumber === entry.collectorNumber;
          return (
            normalize(candidate.name) === normalize(entry.name) ||
            candidate.faces.some(
              (face) => normalize(face.name) === normalize(entry.name),
            )
          );
        });
        if (card)
          entries.push({
            id: randomUUID(),
            card,
            quantity: entry.quantity,
            zone: entry.zone,
            selectedArt: null,
            selectedBack: null,
            excluded: false,
          });
        else
          issues.push({
            line: 0,
            input: `${entry.quantity} ${entry.name}${entry.set ? ` (${entry.set}) ${entry.collectorNumber}` : ""}`,
            message:
              "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.",
          });
      }
    }
    return { entries, issues, format: parsed.format };
  }

  async prints(oracleId: string, page: number, face = 0): Promise<ArtPage> {
    const query = new URLSearchParams({
      q: `oracleid:${oracleId} game:paper`,
      unique: "prints",
      order: "released",
      dir: "desc",
      page: String(page),
    });
    const response = z
      .object({
        data: z.array(z.unknown()),
        has_more: z.boolean(),
        total_cards: z.number(),
      })
      .parse(await this.json(`https://api.scryfall.com/cards/search?${query}`));
    const items = response.data.flatMap((raw) => {
      try {
        const card = normalizeScryfall(raw);
        const art = card.faces[face];
        return art ? [art] : [];
      } catch {
        return [];
      }
    });
    return {
      items,
      page,
      hasMore: response.has_more,
      total: response.total_cards,
    };
  }

  async community(name: string, page: number): Promise<ArtPage> {
    const sources = z
      .object({ results: z.record(z.string(), mpcSourceSchema) })
      .parse(await this.json("https://mpcfill.com/2/sources/"));
    const query = name.toLowerCase().trim();
    const search = z
      .object({
        results: z.record(
          z.string(),
          z.object({ CARD: z.array(z.string()).optional() }),
        ),
      })
      .parse(
        await this.json("https://mpcfill.com/2/editorSearch/", {
          searchSettings: {
            searchTypeSettings: { fuzzySearch: false, filterCardbacks: false },
            sourceSettings: {
              sources: Object.values(sources.results).map((source) => [
                source.pk,
                true,
              ]),
            },
            filterSettings: {
              minimumDPI: 0,
              maximumDPI: 1500,
              maximumSize: 30,
              languages: [],
              includesTags: [],
              excludesTags: ["NSFW"],
            },
          },
          queries: [{ query, cardType: "CARD" }],
        }),
      );
    const ids = search.results[query]?.CARD ?? [];
    const batch = ids.slice((page - 1) * 48, page * 48);
    if (!batch.length)
      return { items: [], page, hasMore: false, total: ids.length };
    const cards = z
      .object({ results: z.record(z.string(), mpcCardSchema.nullable()) })
      .parse(
        await this.json("https://mpcfill.com/2/cards/", {
          cardIdentifiers: batch,
        }),
      );
    const items = batch.flatMap((id) => {
      const card = cards.results[id];
      return card
        ? [
            artSchema.parse({
              id: `mpc:${id}`,
              provider: "mpc",
              name: card.name,
              imageUrl: card.downloadLink,
              thumbnailUrl: card.mediumThumbnailUrl,
              sourceUrl: card.downloadLink,
              source: card.source,
              artist: "Uncredited",
              dpi: card.dpi || 300,
              bleedMm: 3.048,
              language: card.language.toLowerCase(),
              tags: [
                ...card.tags,
                ...(/full art/i.test(card.name) ? ["full art"] : []),
                ...(/borderless/i.test(card.name) ? ["borderless"] : []),
              ],
            }),
          ]
        : [];
    });
    return { items, page, hasMore: page * 48 < ids.length, total: ids.length };
  }

  async importUrl(input: string): Promise<string> {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      throw new AppError("Use an HTTPS Moxfield or Archidekt deck URL");
    if (["moxfield.com", "www.moxfield.com"].includes(url.hostname)) {
      const id = /^\/decks\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
      if (!id) throw new AppError("Invalid Moxfield deck URL");
      const item = z.object({
        quantity: z.number(),
        card: z.object({
          name: z.string(),
          set: z.string().optional(),
          cn: z.string().optional(),
        }),
      });
      const data = z
        .object({
          boards: z.record(
            z.string(),
            z.object({ cards: z.record(z.string(), item) }),
          ),
        })
        .parse(await this.json(`https://api2.moxfield.com/v3/decks/all/${id}`));
      return Object.entries(data.boards)
        .flatMap(([zone, board]) => [
          zone,
          ...Object.values(board.cards).map(
            (entry) =>
              `${entry.quantity} ${entry.card.name}${entry.card.set && entry.card.cn ? ` (${entry.card.set}) ${entry.card.cn}` : ""}`,
          ),
        ])
        .join("\n");
    }
    if (["archidekt.com", "www.archidekt.com"].includes(url.hostname)) {
      const id = /^\/decks\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
      if (!id) throw new AppError("Invalid Archidekt deck URL");
      const data = z
        .object({
          cards: z.array(
            z.object({
              quantity: z.number(),
              categories: z.array(z.string()),
              card: z.object({
                oracleCard: z.object({ name: z.string() }),
                edition: z.object({ editioncode: z.string() }),
                collectorNumber: z.string(),
              }),
            }),
          ),
          categories: z
            .array(z.object({ name: z.string(), includedInDeck: z.boolean() }))
            .default([]),
        })
        .parse(await this.json(`https://archidekt.com/api/decks/${id}/`));
      return data.cards
        .flatMap((entry) => {
          const categories = entry.categories.map((category) =>
            category.toLowerCase(),
          );
          const zone = categories.includes("commander")
            ? "Commander"
            : categories.includes("sideboard")
              ? "Sideboard"
              : entry.categories.some((category) =>
                    data.categories.some(
                      (value) =>
                        value.name === category && !value.includedInDeck,
                    ),
                  )
                ? "Maybeboard"
                : "Deck";
          return [
            zone,
            `${entry.quantity} ${entry.card.oracleCard.name} (${entry.card.edition.editioncode}) ${entry.card.collectorNumber}`,
          ];
        })
        .join("\n");
    }
    throw new AppError(
      "Only public Moxfield and Archidekt URLs are supported. Other sites can be imported as text or CSV.",
    );
  }
}

export type ResolvedImport = {
  entries: DeckEntry[];
  issues: ImportIssue[];
  format: string;
};
export type { ImportLine };
