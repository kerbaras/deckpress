//! Window chrome. macOS keeps the native title bar in overlay mode (see
//! `tauri.macos.conf.json`) so the traffic lights sit on top of the app's own
//! toolbar. Linux and Windows drop the system decorations and the webview
//! draws the title bar and window controls itself. Set
//! `DECKPRESS_NATIVE_DECORATIONS=1` to keep the window manager's frame.

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChrome {
    pub platform: &'static str,
    /// The webview draws minimize/maximize/close buttons and resize edges.
    pub custom_controls: bool,
    /// Left inset, in CSS px, reserved for the macOS traffic lights.
    pub inset_left: u16,
}

pub fn chrome() -> WindowChrome {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    WindowChrome {
        platform,
        custom_controls: !cfg!(target_os = "macos") && !native_decorations(),
        inset_left: if cfg!(target_os = "macos") { 78 } else { 0 },
    }
}

fn native_decorations() -> bool {
    std::env::var_os("DECKPRESS_NATIVE_DECORATIONS").is_some_and(|value| value != "0")
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    if chrome().custom_controls {
        if let Some(window) = app.get_webview_window("main") {
            window.set_decorations(false)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn window_chrome() -> WindowChrome {
    chrome()
}
