//! Window chrome. macOS keeps the native title bar in overlay mode (see
//! `tauri.macos.conf.json`) so the traffic lights sit on top of the app's own
//! toolbar. Linux and Windows drop the system decorations and the webview
//! draws the title bar and window controls itself. Set
//! `DECKPRESS_NATIVE_DECORATIONS=1` to keep the window manager's frame.

use std::time::Duration;

use deckpress_core::{store::Appearance, AppResult};
#[cfg(target_os = "linux")]
use gtk::prelude::{CssProviderExt, GtkSettingsExt, StyleContextExt, WidgetExt};
use serde::Serialize;
use tauri::{window::Color, AppHandle, State, WebviewWindow, WebviewWindowBuilder};

use crate::commands::AppState;

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

pub fn setup(app: &tauri::App, appearance: Option<Appearance>) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("main window configuration");
    let mut builder = WebviewWindowBuilder::from_config(app, config)?;
    if chrome().custom_controls {
        builder = builder.decorations(false);
    }
    if let Some(appearance) = appearance {
        builder = builder.initialization_script(format!(
            "window.deckpressInitialAppearance = {};",
            serde_json::json!(appearance)
        ));
    }
    #[cfg(target_os = "linux")]
    {
        use tauri::Theme;
        let explicit = match appearance {
            Some(Appearance::Dark) => Some(Theme::Dark),
            Some(Appearance::Light) => Some(Theme::Light),
            _ => None,
        };
        let dark = explicit.map_or_else(
            || {
                gtk::Settings::default()
                    .is_some_and(|gtk| gtk.is_gtk_application_prefer_dark_theme())
            },
            |theme| theme == Theme::Dark,
        );
        if let (Some(theme), Some(gtk)) = (explicit, gtk::Settings::default()) {
            gtk.set_gtk_application_prefer_dark_theme(theme == Theme::Dark);
        }
        builder = builder.theme(explicit).background_color(canvas_color(dark));
    }
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    {
        if let (Some(Appearance::Dark | Appearance::Light), Some(gtk)) =
            (appearance, gtk::Settings::default())
        {
            // Tao can apply the desktop portal setting when it creates the GTK window.
            gtk.set_gtk_application_prefer_dark_theme(appearance == Some(Appearance::Dark));
        }
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if matches!(window.is_visible(), Ok(false)) && !matches!(window.is_minimized(), Ok(true)) {
            if let Err(error) = window.show() {
                log::warn!("Could not reveal the main window: {error}");
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_gtk_backdrop(window: &gtk::ApplicationWindow, canvas: Color) {
    let Color(red, green, blue, _) = canvas;
    let css = gtk::CssProvider::new();
    let rule = format!(
        "window {{ background-image: none; background-color: rgb({red}, {green}, {blue}); }}"
    );
    if let Err(error) = css.load_from_data(rule.as_bytes()) {
        log::warn!("Could not set the GTK window backdrop: {error}");
        return;
    }
    window
        .style_context()
        .add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
}

#[cfg(target_os = "linux")]
fn canvas_color(dark: bool) -> Color {
    let css = include_str!("../../../web/src/tokens.css");
    let (dark_tokens, light_tokens) = css
        .split_once(":root[data-theme=\"light\"]")
        .expect("light appearance tokens");
    let tokens = if dark { dark_tokens } else { light_tokens };
    tokens
        .split_once("--canvas:")
        .and_then(|(_, tail)| tail.split_once(';'))
        .and_then(|(color, _)| color.trim().parse().ok())
        .expect("canvas token must be a native display color")
}

#[tauri::command]
pub fn show_themed_window(window: WebviewWindow, canvas: Color) -> tauri::Result<()> {
    let main = window.clone();
    window.run_on_main_thread(move || {
        let show = || -> tauri::Result<()> {
            #[cfg(target_os = "linux")]
            set_gtk_backdrop(&main.gtk_window()?, canvas);
            main.set_background_color(Some(canvas))?;
            main.show()
        };
        if let Err(error) = show() {
            log::warn!("Could not show the themed window: {error}");
        }
    })
}

#[tauri::command]
pub fn save_appearance(
    app: AppHandle,
    state: State<'_, AppState>,
    appearance: Appearance,
) -> AppResult<()> {
    state.store.set_appearance(appearance)?;
    #[cfg(target_os = "linux")]
    if appearance == Appearance::System {
        app.run_on_main_thread(|| {
            if let Some(gtk) = gtk::Settings::default() {
                gtk.reset_property("gtk-application-prefer-dark-theme");
            }
        })
        .map_err(deckpress_core::AppError::internal)?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn window_chrome() -> WindowChrome {
    chrome()
}
