use std::io::Cursor;

use deckpress_core::cut_svg;
use deckpress_core::layout;
use deckpress_core::models::{Deck, PrintSettings};
use deckpress_core::pdf;
use deckpress_core::png_export;
use deckpress_core::scm;
use deckpress_core::upscaler::CancelToken;
use deckpress_core::validate::validate_entries;
use deckpress_core::{AppError, AppResult};
use js_sys::{JsString, Map, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Map<string, Uint8Array>")]
    pub type ImageBytes;
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn settings(json: &str) -> Result<PrintSettings, JsError> {
    let settings: PrintSettings = serde_json::from_str(json).map_err(js_error)?;
    settings.validate().map_err(js_error)?;
    Ok(settings)
}

fn deck(json: &str) -> Result<Deck, JsError> {
    let deck: Deck = serde_json::from_str(json).map_err(js_error)?;
    validate_entries(&deck.entries).map_err(js_error)?;
    Ok(deck)
}

fn lookup(images: &ImageBytes, key: &str) -> AppResult<Vec<u8>> {
    let images = images
        .dyn_ref::<Map<JsString, JsValue>>()
        .ok_or_else(|| AppError::user("Image bytes must be provided as a Map"))?;
    let bytes = images
        .get_checked(&JsString::from(key))
        .ok_or_else(|| AppError::not_found(format!("No image bytes for {key}")))?;
    let bytes = bytes
        .dyn_ref::<Uint8Array>()
        .ok_or_else(|| AppError::user(format!("Image bytes for {key} must be a Uint8Array")))?;
    Ok(bytes.to_vec())
}

/// Images are encoded PNG/JPEG/WebP, keyed by the deck's art imageUrl.
/// Supply the upscaler's encoded output here to use externally upscaled art.
#[wasm_bindgen(js_name = buildPdf)]
pub fn build_pdf(
    settings_json: &str,
    deck_json: &str,
    images: &ImageBytes,
) -> Result<Vec<u8>, JsError> {
    let output =
        pdf::build_pdf_from_images(&deck(deck_json)?, &settings(settings_json)?, &mut |key| {
            lookup(images, key)
        })
        .map_err(js_error)?;
    Ok(output.bytes)
}

/// Uses the same encoded image inputs as buildPdf. No inference is run.
#[wasm_bindgen(js_name = buildPngZip)]
pub fn build_png_zip(
    settings_json: &str,
    deck_json: &str,
    images: &ImageBytes,
) -> Result<Vec<u8>, JsError> {
    let mut settings = settings(settings_json)?;
    settings.upscale = false;
    let mut output = Cursor::new(Vec::new());
    png_export::build_png_zip(
        &deck(deck_json)?,
        &settings,
        None,
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |key| lookup(images, key),
        &mut output,
    )
    .map_err(js_error)?;
    Ok(output.into_inner())
}

#[wasm_bindgen(js_name = buildCutSvg)]
pub fn build_cut_svg(settings_json: &str) -> Result<String, JsError> {
    cut_svg::build_cut_svg(&settings(settings_json)?).map_err(js_error)
}

/// Coordinates are in PDF points, measured from the top left.
#[wasm_bindgen(js_name = layoutJson)]
pub fn layout_json(settings_json: &str) -> Result<String, JsError> {
    let layout = layout::create_layout(&settings(settings_json)?).map_err(js_error)?;
    serde_json::to_string(&layout).map_err(js_error)
}

#[wasm_bindgen(js_name = scmTemplatesJson)]
pub fn scm_templates_json() -> String {
    scm::TEMPLATE_CATALOG_JSON.into()
}

#[wasm_bindgen(js_name = scmCuttingTemplatesJson)]
pub fn scm_cutting_templates_json() -> String {
    scm::CUTTING_TEMPLATES_JSON.into()
}
