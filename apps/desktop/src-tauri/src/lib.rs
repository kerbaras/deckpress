//! Deckpress desktop: a thin Tauri shell over `deckpress_core`. `commands`
//! maps IPC calls onto the core services, `protocol` serves images to `<img>`
//! tags, `window` handles the custom title bar.

pub mod commands;
pub mod protocol;
pub mod window;

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
            let runtime = tauri::async_runtime::handle().inner().clone();
            let state = AppState::open(&data_dir(app), &resource_dir, runtime)?;
            log::info!("Deckpress data in {}", state.data_dir.display());
            app.manage(state);
            window::setup(app)?;
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
            commands::match_art_style,
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
            window::window_chrome,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Deckpress");
}
