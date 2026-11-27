use std::io::Cursor;

use image::{DynamicImage, ImageFormat, RgbImage};
use serde::Deserialize;

use crate::models::{Art, Provider, Upload};
use crate::raster::{decode, detect_upload_bleed, encode_png, strip_bleed, to_rgb, UPLOAD_CARD_MM};
use crate::{AppError, AppResult};

pub const UPLOAD_SCHEME: &str = "upload://";
pub const THUMBNAIL_EDGE: u32 = 480;
const MAX_UPLOAD: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadInput {
    pub oracle_id: String,
    pub name: String,
    pub artist: String,
    pub bleed_mm: Option<f64>,
}

pub(crate) fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok().filter(|format| {
        matches!(
            format,
            ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
        )
    })
}

pub fn prepare(
    bytes: &[u8],
    input: UploadInput,
    id: &str,
    released_at: String,
) -> AppResult<(Upload, DynamicImage)> {
    if bytes.len() > MAX_UPLOAD {
        return Err(AppError::user("Uploads are limited to 16 MB"));
    }
    if sniff(bytes).is_none() {
        return Err(AppError::user("Use PNG, JPEG or WebP"));
    }
    if input.name.trim().is_empty() || input.name.chars().count() > 300 {
        return Err(AppError::user("Give the upload a name"));
    }
    validate_bleed(input.bleed_mm)?;
    let image = decode(bytes)?;
    let (bleed_mm, dpi) = resolution(image.width(), image.height(), input.bleed_mm);
    let image_url = format!("{UPLOAD_SCHEME}{id}");
    let art = Art {
        id: format!("upload:{id}"),
        provider: Provider::Upload,
        name: input.name.trim().to_string(),
        artist: if input.artist.trim().is_empty() {
            "My upload".into()
        } else {
            input.artist.trim().chars().take(200).collect()
        },
        source: "My uploads".into(),
        source_url: String::new(),
        art_crop_url: String::new(),
        thumbnail_url: image_url.clone(),
        image_url,
        set: String::new(),
        collector_number: String::new(),
        language: "en".into(),
        illustration_id: None,
        scan_quality: None,
        bleed_mm,
        dpi,
        released_at,
        tags: vec!["custom".into()],
        back_image_url: String::new(),
        back_thumbnail_url: String::new(),
        english_fallback: false,
    };
    Ok((
        Upload {
            oracle_id: input.oracle_id,
            art,
            bleed_auto: input.bleed_mm.is_none(),
        },
        image,
    ))
}

pub fn set_bleed(bytes: &[u8], upload: &mut Upload, bleed_mm: Option<f64>) -> AppResult<()> {
    validate_bleed(bleed_mm)?;
    let image = decode(bytes)?;
    let (bleed, dpi) = resolution(image.width(), image.height(), bleed_mm);
    upload.art.bleed_mm = bleed;
    upload.art.dpi = dpi;
    upload.bleed_auto = bleed_mm.is_none();
    Ok(())
}

pub fn encode_original(image: DynamicImage) -> AppResult<Vec<u8>> {
    let mut png = Cursor::new(Vec::new());
    image.to_rgba8().write_to(&mut png, ImageFormat::Png)?;
    Ok(png.into_inner())
}

pub fn trim(bytes: &[u8], art: Art, bleed_mm: f64) -> AppResult<RgbImage> {
    let art = Art { bleed_mm, ..art };
    let rgb = to_rgb(decode(bytes)?, image::Rgb([255; 3]));
    Ok(strip_bleed(&rgb, &art, &Default::default()))
}

pub fn snapshot(bytes: Vec<u8>, art: Art, bleed_mm: f64, thumbnail: bool) -> AppResult<Vec<u8>> {
    validate_bleed(Some(bleed_mm))?;
    if bleed_mm == 0.0 {
        return Ok(bytes);
    }
    let rgb = trim(&bytes, art, bleed_mm)?;
    let rgb = if thumbnail && rgb.width().max(rgb.height()) > THUMBNAIL_EDGE {
        DynamicImage::ImageRgb8(rgb)
            .thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE)
            .into_rgb8()
    } else {
        rgb
    };
    encode_png(&rgb)
}

pub fn validate_bleed(bleed_mm: Option<f64>) -> AppResult<()> {
    if bleed_mm.is_some_and(|bleed| !(0.0..=10.0).contains(&bleed)) {
        return Err(AppError::user("Bleed must be between 0 and 10 mm"));
    }
    Ok(())
}

fn resolution(width: u32, height: u32, declared_bleed: Option<f64>) -> (f64, f64) {
    let bleed = declared_bleed.unwrap_or_else(|| detect_upload_bleed(width, height));
    let dpi = f64::min(
        f64::from(width) / ((UPLOAD_CARD_MM.0 + 2.0 * bleed) / 25.4),
        f64::from(height) / ((UPLOAD_CARD_MM.1 + 2.0 * bleed) / 25.4),
    )
    .round()
    .clamp(1.0, 10_000.0);
    (bleed, dpi)
}
