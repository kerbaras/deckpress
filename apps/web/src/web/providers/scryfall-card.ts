import { z } from "zod";
import type { Art, Card } from "../../core/index.ts";

const images = z.object({
  png: z.string().nullish(),
  large: z.string().nullish(),
  normal: z.string().nullish(),
  art_crop: z.string().nullish(),
});
const faceSchema = z.object({
  name: z.string(),
  artist: z.string().nullish(),
  image_uris: images.nullish(),
  illustration_id: z.uuid().nullish(),
});
const cardSchema = faceSchema.extend({
  artist: z.string().default("Unknown"),
  id: z.uuid(),
  oracle_id: z.uuid().nullish(),
  type_line: z.string().default(""),
  mana_cost: z.string().default(""),
  cmc: z.number().default(0),
  color_identity: z.array(z.string()).default([]),
  image_status: z.string().nullish(),
  card_faces: z.array(faceSchema).nullish(),
  highres_image: z.boolean().nullish(),
  set: z.string(),
  set_name: z.string(),
  collector_number: z.string(),
  lang: z.string().default(""),
  released_at: z.string().default(""),
  scryfall_uri: z.string().default(""),
  border_color: z.string().default("black"),
  frame: z.string().default(""),
  frame_effects: z.array(z.string()).default([]),
  full_art: z.boolean().default(false),
  textless: z.boolean().default(false),
  promo: z.boolean().default(false),
});

function scanQuality(
  status: string | null | undefined,
  highres: boolean | null | undefined,
): Art["scanQuality"] {
  if (status === "lowres" || status === "highres_scan") return status;
  return highres == null ? null : highres ? "highres_scan" : "lowres";
}

export function normalizeScryfall(value: unknown): Card {
  const parsed = cardSchema.safeParse(value);
  if (!parsed.success) throw new Error("Unexpected Scryfall card data");
  const card = parsed.data;
  if (card.image_status === "placeholder" || card.image_status === "missing") {
    throw new Error("Scryfall has no usable scan for this printing");
  }

  const tags = [...card.frame_effects];
  if (card.border_color === "borderless") tags.push("borderless");
  if (card.full_art) tags.push("full art");
  if (card.textless) tags.push("textless");
  if (card.promo) tags.push("promo");
  if (card.frame === "1993" || card.frame === "1997") tags.push("retro frame");

  const rawFaces = card.image_uris ? [card] : (card.card_faces ?? []);
  const faces = rawFaces.flatMap((face, index): Art[] => {
    const images = face.image_uris;
    const imageUrl = images?.png ?? images?.large;
    if (!images || !imageUrl) return [];
    return [
      {
        id: `scryfall:${card.id}:${index}`,
        englishFallback: false,
        provider: "scryfall",
        name: face.name,
        thumbnailUrl: images.normal ?? imageUrl,
        imageUrl,
        artCropUrl: images.art_crop ?? "",
        sourceUrl: card.scryfall_uri,
        source: card.set_name,
        artist: face.artist ?? card.artist,
        set: card.set,
        collectorNumber: card.collector_number,
        language: card.lang,
        illustrationId: face.illustration_id ?? null,
        scanQuality: scanQuality(card.image_status, card.highres_image),
        releasedAt: card.released_at,
        dpi: 0,
        tags,
        bleedMm: 0,
        backImageUrl: "",
        backThumbnailUrl: "",
      },
    ];
  });

  const [front, back] = faces;
  if (!front) throw new Error(`No printable scan available for ${card.name}`);
  if (back) {
    front.backImageUrl = back.imageUrl;
    front.backThumbnailUrl = back.thumbnailUrl;
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

export function usableCard(value: unknown): Card | undefined {
  try {
    return normalizeScryfall(value);
  } catch {
    return undefined;
  }
}

export function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function recordList(raw: unknown) {
  return Array.isArray(raw) ? raw.map(record) : [];
}

export function printNumber(raw: Record<string, unknown>) {
  const { set, collector_number: collectorNumber } = raw;
  return typeof set === "string" &&
    set &&
    typeof collectorNumber === "string" &&
    collectorNumber
    ? { set, collectorNumber }
    : undefined;
}

export const foldName = (name: string) => name.trim().toLowerCase();

export function nameMatches(raw: Record<string, unknown>, wanted: string) {
  return [raw.name, raw.printed_name].some(
    (name) => typeof name === "string" && foldName(name) === wanted,
  );
}
