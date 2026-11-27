import { z } from "zod";
import {
  artPolicySchema,
  artSchema,
  type HealthResponse,
  importLineSchema,
  printSettingsSchema,
} from "../../core/index.ts";
import { webAssetBase } from "../asset-base.ts";
import { runPrintWorker, webJobs } from "../print/jobs.ts";
import { betterScan, searchArt } from "../providers/art.ts";
import { policyProvider } from "../providers/printings.ts";
import { resolveCards } from "../providers/resolve.ts";
import { scryfallCacheKind, scryfallClient } from "../providers/scryfall.ts";
import { relatedTokens } from "../providers/tokens.ts";
import { deckStore } from "../store/decks.ts";
import { clearImageCache, imageSrc } from "../store/image-cache.ts";
import { indexedDbDocuments } from "../store/indexed-db.ts";
import { exportFileName, settingsStore } from "../store/settings.ts";
import { isModelCached, MODEL_CACHE } from "../upscale/model-store.ts";
import { defaultWebModel, webModels } from "../upscale/models.ts";
import { artHistory } from "./art-history.ts";
import { downloadBlob, downloadText } from "./download.ts";
import { setCoverage } from "./set-matching.ts";
import type { Backend } from "./types.ts";

export class NotAvailableOnWebError extends Error {
  override name = "NotAvailableOnWebError";
}

function notAvailableYet(feature: string): Promise<never> {
  return Promise.reject(
    new NotAvailableOnWebError(`${feature} is not available yet on the web.`),
  );
}

function unsupportedSource(feature: string): Promise<never> {
  return Promise.reject(
    new NotAvailableOnWebError(`${feature} is not available on the web.`),
  );
}

const placeholderImage = () => "about:blank";
const documents = indexedDbDocuments();
const decks = deckStore(documents);
const settings = settingsStore(documents, decks.list);
const scryfall = scryfallClient(documents);
const policyPrintings = policyProvider(scryfall);
const art = artHistory(decks, policyPrintings, settings.printLanguage);
const text = z.string();
const index = z.number().int().nonnegative();

export const webBackend: Backend = {
  async call(name, args = {}) {
    switch (name) {
      case "health":
        return {
          status: "ok",
          service: "@deckpress/desktop",
        } satisfies HealthResponse;
      case "list_decks":
        return decks.list();
      case "get_deck":
        return decks.get(text.parse(args.id));
      case "create_deck":
        return decks.create(args.deck);
      case "save_deck":
        return decks.save(args.deck);
      case "delete_deck":
        return decks.remove(text.parse(args.id));
      case "restore_deck":
        return decks.restore(text.parse(args.contents));
      case "scryfall_sets":
        return policyPrintings.sets();
      case "set_coverage":
        return setCoverage(
          policyPrintings,
          await decks.get(text.parse(args.deckId)),
        );
      case "preview_art_policy": {
        const policy = artPolicySchema.parse(args.policy);
        return art.previewPolicy(
          text.parse(args.deckId),
          index.parse(args.expectedRevision),
          policy,
        );
      }
      case "preview_art_localization":
        return art.previewLocalization(
          text.parse(args.deckId),
          index.parse(args.expectedRevision),
          text.parse(args.entryId),
          text.parse(args.artId),
        );
      case "apply_art_preview":
        return art.apply(
          text.parse(args.deckId),
          index.parse(args.expectedRevision),
          text.parse(args.previewId),
        );
      case "undo_art_change":
        return art.undo(
          text.parse(args.deckId),
          index.parse(args.expectedRevision),
        );
      case "list_uploads":
      case "upload_bleed":
      case "update_upload_bleed":
        return notAvailableYet("Art uploads");
      case "settings":
        return {
          ...(await settings.settings()),
          defaultModel: defaultWebModel,
          models: await Promise.all(
            webModels.map(async (model) => ({
              ...model,
              bundled: false,
              installed: await isModelCached(model, webAssetBase()).catch(
                () => false,
              ),
              downloading: false,
            })),
          ),
        };
      case "web_storage_usage": {
        const estimate = await navigator.storage?.estimate?.();
        return {
          usage: estimate?.usage ?? null,
          quota: estimate?.quota ?? null,
        };
      }
      case "clear_web_cache": {
        if (webJobs.busy)
          throw new Error(
            "Wait for exports to finish before clearing the cache.",
          );
        const rows = await documents.list(scryfallCacheKind);
        await Promise.all([
          clearImageCache(),
          caches.delete(MODEL_CACHE),
          caches.delete("deckpress-web-art-v1"),
          ...rows.map(({ id }) => documents.remove(scryfallCacheKind, id)),
        ]);
        return null;
      }
      case "save_print_language":
        return settings.savePrintLanguage(args.preferences);
      case "save_appearance":
        return settings.saveAppearance(args.appearance);
      case "preferences":
        return settings.preferences();
      case "save_preference":
        return settings.savePreference(text.parse(args.id), args.preference);
      case "list_printer_profiles":
        return settings.profiles();
      case "save_printer_profile":
        return settings.saveProfile(
          z.uuid().nullable().parse(args.id),
          args.input,
        );
      case "delete_printer_profile":
        return settings.removeProfile(text.parse(args.id));
      case "export_file_name":
        return exportFileName(
          text.parse(args.deckName),
          text.parse(args.suffix),
        );
      case "window_chrome":
        return { platform: "linux", customControls: false, insetLeft: 0 };
      case "resolve_cards": {
        const preferences = await settings.printLanguage();
        const deckId = text.optional().parse(args.deckId);
        const language = deckId
          ? (await decks.get(deckId)).printLanguage
          : undefined;
        return resolveCards(
          scryfall,
          z.array(importLineSchema).parse(args.lines),
          language ? { ...preferences, languages: [language] } : preferences,
        );
      }
      case "preview_deck_language":
      case "override_language_print":
        return notAvailableYet("Deck language switching");
      case "related_tokens":
        return relatedTokens(scryfall, z.array(text).parse(args.cardIds));
      case "better_scan":
        return betterScan(
          scryfall,
          artSchema.parse(args.selected),
          text.parse(args.oracleId),
          index.parse(args.face),
        );
      case "import_url":
        return unsupportedSource("Deck URL import");
      case "search_decks":
      case "deck_detail":
      case "import_external_deck":
        return unsupportedSource("External deck browsing and import");
      case "mpc_artwork":
        return unsupportedSource("MPC Autofill");
      case "search_art":
        if (args.provider === "mpc") return unsupportedSource("MPC Autofill");
        if (args.provider !== "scryfall")
          throw new Error("Unknown art provider");
        return searchArt(
          scryfall,
          text.parse(args.oracleId),
          index.parse(args.page),
          index.parse(args.face),
          text.optional().parse(args.language),
        );
      case "save_text":
        return downloadText(
          text.parse(args.destination),
          text.parse(args.contents),
          "json",
        );
      case "save_mpc_xml":
        return downloadText(
          text.parse(args.destination),
          text.parse(args.contents),
          "xml",
        );
      case "list_jobs":
        return webJobs.list();
      case "create_job":
        return webJobs.create(
          await decks.get(text.parse(args.deckId)),
          printSettingsSchema.parse(args.settings),
          z.enum(["pdf", "png"]).parse(args.format),
        );
      case "cancel_job":
        return webJobs.cancel(text.parse(args.id));
      case "save_pdf":
        return webJobs.save(text.parse(args.id), text.parse(args.destination));
      case "save_duplex_calibration": {
        const result = await runPrintWorker({
          kind: "calibration",
          settings: printSettingsSchema.parse(args.settings),
        });
        if (result.kind !== "calibration")
          throw new Error("Invalid calibration response");
        return downloadBlob(text.parse(args.destination), result.file);
      }
      case "save_cut_template": {
        const format = z
          .enum(["svg", "dxf", "studio3"])
          .default("svg")
          .parse(args.format);
        const destination = text.parse(args.destination);
        if (!destination.endsWith(`.${format}`))
          throw new Error(`Save the cut template as a .${format} file.`);
        const result = await runPrintWorker({
          kind: "cut",
          format,
          settings: printSettingsSchema.parse(args.settings),
        });
        if (result.kind !== "cut")
          throw new Error("Invalid cut template response");
        return downloadBlob(destination, result.file);
      }
      case "source_dpi": {
        const result = await runPrintWorker({
          kind: "source-dpi",
          settings: printSettingsSchema.parse(args.settings),
          arts: z.array(artSchema).parse(args.arts),
        });
        if (result.kind !== "source-dpi")
          throw new Error("Invalid source DPI response");
        return result.readings;
      }
      case "begin_upscale_comparison":
      case "compare_upscalers":
      case "load_model":
      case "download_model":
        return unsupportedSource("AI upscaling");
    }
    return notAvailableYet(name);
  },
  uploadArt: () => notAvailableYet("Art upload"),
  matchArtStyle: () => notAvailableYet("Art style matching"),
  imageSrc,
  uploadTrimSrc: placeholderImage,
  comparisonThumbnailSrc: (art) => imageSrc(art.thumbnailUrl),
  previewSrc: placeholderImage,
  async save({ defaultPath, filters }) {
    if (
      filters?.some(({ extensions }) =>
        extensions.some((extension) =>
          ["json", "pdf", "zip", "svg", "dxf", "studio3"].includes(extension),
        ),
      )
    ) {
      return defaultPath ?? null;
    }
    return unsupportedSource("This export");
  },
  async ask(message) {
    return window.confirm(message);
  },
};
