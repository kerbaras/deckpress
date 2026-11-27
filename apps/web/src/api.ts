import type { SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import {
  type Art,
  type ArtPolicy,
  type ArtPreference,
  artPreferenceSchema,
  artSchema,
  cardSchema,
  type Deck,
  type DeckEntry,
  deckSchema,
  entrySchema,
  exportMpcXml,
  healthResponseSchema,
  type ImportIssue,
  importLineSchema,
  importMpcXml,
  isMpcXml,
  jobSchema,
  missingPrintSchema,
  mpcArtworkSchema,
  mpcXmlFormat,
  type PrinterProfileInput,
  type PrintJob,
  type PrintSettings,
  parseDecklist,
  printerProfileSchema,
} from "./core/index.ts";
import { setCoverageSchema, setInfoSchema } from "./core/sets.ts";
import { getBackend } from "./web/backend/index.ts";
import type {
  CommandName,
  PreviewSettings,
  UploadMetadata,
} from "./web/backend/types.ts";
import { NotAvailableOnWebError, webBackend } from "./web/backend/web.ts";

/** Calls a backend command and validates the response shape. */
export function command<T>(
  name: CommandName,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  return parseResponse(getBackend().call(name, args), schema);
}

async function parseResponse<T>(
  response: Promise<unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let data: unknown;
  try {
    data = await response;
  } catch (error) {
    if (error instanceof NotAvailableOnWebError) throw error;
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
const artPreviewSchema = z.object({
  previewId: z.uuid(),
  canApply: z.boolean(),
  changes: z.array(
    z.object({
      entryId: z.uuid(),
      name: z.string(),
      quantity: z.number(),
      before: artSchema,
      after: artSchema.nullable(),
      kind: z.enum(["changed", "unchanged", "pinned", "unmatched", "fallback"]),
      reason: z.string(),
    }),
  ),
});
export type ArtPreview = z.infer<typeof artPreviewSchema>;
export type ModelStatus = z.infer<typeof modelStatusSchema>;
const cropPreviewSchema = z
  .object({
    modelId: z.string().nullable(),
  })
  .and(
    z.union([
      z.object({
        crop: z.object({
          png: z.array(z.number()),
          width: z.number(),
          height: z.number(),
          elapsedMs: z.number(),
        }),
      }),
      z.object({ error: z.string() }),
    ]),
  );
export type CropPreview = z.infer<typeof cropPreviewSchema>;
const upscalerInfoSchema = z.object({
  modelId: z.string(),
  modelName: z.string(),
  scale: z.number(),
  tile: z.number(),
  executionProvider: z.string(),
});
export type UpscalerInfo = z.infer<typeof upscalerInfoSchema>;
const printLanguageSchema = z.object({
  languages: z.array(z.string()).min(1),
  policy: z.enum(["strict", "fallback-to-english"]),
});
export type PrintLanguagePreferences = z.infer<typeof printLanguageSchema>;
export const settingsSchema = z.object({
  models: z.array(modelStatusSchema),
  defaultModel: z.string(),
  loaded: upscalerInfoSchema.nullable(),
  styleModel: modelStatusSchema.nullable().default(null),
  storage: z.string(),
  localOnly: z.boolean(),
  dataDir: z.string(),
  printLanguage: printLanguageSchema.optional(),
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
    z.object({
      line: z.number(),
      input: z.string(),
      message: z.string(),
      kind: z.enum(["notFound", "noUsableScan"]).optional(),
      printLookup: z
        .object({
          set: z.string(),
          collectorNumber: z.string(),
          languages: z.array(z.string()),
        })
        .optional(),
    }),
  ),
  missingPrints: z.array(missingPrintSchema).optional(),
});
/** The deck URL could not be turned into a list; the pasted list still can. */
export class UrlImportError extends Error {}

export type ResolvedCards = z.infer<typeof resolvedSchema>;
export interface ImportResult {
  entries: z.infer<typeof entrySchema>[];
  issues: (ImportIssue & ResolvedCards["issues"][number])[];
  format: string;
  missingPrints?: ResolvedCards["missingPrints"];
}

export function importedDeckFields({
  entries,
  missingPrints,
}: Pick<ImportResult, "entries" | "missingPrints">) {
  return {
    entries,
    ...(missingPrints?.length ? { missingPrints } : {}),
  };
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
// Deck builder wizard payloads (mirrors packages/core-rs/src/builder.rs).
const builderFormatSchema = z.object({
  id: z.string(),
  name: z.string(),
  deckFormat: z.string(),
  deckSize: z.number(),
  landTarget: z.number(),
  singleton: z.boolean(),
  maxCopies: z.number(),
  commander: z.boolean(),
  needsSet: z.boolean(),
  description: z.string(),
});
export type BuilderFormat = z.infer<typeof builderFormatSchema>;
const builderStyleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  landAdjust: z.number(),
  curve: z.array(z.number()),
});
export type BuilderStyle = z.infer<typeof builderStyleSchema>;
const builderThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  needsTribe: z.boolean(),
  cues: z.array(z.string()),
  typeCues: z.array(z.string()),
});
export type BuilderTheme = z.infer<typeof builderThemeSchema>;
export const builderOptionsSchema = z.object({
  formats: z.array(builderFormatSchema),
  colors: z.array(
    z.object({ id: z.string(), name: z.string(), basic: z.string() }),
  ),
  styles: z.array(builderStyleSchema),
  themes: z.array(builderThemeSchema),
  source: z.string(),
});
export type BuilderOptions = z.infer<typeof builderOptionsSchema>;
const builderSetSchema = z.object({
  code: z.string(),
  name: z.string(),
  releasedAt: z.string(),
  cardCount: z.number(),
});
export type BuilderSet = z.infer<typeof builderSetSchema>;
export const builderSpecSchema = z.object({
  format: z.string(),
  set: z.string(),
  colors: z.array(z.string()),
  commander: cardSchema.nullable(),
  style: z.string(),
  theme: z.string(),
  tribe: z.string(),
});
export type BuilderSpec = z.infer<typeof builderSpecSchema>;
export const suggestionSchema = z.object({
  card: cardSchema,
  score: z.number(),
  reasons: z.array(z.string()),
  role: z.string(),
  oracleText: z.string(),
  popularityRank: z.number().nullable(),
  metaDecks: z.number(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;
export const deckSources = ["archidekt"] as const;
export const deckSourceSchema = z.enum(deckSources);
export type DeckSource = z.infer<typeof deckSourceSchema>;
export const metaSampleSchema = z.object({
  source: deckSourceSchema,
  decks: z.number(),
  label: z.string(),
});
export type MetaSample = z.infer<typeof metaSampleSchema>;
const suggestionPageSchema = z.object({
  items: z.array(suggestionSchema),
  page: z.number(),
  hasMore: z.boolean(),
  total: z.number(),
  queries: z.array(z.string()),
  colors: z.array(z.string()),
  meta: metaSampleSchema.nullable(),
});
export type SuggestionPage = z.infer<typeof suggestionPageSchema>;
export const builderSummarySchema = z.object({
  count: z.number(),
  target: z.number(),
  lands: z.number(),
  landTarget: z.number(),
  singleton: z.boolean(),
  maxCopies: z.number(),
  curve: z.array(
    z.object({ label: z.string(), count: z.number(), target: z.number() }),
  ),
  colors: z.array(
    z.object({ color: z.string(), pips: z.number(), cards: z.number() }),
  ),
  issues: z.array(z.string()),
  complete: z.boolean(),
});
export type BuilderSummary = z.infer<typeof builderSummarySchema>;

const nothing = z
  .null()
  .or(z.undefined())
  .transform(() => undefined);
export const searchFields = ["name", "commander", "card"] as const;
export type SearchField = (typeof searchFields)[number];
export interface DeckQuery {
  text: string;
  field: SearchField;
  format: string;
  source: DeckSource | null;
}
export const deckSummarySchema = z.object({
  source: deckSourceSchema,
  id: z.string(),
  name: z.string(),
  format: z.string(),
  deckpressFormat: z.string(),
  author: z.string(),
  colorIdentity: z.array(z.string()),
  cardCount: z.number(),
  updatedAt: z.string(),
  url: z.string(),
  coverUrl: z.string(),
  views: z.number(),
});
export type DeckSummary = z.infer<typeof deckSummarySchema>;
export const deckSearchPageSchema = z.object({
  items: z.array(deckSummarySchema),
  page: z.number(),
  hasMore: z.boolean(),
  total: z.number(),
  matchedCard: z.string().nullable(),
  cardMatches: z.array(z.string()),
});
export type DeckSearchPage = z.infer<typeof deckSearchPageSchema>;
export const externalDeckSchema = z.object({
  summary: deckSummarySchema,
  description: z.string(),
  lines: z.array(importLineSchema),
});
export type ExternalDeck = z.infer<typeof externalDeckSchema>;

const lookupMpcArtwork = (ids: string[]) =>
  command("mpc_artwork", z.array(mpcArtworkSchema), { ids });

export interface CropPosition {
  x: number;
  y: number;
}

export type Appearance = "system" | "light" | "dark";

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
        Pick<
          Deck,
          | "entries"
          | "notes"
          | "printSettings"
          | "coverEntryId"
          | "missingPrints"
          | "artPolicy"
        >
      >,
  ) => command("create_deck", deckSchema, { deck: value }),
  restoreDeck: (contents: string) =>
    command(
      "restore_deck",
      z.object({
        deck: deckSchema,
        updatedUploads: z.number().int().nonnegative(),
      }),
      { contents },
    ),
  saveDeck: (deck: Deck) => command("save_deck", deckSchema, { deck }),
  listSets: () => command("scryfall_sets", z.array(setInfoSchema)),
  setCoverage: (deckId: string) =>
    command("set_coverage", z.array(setCoverageSchema), { deckId }),
  previewArtPolicy: (
    deckId: string,
    expectedRevision: number,
    policy: ArtPolicy,
  ) =>
    command("preview_art_policy", artPreviewSchema, {
      deckId,
      expectedRevision,
      policy,
    }),
  previewArtLocalization: (
    deckId: string,
    expectedRevision: number,
    entryId: string,
    artId: string,
  ) =>
    command("preview_art_localization", artPreviewSchema, {
      deckId,
      expectedRevision,
      entryId,
      artId,
    }),
  applyArtPreview: (
    deckId: string,
    expectedRevision: number,
    previewId: string,
  ) =>
    command("apply_art_preview", deckSchema, {
      deckId,
      expectedRevision,
      previewId,
    }),
  undoArtChange: (deckId: string, expectedRevision: number) =>
    command("undo_art_change", deckSchema, { deckId, expectedRevision }),
  deleteDeck: (id: string) => command("delete_deck", nothing, { id }),
  relatedTokens: (cardIds: string[]) =>
    command("related_tokens", z.array(entrySchema), { cardIds }),
  /** Decklist parsing stays in the UI; the backend resolves the cards. */
  import: async (
    value: { text: string } | { url: string },
  ): Promise<ImportResult> => {
    const text =
      "url" in value
        ? await command("import_url", z.string(), { url: value.url }).catch(
            (error: unknown) => {
              throw new UrlImportError(
                error instanceof Error ? error.message : String(error),
              );
            },
          )
        : value.text;
    if (isMpcXml(text))
      return {
        entries: await importMpcXml(text, lookupMpcArtwork),
        issues: [],
        format: mpcXmlFormat,
      };
    const parsed = parseDecklist(text);
    const resolved = await command("resolve_cards", resolvedSchema, {
      lines: parsed.entries,
    });
    // `resolve_cards` numbers issues by position in `lines`; map them back to
    // the line the user typed.
    const issues = resolved.issues.map((issue) => ({
      ...issue,
      line: issue.line > 0 ? (parsed.lines[issue.line - 1] ?? 0) : 0,
    }));
    return {
      entries: resolved.entries,
      issues: [...parsed.issues, ...issues].sort(
        (a, b) => (a.line || Infinity) - (b.line || Infinity),
      ),
      format: parsed.format,
      missingPrints: resolved.missingPrints,
    };
  },
  settings: (_signal?: AbortSignal) => command("settings", settingsSchema),
  savePrintLanguage: (preferences: PrintLanguagePreferences) =>
    command("save_print_language", printLanguageSchema, { preferences }),
  saveAppearance: (appearance: Appearance) =>
    command("save_appearance", z.null(), { appearance }),
  downloadModel: (id: string) =>
    command("download_model", z.array(modelStatusSchema), { id }),
  loadModel: (id: string) => command("load_model", upscalerInfoSchema, { id }),
  compareUpscalers: async (
    art: Art,
    settings: PrintSettings,
    signal: AbortSignal,
    position?: CropPosition,
  ) => {
    const requestId = crypto.randomUUID();
    const backend = getBackend();
    const cancel = () =>
      backend.call("cancel_upscale_comparison", { requestId });
    await backend.call("begin_upscale_comparison", { requestId });
    if (signal.aborted) {
      await cancel();
      return [];
    }
    const onAbort = () => void cancel().catch(console.error);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await command("compare_upscalers", z.array(cropPreviewSchema), {
        requestId,
        art,
        settings,
        position,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  },
  preferences: (_signal?: AbortSignal) =>
    command("preferences", preferencesSchema),
  betterScan: (selected: Art, oracleId: string, face: number) =>
    command("better_scan", artSchema, { selected, oracleId, face }),
  sourceDpi: (arts: Art[], settings: PrintSettings) =>
    command(
      "source_dpi",
      z.array(
        z
          .object({
            effectiveDpi: z.number(),
            belowUpscaleThreshold: z.boolean(),
          })
          .nullable(),
      ),
      { arts, settings },
    ),
  pickerDpi: (arts: Art[], settings: PrintSettings) =>
    command(
      "picker_dpi",
      z.array(
        z
          .object({ effectiveDpi: z.number(), estimated: z.boolean() })
          .nullable(),
      ),
      { arts, settings },
    ),
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
    language?: string,
  ) =>
    command("search_art", artPageSchema, {
      provider,
      oracleId,
      name,
      face,
      page,
      language,
    }),
  /** Ranks each entry's printings against a reference illustration (beta). */
  matchArtStyle: (
    request: StyleRequest,
    onProgress?: (progress: StyleProgress) => void,
  ) => {
    return parseResponse(
      getBackend().matchArtStyle(request, onProgress),
      styleReportSchema,
    );
  },
  uploads: (oracleId: string, _signal?: AbortSignal) =>
    command("list_uploads", z.array(artSchema), { oracleId }),
  uploadBleed: (imageUrl: string) =>
    command("upload_bleed", z.number().nullable(), { imageUrl }),
  updateUploadBleed: (imageUrl: string, bleedMm: number | null) =>
    command("update_upload_bleed", artSchema, { imageUrl, bleedMm }),
  upload: async (file: File, meta: UploadMetadata) => {
    let data: unknown;
    try {
      data = await getBackend().uploadArt(
        new Uint8Array(await file.arrayBuffer()),
        meta,
      );
    } catch (error) {
      if (error instanceof NotAvailableOnWebError) throw error;
      throw new Error(typeof error === "string" ? error : "Upload failed");
    }
    return artSchema.parse(data);
  },
  jobs: (_signal?: AbortSignal) => command("list_jobs", z.array(jobSchema)),
  createJob: (
    deckId: string,
    settings: PrintSettings,
    format: PrintJob["format"] = "pdf",
  ) => command("create_job", jobSchema, { deckId, settings, format }),
  cancelJob: (id: string) => command("cancel_job", jobSchema, { id }),
  openPdf: (id: string) => command("open_pdf", nothing, { id }),
  revealPdf: (id: string) => command("reveal_pdf", nothing, { id }),
  savePdf: (id: string, destination: string) =>
    command("save_pdf", z.number(), { id, destination }),
  printerProfiles: () =>
    command("list_printer_profiles", z.array(printerProfileSchema)),
  savePrinterProfile: (id: string | null, input: PrinterProfileInput) =>
    command("save_printer_profile", printerProfileSchema, { id, input }),
  deletePrinterProfile: (id: string) =>
    command("delete_printer_profile", nothing, { id }),
  exportDuplexCalibration: async (settings: PrintSettings) => {
    const destination = await saveFileDialog({
      title: "Save duplex calibration sheet",
      defaultPath: "deckpress-duplex-calibration.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!destination) return false;
    await command("save_duplex_calibration", nothing, {
      settings,
      destination,
    });
    return true;
  },
  openDataDir: () => command("open_data_dir", nothing),
  searchDecks: (query: DeckQuery, page: number, _signal?: AbortSignal) =>
    command("search_decks", deckSearchPageSchema, { query, page }),
  deckDetail: (source: DeckSource, id: string, _signal?: AbortSignal) =>
    command("deck_detail", externalDeckSchema, { source, id }),
  importExternalDeck: (source: DeckSource, id: string) =>
    command("import_external_deck", resolvedSchema, { source, id }),
  builderOptions: (_signal?: AbortSignal) =>
    command("builder_options", builderOptionsSchema),
  builderSets: (_signal?: AbortSignal) =>
    command("builder_sets", z.array(builderSetSchema)),
  builderCommanders: (query: string, colors: string[], _signal?: AbortSignal) =>
    command("builder_commanders", z.array(suggestionSchema), {
      query,
      colors,
    }),
  builderSuggest: (spec: BuilderSpec, page: number, _signal?: AbortSignal) =>
    command("builder_suggest", suggestionPageSchema, { spec, page }),
  builderSummary: (spec: BuilderSpec, entries: DeckEntry[]) =>
    command("builder_summary", builderSummarySchema, { spec, entries }),
  builderFill: (spec: BuilderSpec, entries: DeckEntry[]) =>
    command("builder_fill", z.array(entrySchema), { spec, entries }),
};

export const fetchHealth = (_signal?: AbortSignal) =>
  command("health", healthResponseSchema);

export function imageSrc(url: string): string {
  return getBackend().imageSrc(url);
}
export function uploadTrimSrc(art: Art, thumbnail = false) {
  return getBackend().uploadTrimSrc(art, thumbnail);
}
export function comparisonThumbnailSrc(art: Art, settings: PrintSettings) {
  return getBackend().comparisonThumbnailSrc(art, settings);
}
/** 150 DPI print-pipeline preview of one face, no AI. */
export function previewSrc(art: unknown, settings: PreviewSettings): string {
  return getBackend().previewSrc(art, settings);
}

export function saveFileDialog(options: SaveDialogOptions) {
  return getBackend().save(options);
}

export const isWebPreview = () => getBackend() === webBackend;

export function printPreviewUnavailable(): Error | null {
  return isWebPreview()
    ? new NotAvailableOnWebError(
        "Rendered print previews are not available on the web.",
      )
    : null;
}

export function upscalingUnavailable(): Error | null {
  return isWebPreview()
    ? new NotAvailableOnWebError("AI upscaling is not available on the web.")
    : null;
}
/** Native yes/no dialog for destructive actions; resolves false when declined. */
export function confirmAction(
  message: string,
  okLabel: string,
): Promise<boolean> {
  return getBackend().ask(message, {
    title: "Deckpress",
    kind: "warning",
    okLabel,
    cancelLabel: "Cancel",
  });
}

/** Same byte-capped deck-name stem as the PDF and PNG ZIP job file names. */
const exportFileName = (deck: Deck, suffix: string) =>
  command("export_file_name", z.string(), { deckName: deck.name, suffix });

/** Deck backup through the native save dialog; resolves false when cancelled. */
export async function downloadJson(deck: Deck): Promise<boolean> {
  const destination = await saveFileDialog({
    title: "Back up deck",
    defaultPath: await exportFileName(deck, ".deckpress.json"),
    filters: [{ name: "Deckpress backup", extensions: ["json"] }],
  });
  if (!destination) return false;
  await command("save_text", nothing, {
    destination,
    contents: JSON.stringify(deck, null, 2),
  });
  return true;
}

export async function downloadCutTemplate(deck: Deck): Promise<string | null> {
  const destination = await saveFileDialog({
    title: "Save cut template",
    defaultPath: await exportFileName(deck, "-cut-template.svg"),
    filters: [{ name: "SVG cut template", extensions: ["svg"] }],
  });
  if (!destination) return null;
  await command("save_cut_template", nothing, {
    destination,
    settings: deck.printSettings,
  });
  return destination;
}

export async function downloadMpcXml(deck: Deck): Promise<boolean> {
  const contents = await exportMpcXml(deck.entries, lookupMpcArtwork);
  const destination = await saveFileDialog({
    title: "Export MPC Autofill XML",
    defaultPath: await exportFileName(deck, ".xml"),
    filters: [{ name: mpcXmlFormat, extensions: ["xml"] }],
  });
  if (!destination) return false;
  await command("save_mpc_xml", nothing, { destination, contents });
  return true;
}
