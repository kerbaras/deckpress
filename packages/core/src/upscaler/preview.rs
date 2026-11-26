use std::sync::Arc;
use std::time::Instant;

use image::{imageops::crop_imm, RgbImage};
use serde::{Deserialize, Serialize};

use super::{manifest::ModelManager, CancelToken, Upscaler};
use crate::error::{AppError, AppResult};
use crate::models::{Art, PrintSettings};
use crate::raster::{encode_png, parse_hex_color, resize, strip_bleed, to_rgb};

const CONTEXT: u32 = 256;
const CROP_WIDTH: u32 = 56;
const CROP_HEIGHT: u32 = 36;
const SCALE: u32 = 4;
const THUMBNAIL_SIZE: u32 = 180;

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CropPosition {
    pub x: f64,
    pub y: f64,
}

impl Default for CropPosition {
    fn default() -> Self {
        Self { x: 0.5, y: 0.78 }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropPreview {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub elapsed_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCrop {
    pub model_id: Option<String>,
    #[serde(flatten)]
    pub result: CropResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum CropResult {
    Ready { crop: CropPreview },
    Failed { error: String },
}

fn render(
    context: &RgbImage,
    center: (u32, u32),
    model: Option<&dyn Upscaler>,
    cancel: &CancelToken,
) -> AppResult<CropPreview> {
    cancel.check()?;
    let start = Instant::now();
    let output = match model {
        Some(model) => model.upscale(context, cancel, &mut |_, _| {})?,
        None => resize(context, context.width() * SCALE, context.height() * SCALE)?,
    };
    cancel.check()?;
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let width = output.width().min(CROP_WIDTH * SCALE);
    let height = output.height().min(CROP_HEIGHT * SCALE);
    let crop = crop_imm(
        &output,
        (center.0 * SCALE)
            .saturating_sub(width / 2)
            .min(output.width() - width),
        (center.1 * SCALE)
            .saturating_sub(height / 2)
            .min(output.height() - height),
        width,
        height,
    );
    Ok(CropPreview {
        png: encode_png(&crop.to_image())?,
        width,
        height,
        elapsed_ms,
    })
}

/// Compare the same patch of the rules box at native 4× output pixels.
/// Each inference gets the surrounding scan pixels as context.
pub fn compare(
    source: &[u8],
    art: &Art,
    settings: &PrintSettings,
    models: &ModelManager,
    cancel: &CancelToken,
) -> AppResult<Vec<ModelCrop>> {
    compare_at(
        source,
        art,
        settings,
        models,
        CropPosition::default(),
        cancel,
    )
}

/// Compare a normalized position on the trimmed card face.
pub fn compare_at(
    source: &[u8],
    art: &Art,
    settings: &PrintSettings,
    models: &ModelManager,
    position: CropPosition,
    cancel: &CancelToken,
) -> AppResult<Vec<ModelCrop>> {
    cancel.check()?;
    compare_models_at(
        source,
        art,
        settings,
        models
            .status()
            .into_iter()
            .filter(|status| status.installed)
            .map(|status| status.spec.id),
        |id| models.upscaler_cancellable(id, cancel),
        position,
        cancel,
    )
}

pub fn compare_models(
    source: &[u8],
    art: &Art,
    settings: &PrintSettings,
    ids: impl IntoIterator<Item = String>,
    load: impl Fn(&str) -> AppResult<Arc<dyn Upscaler>>,
    cancel: &CancelToken,
) -> AppResult<Vec<ModelCrop>> {
    compare_models_at(
        source,
        art,
        settings,
        ids,
        load,
        CropPosition::default(),
        cancel,
    )
}

fn compare_models_at(
    source: &[u8],
    art: &Art,
    settings: &PrintSettings,
    ids: impl IntoIterator<Item = String>,
    load: impl Fn(&str) -> AppResult<Arc<dyn Upscaler>>,
    position: CropPosition,
    cancel: &CancelToken,
) -> AppResult<Vec<ModelCrop>> {
    cancel.check()?;
    if !(0.0..=1.0).contains(&position.x) || !(0.0..=1.0).contains(&position.y) {
        return Err(AppError::user("Crop position must be within the card"));
    }
    settings.validate()?;
    let face = card_face(source, art, settings)?;
    let width = face.width().min(CONTEXT);
    let height = face.height().min(CONTEXT);
    let center_x = ((f64::from(face.width()) * position.x).round() as u32).min(face.width() - 1);
    let center_y = ((f64::from(face.height()) * position.y).round() as u32).min(face.height() - 1);
    let left = center_x.saturating_sub(width / 2).min(face.width() - width);
    let top = center_y
        .saturating_sub(height / 2)
        .min(face.height() - height);
    let context = crop_imm(&face, left, top, width, height).to_image();
    let center = (center_x - left, center_y - top);

    let mut crops = vec![ModelCrop {
        model_id: None,
        result: CropResult::Ready {
            crop: render(&context, center, None, cancel)?,
        },
    }];
    for id in ids {
        cancel.check()?;
        let rendered =
            load(&id).and_then(|model| render(&context, center, Some(model.as_ref()), cancel));
        cancel.check()?;
        let result = match rendered {
            Ok(crop) => CropResult::Ready { crop },
            Err(AppError::Cancelled) => return Err(AppError::Cancelled),
            Err(error) => CropResult::Failed {
                error: error.to_string(),
            },
        };
        crops.push(ModelCrop {
            model_id: Some(id),
            result,
        });
    }
    cancel.check()?;
    Ok(crops)
}

fn card_face(source: &[u8], art: &Art, settings: &PrintSettings) -> AppResult<RgbImage> {
    let decoded = to_rgb(
        crate::images::decode(source)?,
        parse_hex_color(&settings.bleed_color),
    );
    Ok(strip_bleed(&decoded, art, settings))
}

pub fn thumbnail(source: &[u8], art: &Art, settings: &PrintSettings) -> AppResult<Vec<u8>> {
    settings.validate()?;
    let face = card_face(source, art, settings)?;
    let scale = f64::from(THUMBNAIL_SIZE) / f64::from(face.width().max(face.height()));
    if scale >= 1.0 {
        return encode_png(&face);
    }
    let width = (f64::from(face.width()) * scale).round().max(1.0) as u32;
    let height = (f64::from(face.height()) * scale).round().max(1.0) as u32;
    encode_png(&resize(&face, width, height)?)
}
