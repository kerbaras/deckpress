import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import {
  type Art,
  type ArtPreference,
  artPreferenceSchema,
  artSchema,
  type Deck,
  deckSchema,
  entrySchema,
  healthResponseSchema,
  type ImportIssue,
  jobSchema,
  type PrintSettings,
  parseDecklist,
} from "./core/index.ts";

/** Calls a Rust command over Tauri IPC and validates the response shape. */
export async function command<T>(
  name: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  let data: unknown;
  try {
    data = await invoke(name, args);
  } catch (error) {
    throw new Error(
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "Request failed. Check the application log and try again.",
    );
  }
  return schema.parse(data);
}

const modelStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.enum(["default", "fast", "quality", "style"]),
  kind: z.enum(["upscale", "styleEmbedding"]).default("upscale"),
  file: z.string(),
  scale: z.number(),
  tile: z.number(),
  bytes: z.number(),
  sha256: z.string(),
  bundled: z.boolean(),
  url: z.string().nullable(),
  license: z.string(),
  licenseUrl: z.string(),
  source: z.string(),
  description: z.string(),
  installed: z.boolean(),
  downloading: z.boolean(),
});
export type ModelStatus = z.infer<typeof modelStatusSchema>;
const upscalerInfoSchema = z.object({
  modelId: z.string(),
  modelName: z.string(),
  scale: z.number(),
  tile: z.number(),
  executionProvider: z.string(),
});
export type UpscalerInfo = z.infer<typeof upscalerInfoSchema>;
export const settingsSchema = z.object({
  models: z.array(modelStatusSchema),
  defaultModel: z.string(),
  loaded: upscalerInfoSchema.nullable(),
  styleModel: modelStatusSchema.nullable().default(null),
  storage: z.string(),
  localOnly: z.boolean(),
  dataDir: z.string(),
});
export type Settings = z.infer<typeof settingsSchema>;
export const preferencesSchema = z.object({
  preferences: z.record(z.string(), artPreferenceSchema),
  usage: z.record(z.string(), z.number()),
});
const artPageSchema = z.object({
  items: z.array(artSchema),
  page: z.number(),
  hasMore: z.boolean(),
  total: z.number(),
});
const resolvedSchema = z.object({
  entries: z.array(entrySchema),
  issues: z.array(
    z.object({ line: z.number(), input: z.string(), message: z.string() }),
  ),
});
export interface ImportResult {
  entries: z.infer<typeof entrySchema>[];
  issues: ImportIssue[];
  format: string;
}
export type Preferences = z.infer<typeof preferencesSchema>;
const scoredArtSchema = z.object({
  art: artSchema,
  score: z.number(),
  visual: z.number().nullable(),
  metadata: z.number(),
  reasons: z.array(z.string()),
});
export type ScoredArt = z.infer<typeof scoredArtSchema>;
export const styleReportSchema = z.object({
  method: z.enum(["model", "heuristic"]),
  model: z
    .object({
      id: z.string(),
      name: z.string(),
      executionProvider: z.string(),
    })
    .nullable(),
  matches: z.array(
    z.object({ entryId: z.string(), ranked: z.array(scoredArtSchema) }),
  ),
  warnings: z.array(z.string()),
  embedded: z.number(),
  skipped: z.number(),
});
export type StyleReport = z.infer<typeof styleReportSchema>;
export interface StyleRequest {
  reference: Art;
  entries: { entryId: string; options: Art[] }[];
  useModel?: boolean;
}
export interface StyleProgress {
  done: number;
  total: number;
}
export const windowChromeSchema = z.object({
  platform: z.enum(["macos", "windows", "linux"]),
  customControls: z.boolean(),
  insetLeft: z.number(),
});
export type WindowChrome = z.infer<typeof windowChromeSchema>;
/** Used when the command is unavailable (browser dev server, tests). */
export const defaultWindowChrome: WindowChrome = {
  platform: "linux",
  customControls: false,
  insetLeft: 0,
};
const nothing = z
  .null()
  .or(z.undefined())
  .transform(() => undefined);

export const api = {
  windowChrome: () =>
    command("window_chrome", windowChromeSchema).catch(
      () => defaultWindowChrome,
    ),
  decks: (_signal?: AbortSignal) => command("list_decks", z.array(deckSchema)),
  deck: (id: string, _signal?: AbortSignal) =>
    command("get_deck", deckSchema, { id }),
  createDeck: (
    value: Pick<Deck, "name" | "format"> &
      Partial<
        Pick<Deck, "entries" | "notes" | "printSettings" | "coverEntryId">
      >,
  ) => command("create_deck", deckSchema, { deck: value }),
  saveDeck: (deck: Deck) => command("save_deck", deckSchema, { deck }),
  deleteDeck: (id: string) => command("delete_deck", nothing, { id }),
  /** Decklist parsing stays in the browser; Scryfall resolution runs in Rust. */
  import: async (
    value: { text: string } | { url: string },
  ): Promise<ImportResult> => {
    const text =
      "url" in value
        ? await command("import_url", z.string(), { url: value.url })
        : value.text;
    const parsed = parseDecklist(text);
    const resolved = await command("resolve_cards", resolvedSchema, {
      lines: parsed.entries,
    });
    return {
      entries: resolved.entries,
      issues: [...parsed.issues, ...resolved.issues],
      format: parsed.format,
    };
  },
  settings: (_signal?: AbortSignal) => command("settings", settingsSchema),
  downloadModel: (id: string) =>
    command("download_model", z.array(modelStatusSchema), { id }),
  loadModel: (id: string) => command("load_model", upscalerInfoSchema, { id }),
  preferences: (_signal?: AbortSignal) =>
    command("preferences", preferencesSchema),
  savePreference: (id: string, value: ArtPreference) =>
    command("save_preference", artPreferenceSchema, {
      id,
      preference: value,
    }),
  art: (
    provider: "scryfall" | "mpc",
    oracleId: string,
    name: string,
    face: number,
    page: number,
    _signal?: AbortSignal,
  ) =>
    command("search_art", artPageSchema, {
      provider,
      oracleId,
      name,
      face,
      page,
    }),
  /** Ranks each entry's printings against a reference illustration (beta). */
  matchArtStyle: (
    request: StyleRequest,
    onProgress?: (progress: StyleProgress) => void,
  ) => {
    const progress = new Channel<StyleProgress>();
    progress.onmessage = (message) => onProgress?.(message);
    return command("match_art_style", styleReportSchema, {
      request,
      progress,
    });
  },
  uploads: (oracleId: string, _signal?: AbortSignal) =>
    command("list_uploads", z.array(artSchema), { oracleId }),
  /** Image bytes travel as the raw IPC body; metadata rides in a header. */
  upload: async (
    file: File,
    meta: { oracleId: string; name: string; artist: string; bleedMm: number },
  ) => {
    let data: unknown;
    try {
      data = await invoke(
        "upload_art",
        new Uint8Array(await file.arrayBuffer()),
        {
          headers: {
            "x-deckpress-upload": encodeURIComponent(JSON.stringify(meta)),
          },
        },
      );
    } catch (error) {
      throw new Error(typeof error === "string" ? error : "Upload failed");
    }
    return artSchema.parse(data);
  },
  jobs: (_signal?: AbortSignal) => command("list_jobs", z.array(jobSchema)),
  createJob: (deckId: string, settings: PrintSettings) =>
    command("create_job", jobSchema, { deckId, settings }),
  cancelJob: (id: string) => command("cancel_job", jobSchema, { id }),
  openPdf: (id: string) => command("open_pdf", nothing, { id }),
  revealPdf: (id: string) => command("reveal_pdf", nothing, { id }),
  savePdf: (id: string, destination: string) =>
    command("save_pdf", z.number(), { id, destination }),
  openDataDir: () => command("open_data_dir", nothing),
};

export const fetchHealth = (_signal?: AbortSignal) =>
  command("health", healthResponseSchema);

const IMAGE_SCHEME = "dpimg";
/** `<img src>` for any art URL, served by the Rust image cache. */
export function imageSrc(url: string): string {
  return convertFileSrc(`image/${url}`, IMAGE_SCHEME);
}
/** 150 DPI print-pipeline preview of one face, no AI. */
export function previewSrc(
  art: unknown,
  settings: Pick<
    PrintSettings,
    "cardWidthMm" | "cardHeightMm" | "bleedMm" | "bleedMode" | "bleedColor"
  >,
): string {
  return convertFileSrc(
    `preview/${JSON.stringify({ art, settings })}`,
    IMAGE_SCHEME,
  );
}
/** Native yes/no dialog for destructive actions; resolves false when declined. */
export function confirmAction(
  message: string,
  okLabel: string,
): Promise<boolean> {
  return ask(message, {
    title: "Deckpress",
    kind: "warning",
    okLabel,
    cancelLabel: "Cancel",
  });
}

/** Deck backup through the native save dialog; resolves false when cancelled. */
export async function downloadJson(deck: Deck): Promise<boolean> {
  const destination = await save({
    title: "Back up deck",
    defaultPath: `${deck.name.replace(/[^\w-]+/g, "-")}.deckpress.json`,
    filters: [{ name: "Deckpress backup", extensions: ["json"] }],
  });
  if (!destination) return false;
  await command("save_text", nothing, {
    destination,
    contents: JSON.stringify(deck, null, 2),
  });
  return true;
}
