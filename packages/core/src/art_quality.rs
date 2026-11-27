#[cfg(feature = "native")]
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};

#[cfg(feature = "native")]
use crate::images::{decode, Images};
use crate::models::{Art, PrintSettings, Provider};
use crate::raster::{below_upscale_threshold, fitted_art_dimensions, trim_bounds, trim_pixels};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanQuality {
    Missing,
    Placeholder,
    Lowres,
    HighresScan,
}

pub fn scryfall_quality(status: Option<&str>, highres: Option<bool>) -> Option<ScanQuality> {
    match status {
        Some("missing") => Some(ScanQuality::Missing),
        Some("placeholder") => Some(ScanQuality::Placeholder),
        Some("lowres") => Some(ScanQuality::Lowres),
        Some("highres_scan") => Some(ScanQuality::HighresScan),
        _ => highres.map(|value| {
            if value {
                ScanQuality::HighresScan
            } else {
                ScanQuality::Lowres
            }
        }),
    }
}

pub fn prefer_high_res<'a>(
    selected: &'a Art,
    candidates: impl IntoIterator<Item = &'a Art>,
) -> &'a Art {
    let Some(illustration) = selected.illustration_id else {
        return selected;
    };
    if selected.provider != Provider::Scryfall {
        return selected;
    }
    candidates.into_iter().fold(selected, |best, art| {
        if art.provider == Provider::Scryfall
            && art.illustration_id == Some(illustration)
            && art.language == selected.language
            && art.scan_quality >= Some(ScanQuality::Lowres)
            && art.scan_quality > best.scan_quality
        {
            art
        } else {
            best
        }
    })
}

pub fn effective_dpi(width: u32, height: u32, art: &Art, settings: &PrintSettings) -> f64 {
    assess_source(width, height, art, settings).effective_dpi
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReading {
    pub effective_dpi: f64,
    pub below_upscale_threshold: bool,
}

pub fn assess_source(
    width: u32,
    height: u32,
    art: &Art,
    settings: &PrintSettings,
) -> SourceReading {
    let (_, _, width, height) = trim_bounds(width, height, art, settings);
    let target = trim_pixels(settings);
    let target = (target.0.max(1), target.1.max(1));
    let (fitted_w, fitted_h) = fitted_art_dimensions((width, height), target, art, settings);
    let fitted_width_mm = settings.card_width_mm * f64::from(fitted_w) / f64::from(target.0);
    let fitted_height_mm = settings.card_height_mm * f64::from(fitted_h) / f64::from(target.1);
    SourceReading {
        effective_dpi: 25.4
            * (f64::from(width) / fitted_width_mm).min(f64::from(height) / fitted_height_mm),
        below_upscale_threshold: below_upscale_threshold(width, height, fitted_w, fitted_h),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerDpi {
    pub effective_dpi: f64,
    pub estimated: bool,
}

#[cfg(feature = "native")]
fn scryfall_format_size(url: &str) -> Option<(u32, u32)> {
    let url = url::Url::parse(url).ok()?;
    if url.host_str()? != "cards.scryfall.io" {
        return None;
    }
    match url.path_segments()?.next()? {
        "png" => Some((745, 1040)),
        "large" => Some((672, 936)),
        "normal" => Some((488, 680)),
        _ => None,
    }
}

#[cfg(feature = "native")]
pub async fn picker_dpi(
    images: &Images,
    arts: Vec<Art>,
    settings: &PrintSettings,
) -> Vec<Option<PickerDpi>> {
    stream::iter(arts)
        .map(|art| async move {
            let cached = match images.local_path(&art.image_url) {
                Ok(path) => {
                    tokio::task::spawn_blocking(move || crate::images::file_dimensions(&path).ok())
                        .await
                        .ok()
                        .flatten()
                }
                Err(_) => None,
            };
            let (width, height) = cached.or_else(|| {
                (art.provider == Provider::Scryfall)
                    .then(|| scryfall_format_size(&art.image_url))
                    .flatten()
            })?;
            Some(PickerDpi {
                effective_dpi: effective_dpi(width, height, &art, settings),
                estimated: cached.is_none(),
            })
        })
        .buffered(4)
        .collect()
        .await
}

#[cfg(feature = "native")]
pub async fn source_dpi(
    images: &Images,
    arts: Vec<Art>,
    settings: &PrintSettings,
) -> Vec<Option<SourceReading>> {
    stream::iter(arts)
        .map(|art| async move {
            let bytes = images.read(&art.image_url).await.ok()?;
            let settings = settings.clone();
            tokio::task::spawn_blocking(move || {
                let image = decode(&bytes).ok()?;
                Some(assess_source(
                    image.width(),
                    image.height(),
                    &art,
                    &settings,
                ))
            })
            .await
            .ok()
            .flatten()
        })
        .buffered(4)
        .collect()
        .await
}
