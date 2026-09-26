//! `dpimg://localhost/<kind>/<payload>` serves images to the webview so `<img>`
//! tags work without a local HTTP server.
//!
//! - `image/<url>`: the cached original for a Scryfall, Google Drive or
//!   `upload://` art URL.
//! - `preview/<json {art, settings}>`: the 150 DPI print preview of one face
//!   (no upscaling), rendered with the same pipeline as the export.

use std::sync::Arc;

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::commands::AppState;
use deckpress_core::error::{AppError, AppResult};
use deckpress_core::images::{mime_for, Images};
use deckpress_core::models::{Art, PrintSettings};
use deckpress_core::raster::{encode_jpeg, rasterize, PIPELINE_VERSION};
use deckpress_core::upscaler::CancelToken;

pub const IMAGE_SCHEME: &str = "dpimg";
pub const PREVIEW_DPI: u32 = 150;

#[derive(Debug, Deserialize)]
struct PreviewRequest {
    art: Art,
    #[serde(default)]
    settings: PrintSettings,
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CACHE_CONTROL,
            if status.is_success() {
                "private, max-age=86400"
            } else {
                "no-store"
            },
        )
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

async fn preview(
    images: &Images,
    preview_dir: &std::path::Path,
    payload: &str,
) -> AppResult<Vec<u8>> {
    let request: PreviewRequest =
        serde_json::from_str(payload).map_err(|_| AppError::user("Invalid preview request"))?;
    let settings = PrintSettings {
        dpi: PREVIEW_DPI,
        upscale: false,
        ..request.settings
    };
    let source = images.read(&request.art.image_url).await?;
    let mut hasher = Sha256::new();
    hasher.update(&source);
    hasher.update(
        serde_json::json!([
            PIPELINE_VERSION,
            request.art.bleed_mm,
            request.art.provider,
            settings.card_width_mm,
            settings.card_height_mm,
            settings.bleed_mm,
            settings.bleed_mode,
            settings.bleed_color,
        ])
        .to_string(),
    );
    let path = preview_dir.join(format!("{}.jpg", hex::encode(hasher.finalize())));
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }
    let art = request.art;
    let dir = preview_dir.to_path_buf();
    tokio::task::spawn_blocking(move || -> AppResult<Vec<u8>> {
        let output = rasterize(
            &source,
            &art,
            &settings,
            None,
            &CancelToken::default(),
            &mut |_, _| {},
        )?;
        let bytes = encode_jpeg(&output.image, 85)?;
        std::fs::create_dir_all(&dir)?;
        let tmp = path.with_extension(format!("part-{}", deckpress_core::models::new_id()));
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(bytes)
    })
    .await?
}

async fn serve(state: Arc<Served>, path: String) -> Response<Vec<u8>> {
    let decoded = percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy();
    let (kind, payload) = match decoded.split_once('/') {
        Some(parts) => parts,
        None => return respond(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec()),
    };
    let result = match kind {
        "image" => state.images.read(payload).await,
        "preview" => preview(&state.images, &state.preview_dir, payload).await,
        _ => Err(AppError::not_found("Not found")),
    };
    match result {
        Ok(bytes) => {
            let mime = if kind == "preview" {
                "image/jpeg"
            } else {
                mime_for(&bytes)
            };
            respond(StatusCode::OK, mime, bytes)
        }
        Err(error) => {
            let status = match &error {
                AppError::NotFound(_) => StatusCode::NOT_FOUND,
                AppError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
                AppError::User(_) | AppError::Conflict(_) => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            respond(status, "text/plain", error.to_string().into_bytes())
        }
    }
}

struct Served {
    images: Arc<Images>,
    preview_dir: std::path::PathBuf,
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let state = ctx.app_handle().state::<AppState>();
    let served = Arc::new(Served {
        images: Arc::clone(&state.images),
        preview_dir: state.data_dir.join("preview"),
    });
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn(async move {
        responder.respond(serve(served, path).await);
    });
}
