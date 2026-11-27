import type {
  ConfirmDialogOptions,
  SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";
import type { StyleProgress, StyleRequest } from "../../api.ts";
import type { Art, PrintSettings } from "../../core/index.ts";

export type CommandName =
  | "apply_art_preview"
  | "begin_upscale_comparison"
  | "better_scan"
  | "builder_commanders"
  | "builder_fill"
  | "builder_options"
  | "builder_sets"
  | "builder_suggest"
  | "builder_summary"
  | "cancel_job"
  | "cancel_upscale_comparison"
  | "clear_web_cache"
  | "compare_upscalers"
  | "create_deck"
  | "create_job"
  | "deck_detail"
  | "delete_deck"
  | "delete_printer_profile"
  | "download_model"
  | "export_file_name"
  | "get_deck"
  | "health"
  | "import_external_deck"
  | "import_url"
  | "list_decks"
  | "list_jobs"
  | "list_printer_profiles"
  | "list_uploads"
  | "load_model"
  | "mpc_artwork"
  | "open_data_dir"
  | "open_pdf"
  | "override_language_print"
  | "picker_dpi"
  | "preferences"
  | "preview_art_localization"
  | "preview_art_policy"
  | "preview_deck_language"
  | "related_tokens"
  | "resolve_cards"
  | "restore_deck"
  | "reveal_pdf"
  | "save_appearance"
  | "save_cut_template"
  | "save_deck"
  | "save_duplex_calibration"
  | "save_mpc_xml"
  | "save_pdf"
  | "save_preference"
  | "save_print_language"
  | "save_printer_profile"
  | "save_text"
  | "scryfall_sets"
  | "search_art"
  | "search_decks"
  | "set_coverage"
  | "settings"
  | "source_dpi"
  | "undo_art_change"
  | "update_upload_bleed"
  | "upload_bleed"
  | "web_storage_usage"
  | "window_chrome";

export interface UploadMetadata {
  oracleId: string;
  name: string;
  artist: string;
  bleedMm?: number;
}

export type PreviewSettings = Pick<
  PrintSettings,
  "cardWidthMm" | "cardHeightMm" | "bleedMm" | "bleedMode" | "bleedColor"
>;

export interface Backend {
  call(name: CommandName, args?: Record<string, unknown>): Promise<unknown>;
  uploadArt(bytes: Uint8Array, meta: UploadMetadata): Promise<unknown>;
  matchArtStyle(
    request: StyleRequest,
    onProgress?: (progress: StyleProgress) => void,
  ): Promise<unknown>;
  imageSrc(url: string): string;
  uploadTrimSrc(art: Art, thumbnail?: boolean): string;
  comparisonThumbnailSrc(art: Art, settings: PrintSettings): string;
  previewSrc(art: unknown, settings: PreviewSettings): string;
  save(options: SaveDialogOptions): Promise<string | null>;
  ask(message: string, options: ConfirmDialogOptions): Promise<boolean>;
}
