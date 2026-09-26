//! Tauri commands: the whole application API the webview can call. Each one
//! maps to a former `/api/*` route; errors serialize as plain strings.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use deckpress_core::decksearch::{DeckQuery, DeckSearchPage, DeckSource, ExternalDeck};
use deckpress_core::error::{AppError, AppResult};
use deckpress_core::images::UploadInput;
use deckpress_core::models::{
    Art, ArtPage, ArtPreference, Deck, ImportLine, NewDeck, PrintJob, PrintSettings, ResolvedCards,
};
use deckpress_core::style::{StyleReport, StyleRequest};
use deckpress_core::upscaler::manifest::{default_model_id, ModelStatus};
use deckpress_core::upscaler::UpscalerInfo;

pub type AppState = deckpress_core::Core;

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
    })
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
pub fn list_decks(state: State<'_, AppState>) -> AppResult<Vec<Deck>> {
    let mut decks = state.store.list::<Deck>("deck")?;
    decks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(decks)
}

#[tauri::command]
pub fn get_deck(state: State<'_, AppState>, id: String) -> AppResult<Deck> {
    state
        .store
        .get::<Deck>("deck", &id)?
        .ok_or_else(|| AppError::not_found("Deck not found"))
}

#[tauri::command]
pub fn create_deck(state: State<'_, AppState>, deck: NewDeck) -> AppResult<Deck> {
    state.store.create_deck(deck)
}

#[tauri::command]
pub fn save_deck(state: State<'_, AppState>, deck: Deck) -> AppResult<Deck> {
    state.store.update_deck(deck)
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
) -> AppResult<ResolvedCards> {
    if lines.len() > 1000 {
        return Err(AppError::user("Decklists are limited to 1000 lines"));
    }
    state.providers.resolve(lines).await
}

#[tauri::command]
pub async fn search_art(
    state: State<'_, AppState>,
    provider: String,
    oracle_id: String,
    name: String,
    face: usize,
    page: u32,
) -> AppResult<ArtPage> {
    let page = page.clamp(1, 100);
    match provider.as_str() {
        "scryfall" => state.providers.prints(&oracle_id, page, face.min(1)).await,
        "mpc" => state.providers.community(&name, page).await,
        _ => Err(AppError::user("Unknown art provider")),
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeta {
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub bleed_mm: f64,
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
    if !(0.0..=10.0).contains(&meta.bleed_mm) {
        return Err(AppError::user("Bleed must be between 0 and 10 mm"));
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
) -> AppResult<PrintJob> {
    let deck = state
        .store
        .get::<Deck>("deck", &deck_id)?
        .ok_or_else(|| AppError::not_found("Deck not found"))?;
    state.jobs.create(deck, settings)
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
    let path = state.jobs.pdf_path(&id)?;
    with_desktop("open the PDF", move || {
        tauri_plugin_opener::open_path(path, None::<&str>)
    })
    .await
}

#[tauri::command]
pub async fn reveal_pdf(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let path = state.jobs.pdf_path(&id)?;
    with_desktop("show the PDF", move || {
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
    let source = state.jobs.pdf_path(&id)?;
    let destination = PathBuf::from(destination);
    if destination.extension().and_then(|e| e.to_str()) != Some("pdf") {
        return Err(AppError::user("Save the export as a .pdf file"));
    }
    Ok(tokio::fs::copy(source, destination).await?)
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
