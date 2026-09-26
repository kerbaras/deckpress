//! Scryfall, MPC Autofill, Moxfield and Archidekt clients. Scryfall calls are
//! serialized through a single rate limiter (550 ms between requests, 30 s
//! back-off on 429) and every JSON response is cached in SQLite for 24 hours.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{redirect, Client, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::models::{
    new_id, Art, ArtPage, Card, DeckEntry, ImportIssue, ImportLine, Provider, ResolvedCards,
};
use crate::store::Store;

pub const USER_AGENT: &str = "Deckpress/0.1 (local playtest tool)";
const SCRYFALL_INTERVAL: Duration = Duration::from_millis(550);
const SCRYFALL_BACKOFF: Duration = Duration::from_secs(30);
const COLLECTION_BATCH: usize = 75;
const MPC_PAGE: usize = 48;

pub struct Providers {
    store: Arc<Store>,
    client: Client,
    scryfall_next: Mutex<Instant>,
}

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
    image_uris: Option<ScryfallImages>,
    card_faces: Option<Vec<ScryfallFace>>,
    #[serde(default = "unknown")]
    artist: String,
    set: String,
    set_name: String,
    collector_number: String,
    #[serde(default = "english")]
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
fn english() -> String {
    "en".into()
}
fn black() -> String {
    "black".into()
}

pub fn normalize_scryfall(value: &Value) -> AppResult<Card> {
    let card: ScryfallCard = serde_json::from_value(value.clone())
        .map_err(|error| AppError::user(format!("Unexpected Scryfall card data: {error}")))?;
    let raw_faces: Vec<ScryfallFace> = match card.image_uris {
        Some(images) => vec![ScryfallFace {
            name: card.name.clone(),
            artist: Some(card.artist.clone()),
            image_uris: Some(images),
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
        .filter(|face| {
            face.image_uris
                .as_ref()
                .is_some_and(|images| images.png.is_some() || images.large.is_some())
        })
        .enumerate()
        .map(|(index, face)| {
            let images = face.image_uris.unwrap_or_default();
            let image_url = images.png.or(images.large).unwrap_or_default();
            Art {
                id: format!("scryfall:{}:{}", card.id, index),
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
                released_at: card.released_at.clone(),
                dpi: 300.0,
                tags: tags.clone(),
                bleed_mm: 0.0,
                back_image_url: String::new(),
                back_thumbnail_url: String::new(),
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

fn cache_key(url: &str, body: Option<&Value>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hasher.update(
        serde_json::to_string(&body.cloned().unwrap_or(Value::Null))
            .unwrap_or_default()
            .as_bytes(),
    );
    hex::encode(hasher.finalize())
}

fn fold_name(name: &str) -> String {
    name.trim().to_lowercase()
}

impl Providers {
    pub fn new(store: Arc<Store>) -> AppResult<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .build()?;
        Ok(Self {
            store,
            client,
            scryfall_next: Mutex::new(Instant::now()),
        })
    }

    pub async fn json(&self, url: &str, body: Option<Value>) -> AppResult<Value> {
        let key = cache_key(url, body.as_ref());
        if let Some(cached) = self.store.cached(&key)? {
            return Ok(cached);
        }
        let parsed = Url::parse(url).map_err(|_| AppError::user("Invalid provider URL"))?;
        let scryfall = parsed.host_str() == Some("api.scryfall.com");
        if scryfall {
            let mut next = self.scryfall_next.lock().await;
            let now = Instant::now();
            if *next > now {
                tokio::time::sleep(*next - now).await;
            }
            *next = Instant::now() + SCRYFALL_INTERVAL;
        }
        let request = match &body {
            Some(body) => self.client.post(url).json(body),
            None => self.client.get(url),
        }
        .header("Accept", "application/json");
        let response = request.send().await.map_err(|error| {
            AppError::user(format!(
                "Could not reach {}: {}",
                parsed.host_str().unwrap_or("provider"),
                if error.is_timeout() {
                    "timed out".to_string()
                } else {
                    "network error".to_string()
                }
            ))
        })?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            if scryfall {
                *self.scryfall_next.lock().await = Instant::now() + SCRYFALL_BACKOFF;
            }
            return Err(AppError::RateLimited);
        }
        if !response.status().is_success() {
            return Err(AppError::user(format!(
                "Provider returned {}. Try again or import an exported decklist instead.",
                response.status().as_u16()
            )));
        }
        let json: Value = response
            .json()
            .await
            .map_err(|_| AppError::user("Provider returned invalid JSON"))?;
        self.store.put("cache", &key, &json)?;
        Ok(json)
    }

    pub async fn resolve(&self, lines: Vec<ImportLine>) -> AppResult<ResolvedCards> {
        let mut entries = Vec::new();
        let mut issues = Vec::new();
        for batch in lines.chunks(COLLECTION_BATCH) {
            let identifiers: Vec<Value> = batch
                .iter()
                .map(|line| {
                    if !line.set.is_empty() && !line.collector_number.is_empty() {
                        serde_json::json!({ "set": line.set, "collector_number": line.collector_number })
                    } else if !line.set.is_empty() {
                        serde_json::json!({ "name": line.name, "set": line.set })
                    } else {
                        serde_json::json!({ "name": line.name })
                    }
                })
                .collect();
            let response = self
                .json(
                    "https://api.scryfall.com/cards/collection",
                    Some(serde_json::json!({ "identifiers": identifiers })),
                )
                .await?;
            let mut cards = Vec::new();
            for item in response
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                match normalize_scryfall(item) {
                    Ok(card) => cards.push(card),
                    Err(_) => issues.push(ImportIssue {
                        line: 0,
                        input: "Card without a printable scan".into(),
                        message: "Scryfall returned a card without supported imagery".into(),
                    }),
                }
            }
            for line in batch {
                let wanted = fold_name(&line.name);
                let found = cards.iter().find(|candidate| {
                    let front = &candidate.faces[0];
                    if !line.set.is_empty() && front.set != line.set {
                        return false;
                    }
                    if !line.collector_number.is_empty() {
                        return front.collector_number == line.collector_number;
                    }
                    fold_name(&candidate.name) == wanted
                        || candidate
                            .faces
                            .iter()
                            .any(|face| fold_name(&face.name) == wanted)
                });
                match found {
                    Some(card) => entries.push(DeckEntry {
                        id: new_id(),
                        card: card.clone(),
                        quantity: line.quantity,
                        zone: line.zone,
                        selected_art: None,
                        selected_back: None,
                        excluded: false,
                    }),
                    None => issues.push(ImportIssue {
                        line: 0,
                        input: if line.set.is_empty() {
                            format!("{} {}", line.quantity, line.name)
                        } else {
                            format!(
                                "{} {} ({}) {}",
                                line.quantity, line.name, line.set, line.collector_number
                            )
                        },
                        message: "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.".into(),
                    }),
                }
            }
        }
        Ok(ResolvedCards { entries, issues })
    }

    pub async fn prints(&self, oracle_id: &str, page: u32, face: usize) -> AppResult<ArtPage> {
        let mut url = Url::parse("https://api.scryfall.com/cards/search").expect("static URL");
        url.query_pairs_mut()
            .append_pair("q", &format!("oracleid:{oracle_id} game:paper"))
            .append_pair("unique", "prints")
            .append_pair("order", "released")
            .append_pair("dir", "desc")
            .append_pair("page", &page.to_string());
        let response = self.json(url.as_str(), None).await?;
        let items = response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|raw| normalize_scryfall(raw).ok())
            .filter_map(|card| card.faces.get(face).cloned())
            .collect();
        Ok(ArtPage {
            items,
            page,
            has_more: response
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            total: response
                .get("total_cards")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }

    pub async fn community(&self, name: &str, page: u32) -> AppResult<ArtPage> {
        #[derive(Deserialize)]
        struct Source {
            pk: u64,
        }
        #[derive(Deserialize)]
        struct MpcCard {
            name: String,
            #[serde(rename = "downloadLink")]
            download_link: String,
            #[serde(rename = "mediumThumbnailUrl")]
            medium_thumbnail_url: String,
            source: String,
            dpi: f64,
            #[serde(default)]
            tags: Vec<String>,
            #[serde(default = "english_upper")]
            language: String,
        }
        fn english_upper() -> String {
            "EN".into()
        }
        let sources = self.json("https://mpcfill.com/2/sources/", None).await?;
        let pks: Vec<Value> = sources
            .get("results")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|map| map.values())
            .filter_map(|value| serde_json::from_value::<Source>(value.clone()).ok())
            .map(|source| serde_json::json!([source.pk, true]))
            .collect();
        let query = name.to_lowercase().trim().to_string();
        let search = self
            .json(
                "https://mpcfill.com/2/editorSearch/",
                Some(serde_json::json!({
                    "searchSettings": {
                        "searchTypeSettings": { "fuzzySearch": false, "filterCardbacks": false },
                        "sourceSettings": { "sources": pks },
                        "filterSettings": {
                            "minimumDPI": 0, "maximumDPI": 1500, "maximumSize": 30,
                            "languages": [], "includesTags": [], "excludesTags": ["NSFW"]
                        }
                    },
                    "queries": [{ "query": query, "cardType": "CARD" }]
                })),
            )
            .await?;
        let ids: Vec<String> = search
            .pointer(&format!(
                "/results/{}/CARD",
                query.replace('~', "~0").replace('/', "~1")
            ))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let page = page.max(1);
        let start = ((page as usize) - 1) * MPC_PAGE;
        let batch: Vec<String> = ids.iter().skip(start).take(MPC_PAGE).cloned().collect();
        let total = ids.len() as u64;
        if batch.is_empty() {
            return Ok(ArtPage {
                items: vec![],
                page,
                has_more: false,
                total,
            });
        }
        let cards = self
            .json(
                "https://mpcfill.com/2/cards/",
                Some(serde_json::json!({ "cardIdentifiers": batch })),
            )
            .await?;
        let items = batch
            .iter()
            .filter_map(|id| {
                let card: MpcCard =
                    serde_json::from_value(cards.pointer(&format!("/results/{id}"))?.clone())
                        .ok()?;
                let lower = card.name.to_lowercase();
                let mut tags = card.tags;
                if lower.contains("full art") {
                    tags.push("full art".into());
                }
                if lower.contains("borderless") {
                    tags.push("borderless".into());
                }
                Some(Art {
                    id: format!("mpc:{id}"),
                    provider: Provider::Mpc,
                    name: card.name,
                    image_url: card.download_link.clone(),
                    thumbnail_url: card.medium_thumbnail_url,
                    art_crop_url: String::new(),
                    source_url: card.download_link,
                    source: card.source,
                    artist: "Uncredited".into(),
                    set: String::new(),
                    collector_number: String::new(),
                    language: card.language.to_lowercase(),
                    released_at: String::new(),
                    tags,
                    dpi: if card.dpi > 0.0 { card.dpi } else { 300.0 },
                    bleed_mm: 3.048,
                    back_image_url: String::new(),
                    back_thumbnail_url: String::new(),
                })
            })
            .collect();
        Ok(ArtPage {
            items,
            page,
            has_more: (page as usize) * MPC_PAGE < ids.len(),
            total,
        })
    }

    /// Turns a public Moxfield or Archidekt deck URL into decklist text that the
    /// TypeScript parser understands.
    pub async fn import_url(&self, input: &str) -> AppResult<String> {
        let url = Url::parse(input)
            .map_err(|_| AppError::user("Use an HTTPS Moxfield or Archidekt deck URL"))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(AppError::user(
                "Use an HTTPS Moxfield or Archidekt deck URL",
            ));
        }
        let host = url.host_str().unwrap_or_default();
        if host == "moxfield.com" || host == "www.moxfield.com" {
            let id = url
                .path()
                .trim_end_matches('/')
                .strip_prefix("/decks/")
                .filter(|id| {
                    !id.is_empty()
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
                .ok_or_else(|| AppError::user("Invalid Moxfield deck URL"))?;
            let data = self
                .json(
                    &format!("https://api2.moxfield.com/v3/decks/all/{id}"),
                    None,
                )
                .await?;
            let mut lines = Vec::new();
            for (zone, board) in data
                .get("boards")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                lines.push(zone.clone());
                for entry in board
                    .get("cards")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|m| m.values())
                {
                    let quantity = entry.get("quantity").and_then(Value::as_u64).unwrap_or(1);
                    let card = entry.get("card").cloned().unwrap_or_default();
                    let name = card.get("name").and_then(Value::as_str).unwrap_or_default();
                    let set = card.get("set").and_then(Value::as_str).unwrap_or_default();
                    let cn = card.get("cn").and_then(Value::as_str).unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    lines.push(if !set.is_empty() && !cn.is_empty() {
                        format!("{quantity} {name} ({set}) {cn}")
                    } else {
                        format!("{quantity} {name}")
                    });
                }
            }
            return Ok(lines.join("\n"));
        }
        if host == "archidekt.com" || host == "www.archidekt.com" {
            let id = url
                .path()
                .strip_prefix("/decks/")
                .and_then(|rest| rest.split('/').next())
                .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
                .ok_or_else(|| AppError::user("Invalid Archidekt deck URL"))?;
            let data = self
                .json(&format!("https://archidekt.com/api/decks/{id}/"), None)
                .await?;
            let excluded: Vec<String> = data
                .get("categories")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|c| c.get("includedInDeck").and_then(Value::as_bool) == Some(false))
                .filter_map(|c| c.get("name").and_then(Value::as_str).map(str::to_string))
                .collect();
            let mut lines = Vec::new();
            for entry in data
                .get("cards")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let categories: Vec<String> = entry
                    .get("categories")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.as_str().map(str::to_string))
                    .collect();
                let lower: Vec<String> = categories.iter().map(|c| c.to_lowercase()).collect();
                let zone = if lower.iter().any(|c| c == "commander") {
                    "Commander"
                } else if lower.iter().any(|c| c == "sideboard") {
                    "Sideboard"
                } else if categories.iter().any(|c| excluded.contains(c)) {
                    "Maybeboard"
                } else {
                    "Deck"
                };
                let quantity = entry.get("quantity").and_then(Value::as_u64).unwrap_or(1);
                let name = entry
                    .pointer("/card/oracleCard/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let set = entry
                    .pointer("/card/edition/editioncode")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let cn = entry
                    .pointer("/card/collectorNumber")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                lines.push(zone.to_string());
                lines.push(format!("{quantity} {name} ({set}) {cn}"));
            }
            return Ok(lines.join("\n"));
        }
        Err(AppError::user(
            "Only public Moxfield and Archidekt URLs are supported. Other sites can be imported as text or CSV.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        serde_json::json!({
            "id": "6b6d5a31-b4b4-4f53-8c6b-7f1a4f3d9f01",
            "oracle_id": "f7f0d6e3-3d8e-4b32-9f68-cf45f58a0eaa",
            "name": "Lightning Bolt",
            "type_line": "Instant",
            "mana_cost": "{R}",
            "cmc": 1,
            "color_identity": ["R"],
            "image_uris": { "png": "https://cards.scryfall.io/png/front/x.png", "normal": "https://cards.scryfall.io/normal/front/x.jpg" },
            "artist": "Christopher Rush",
            "set": "lea",
            "set_name": "Limited Edition Alpha",
            "collector_number": "161",
            "frame": "1993",
            "scryfall_uri": "https://scryfall.com/card/lea/161"
        })
    }

    #[test]
    fn normalizes_single_faced_cards() {
        let card = normalize_scryfall(&sample()).unwrap();
        assert_eq!(card.faces.len(), 1);
        assert_eq!(card.faces[0].provider, Provider::Scryfall);
        assert_eq!(
            card.faces[0].id,
            "scryfall:6b6d5a31-b4b4-4f53-8c6b-7f1a4f3d9f01:0"
        );
        assert_eq!(card.faces[0].tags, vec!["retro frame".to_string()]);
        assert_eq!(
            card.faces[0].thumbnail_url,
            "https://cards.scryfall.io/normal/front/x.jpg"
        );
    }

    #[test]
    fn double_faced_cards_link_the_back() {
        let mut value = sample();
        value.as_object_mut().unwrap().remove("image_uris");
        value["card_faces"] = serde_json::json!([
            { "name": "Front", "image_uris": { "png": "https://cards.scryfall.io/png/front/a.png" } },
            { "name": "Back", "image_uris": { "png": "https://cards.scryfall.io/png/back/a.png" } }
        ]);
        let card = normalize_scryfall(&value).unwrap();
        assert_eq!(card.faces.len(), 2);
        assert_eq!(
            card.faces[0].back_image_url,
            "https://cards.scryfall.io/png/back/a.png"
        );
    }

    #[test]
    fn rejects_cards_without_scans() {
        let mut value = sample();
        value.as_object_mut().unwrap().remove("image_uris");
        assert!(normalize_scryfall(&value).is_err());
    }
}
