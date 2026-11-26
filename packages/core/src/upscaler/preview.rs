use std::time::Instant;

use image::{imageops::crop_imm, RgbImage};
use serde::Serialize;

use super::{manifest::ModelManager, CancelToken, Upscaler};
use crate::error::AppResult;
use crate::models::{Art, PrintSettings};
use crate::raster::{encode_png, parse_hex_color, resize, strip_bleed, to_rgb};

const CONTEXT: u32 = 256;
const CROP_WIDTH: u32 = 56;
const CROP_HEIGHT: u32 = 36;
const SCALE: u32 = 4;

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

fn render(context: &RgbImage, text_y: u32, model: Option<&dyn Upscaler>) -> AppResult<CropPreview> {
    let start = Instant::now();
    let output = match model {
        Some(model) => model.upscale(context, &CancelToken::default(), &mut |_, _| {})?,
        None => resize(context, context.width() * SCALE, context.height() * SCALE)?,
    };
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let width = output.width().min(CROP_WIDTH * SCALE);
    let height = output.height().min(CROP_HEIGHT * SCALE);
    let crop = crop_imm(
        &output,
        (output.width() - width) / 2,
        (text_y * SCALE)
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
) -> AppResult<Vec<ModelCrop>> {
    settings.validate()?;
    let decoded = to_rgb(
        crate::images::decode(source)?,
        parse_hex_color(&settings.bleed_color),
    );
    let face = strip_bleed(&decoded, art, settings);
    let width = face.width().min(CONTEXT);
    let height = face.height().min(CONTEXT);
    let center_y = (f64::from(face.height()) * 0.78).round() as u32;
    let top = center_y
        .saturating_sub(height / 2)
        .min(face.height() - height);
    let context = crop_imm(&face, (face.width() - width) / 2, top, width, height).to_image();

    let mut crops = vec![ModelCrop {
        model_id: None,
        result: CropResult::Ready {
            crop: render(&context, center_y - top, None)?,
        },
    }];
    for status in models
        .status()
        .into_iter()
        .filter(|status| status.installed)
    {
        let id = status.spec.id;
        let result = match models
            .upscaler(&id)
            .and_then(|model| render(&context, center_y - top, Some(model.as_ref())))
        {
            Ok(crop) => CropResult::Ready { crop },
            Err(error) => CropResult::Failed {
                error: error.to_string(),
            },
        };
        crops.push(ModelCrop {
            model_id: Some(id),
            result,
        });
    }
    Ok(crops)
}
