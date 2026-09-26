import { z } from "zod";

export const zones = ["main", "commander", "side", "maybe", "tokens"] as const;
export const zoneSchema = z.enum(zones);
export const formats = [
  "Commander",
  "Modern",
  "Standard",
  "Pioneer",
  "Legacy",
  "Vintage",
  "Pauper",
  "Cube",
  "Casual",
] as const;

export const artSchema = z.object({
  id: z.string().min(1).max(160),
  provider: z.enum(["scryfall", "mpc", "upload"]),
  name: z.string().max(300),
  imageUrl: z.string().min(1).max(2048),
  thumbnailUrl: z.string().min(1).max(2048),
  artCropUrl: z.string().max(2048).default(""),
  sourceUrl: z.string().max(2048).default(""),
  source: z.string().max(200),
  artist: z.string().max(200).default("Unknown"),
  set: z.string().max(20).default(""),
  collectorNumber: z.string().max(40).default(""),
  language: z.string().max(20).default("en"),
  releasedAt: z.string().max(40).default(""),
  tags: z.array(z.string().max(80)).max(40).default([]),
  dpi: z.number().min(1).max(10000).default(300),
  bleedMm: z.number().min(0).max(10).default(0),
  backImageUrl: z.string().max(2048).default(""),
  backThumbnailUrl: z.string().max(2048).default(""),
});
export type Art = z.infer<typeof artSchema>;

export const cardSchema = z.object({
  id: z.uuid(),
  oracleId: z.uuid(),
  name: z.string().max(300),
  typeLine: z.string().max(300),
  manaCost: z.string().max(100),
  manaValue: z.number().min(0).max(1000),
  colors: z.array(z.string().max(1)).max(5),
  faces: z.array(artSchema).min(1).max(2),
});
export type Card = z.infer<typeof cardSchema>;

export const entrySchema = z.object({
  id: z.uuid(),
  card: cardSchema,
  quantity: z.number().int().min(1).max(250),
  zone: zoneSchema,
  selectedArt: artSchema.nullable().default(null),
  selectedBack: artSchema.nullable().default(null),
  excluded: z.boolean().default(false),
});
export type DeckEntry = z.infer<typeof entrySchema>;

export const papers = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  a3: [297, 420],
  a5: [148, 210],
  legal: [215.9, 355.6],
  tabloid: [279.4, 431.8],
} as const;

export const printSettingsSchema = z.object({
  paper: z
    .enum(["a4", "letter", "a3", "a5", "legal", "tabloid", "custom"])
    .default("a4"),
  customWidthMm: z.number().min(40).max(1000).default(210),
  customHeightMm: z.number().min(40).max(1000).default(297),
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
  cardWidthMm: z.number().min(25).max(200).default(63),
  cardHeightMm: z.number().min(25).max(250).default(88),
  marginMm: z.number().min(0).max(50).default(4),
  gapMm: z.number().min(0).max(20).default(0),
  bleedMm: z.number().min(0).max(5).default(1),
  bleedMode: z.enum(["solid", "mirror", "edge"]).default("mirror"),
  bleedColor: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default("#111111"),
  columns: z.number().int().min(0).max(20).default(0),
  rows: z.number().int().min(0).max(20).default(0),
  guides: z.enum(["crop", "full", "none"]).default("crop"),
  guideLengthMm: z.number().min(0.5).max(10).default(2),
  guideOffsetMm: z.number().min(0).max(5).default(0.5),
  guideWidthPt: z.number().min(0.1).max(2).default(0.25),
  guideColor: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default("#222222"),
  dpi: z.number().int().min(150).max(1200).default(800),
  quality: z.number().int().min(60).max(100).default(92),
  upscale: z.boolean().default(false),
  /** Model id from the desktop manifest; empty selects the bundled default. */
  upscaleModel: z.string().max(100).default(""),
  calibrationPage: z.boolean().default(true),
  backs: z
    .enum(["none", "long-edge", "short-edge", "separate"])
    .default("none"),
  backOffsetXmm: z.number().min(-10).max(10).default(0),
  backOffsetYmm: z.number().min(-10).max(10).default(0),
  includeSideboard: z.boolean().default(false),
  includeMaybeboard: z.boolean().default(false),
  skipBasics: z.boolean().default(false),
  pageFrom: z.number().int().min(1).max(1000).default(1),
  pageTo: z.number().int().min(0).max(1000).default(0),
});
export type PrintSettings = z.infer<typeof printSettingsSchema>;

export const deckSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  format: z.enum(formats),
  notes: z.string().max(5000).default(""),
  entries: z
    .array(entrySchema)
    .max(1000)
    .refine(
      (entries) => entries.reduce((n, entry) => n + entry.quantity, 0) <= 1500,
      "A deck can contain at most 1,500 cards",
    ),
  coverEntryId: z.string().max(36).default(""),
  printSettings: printSettingsSchema,
  revision: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Deck = z.infer<typeof deckSchema>;

export const artPreferenceSchema = z.object({
  rating: z.number().int().min(0).max(5).default(0),
  favorite: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export type ArtPreference = z.infer<typeof artPreferenceSchema>;

export const jobSchema = z.object({
  id: z.uuid(),
  deckId: z.uuid(),
  deckName: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  completed: z.number(),
  total: z.number(),
  message: z.string(),
  createdAt: z.string(),
  fileName: z.string(),
  bytes: z.number(),
  pages: z.number(),
});
export type PrintJob = z.infer<typeof jobSchema>;

export function frontArt(entry: DeckEntry): Art {
  const art = entry.selectedArt ?? entry.card.faces[0];
  if (!art) throw new Error(`No front image for ${entry.card.name}`);
  return art;
}

export function backArt(entry: DeckEntry): Art | null {
  if (entry.selectedBack) return entry.selectedBack;
  const front = frontArt(entry);
  if (front.backImageUrl)
    return {
      ...front,
      id: `${front.id}:back`,
      imageUrl: front.backImageUrl,
      thumbnailUrl: front.backThumbnailUrl || front.backImageUrl,
    };
  return entry.card.faces[1] ?? null;
}

export function printableEntries(
  deck: Deck,
  settings: PrintSettings,
): DeckEntry[] {
  return deck.entries.filter(
    (entry) =>
      !entry.excluded &&
      (entry.zone !== "side" || settings.includeSideboard) &&
      (entry.zone !== "maybe" || settings.includeMaybeboard) &&
      (!settings.skipBasics || !entry.card.typeLine.startsWith("Basic Land")),
  );
}

export function mergeImport(
  previous: DeckEntry[],
  incoming: DeckEntry[],
  replace: boolean,
): DeckEntry[] {
  const key = (entry: DeckEntry) =>
    `${entry.card.oracleId}:${entry.zone}:${entry.card.id}`;
  const result: DeckEntry[] = replace ? [] : [...previous];
  const used = new Set<string>();
  for (const entry of incoming) {
    if (!replace) {
      const index = result.findIndex((item) => key(item) === key(entry));
      const old = result[index];
      if (old)
        result[index] = { ...old, quantity: old.quantity + entry.quantity };
      else result.push(entry);
      continue;
    }
    let matches = previous.filter(
      (item) => !used.has(item.id) && key(item) === key(entry),
    );
    if (!matches.length) {
      const candidates = previous.filter(
        (item) =>
          !used.has(item.id) &&
          item.card.oracleId === entry.card.oracleId &&
          item.zone === entry.zone &&
          !incoming.some(
            (other) => other !== entry && key(other) === key(item),
          ),
      );
      if (new Set(candidates.map((item) => item.card.id)).size === 1)
        matches = candidates;
    }
    let remaining = entry.quantity;
    for (const old of matches) {
      if (!remaining) break;
      const quantity = Math.min(remaining, old.quantity);
      result.push({
        ...entry,
        id: old.id,
        quantity,
        selectedArt: old.selectedArt,
        selectedBack: old.selectedBack,
        excluded: old.excluded,
      });
      used.add(old.id);
      remaining -= quantity;
    }
    if (remaining) result.push({ ...entry, quantity: remaining });
  }
  return result;
}
