use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::images::{decode, Images};
use crate::models::{Art, PrintSettings, Provider};
use crate::raster::trim_bounds;

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
    let (_, _, width, height) = trim_bounds(width, height, art, settings);
    25.4 * (f64::from(width) / settings.card_width_mm)
        .min(f64::from(height) / settings.card_height_mm)
}

pub async fn source_dpi(
    images: &Images,
    arts: Vec<Art>,
    settings: &PrintSettings,
) -> Vec<Option<f64>> {
    stream::iter(arts)
        .map(|art| async move {
            let bytes = images.read(&art.image_url).await.ok()?;
            let settings = settings.clone();
            tokio::task::spawn_blocking(move || {
                let image = decode(&bytes).ok()?;
                Some(effective_dpi(
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
