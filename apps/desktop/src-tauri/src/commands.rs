//! Tauri commands: the whole application API the webview can call. Each one
//! maps to a former `/api/*` route; errors serialize as plain strings.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use deckpress_core::art_policy::{ArtChange, ArtPolicy, ArtPreview};
use deckpress_core::decksearch::{DeckQuery, DeckSearchPage, DeckSource, ExternalDeck};
use deckpress_core::error::{AppError, AppResult};
use deckpress_core::images::{RestoreResult, UploadInput};
use deckpress_core::models::{
    Art, ArtPage, ArtPreference, Deck, DeckEntry, ExportFormat, ImportLine, NewDeck, PrintJob,
    PrintLanguagePreferences, PrintSettings, PrinterProfile, PrinterProfileInput, ResolvedCards,
};
use deckpress_core::pdf::build_duplex_calibration_pdf;
use deckpress_core::providers::MpcArtwork;
use deckpress_core::set_family::{SetCoverage, SetInfo};
use deckpress_core::style::{StyleReport, StyleRequest};
use deckpress_core::upscaler::manifest::{default_model_id, ModelStatus};
use deckpress_core::upscaler::preview::{self, ModelCrop};
use deckpress_core::upscaler::{CancelToken, UpscalerInfo};
use deckpress_core::{art_quality, cut_dxf::build_cut_dxf, cut_svg::build_cut_svg, scm_cut};

pub type AppState = deckpress_core::Core;
pub type Comparisons = Mutex<HashMap<String, CancelToken>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: &'static str,
    pub service: &'static str,
    pub version: &'static str,
}

#[tauri::command]
pub fn health() -> Health {
    Health {
        status: "ok",
        service: "@deckpress/desktop",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub models: Vec<ModelStatus>,
    pub default_model: String,
    pub loaded: Option<UpscalerInfo>,
    pub style_model: Option<ModelStatus>,
    pub storage: &'static str,
    pub local_only: bool,
    pub data_dir: String,
    pub print_language: PrintLanguagePreferences,
}

#[tauri::command]
pub fn settings(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(Settings {
        models: state.models.status(),
        default_model: default_model_id(),
        loaded: state.models.loaded_info(),
        style_model: state.models.style_status(),
        storage: "Local SQLite",
        local_only: true,
        data_dir: state.data_dir.display().to_string(),
        print_language: state.providers.print_language_preferences()?,
    })
}

#[tauri::command]
pub fn save_print_language(
    state: State<'_, AppState>,
    preferences: PrintLanguagePreferences,
) -> AppResult<PrintLanguagePreferences> {
    state.providers.save_print_language_preferences(preferences)
}

#[tauri::command]
pub async fn download_model(state: State<'_, AppState>, id: String) -> AppResult<Vec<ModelStatus>> {
    state.models.install(&id, |_, _| {}).await?;
    Ok(state.models.status())
}

#[tauri::command]
pub async fn load_model(state: State<'_, AppState>, id: String) -> AppResult<UpscalerInfo> {
    let models = Arc::clone(&state.models);
    let upscaler = tokio::task::spawn_blocking(move || models.upscaler(&id)).await??;
    Ok(upscaler.info())
}

#[tauri::command]
pub fn begin_upscale_comparison(comparisons: State<'_, Comparisons>, request_id: String) {
    comparisons
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .entry(request_id)
        .or_default();
}

#[tauri::command]
pub fn cancel_upscale_comparison(comparisons: State<'_, Comparisons>, request_id: String) {
    let cancel = comparisons
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&request_id);
    if let Some(cancel) = cancel {
        cancel.cancel();
    }
}

#[tauri::command]
pub async fn compare_upscalers(
    state: State<'_, AppState>,
    comparisons: State<'_, Comparisons>,
    request_id: String,
    art: Art,
    settings: PrintSettings,
    position: Option<preview::CropPosition>,
) -> AppResult<Vec<ModelCrop>> {
    let cancel = comparisons
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .get(&request_id)
        .cloned()
        .ok_or(AppError::Cancelled)?;
    let result = async {
        let source = state
            .images
            .read_cancellable(&art.image_url, &cancel)
            .await?;
        let models = Arc::clone(&state.models);
        tokio::task::spawn_blocking(move || {
            preview::compare_at(
                &source,
                &art,
                &settings,
                &models,
                position.unwrap_or_default(),
                &cancel,
            )
        })
        .await?
    }
    .await;
    comparisons
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&request_id);
    if matches!(result, Err(AppError::Cancelled)) {
        log::debug!("Upscale comparison {request_id} cancelled");
    }
    result
}

#[tauri::command]
pub fn list_decks(state: State<'_, AppState>) -> AppResult<Vec<Deck>> {
    state.store.decks()
}

#[tauri::command]
pub fn get_deck(state: State<'_, AppState>, id: String) -> AppResult<Deck> {
    state.store.deck(&id)
}

#[tauri::command]
pub fn create_deck(state: State<'_, AppState>, deck: NewDeck) -> AppResult<Deck> {
    state.store.create_deck(deck)
}

#[tauri::command]
pub async fn restore_deck(
    state: State<'_, AppState>,
    contents: String,
) -> AppResult<RestoreResult> {
    let images = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.restore_deck(&contents)).await?
}

#[tauri::command]
pub async fn save_deck(state: State<'_, AppState>, deck: Deck) -> AppResult<Deck> {
    let store = Arc::clone(&state.store);
    tokio::task::spawn_blocking(move || store.update_deck(deck)).await?
}

#[tauri::command]
pub async fn scryfall_sets(state: State<'_, AppState>) -> AppResult<Vec<SetInfo>> {
    state.providers.sets().await
}

#[tauri::command]
pub async fn set_coverage(
    state: State<'_, AppState>,
    deck_id: String,
) -> AppResult<Vec<SetCoverage>> {
    let deck = state.store.deck(&deck_id)?;
    state.providers.set_coverage(&deck.entries).await
}

#[tauri::command]
pub async fn preview_art_policy(
    state: State<'_, AppState>,
    deck_id: String,
    expected_revision: u64,
    policy: ArtPolicy,
) -> AppResult<ArtPreview> {
    state
        .art_policy
        .preview_policy(&deck_id, expected_revision, policy)
        .await
}

#[tauri::command]
pub async fn preview_art_localization(
    state: State<'_, AppState>,
    deck_id: String,
    expected_revision: u64,
    entry_id: String,
    art_id: String,
) -> AppResult<ArtPreview> {
    state
        .art_policy
        .preview_localization(&deck_id, expected_revision, &entry_id, &art_id)
        .await
}

#[tauri::command]
pub async fn preview_deck_language(
    state: State<'_, AppState>,
    deck_id: String,
    expected_revision: u64,
    language: String,
) -> AppResult<ArtPreview> {
    state
        .art_policy
        .preview_language(&deck_id, expected_revision, language)
        .await
}

#[tauri::command]
pub async fn override_language_print(
    state: State<'_, AppState>,
    deck_id: String,
    expected_revision: u64,
    preview_id: String,
    entry_id: String,
    art_id: String,
) -> AppResult<ArtChange> {
    state
        .art_policy
        .override_language_print(&deck_id, expected_revision, &preview_id, &entry_id, &art_id)
        .await
}

#[tauri::command]
pub fn apply_art_preview(
    state: State<'_, AppState>,
    deck_id: String,
    expected_revision: u64,
    preview_id: String,
) -> AppResult<Deck> {
    state
        .art_policy
        .apply(&deck_id, expected_revision, &preview_id)
}

#[tauri::command]
pub fn undo_art_change(
    state: State<'_, AppState>,
    deck_id: String,
    expected_revision: u64,
) -> AppResult<Deck> {
    state.art_policy.undo(&deck_id, expected_revision)
}

#[tauri::command]
pub fn delete_deck(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.remove("deck", &id)
}

#[tauri::command]
pub async fn import_url(state: State<'_, AppState>, url: String) -> AppResult<String> {
    state.providers.import_url(&url).await
}

#[tauri::command]
pub async fn resolve_cards(
    state: State<'_, AppState>,
    lines: Vec<ImportLine>,
    deck_id: Option<String>,
) -> AppResult<ResolvedCards> {
    if lines.len() > 1000 {
        return Err(AppError::user("Decklists are limited to 1000 lines"));
    }
    match deck_id {
        Some(id) => {
            state
                .providers
                .resolve_deck_import(&state.store.deck(&id)?, lines)
                .await
        }
        None => state.providers.resolve_import(lines).await,
    }
}

#[tauri::command]
pub async fn related_tokens(
    state: State<'_, AppState>,
    card_ids: Vec<String>,
    deck_id: Option<String>,
) -> AppResult<Vec<DeckEntry>> {
    match deck_id {
        Some(id) => {
            state
                .providers
                .related_deck_tokens(&state.store.deck(&id)?, card_ids)
                .await
        }
        None => state.providers.related_tokens(card_ids).await,
    }
}

#[tauri::command]
pub async fn mpc_artwork(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<MpcArtwork>> {
    state.providers.mpc_artwork(ids).await
}

#[tauri::command]
pub async fn search_art(
    state: State<'_, AppState>,
    provider: String,
    oracle_id: String,
    name: String,
    face: usize,
    page: u32,
    language: Option<String>,
) -> AppResult<ArtPage> {
    let page = page.clamp(1, 100);
    match provider.as_str() {
        "scryfall" => {
            state
                .providers
                .prints(&oracle_id, page, face.min(1), language.as_deref())
                .await
        }
        "mpc" => state.providers.community(&name, page).await,
        _ => Err(AppError::user("Unknown art provider")),
    }
}

#[tauri::command]
pub async fn better_scan(
    state: State<'_, AppState>,
    selected: Art,
    oracle_id: String,
    face: usize,
) -> AppResult<Art> {
    let Ok(oracle_id) = oracle_id.parse() else {
        return Ok(selected);
    };
    state.providers.better_scan(selected, oracle_id, face).await
}

#[tauri::command]
pub async fn source_dpi(
    state: State<'_, AppState>,
    arts: Vec<Art>,
    settings: PrintSettings,
) -> AppResult<Vec<Option<art_quality::SourceReading>>> {
    Ok(art_quality::source_dpi(&state.images, arts, &settings).await)
}

#[tauri::command]
pub async fn picker_dpi(
    state: State<'_, AppState>,
    arts: Vec<Art>,
    settings: PrintSettings,
) -> AppResult<Vec<Option<art_quality::PickerDpi>>> {
    Ok(art_quality::picker_dpi(&state.images, arts, &settings).await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleProgress {
    pub done: usize,
    pub total: usize,
}

#[tauri::command]
pub async fn match_art_style(
    state: State<'_, AppState>,
    request: StyleRequest,
    progress: Channel<StyleProgress>,
) -> AppResult<StyleReport> {
    state
        .style
        .rank(request, |done, total| {
            let _ = progress.send(StyleProgress { done, total });
        })
        .await
}

#[derive(Debug, Serialize)]
pub struct Preferences {
    pub preferences: HashMap<String, ArtPreference>,
    pub usage: HashMap<String, u32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredPreference {
    id: String,
    #[serde(flatten)]
    preference: ArtPreference,
}

#[tauri::command]
pub fn preferences(state: State<'_, AppState>) -> AppResult<Preferences> {
    let mut usage: HashMap<String, u32> = HashMap::new();
    for deck in state.store.list::<Deck>("deck")? {
        for entry in &deck.entries {
            *usage.entry(entry.front_art().id.clone()).or_default() += entry.quantity;
        }
    }
    Ok(Preferences {
        preferences: state
            .store
            .list::<StoredPreference>("preference")?
            .into_iter()
            .map(|stored| (stored.id, stored.preference))
            .collect(),
        usage,
    })
}

#[tauri::command]
pub fn save_preference(
    state: State<'_, AppState>,
    id: String,
    preference: ArtPreference,
) -> AppResult<ArtPreference> {
    if id.is_empty() || id.chars().count() > 160 {
        return Err(AppError::user("Invalid art id"));
    }
    let preference = preference.normalized()?;
    let stored = StoredPreference {
        id,
        preference: preference.clone(),
    };
    state.store.put("preference", &stored.id, &stored)?;
    Ok(preference)
}

#[tauri::command]
pub fn list_uploads(state: State<'_, AppState>, oracle_id: String) -> AppResult<Vec<Art>> {
    state.images.uploads_for(&oracle_id)
}

#[tauri::command]
pub fn upload_bleed(state: State<'_, AppState>, image_url: String) -> AppResult<Option<f64>> {
    state.images.upload_bleed(&image_url)
}

#[tauri::command]
pub async fn update_upload_bleed(
    state: State<'_, AppState>,
    image_url: String,
    bleed_mm: Option<f64>,
) -> AppResult<Art> {
    let images = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.update_upload_bleed(&image_url, bleed_mm)).await?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeta {
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub bleed_mm: Option<f64>,
}

/// The image travels as the raw IPC body; metadata is a percent-encoded JSON
/// header so large uploads never pass through JSON number arrays.
#[tauri::command]
pub async fn upload_art(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<Art> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::user("Select an image file"));
    };
    let bytes = bytes.clone();
    let header = request
        .headers()
        .get("x-deckpress-upload")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::user("Upload metadata is missing"))?;
    let meta: UploadMeta =
        serde_json::from_str(&percent_encoding::percent_decode_str(header).decode_utf8_lossy())
            .map_err(|_| AppError::user("Upload metadata is invalid"))?;
    if meta.name.trim().is_empty() || meta.name.chars().count() > 300 {
        return Err(AppError::user("Card name is required"));
    }
    let images = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || {
        images.upload(
            &bytes,
            UploadInput {
                oracle_id: meta.oracle_id,
                name: meta.name,
                artist: meta.artist,
                bleed_mm: meta.bleed_mm,
            },
        )
    })
    .await?
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> AppResult<Vec<PrintJob>> {
    state.jobs.list()
}

#[tauri::command]
pub fn create_job(
    state: State<'_, AppState>,
    deck_id: String,
    settings: PrintSettings,
    format: Option<ExportFormat>,
) -> AppResult<PrintJob> {
    let deck = state.store.deck(&deck_id)?;
    state
        .jobs
        .create(deck, settings, format.unwrap_or_default())
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, id: String) -> AppResult<PrintJob> {
    state.jobs.cancel(&id)
}

/// Runs a desktop-integration call (xdg-open, D-Bus file manager, ...) off
/// the main thread and gives up after a few seconds, so a missing or stuck
/// desktop service can never freeze the window.
async fn with_desktop<F>(what: &str, call: F) -> AppResult<()>
where
    F: FnOnce() -> Result<(), tauri_plugin_opener::Error> + Send + 'static,
{
    let task = tokio::task::spawn_blocking(call);
    match tokio::time::timeout(std::time::Duration::from_secs(8), task).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(AppError::user(format!("Could not {what}: {error}"))),
        Ok(Err(error)) => Err(AppError::internal(error.to_string())),
        Err(_) => Err(AppError::user(format!(
            "Could not {what}: the desktop did not respond. Use Save as instead."
        ))),
    }
}

#[tauri::command]
pub async fn open_pdf(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let (path, _) = state.jobs.output_path(&id)?;
    with_desktop("open the PDF", move || {
        tauri_plugin_opener::open_path(path, None::<&str>)
    })
    .await
}

#[tauri::command]
pub async fn reveal_pdf(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let (path, _) = state.jobs.output_path(&id)?;
    with_desktop("show the export", move || {
        tauri_plugin_opener::reveal_item_in_dir(&path).or_else(|_| {
            let dir = path.parent().unwrap_or(&path);
            tauri_plugin_opener::open_path(dir, None::<&str>)
        })
    })
    .await
}

#[tauri::command]
pub async fn save_pdf(
    state: State<'_, AppState>,
    id: String,
    destination: String,
) -> AppResult<u64> {
    let (source, format) = state.jobs.output_path(&id)?;
    let destination = PathBuf::from(destination);
    let extension = format.extension();
    if destination.extension().and_then(|e| e.to_str()) != Some(extension) {
        return Err(AppError::user(format!(
            "Save the export as a .{extension} file"
        )));
    }
    Ok(tokio::fs::copy(source, destination).await?)
}

#[tauri::command]
pub async fn save_cut_template(
    destination: String,
    settings: PrintSettings,
    format: Option<String>,
) -> AppResult<()> {
    let destination = PathBuf::from(destination);
    let format = format.as_deref().unwrap_or("svg");
    if destination.extension().and_then(|e| e.to_str()) != Some(format) {
        return Err(AppError::user(format!(
            "Save the cut template as a .{format} file"
        )));
    }
    let bytes = match format {
        "svg" => build_cut_svg(&settings)?.into_bytes(),
        "dxf" => build_cut_dxf(&settings)?.into_bytes(),
        "studio3" => scm_cut::studio3(&settings)?,
        _ => return Err(AppError::user("Unknown cut template format")),
    };
    Ok(tokio::fs::write(destination, bytes).await?)
}

#[tauri::command]
pub fn list_printer_profiles(state: State<'_, AppState>) -> AppResult<Vec<PrinterProfile>> {
    state.store.printer_profiles()
}

#[tauri::command]
pub fn save_printer_profile(
    state: State<'_, AppState>,
    id: Option<String>,
    input: PrinterProfileInput,
) -> AppResult<PrinterProfile> {
    state.store.save_printer_profile(id, input)
}

#[tauri::command]
pub fn delete_printer_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_printer_profile(&id)
}

#[tauri::command]
pub async fn save_duplex_calibration(
    settings: PrintSettings,
    destination: String,
) -> AppResult<()> {
    let destination = PathBuf::from(destination);
    if destination.extension().and_then(|e| e.to_str()) != Some("pdf") {
        return Err(AppError::user("Save the export as a .pdf file"));
    }
    let bytes = tokio::task::spawn_blocking(move || build_duplex_calibration_pdf(&settings))
        .await
        .map_err(AppError::internal)??;
    Ok(tokio::fs::write(destination, bytes).await?)
}

/// Default save-dialog name for a deck export such as `.xml` or `-cut-template.svg`.
#[tauri::command]
pub fn export_file_name(deck_name: String, suffix: String) -> String {
    deckpress_core::jobs::export_file_name(&deck_name, &suffix)
}

/// Writes user-visible text (deck backups) to a path the save dialog returned.
#[tauri::command]
pub async fn save_text(destination: String, contents: String) -> AppResult<()> {
    if contents.len() > 64 * 1024 * 1024 {
        return Err(AppError::user("Backup is too large to save"));
    }
    let destination = PathBuf::from(destination);
    if destination.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err(AppError::user("Save the backup as a .json file"));
    }
    Ok(tokio::fs::write(destination, contents).await?)
}

#[tauri::command]
pub async fn save_mpc_xml(destination: String, contents: String) -> AppResult<()> {
    let destination = PathBuf::from(destination);
    if destination.extension().and_then(|e| e.to_str()) != Some("xml") {
        return Err(AppError::user(
            "Save the MPC Autofill order as an .xml file",
        ));
    }
    if contents.len() > 512 * 1024 {
        return Err(AppError::user("MPC Autofill order is too large to save"));
    }
    Ok(tokio::fs::write(destination, contents).await?)
}

#[tauri::command]
pub async fn open_data_dir(state: State<'_, AppState>) -> AppResult<()> {
    let dir = state.data_dir.clone();
    with_desktop("open the data folder", move || {
        tauri_plugin_opener::open_path(dir, None::<&str>)
    })
    .await
}

#[tauri::command]
pub async fn search_decks(
    state: State<'_, AppState>,
    query: DeckQuery,
    page: u32,
) -> AppResult<DeckSearchPage> {
    state.decksearch.search(query, page).await
}

#[tauri::command]
pub async fn deck_detail(
    state: State<'_, AppState>,
    source: DeckSource,
    id: String,
) -> AppResult<ExternalDeck> {
    state.decksearch.detail(source, &id).await
}

#[tauri::command]
pub async fn import_external_deck(
    state: State<'_, AppState>,
    source: DeckSource,
    id: String,
) -> AppResult<ResolvedCards> {
    state.decksearch.import(source, &id).await
}

// Deck builder wizard. All logic lives in `deckpress_core::builder`; these
// commands only translate IPC payloads.

#[tauri::command]
pub fn builder_options() -> deckpress_core::builder::BuilderOptions {
    deckpress_core::builder::options()
}

#[tauri::command]
pub async fn builder_sets(
    state: State<'_, AppState>,
) -> AppResult<Vec<deckpress_core::builder::SetOption>> {
    state.builder.sets().await
}

#[tauri::command]
pub async fn builder_commanders(
    state: State<'_, AppState>,
    query: String,
    colors: Vec<String>,
) -> AppResult<Vec<deckpress_core::builder::Suggestion>> {
    if query.chars().count() > 80 {
        return Err(AppError::user(
            "Shorten the commander search to 80 characters",
        ));
    }
    state.builder.commanders(&query, &colors).await
}

#[tauri::command]
pub async fn builder_suggest(
    state: State<'_, AppState>,
    spec: deckpress_core::builder::BuilderSpec,
    page: u32,
) -> AppResult<deckpress_core::builder::SuggestionPage> {
    state.builder.suggest(&spec, page.clamp(1, 100)).await
}

#[tauri::command]
pub fn builder_summary(
    state: State<'_, AppState>,
    spec: deckpress_core::builder::BuilderSpec,
    entries: Vec<deckpress_core::models::DeckEntry>,
) -> AppResult<deckpress_core::builder::Summary> {
    state.builder.summary(&spec, &entries)
}

#[tauri::command]
pub async fn builder_fill(
    state: State<'_, AppState>,
    spec: deckpress_core::builder::BuilderSpec,
    entries: Vec<deckpress_core::models::DeckEntry>,
) -> AppResult<Vec<deckpress_core::models::DeckEntry>> {
    state.builder.fill(&spec, &entries).await
}
