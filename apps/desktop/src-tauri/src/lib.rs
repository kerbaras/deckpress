//! Deckpress desktop: Rust core behind Tauri commands. See `commands` for the
//! API the webview calls and `protocol` for how images reach `<img>` tags.

pub mod commands;
pub mod error;
pub mod images;
pub mod jobs;
pub mod layout;
pub mod models;
pub mod pdf;
pub mod protocol;
pub mod providers;
pub mod raster;
pub mod store;
pub mod upscaler;

use std::path::PathBuf;

use tauri::Manager;

use commands::AppState;

fn data_dir(app: &tauri::App) -> PathBuf {
    if let Some(dir) = std::env::var_os("DECKPRESS_DATA_DIR") {
        return PathBuf::from(dir);
    }
    app.path()
        .app_data_dir()
        .expect("platform app data directory")
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(protocol::IMAGE_SCHEME, protocol::handle)
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?.join("resources");
            let state = AppState::new(&data_dir(app), &resource_dir)?;
            state.jobs.start();
            log::info!("Deckpress data in {}", state.data_dir.display());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::settings,
            commands::download_model,
            commands::load_model,
            commands::list_decks,
            commands::get_deck,
            commands::create_deck,
            commands::save_deck,
            commands::delete_deck,
            commands::import_url,
            commands::resolve_cards,
            commands::search_art,
            commands::preferences,
            commands::save_preference,
            commands::list_uploads,
            commands::upload_art,
            commands::list_jobs,
            commands::create_job,
            commands::cancel_job,
            commands::open_pdf,
            commands::reveal_pdf,
            commands::save_pdf,
            commands::save_text,
            commands::open_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Deckpress");
}
