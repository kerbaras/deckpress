use serde::Deserialize;
use serde_json::Value;

use crate::art_quality::scryfall_quality;
use crate::error::{AppError, AppResult};
use crate::models::{Art, Card, Provider};

#[derive(Debug, Deserialize, Default)]
struct ScryfallImages {
    png: Option<String>,
    large: Option<String>,
    normal: Option<String>,
    art_crop: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScryfallFace {
    name: String,
    artist: Option<String>,
    image_uris: Option<ScryfallImages>,
    illustration_id: Option<uuid::Uuid>,
}

#[derive(Debug, Deserialize)]
struct ScryfallCard {
    id: String,
    oracle_id: Option<String>,
    name: String,
    #[serde(default)]
    type_line: String,
    #[serde(default)]
    mana_cost: String,
    #[serde(default)]
    cmc: f64,
    #[serde(default)]
    color_identity: Vec<String>,
    image_status: Option<String>,
    image_uris: Option<ScryfallImages>,
    card_faces: Option<Vec<ScryfallFace>>,
    illustration_id: Option<uuid::Uuid>,
    highres_image: Option<bool>,
    #[serde(default = "unknown")]
    artist: String,
    set: String,
    set_name: String,
    collector_number: String,
    #[serde(default)]
    lang: String,
    #[serde(default)]
    released_at: String,
    #[serde(default)]
    scryfall_uri: String,
    #[serde(default = "black")]
    border_color: String,
    #[serde(default)]
    frame: String,
    #[serde(default)]
    frame_effects: Vec<String>,
    #[serde(default)]
    full_art: bool,
    #[serde(default)]
    textless: bool,
    #[serde(default)]
    promo: bool,
}

fn unknown() -> String {
    "Unknown".into()
}
fn black() -> String {
    "black".into()
}

pub fn normalize_scryfall(value: &Value) -> AppResult<Card> {
    let card: ScryfallCard = serde_json::from_value(value.clone())
        .map_err(|error| AppError::user(format!("Unexpected Scryfall card data: {error}")))?;
    if matches!(
        card.image_status.as_deref(),
        Some("placeholder" | "missing")
    ) {
        return Err(AppError::user(
            "Scryfall has no usable scan for this printing",
        ));
    }
    let raw_faces: Vec<ScryfallFace> = match card.image_uris {
        Some(images) => vec![ScryfallFace {
            name: card.name.clone(),
            artist: Some(card.artist.clone()),
            image_uris: Some(images),
            illustration_id: card.illustration_id,
        }],
        None => card.card_faces.unwrap_or_default(),
    };
    let mut tags: Vec<String> = card.frame_effects.clone();
    if card.border_color == "borderless" {
        tags.push("borderless".into());
    }
    if card.full_art {
        tags.push("full art".into());
    }
    if card.textless {
        tags.push("textless".into());
    }
    if card.promo {
        tags.push("promo".into());
    }
    if card.frame == "1993" || card.frame == "1997" {
        tags.push("retro frame".into());
    }
    let mut faces: Vec<Art> = raw_faces
        .into_iter()
        .enumerate()
        .filter(|(_, face)| {
            face.image_uris
                .as_ref()
                .is_some_and(|images| images.png.is_some() || images.large.is_some())
        })
        .map(|(index, face)| {
            let images = face.image_uris.unwrap_or_default();
            let image_url = images.png.or(images.large).unwrap_or_default();
            Art {
                id: format!("scryfall:{}:{}", card.id, index),
                english_fallback: false,
                provider: Provider::Scryfall,
                name: face.name,
                thumbnail_url: images.normal.unwrap_or_else(|| image_url.clone()),
                image_url,
                art_crop_url: images.art_crop.unwrap_or_default(),
                source_url: card.scryfall_uri.clone(),
                source: card.set_name.clone(),
                artist: face.artist.unwrap_or_else(|| card.artist.clone()),
                set: card.set.clone(),
                collector_number: card.collector_number.clone(),
                language: card.lang.clone(),
                illustration_id: face.illustration_id,
                scan_quality: scryfall_quality(card.image_status.as_deref(), card.highres_image),
                released_at: card.released_at.clone(),
                dpi: 0.0,
                tags: tags.clone(),
                bleed_mm: 0.0,
                back_image_url: String::new(),
                back_thumbnail_url: String::new(),
                filename: None,
                content_hash: None,
            }
        })
        .collect();
    if faces.is_empty() {
        return Err(AppError::user(format!(
            "No printable scan available for {}",
            card.name
        )));
    }
    if faces.len() > 1 {
        let (back_image, back_thumb) = (faces[1].image_url.clone(), faces[1].thumbnail_url.clone());
        faces[0].back_image_url = back_image;
        faces[0].back_thumbnail_url = back_thumb;
    }
    Ok(Card {
        id: card.id.clone(),
        oracle_id: card.oracle_id.unwrap_or(card.id),
        name: card.name,
        type_line: card.type_line,
        mana_cost: card.mana_cost,
        mana_value: card.cmc,
        colors: card.color_identity,
        faces,
    })
}

pub(super) fn fold_name(name: &str) -> String {
    name.trim().to_lowercase()
}

pub(super) fn scryfall_print_number(raw: &Value) -> Option<(&str, &str)> {
    let set = raw.get("set")?.as_str()?;
    let collector = raw.get("collector_number")?.as_str()?;
    (!set.is_empty() && !collector.is_empty()).then_some((set, collector))
}

pub(super) fn scryfall_name_matches(raw: &Value, wanted: &str) -> bool {
    ["name", "printed_name"].iter().any(|key| {
        raw.get(key)
            .and_then(Value::as_str)
            .is_some_and(|name| fold_name(name) == wanted)
    })
}

pub(super) fn scryfall_full_name_matches(raw: &Value, wanted: &str) -> bool {
    if scryfall_name_matches(raw, wanted) {
        return true;
    }
    let Some(faces) = raw["card_faces"]
        .as_array()
        .filter(|faces| faces.len() >= 2)
    else {
        return false;
    };
    let names: Option<Vec<_>> = faces
        .iter()
        .map(|face| {
            face["printed_name"]
                .as_str()
                .or_else(|| face["name"].as_str())
        })
        .collect();
    names.is_some_and(|names| fold_name(&names.join(" // ")) == wanted)
}

pub(super) fn scryfall_oracle_id(raw: &Value) -> Option<&str> {
    raw.get("oracle_id")
        .and_then(Value::as_str)
        .or_else(|| raw.get("id").and_then(Value::as_str))
}
