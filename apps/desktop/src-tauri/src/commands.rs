//! Tauri commands: the whole application API the webview can call. Each one
//! maps to a former `/api/*` route; errors serialize as plain strings.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::images::{Images, UploadInput};
use crate::jobs::Jobs;
use crate::models::{
    Art, ArtPage, ArtPreference, Deck, ImportLine, NewDeck, PrintJob, PrintSettings, ResolvedCards,
};
use crate::providers::Providers;
use crate::store::Store;
use crate::upscaler::manifest::{default_model_id, ModelManager, ModelStatus};
use crate::upscaler::UpscalerInfo;

pub struct AppState {
    pub data_dir: PathBuf,
    pub store: Arc<Store>,
    pub providers: Arc<Providers>,
    pub images: Arc<Images>,
    pub models: Arc<ModelManager>,
    pub jobs: Arc<Jobs>,
}

impl AppState {
    pub fn new(data_dir: &Path, resource_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let store = Arc::new(Store::open(&data_dir.join("deckpress.sqlite"))?);
        let providers = Arc::new(Providers::new(Arc::clone(&store))?);
        let images = Arc::new(Images::new(data_dir, Arc::clone(&store))?);
        let models = Arc::new(ModelManager::new(resource_dir, data_dir)?);
        let jobs = Arc::new(Jobs::new(
            Arc::clone(&store),
            Arc::clone(&images),
            Arc::clone(&models),
            data_dir,
        )?);
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            store,
            providers,
            images,
            models,
            jobs,
        })
    }
}

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
    let upscaler = tauri::async_runtime::spawn_blocking(move || models.upscaler(&id)).await??;
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
    if preference.rating > 5 || preference.tags.len() > 50 {
        return Err(AppError::user(
            "Rating must be 0-5 and labels are limited to 50",
        ));
    }
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
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub fn open_pdf(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let path = state.jobs.pdf_path(&id)?;
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| AppError::user(format!("Could not open the PDF: {error}")))
}

#[tauri::command]
pub fn reveal_pdf(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let path = state.jobs.pdf_path(&id)?;
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|error| AppError::user(format!("Could not show the PDF: {error}")))
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
pub fn open_data_dir(state: State<'_, AppState>) -> AppResult<()> {
    tauri_plugin_opener::open_path(&state.data_dir, None::<&str>)
        .map_err(|error| AppError::user(format!("Could not open the data folder: {error}")))
}
