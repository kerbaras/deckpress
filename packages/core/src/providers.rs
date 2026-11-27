//! Scryfall, MPC Autofill, Moxfield and Archidekt clients. Scryfall calls are
//! paced through a single rate limiter and JSON responses are cached in
//! SQLite for 24 hours.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{redirect, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::art_policy::{policy_can_change, Printing};
use crate::art_quality::{prefer_high_res, scryfall_quality, ScanQuality};
use crate::error::{AppError, AppResult};
use crate::models::{
    new_id, Art, ArtPage, Card, Deck, DeckEntry, ImportIssue, ImportIssueKind, ImportLine,
    ImportPrintLookup, MissingPrint, PrintLanguagePolicy, PrintLanguagePreferences, Provider,
    ResolvedCards, Zone,
};
use crate::set_family::{coverage, SetCoverage, SetInfo};
use crate::store::Store;

pub const USER_AGENT: &str = "Deckpress/0.1 (local playtest tool)";
const SCRYFALL_INTERVAL: Duration = Duration::from_millis(550);
const SCRYFALL_BACKOFF: Duration = Duration::from_secs(15);
const SCRYFALL_MAX_BACKOFF: Duration = Duration::from_secs(30);
const SCRYFALL_RETRIES: u32 = 3;
const COLLECTION_BATCH: usize = 75;
const PRINT_SEARCH_BATCH: usize = 12;
const MPC_PAGE: usize = 48;
const MPC_PROJECT_LIMIT: usize = 612;
const SCRYFALL_LANGUAGES: &[&str] = &[
    "en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "he", "la", "grc", "ar",
    "sa", "ph", "qya", "tlh", "dw",
];

pub struct Providers {
    store: Arc<Store>,
    client: Client,
    scryfall_next: Mutex<Instant>,
    scryfall_origin: Option<Url>,
}

pub(crate) enum PrintingLookupProgress {
    Cards { done: usize, total: usize },
    RateLimited(Duration),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MpcCard {
    name: String,
    download_link: String,
    medium_thumbnail_url: String,
    source: String,
    dpi: f64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    language: String,
    #[serde(default)]
    searchq: String,
    #[serde(default)]
    extension: String,
    #[serde(default)]
    card_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpcArtwork {
    pub art: Art,
    pub filename: String,
    pub query: String,
}

impl MpcCard {
    fn artwork(self, id: &str) -> MpcArtwork {
        let lower = self.name.to_lowercase();
        let mut tags = self.tags;
        if lower.contains("full art") {
            tags.push("full art".into());
        }
        if lower.contains("borderless") {
            tags.push("borderless".into());
        }
        let prefix = match self.card_type.as_str() {
            "TOKEN" => "t:",
            "CARDBACK" => "b:",
            _ => "",
        };
        let filename = if self.extension.is_empty() {
            self.name.clone()
        } else {
            format!("{}.{}", self.name, self.extension)
        };
        MpcArtwork {
            filename: filename.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"),
            query: format!(
                "{prefix}{}",
                if self.searchq.is_empty() {
                    &self.name
                } else {
                    &self.searchq
                }
            ),
            art: Art {
                id: format!("mpc:{id}"),
                provider: Provider::Mpc,
                name: self.name,
                image_url: self.download_link.clone(),
                thumbnail_url: self.medium_thumbnail_url,
                art_crop_url: String::new(),
                source_url: self.download_link,
                source: self.source,
                artist: "Uncredited".into(),
                set: String::new(),
                collector_number: String::new(),
                language: self.language.to_lowercase(),
                illustration_id: None,
                scan_quality: None,
                released_at: String::new(),
                tags,
                dpi: if self.dpi > 0.0 { self.dpi } else { 300.0 },
                bleed_mm: 3.048,
                back_image_url: String::new(),
                back_thumbnail_url: String::new(),
                english_fallback: false,
                filename: None,
                content_hash: None,
            },
        }
    }
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

fn print_search(query: &str, page: u32) -> Url {
    let mut url = Url::parse("https://api.scryfall.com/cards/search").expect("static URL");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("unique", "prints")
        .append_pair("include_multilingual", "true")
        .append_pair("order", "released")
        .append_pair("dir", "desc")
        .append_pair("page", &page.to_string());
    url
}

fn printing_queries<'a, T>(
    clauses: &'a [(String, T)],
    suffix: &'a str,
    parenthesize_single: bool,
) -> impl Iterator<Item = (String, &'a [(String, T)])> {
    clauses.chunks(PRINT_SEARCH_BATCH).map(move |batch| {
        let terms = batch
            .iter()
            .map(|(term, _)| term.as_str())
            .collect::<Vec<_>>()
            .join(" or ");
        let query = if batch.len() > 1 || parenthesize_single {
            format!("({terms}) {suffix}")
        } else {
            format!("{terms} {suffix}")
        };
        (query, batch)
    })
}

struct ImportResolution<'a> {
    line: &'a ImportLine,
    original: Option<&'a Card>,
    card: Option<Card>,
    looked_up: Option<(String, String)>,
}

impl ImportResolution<'_> {
    fn search_clause(&self) -> Option<String> {
        if let Some(card) = self.original {
            uuid::Uuid::parse_str(&card.oracle_id).ok()?;
            return Some(format!("oracleid:{}", card.oracle_id));
        }
        let escaped = self.line.name.replace('\\', "\\\\").replace('"', "\\\"");
        let mut clause = format!("!\"{escaped}\"");
        if !self.line.set.is_empty() {
            if !self
                .line
                .set
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
            {
                return None;
            }
            clause.push_str(&format!(" set:{}", self.line.set));
        }
        Some(clause)
    }

    fn consider(&mut self, raw: &Value, language: &str) {
        let Some((set, collector)) = scryfall_print_number(raw) else {
            return;
        };
        if self.card.is_none()
            && raw["lang"] == language
            && self.original.map_or_else(
                || {
                    (self.line.set.is_empty() || self.line.set == set)
                        && scryfall_name_matches(raw, &fold_name(&self.line.name))
                },
                |card| scryfall_oracle_id(raw) == Some(&card.oracle_id),
            )
        {
            self.looked_up
                .get_or_insert_with(|| (set.to_owned(), collector.to_owned()));
            self.card = normalize_scryfall(raw).ok();
        }
    }
}

fn cards_in(response: &Value) -> impl Iterator<Item = &Value> {
    response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn has_more(response: &Value) -> bool {
    response
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let value = response.headers().get("Retry-After")?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse() {
        return Some(Duration::from_secs(seconds));
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        date.signed_duration_since(chrono::Utc::now())
            .to_std()
            .unwrap_or_default(),
    )
}

fn policy_printing(raw: &Value) -> Option<Printing> {
    let string = |key: &str| raw[key].as_str().unwrap_or_default().to_owned();
    let flag = |key: &str| raw[key].as_bool().unwrap_or(false);
    let illustration = |face: &Value| uuid::Uuid::parse_str(face["illustration_id"].as_str()?).ok();
    let illustrations: Vec<_> = if raw["image_uris"].is_object() || !raw["card_faces"].is_array() {
        vec![illustration(raw)]
    } else {
        raw["card_faces"]
            .as_array()?
            .iter()
            .map(illustration)
            .collect()
    };
    let scans = normalize_scryfall(raw)
        .ok()
        .map(|card| card.faces)
        .filter(|faces| faces.len() == illustrations.len());
    Some(Printing {
        id: raw["id"].as_str()?.into(),
        oracle_id: scryfall_oracle_id(raw)?.into(),
        set: string("set"),
        collector: string("collector_number"),
        date: string("released_at"),
        language: string("lang"),
        frame: string("frame"),
        border: string("border_color"),
        full_art: flag("full_art"),
        showcase: raw["frame_effects"]
            .as_array()
            .is_some_and(|effects| effects.iter().any(|effect| effect == "showcase")),
        treatments: raw["frame_effects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|effect| *effect != "showcase")
            .chain(flag("textless").then_some("textless"))
            .map(str::to_owned)
            .collect(),
        paper: !flag("digital")
            && raw["games"]
                .as_array()
                .is_some_and(|games| games.iter().any(|game| game == "paper")),
        promo: flag("promo"),
        illustrations,
        scans,
    })
}

fn import_label(line: &ImportLine) -> String {
    if line.set.is_empty() {
        format!("{} {}", line.quantity, line.name)
    } else {
        format!(
            "{} {} ({}) {}",
            line.quantity, line.name, line.set, line.collector_number
        )
        .trim_end()
        .to_string()
    }
}

fn scryfall_print_number(raw: &Value) -> Option<(&str, &str)> {
    let set = raw.get("set")?.as_str()?;
    let collector = raw.get("collector_number")?.as_str()?;
    (!set.is_empty() && !collector.is_empty()).then_some((set, collector))
}

fn scryfall_name_matches(raw: &Value, wanted: &str) -> bool {
    ["name", "printed_name"].iter().any(|key| {
        raw.get(key)
            .and_then(Value::as_str)
            .is_some_and(|name| fold_name(name) == wanted)
    })
}

fn scryfall_oracle_id(raw: &Value) -> Option<&str> {
    raw.get("oracle_id")
        .and_then(Value::as_str)
        .or_else(|| raw.get("id").and_then(Value::as_str))
}

pub(crate) fn validate_language(language: &str) -> AppResult<()> {
    if SCRYFALL_LANGUAGES.contains(&language) {
        Ok(())
    } else {
        Err(AppError::user("Unsupported print language."))
    }
}

pub(crate) fn scryfall_art_id(art_id: &str) -> Option<uuid::Uuid> {
    art_id
        .strip_prefix("scryfall:")
        .and_then(|rest| rest.split(':').next())
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
}

fn valid_languages(languages: &[String]) -> bool {
    !languages.is_empty()
        && languages.iter().enumerate().all(|(index, language)| {
            SCRYFALL_LANGUAGES.contains(&language.as_str())
                && !languages[..index].contains(language)
        })
}

impl Providers {
    pub fn new(store: Arc<Store>) -> AppResult<Self> {
        Self::with_origin(store, None)
    }

    /// Uses an alternate origin for Scryfall, leaving other providers unchanged.
    pub fn with_scryfall_origin(store: Arc<Store>, origin: Url) -> AppResult<Self> {
        Self::with_origin(store, Some(origin))
    }

    fn with_origin(store: Arc<Store>, scryfall_origin: Option<Url>) -> AppResult<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .build()?;
        Ok(Self {
            store,
            client,
            scryfall_next: Mutex::new(Instant::now()),
            scryfall_origin,
        })
    }

    pub async fn json(&self, url: &str, body: Option<Value>) -> AppResult<Value> {
        self.json_or_status(url, body, false, |_| {})
            .await?
            .map_err(|status| {
                AppError::user(format!(
                    "Provider returned {status}. Try again or import an exported decklist instead."
                ))
            })
    }

    /// Like [`Self::json`], but hands a non-success HTTP status back to the
    /// caller so it can explain that provider's refusal.
    async fn json_or_status(
        &self,
        url: &str,
        body: Option<Value>,
        allow_missing: bool,
        on_retry: impl Fn(Duration),
    ) -> AppResult<Result<Value, u16>> {
        let key = cache_key(url, body.as_ref());
        if let Some(cached) = self.store.cached(&key)? {
            return Ok(Ok(cached));
        }
        let parsed = Url::parse(url).map_err(|_| AppError::user("Invalid provider URL"))?;
        let scryfall = parsed.host_str() == Some("api.scryfall.com");
        let endpoint = if let Some(origin) = self.scryfall_origin.as_ref().filter(|_| scryfall) {
            let mut endpoint = origin.clone();
            endpoint.set_path(parsed.path());
            endpoint.set_query(parsed.query());
            endpoint
        } else {
            parsed.clone()
        };
        let mut attempt = 0;
        let response = loop {
            let mut next = if scryfall {
                let next = self.scryfall_next.lock().await;
                if let Some(cached) = self.store.cached(&key)? {
                    return Ok(Ok(cached));
                }
                Some(next)
            } else {
                None
            };
            if let Some(next) = &mut next {
                tokio::time::sleep((**next).saturating_duration_since(Instant::now())).await;
                **next = Instant::now() + SCRYFALL_INTERVAL;
            }
            let request = match &body {
                Some(body) => self.client.post(endpoint.clone()).json(body),
                None => self.client.get(endpoint.clone()),
            }
            .header("Accept", "application/json");
            let response = request.send().await.map_err(|error| {
                AppError::user(format!(
                    "Could not reach {}: {}",
                    parsed.host_str().unwrap_or("provider"),
                    if error.is_timeout() {
                        "timed out"
                    } else {
                        "network error"
                    }
                ))
            })?;
            if response.status() != StatusCode::TOO_MANY_REQUESTS {
                break response;
            }
            let Some(mut next) = next else {
                return Err(AppError::RateLimited);
            };
            let now = Instant::now();
            let fallback = (SCRYFALL_BACKOFF * (1 << attempt)).min(SCRYFALL_MAX_BACKOFF);
            let delay = retry_after(&response)
                .filter(|delay| now.checked_add(*delay).is_some())
                .unwrap_or(fallback);
            *next = (*next).max(now + delay);
            if attempt == SCRYFALL_RETRIES {
                return Err(AppError::user(
                    "Scryfall is still rate limiting requests. Try again later.",
                ));
            }
            on_retry(next.saturating_duration_since(now));
            attempt += 1;
        };
        if allow_missing && response.status() == StatusCode::NOT_FOUND {
            self.store.put("cache", &key, &Value::Null)?;
            return Ok(Ok(Value::Null));
        }
        if !response.status().is_success() {
            return Ok(Err(response.status().as_u16()));
        }
        let json: Value = response
            .json()
            .await
            .map_err(|_| AppError::user("Provider returned invalid JSON"))?;
        self.store.put("cache", &key, &json)?;
        Ok(Ok(json))
    }

    async fn scryfall_json(&self, url: &str) -> AppResult<Value> {
        self.scryfall_json_with_retry(url, |_| {}).await
    }

    async fn scryfall_json_with_retry(
        &self,
        url: &str,
        on_retry: impl Fn(Duration),
    ) -> AppResult<Value> {
        self.json_or_status(url, None, true, on_retry)
            .await?
            .map_err(|status| AppError::user(format!("Scryfall returned {status}. Try again.")))
    }

    pub async fn sets(&self) -> AppResult<Vec<SetInfo>> {
        #[derive(Deserialize)]
        struct SetList {
            data: Vec<SetInfo>,
        }

        let raw = self.scryfall_json("https://api.scryfall.com/sets").await?;
        Ok(serde_json::from_value::<SetList>(raw)?.data)
    }

    pub async fn set_coverage(&self, entries: &[DeckEntry]) -> AppResult<Vec<SetCoverage>> {
        if !entries.iter().any(policy_can_change) {
            return Ok(Vec::new());
        }
        let sets = self.sets().await?;
        let inventory = self
            .printing_inventory(
                entries
                    .iter()
                    .filter(|entry| policy_can_change(entry))
                    .map(|entry| entry.card.oracle_id.as_str())
                    .collect(),
                None,
                |_| {},
            )
            .await?;
        let mut entry_sets = Vec::new();
        for entry in entries {
            if !policy_can_change(entry) {
                entry_sets.push((entry.quantity, Vec::new()));
                continue;
            }
            let codes = inventory
                .get(&entry.card.oracle_id)
                .into_iter()
                .flatten()
                .filter(|print| {
                    print.paper
                        && !print.promo
                        && print.illustrations.len() == entry.card.faces.len()
                })
                .map(|print| print.set.clone())
                .collect();
            entry_sets.push((entry.quantity, codes));
        }
        Ok(coverage(&entry_sets, &sets))
    }

    pub fn print_language_preferences(&self) -> AppResult<PrintLanguagePreferences> {
        Ok(self
            .store
            .get("settings", "print-language")?
            .unwrap_or_default())
    }

    pub(crate) fn preferences_for_deck(&self, deck: &Deck) -> AppResult<PrintLanguagePreferences> {
        let mut preferences = self.print_language_preferences()?;
        if let Some(language) = &deck.print_language {
            preferences.languages = vec![language.clone()];
        }
        Ok(preferences)
    }

    pub fn save_print_language_preferences(
        &self,
        preferences: PrintLanguagePreferences,
    ) -> AppResult<PrintLanguagePreferences> {
        if !valid_languages(&preferences.languages) {
            return Err(AppError::user(
                "Choose at least one supported print language, without duplicates.",
            ));
        }
        self.store.put("settings", "print-language", &preferences)?;
        Ok(preferences)
    }

    pub async fn resolve_import(&self, lines: Vec<ImportLine>) -> AppResult<ResolvedCards> {
        self.resolve_with_languages(lines, &self.print_language_preferences()?)
            .await
    }

    pub async fn resolve_deck_import(
        &self,
        deck: &Deck,
        lines: Vec<ImportLine>,
    ) -> AppResult<ResolvedCards> {
        self.resolve_with_languages(lines, &self.preferences_for_deck(deck)?)
            .await
    }

    pub async fn related_deck_tokens(
        &self,
        deck: &Deck,
        card_ids: Vec<String>,
    ) -> AppResult<Vec<DeckEntry>> {
        let mut tokens = self.related_tokens(card_ids).await?;
        if let Some(language) = &deck.print_language {
            crate::language_deck::plan(
                self,
                &mut tokens,
                deck.art_policy.as_ref(),
                language,
                self.print_language_preferences()?.policy,
            )
            .await?;
        }
        Ok(tokens)
    }

    pub async fn resolve(&self, lines: Vec<ImportLine>) -> AppResult<ResolvedCards> {
        self.resolve_with_languages(lines, &PrintLanguagePreferences::default())
            .await
    }

    async fn resolve_with_languages(
        &self,
        lines: Vec<ImportLine>,
        preferences: &PrintLanguagePreferences,
    ) -> AppResult<ResolvedCards> {
        let mut entries = Vec::new();
        let mut issues = Vec::new();
        let mut missing_prints = Vec::new();
        let languages = &preferences.languages;
        let english_only = languages.as_slice() == ["en"];
        let fallback_english = preferences.policy == PrintLanguagePolicy::FallbackToEnglish
            && !languages.iter().any(|lang| lang == "en");
        for (offset, batch) in lines.chunks(COLLECTION_BATCH).enumerate() {
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
            let cards: Vec<_> = cards_in(&response)
                .map(|raw| (raw, normalize_scryfall(raw).ok()))
                .collect();
            let mut resolutions = Vec::with_capacity(batch.len());
            for line in batch {
                let wanted = fold_name(&line.name);
                let mut candidates = cards.iter().filter(|(raw, _)| {
                    let Some((set, collector)) = scryfall_print_number(raw) else {
                        return false;
                    };
                    if !line.set.is_empty() && set != line.set {
                        return false;
                    }
                    if !line.collector_number.is_empty() {
                        return collector == line.collector_number;
                    }
                    scryfall_name_matches(raw, &wanted)
                        || raw
                            .get("card_faces")
                            .and_then(Value::as_array)
                            .is_some_and(|faces| {
                                faces
                                    .iter()
                                    .any(|face| scryfall_name_matches(face, &wanted))
                            })
                });
                let candidate = candidates
                    .clone()
                    .find(|(_, card)| card.is_some())
                    .or_else(|| candidates.next());
                resolutions.push(ImportResolution {
                    line,
                    original: candidate.and_then(|(_, card)| card.as_ref()),
                    card: None,
                    looked_up: candidate
                        .and_then(|(raw, _)| scryfall_print_number(raw))
                        .map(|(set, collector)| (set.to_owned(), collector.to_owned())),
                });
            }
            let mut attempted = languages.clone();
            if fallback_english {
                attempted.push("en".into());
            }
            for language in &attempted {
                self.resolve_import_language(&mut resolutions, language, english_only)
                    .await?;
            }
            for (index, resolution) in resolutions.into_iter().enumerate() {
                let position = offset * COLLECTION_BATCH + index + 1;
                let ImportResolution {
                    line,
                    card,
                    looked_up,
                    ..
                } = resolution;
                match card {
                    Some(card) => entries.push(DeckEntry {
                        id: new_id(),
                        card,
                        quantity: line.quantity,
                        zone: line.zone,
                        board: line.board.clone(),
                        selected_art: None,
                        selected_back: None,
                        art_pinned: false,
                        policy_art: None,
                        language_anchor: None,
                        language_choices: Default::default(),
                        excluded: false,
                        requested_languages: if english_only { Vec::new() } else { languages.clone() },
                    }),
                    None if looked_up.is_some() => {
                        let input = import_label(line);
                        issues.push(ImportIssue {
                            line: position as u32,
                            input: input.clone(),
                            message: format!("No usable scan found in {}.", attempted.join(", ")),
                            kind: ImportIssueKind::NoUsableScan,
                            print_lookup: looked_up.map(|(set, collector_number)| ImportPrintLookup {
                                set,
                                collector_number,
                                languages: attempted.clone(),
                            }),
                        });
                        missing_prints.push(MissingPrint { input, languages: languages.clone() });
                    }
                    None => issues.push(ImportIssue {
                        line: position as u32,
                        input: import_label(line),
                        message: "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.".into(),
                        kind: ImportIssueKind::NotFound,
                        print_lookup: None,
                    }),
                }
            }
        }
        Ok(ResolvedCards {
            entries,
            issues,
            missing_prints,
        })
    }

    async fn collection_by_id(&self, ids: BTreeSet<uuid::Uuid>) -> AppResult<Vec<Value>> {
        let ids: Vec<_> = ids.into_iter().collect();
        let mut result = Vec::new();
        for batch in ids.chunks(COLLECTION_BATCH) {
            let identifiers: Vec<_> = batch
                .iter()
                .map(|id| serde_json::json!({ "id": id.to_string() }))
                .collect();
            let mut response = self
                .json(
                    "https://api.scryfall.com/cards/collection",
                    Some(serde_json::json!({ "identifiers": identifiers })),
                )
                .await?;
            let cards = response
                .get_mut("data")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| AppError::user("Unexpected Scryfall collection data"))?;
            result.append(cards);
        }
        Ok(result)
    }

    pub async fn related_tokens(&self, card_ids: Vec<String>) -> AppResult<Vec<DeckEntry>> {
        if card_ids.len() > 1000 {
            return Err(AppError::user("Decklists are limited to 1000 lines"));
        }
        let producers = card_ids
            .iter()
            .map(|id| uuid::Uuid::parse_str(id).map_err(|_| AppError::user("Invalid card ID")))
            .collect::<AppResult<_>>()?;
        let ids = self
            .collection_by_id(producers)
            .await?
            .iter()
            .filter_map(|card| card["all_parts"].as_array())
            .flatten()
            .filter(|part| {
                part["component"] == "token"
                    || (part["component"] == "combo_piece"
                        && part["type_line"]
                            .as_str()
                            .is_some_and(|line| line.starts_with("Emblem")))
            })
            .filter_map(|part| uuid::Uuid::parse_str(part["id"].as_str()?).ok())
            .collect();
        let mut seen = BTreeSet::new();
        let mut entries: Vec<_> = self
            .collection_by_id(ids)
            .await?
            .iter()
            .filter_map(|raw| normalize_scryfall(raw).ok())
            .filter(|card| seen.insert(card.oracle_id.clone()))
            .map(|card| DeckEntry {
                id: new_id(),
                card,
                quantity: 1,
                zone: Zone::Tokens,
                board: None,
                selected_art: None,
                selected_back: None,
                art_pinned: false,
                policy_art: None,
                language_anchor: None,
                language_choices: Default::default(),
                excluded: false,
                requested_languages: Vec::new(),
            })
            .collect();
        entries.sort_by(|a, b| a.card.name.cmp(&b.card.name));
        Ok(entries)
    }

    async fn resolve_import_language(
        &self,
        resolutions: &mut [ImportResolution<'_>],
        language: &str,
        english_only: bool,
    ) -> AppResult<()> {
        let mut clauses = BTreeMap::<_, Vec<_>>::new();
        for (index, resolution) in resolutions.iter_mut().enumerate() {
            if resolution.card.is_some() || (english_only && resolution.original.is_none()) {
                continue;
            }
            if let Some(card) = resolution
                .original
                .filter(|card| card.faces[0].language == language)
            {
                resolution.card = Some(card.clone());
            } else if !resolution.line.set.is_empty()
                && !resolution.line.collector_number.is_empty()
            {
                let line = resolution.line;
                let mut url = Url::parse("https://api.scryfall.com/cards").expect("static URL");
                url.path_segments_mut().expect("static URL").extend([
                    line.set.as_str(),
                    line.collector_number.as_str(),
                    language,
                ]);
                let raw = self.scryfall_json(url.as_str()).await?;
                if scryfall_print_number(&raw)
                    == Some((line.set.as_str(), line.collector_number.as_str()))
                    && raw["lang"] == language
                    && resolution
                        .original
                        .is_none_or(|card| scryfall_oracle_id(&raw) == Some(&card.oracle_id))
                {
                    resolution
                        .looked_up
                        .get_or_insert_with(|| (line.set.clone(), line.collector_number.clone()));
                    resolution.card = normalize_scryfall(&raw).ok();
                }
            } else if let Some(clause) = resolution.search_clause() {
                clauses.entry(clause).or_default().push(index);
            }
        }
        let clauses: Vec<_> = clauses.into_iter().collect();
        let suffix = format!("game:paper lang:{language}");
        for (query, batch) in printing_queries(&clauses, &suffix, false) {
            let indices: Vec<_> = batch
                .iter()
                .flat_map(|(_, indices)| indices.iter().copied())
                .collect();
            self.visit_printing_pages(
                &query,
                |_| {},
                |response| {
                    for raw in cards_in(response) {
                        for &index in &indices {
                            resolutions[index].consider(raw, language);
                        }
                    }
                    indices
                        .iter()
                        .all(|&index| resolutions[index].card.is_some())
                },
            )
            .await?;
        }
        Ok(())
    }

    async fn visit_printing_pages(
        &self,
        query: &str,
        on_retry: impl Fn(Duration),
        mut visit: impl FnMut(&Value) -> bool,
    ) -> AppResult<bool> {
        for page in 1..=100 {
            let url = print_search(query, page);
            let response = self
                .scryfall_json_with_retry(url.as_str(), &on_retry)
                .await?;
            if visit(&response) || !has_more(&response) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(crate) async fn policy_printing(&self, art_id: &str) -> AppResult<Option<Printing>> {
        let Some(id) = scryfall_art_id(art_id) else {
            return Ok(None);
        };
        let raw = self
            .scryfall_json(&format!("https://api.scryfall.com/cards/{id}"))
            .await?;
        Ok(policy_printing(&raw).filter(|print| print.id == id.to_string()))
    }

    pub(crate) async fn language_anchors(
        &self,
        ids: BTreeSet<uuid::Uuid>,
    ) -> AppResult<HashMap<String, Printing>> {
        Ok(self
            .collection_by_id(ids)
            .await?
            .iter()
            .filter_map(policy_printing)
            .map(|print| (print.id.clone(), print))
            .collect())
    }

    pub(crate) async fn language_printings(
        &self,
        oracle_ids: BTreeSet<&str>,
        language: &str,
    ) -> AppResult<HashMap<String, Vec<Printing>>> {
        self.printing_inventory(oracle_ids, Some(language), |_| {})
            .await
    }

    pub(crate) async fn printing_inventory(
        &self,
        mut oracle_ids: BTreeSet<&str>,
        language: Option<&str>,
        progress: impl Fn(PrintingLookupProgress),
    ) -> AppResult<HashMap<String, Vec<Printing>>> {
        if let Some(language) = language {
            validate_language(language)?;
        }
        let cache_key = |oracle| match language {
            Some(language) => format!("language-printings:{language}:{oracle}"),
            None => format!("policy-printings:{oracle}"),
        };
        let mut inventory = HashMap::new();
        let mut missing = Vec::new();
        oracle_ids.retain(|oracle| uuid::Uuid::parse_str(oracle).is_ok());
        let total = oracle_ids.len();
        for oracle in oracle_ids {
            match self.store.cached(&cache_key(oracle))? {
                Some(Value::Array(cards)) => {
                    inventory.insert(
                        oracle.to_owned(),
                        cards.iter().filter_map(policy_printing).collect(),
                    );
                }
                _ => missing.push((format!("oracleid:{oracle}"), oracle)),
            }
        }
        if total > 0 {
            progress(PrintingLookupProgress::Cards {
                done: inventory.len(),
                total,
            });
        }
        let suffix = language.map_or_else(
            || "game:paper".into(),
            |lang| format!("lang:{lang} game:paper"),
        );
        for (query, batch) in printing_queries(&missing, &suffix, language.is_some()) {
            let mut found: HashMap<_, Vec<Value>> = batch
                .iter()
                .map(|(_, oracle)| (*oracle, Vec::new()))
                .collect();
            let complete = self
                .visit_printing_pages(
                    &query,
                    |delay| {
                        progress(PrintingLookupProgress::RateLimited(delay));
                    },
                    |response| {
                        for raw in cards_in(response) {
                            if let Some(bucket) = scryfall_oracle_id(raw)
                                .and_then(|oracle| found.get_mut(oracle))
                                .filter(|_| language.is_none_or(|language| raw["lang"] == language))
                            {
                                bucket.push(raw.clone());
                            }
                        }
                        false
                    },
                )
                .await?;
            if !complete {
                return Err(AppError::user(
                    "Scryfall has too many printings for this deck.",
                ));
            }
            for (oracle, cards) in found {
                self.store.put("cache", &cache_key(oracle), &cards)?;
                inventory.insert(
                    oracle.to_owned(),
                    cards.iter().filter_map(policy_printing).collect(),
                );
            }
            progress(PrintingLookupProgress::Cards {
                done: inventory.len(),
                total,
            });
        }
        Ok(inventory)
    }

    pub(crate) async fn policy_exact(
        &self,
        anchor: &Printing,
        language: &str,
    ) -> AppResult<Option<Printing>> {
        let mut url = Url::parse("https://api.scryfall.com/cards").expect("static URL");
        url.path_segments_mut().expect("static URL").extend([
            &anchor.set,
            &anchor.collector,
            language,
        ]);
        let raw = self.scryfall_json(url.as_str()).await?;
        Ok(policy_printing(&raw)
            .filter(|print| print.set == anchor.set && print.collector == anchor.collector))
    }

    pub async fn prints(
        &self,
        oracle_id: &str,
        page: u32,
        face: usize,
        language: Option<&str>,
    ) -> AppResult<ArtPage> {
        if language.is_some_and(|lang| !SCRYFALL_LANGUAGES.contains(&lang)) {
            return Err(AppError::user("Unsupported print language."));
        }
        if uuid::Uuid::parse_str(oracle_id).is_err() {
            return Ok(ArtPage {
                items: Vec::new(),
                page,
                has_more: false,
                total: 0,
            });
        }
        let mut query = format!("oracleid:{oracle_id} game:paper");
        if let Some(language) = language {
            query.push_str(&format!(" lang:{language}"));
        }
        let url = print_search(&query, page);
        let response = self.scryfall_json(url.as_str()).await?;
        let items = cards_in(&response)
            .filter_map(|raw| normalize_scryfall(raw).ok())
            .filter(|card| card.oracle_id == oracle_id)
            .filter_map(|card| card.faces.get(face).cloned())
            .filter(|art| language.is_none_or(|language| language == art.language))
            .collect();
        Ok(ArtPage {
            items,
            page,
            has_more: has_more(&response),
            total: response
                .get("total_cards")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }

    pub async fn better_scan(
        &self,
        selected: Art,
        oracle_id: uuid::Uuid,
        face: usize,
    ) -> AppResult<Art> {
        if selected.provider != Provider::Scryfall
            || selected.scan_quality == Some(ScanQuality::HighresScan)
        {
            return Ok(selected);
        }
        let Some(print_id) = selected
            .id
            .split(':')
            .nth(1)
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
        else {
            return Ok(selected);
        };
        let mut base = selected;
        if base.illustration_id.is_none() {
            let raw = self
                .json(&format!("https://api.scryfall.com/cards/{print_id}"), None)
                .await?;
            let card = normalize_scryfall(&raw)?;
            let Some(art) = card.faces.into_iter().nth(face) else {
                return Ok(base);
            };
            if art.language != base.language || art.image_url != base.image_url {
                return Ok(base);
            }
            base = art;
        }
        let Some(illustration) = base.illustration_id else {
            return Ok(base);
        };
        if base.scan_quality == Some(ScanQuality::HighresScan)
            || !SCRYFALL_LANGUAGES.contains(&base.language.as_str())
        {
            return Ok(base);
        }
        let query = format!(
            "oracleid:{oracle_id} illustration_id:{illustration} game:paper lang:{}",
            base.language
        );
        for page in 1u32.. {
            let url = print_search(&query, page);
            let response = self.scryfall_json(url.as_str()).await?;
            let candidates: Vec<_> = cards_in(&response)
                .filter_map(|raw| normalize_scryfall(raw).ok())
                .filter_map(|card| card.faces.into_iter().nth(face))
                .collect();
            base = prefer_high_res(&base, &candidates).clone();
            if base.scan_quality == Some(ScanQuality::HighresScan) || !has_more(&response) {
                break;
            }
        }
        Ok(base)
    }

    async fn mpc_cards_batch(&self, ids: &[String]) -> AppResult<Vec<MpcArtwork>> {
        let response = self
            .json(
                "https://mpcfill.com/2/cards/",
                Some(serde_json::json!({ "cardIdentifiers": ids })),
            )
            .await?;
        Ok(ids
            .iter()
            .filter_map(|id| {
                let raw = response.get("results")?.get(id)?;
                let card: MpcCard = serde_json::from_value(raw.clone()).ok()?;
                Some(card.artwork(id))
            })
            .collect())
    }

    pub async fn mpc_artwork(&self, ids: Vec<String>) -> AppResult<Vec<MpcArtwork>> {
        if ids.len() > MPC_PROJECT_LIMIT * 2
            || ids.iter().any(|id| {
                id.is_empty()
                    || id.len() > 120
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        {
            return Err(AppError::user("Invalid MPC Autofill artwork IDs"));
        }
        let ids: Vec<_> = ids
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut artwork = Vec::new();
        for batch in ids.chunks(MPC_PAGE) {
            artwork.extend(self.mpc_cards_batch(batch).await?);
        }
        for item in &artwork {
            crate::images::validate_image_url(&item.art.image_url)?;
            crate::images::validate_image_url(&item.art.thumbnail_url)?;
        }
        Ok(artwork)
    }

    pub async fn community(&self, name: &str, page: u32) -> AppResult<ArtPage> {
        #[derive(Deserialize)]
        struct Source {
            pk: u64,
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
        let items = self
            .mpc_cards_batch(&batch)
            .await?
            .into_iter()
            .map(|item| item.art)
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
                .json_or_status(
                    &format!("https://api2.moxfield.com/v3/decks/all/{id}"),
                    None,
                    false,
                    |_| {},
                )
                .await?
                .map_err(moxfield_status_error)?;
            let Some(boards) = data.get("boards").and_then(Value::as_object) else {
                return Ok(String::new());
            };
            let mut lines = Vec::new();
            for (zone, board) in boards {
                let header = lines.len();
                for (entry, card, name) in moxfield_cards(board) {
                    let quantity = entry.get("quantity").and_then(Value::as_u64).unwrap_or(1);
                    let set = card.get("set").and_then(Value::as_str).unwrap_or_default();
                    let cn = card.get("cn").and_then(Value::as_str).unwrap_or_default();
                    lines.push(if !set.is_empty() && !cn.is_empty() {
                        format!("{quantity} {name} ({set}) {cn}")
                    } else {
                        format!("{quantity} {name}")
                    });
                }
                if lines.len() > header {
                    let heading = match zone.to_ascii_lowercase().as_str() {
                        "deck" | "main" | "mainboard" | "commander" | "commanders" | "side"
                        | "sideboard" | "maybe" | "maybeboard" | "considering" | "token"
                        | "tokens" => zone.clone(),
                        "companion" | "companions" => "Companion".to_string(),
                        _ => format!("Deck\n// Board: {zone}"),
                    };
                    lines.insert(header, heading);
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
                let excluded_board = categories
                    .iter()
                    .any(|c| !c.eq_ignore_ascii_case("companion") && excluded.contains(c));
                let zone = if lower.iter().any(|c| c == "commander") {
                    "Commander"
                } else if !excluded_board && lower.iter().any(|c| c == "companion") {
                    "Companion"
                } else if lower.iter().any(|c| c == "sideboard") {
                    "Sideboard"
                } else if excluded_board {
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

fn moxfield_cards(board: &Value) -> impl Iterator<Item = (&Value, &Value, &str)> {
    board
        .get("cards")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|cards| cards.values())
        .filter_map(|entry| {
            let card = entry.get("card")?;
            let name = card.get("name")?.as_str()?;
            (!name.is_empty()).then_some((entry, card, name))
        })
}

/// Explains a failed Moxfield deck request. Moxfield answers 403 to every
/// client that is not a web browser, so the exported text list is the way in.
pub fn moxfield_status_error(status: u16) -> AppError {
    match status {
        403 => AppError::user(
            "Moxfield refused the request (HTTP 403): it blocks apps that are not a web browser. In Moxfield, open the deck, choose More › Download / Export, click Copy Plain Text and paste the list here.",
        ),
        404 => AppError::user(
            "Moxfield could not find this deck (HTTP 404). Check that the deck is public, or paste its exported text list.",
        ),
        status => AppError::user(format!(
            "Moxfield returned HTTP {status}. Retry later, or paste the deck's exported text list."
        )),
    }
}
