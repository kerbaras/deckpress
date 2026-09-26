//! Search public decks on external deck databases and turn them into import
//! lines. Archidekt is the only source today: its JSON endpoints answer
//! without credentials, unlike Moxfield, whose API sits behind Cloudflare
//! and rejects non-browser clients. Requests are only made in response to a
//! user action, spaced [`ARCHIDEKT_INTERVAL`] apart per host and cached in
//! SQLite for 24 hours next to the Scryfall cache. Commander and card
//! searches need an exact card name on Archidekt, so the typed text is first
//! matched against Scryfall's autocomplete catalogue.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{redirect, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::models::{ImportLine, ResolvedCards, Zone};
use crate::providers::{Providers, USER_AGENT};
use crate::store::Store;

const ARCHIDEKT_INTERVAL: Duration = Duration::from_millis(1000);
const ARCHIDEKT_BACKOFF: Duration = Duration::from_secs(30);
const ARCHIDEKT_API: &str = "https://archidekt.com/api/decks/";
const MAX_CARD_MATCHES: usize = 6;
pub const MAX_DESCRIPTION: usize = 1200;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum DeckSource {
    Archidekt,
}

impl DeckSource {
    pub fn label(self) -> &'static str {
        match self {
            DeckSource::Archidekt => "Archidekt",
        }
    }
}

/// Which attribute the typed text is matched against.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchField {
    #[default]
    Name,
    Commander,
    Card,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckQuery {
    pub text: String,
    pub field: SearchField,
    /// Deckpress format name, or empty for any format.
    pub format: String,
    /// Restrict to one source; `None` searches every source.
    pub source: Option<DeckSource>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    pub source: DeckSource,
    pub id: String,
    pub name: String,
    /// Format label as the source reports it (may be one Deckpress lacks).
    pub format: String,
    /// Deckpress format an import of this deck is created with.
    pub deckpress_format: String,
    pub author: String,
    pub color_identity: Vec<String>,
    pub card_count: u32,
    pub updated_at: String,
    pub url: String,
    pub cover_url: String,
    pub views: u64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckSearchPage {
    pub items: Vec<DeckSummary>,
    pub page: u32,
    pub has_more: bool,
    pub total: u64,
    /// Card name the commander/card search was resolved to on Scryfall.
    pub matched_card: Option<String>,
    /// Other Scryfall names matching the typed text, for the user to pick.
    pub card_matches: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDeck {
    pub summary: DeckSummary,
    pub description: String,
    pub lines: Vec<ImportLine>,
}

pub struct DeckSearch {
    store: Arc<Store>,
    providers: Arc<Providers>,
    client: Client,
    archidekt_next: Mutex<Instant>,
}

/// Archidekt `deckFormat` ids taken from its client bundle, paired with the
/// Deckpress format an import falls into.
pub fn archidekt_format(id: i64) -> (&'static str, &'static str) {
    match id {
        1 => ("Standard", "Standard"),
        2 => ("Modern", "Modern"),
        3 => ("Commander", "Commander"),
        4 => ("Legacy", "Legacy"),
        5 => ("Vintage", "Vintage"),
        6 => ("Pauper", "Pauper"),
        7 => ("Custom", "Casual"),
        8 => ("Frontier", "Casual"),
        9 => ("Future Standard", "Standard"),
        10 => ("Penny Dreadful", "Casual"),
        11 => ("1v1 Commander", "Commander"),
        12 => ("Duel Commander", "Commander"),
        13 => ("Standard Brawl", "Casual"),
        14 => ("Oathbreaker", "Casual"),
        15 => ("Pioneer", "Pioneer"),
        16 => ("Historic", "Casual"),
        17 => ("Pauper EDH", "Commander"),
        18 => ("Alchemy", "Casual"),
        19 => ("Explorer", "Pioneer"),
        20 => ("Brawl", "Casual"),
        21 => ("Gladiator", "Casual"),
        22 => ("Premodern", "Casual"),
        23 => ("PreDH", "Commander"),
        24 => ("Timeless", "Casual"),
        25 => ("Canadian Highlander", "Casual"),
        26 => ("Competitive Brawl", "Casual"),
        27 => ("Tiny Leaders", "Commander"),
        _ => ("Unknown", "Casual"),
    }
}

/// Deckpress formats that map one-to-one onto an Archidekt format filter.
pub fn archidekt_format_id(format: &str) -> Option<u8> {
    match format {
        "Standard" => Some(1),
        "Modern" => Some(2),
        "Commander" => Some(3),
        "Legacy" => Some(4),
        "Vintage" => Some(5),
        "Pauper" => Some(6),
        "Pioneer" => Some(15),
        _ => None,
    }
}

fn color_letter(color: &str) -> Option<&'static str> {
    match color {
        "W" | "White" => Some("W"),
        "U" | "Blue" => Some("U"),
        "B" | "Black" => Some("B"),
        "R" | "Red" => Some("R"),
        "G" | "Green" => Some("G"),
        _ => None,
    }
}

fn wubrg(present: impl Fn(&str) -> bool) -> Vec<String> {
    ["W", "U", "B", "R", "G"]
        .into_iter()
        .filter(|letter| present(letter))
        .map(str::to_string)
        .collect()
}

fn text(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn archidekt_search_url(
    text: &str,
    field: SearchField,
    format: Option<u8>,
    page: u32,
) -> String {
    let mut url = Url::parse(ARCHIDEKT_API).expect("static URL");
    url.set_path("/api/decks/v3/");
    {
        let mut pairs = url.query_pairs_mut();
        let param = match field {
            SearchField::Name => "name",
            SearchField::Commander => "commanderName",
            SearchField::Card => "cardName",
        };
        pairs.append_pair(param, text);
        if let Some(format) = format {
            pairs.append_pair("deckFormat", &format.to_string());
        }
        pairs.append_pair("orderBy", "-viewCount");
        pairs.append_pair("page", &page.max(1).to_string());
    }
    url.to_string()
}

fn archidekt_summary(deck: &Value, colors: Vec<String>, card_count: u32) -> Option<DeckSummary> {
    let id = deck.get("id").and_then(Value::as_i64)?;
    let (format, deckpress_format) =
        archidekt_format(deck.get("deckFormat").and_then(Value::as_i64).unwrap_or(0));
    let cover = text(deck, "/customFeatured");
    Some(DeckSummary {
        source: DeckSource::Archidekt,
        id: id.to_string(),
        name: text(deck, "/name").trim().to_string(),
        format: format.to_string(),
        deckpress_format: deckpress_format.to_string(),
        author: text(deck, "/owner/username"),
        color_identity: colors,
        card_count,
        updated_at: text(deck, "/updatedAt"),
        url: format!("https://archidekt.com/decks/{id}"),
        cover_url: if cover.is_empty() {
            text(deck, "/featured")
        } else {
            cover
        },
        views: deck.get("viewCount").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Normalises an Archidekt `/api/decks/v3/` response. A `count` of -1 is how
/// Archidekt reports a card filter that matched no card.
pub fn parse_archidekt_search(value: &Value, page: u32) -> DeckSearchPage {
    let items: Vec<DeckSummary> = value
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|deck| {
            !deck
                .get("private")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && !deck
                    .get("unlisted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .filter_map(|deck| {
            let colors = wubrg(|letter| {
                deck.pointer(&format!("/colors/{letter}"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > 0
            });
            let size = deck.get("size").and_then(Value::as_u64).unwrap_or(0) as u32;
            archidekt_summary(deck, colors, size)
        })
        .collect();
    let total = value
        .get("count")
        .and_then(Value::as_i64)
        .unwrap_or(items.len() as i64)
        .max(0) as u64;
    DeckSearchPage {
        has_more: value.get("next").is_some_and(Value::is_string) && !items.is_empty(),
        total: total.max(items.len() as u64),
        items,
        page,
        ..DeckSearchPage::default()
    }
}

/// Normalises an Archidekt `/api/decks/<id>/` response into import lines.
/// Categories flagged `includedInDeck: false` land in the maybeboard, a
/// "Commander" category in the commander zone and "Sideboard" in the side.
pub fn parse_archidekt_deck(value: &Value) -> AppResult<ExternalDeck> {
    let excluded: Vec<String> = value
        .get("categories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|category| {
            !category
                .get("includedInDeck")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .map(|category| text(category, "/name").to_lowercase())
        .collect();
    let mut lines = Vec::new();
    let mut colors = std::collections::BTreeSet::new();
    let mut card_count = 0u32;
    for card in value
        .get("cards")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = text(card, "/card/oracleCard/name");
        let quantity = card.get("quantity").and_then(Value::as_u64).unwrap_or(0) as u32;
        if name.is_empty() || quantity == 0 {
            continue;
        }
        let categories: Vec<String> = card
            .get("categories")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_lowercase)
            .collect();
        let zone = if categories.iter().any(|c| c == "commander") {
            Zone::Commander
        } else if categories.iter().any(|c| c == "sideboard") {
            Zone::Side
        } else if categories.iter().any(|c| excluded.contains(c)) {
            Zone::Maybe
        } else {
            Zone::Main
        };
        if zone != Zone::Maybe {
            card_count += quantity;
            for color in card
                .pointer("/card/oracleCard/colorIdentity")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(color_letter)
            {
                colors.insert(color);
            }
        }
        lines.push(ImportLine {
            quantity,
            name,
            zone,
            set: text(card, "/card/edition/editioncode").to_lowercase(),
            collector_number: text(card, "/card/collectorNumber"),
        });
    }
    let summary = archidekt_summary(value, wubrg(|letter| colors.contains(letter)), card_count)
        .ok_or_else(|| AppError::user("Archidekt returned a deck without an id"))?;
    Ok(ExternalDeck {
        summary,
        description: plain_description(&text(value, "/description")),
        lines,
    })
}

/// Archidekt stores descriptions as a Quill delta (`{"ops":[{"insert":…}]}`);
/// older decks hold plain text. Either way, return readable text.
pub fn plain_description(raw: &str) -> String {
    let text = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|delta| {
            let ops = delta.get("ops")?.as_array()?;
            Some(
                ops.iter()
                    .filter_map(|op| op.get("insert")?.as_str())
                    .collect::<String>(),
            )
        })
        .unwrap_or_else(|| raw.to_string());
    let mut out: String = text.trim().chars().take(MAX_DESCRIPTION).collect();
    if text.trim().chars().count() > MAX_DESCRIPTION {
        out.push('…');
    }
    out
}

/// Chooses the Scryfall name a partial commander/card query stands for. An
/// exact match wins; otherwise, for commanders, the first candidate that
/// starts with the text and carries a legendary-style epithet ("Name, Title").
pub fn pick_card_name(text: &str, candidates: &[String], field: SearchField) -> Option<String> {
    let wanted = text.trim().to_lowercase();
    if let Some(exact) = candidates
        .iter()
        .find(|candidate| candidate.to_lowercase() == wanted)
    {
        return Some(exact.clone());
    }
    let prefixed = || {
        candidates
            .iter()
            .filter(|candidate| candidate.to_lowercase().starts_with(&wanted))
    };
    if field == SearchField::Commander {
        if let Some(titled) = prefixed().find(|candidate| candidate.contains(", ")) {
            return Some(titled.clone());
        }
    }
    prefixed().next().or(candidates.first()).cloned()
}

fn cache_key(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"decksearch:");
    hasher.update(url.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn valid_archidekt_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit())
}

impl DeckSearch {
    pub fn new(store: Arc<Store>, providers: Arc<Providers>) -> AppResult<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .build()?;
        Ok(Self {
            store,
            providers,
            client,
            archidekt_next: Mutex::new(Instant::now()),
        })
    }

    /// GET with the SQLite cache and the Archidekt limiter, mirroring
    /// `Providers::json` for the Scryfall host.
    async fn archidekt_json(&self, url: &str) -> AppResult<Value> {
        let key = cache_key(url);
        if let Some(cached) = self.store.cached(&key)? {
            return Ok(cached);
        }
        {
            let mut next = self.archidekt_next.lock().await;
            let now = Instant::now();
            if *next > now {
                tokio::time::sleep(*next - now).await;
            }
            *next = Instant::now() + ARCHIDEKT_INTERVAL;
        }
        let response = self
            .client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|error| {
                AppError::user(format!(
                    "Could not reach Archidekt: {}",
                    if error.is_timeout() {
                        "timed out"
                    } else {
                        "network error"
                    }
                ))
            })?;
        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => {
                *self.archidekt_next.lock().await = Instant::now() + ARCHIDEKT_BACKOFF;
                return Err(AppError::user(
                    "Archidekt is rate limiting requests. Wait 30 seconds and retry.",
                ));
            }
            StatusCode::NOT_FOUND => {
                return Err(AppError::not_found(
                    "Archidekt has no public deck with that id. It may be private or deleted.",
                ));
            }
            status if !status.is_success() => {
                return Err(AppError::user(format!(
                    "Archidekt returned {}. Try again in a moment.",
                    status.as_u16()
                )));
            }
            _ => {}
        }
        let json: Value = response
            .json()
            .await
            .map_err(|_| AppError::user("Archidekt returned invalid JSON"))?;
        self.store.put("cache", &key, &json)?;
        Ok(json)
    }

    async fn card_candidates(&self, text: &str) -> AppResult<Vec<String>> {
        let mut url =
            Url::parse("https://api.scryfall.com/cards/autocomplete").expect("static URL");
        url.query_pairs_mut().append_pair("q", text);
        let catalog = self.providers.json(url.as_str(), None).await?;
        Ok(catalog
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|name| {
                // Reversible printings show up as "Sol Ring // Sol Ring".
                name.split_once(" // ")
                    .is_none_or(|(front, back)| front != back)
            })
            .map(str::to_string)
            .collect())
    }

    pub async fn search(&self, query: DeckQuery, page: u32) -> AppResult<DeckSearchPage> {
        let text = query.text.trim();
        if text.chars().count() < 2 {
            return Err(AppError::user("Type at least two characters to search"));
        }
        if text.len() > 120 {
            return Err(AppError::user("Search text is limited to 120 characters"));
        }
        if let Some(source) = query.source {
            debug_assert_eq!(source, DeckSource::Archidekt);
        }
        let format = if query.format.is_empty() {
            None
        } else {
            Some(archidekt_format_id(&query.format).ok_or_else(|| {
                AppError::user(format!(
                    "Archidekt has no {} format filter. Search any format instead.",
                    query.format
                ))
            })?)
        };
        let (search_text, matched_card, card_matches) = match query.field {
            SearchField::Name => (text.to_string(), None, Vec::new()),
            field => {
                let candidates = self.card_candidates(text).await?;
                let Some(picked) = pick_card_name(text, &candidates, field) else {
                    return Ok(DeckSearchPage {
                        page,
                        ..DeckSearchPage::default()
                    });
                };
                let others = candidates
                    .iter()
                    .filter(|candidate| **candidate != picked)
                    .take(MAX_CARD_MATCHES)
                    .cloned()
                    .collect();
                (picked.clone(), Some(picked), others)
            }
        };
        let url = archidekt_search_url(&search_text, query.field, format, page);
        let value = self.archidekt_json(&url).await?;
        let mut result = parse_archidekt_search(&value, page);
        result.matched_card = matched_card;
        result.card_matches = card_matches;
        Ok(result)
    }

    pub async fn detail(&self, source: DeckSource, id: &str) -> AppResult<ExternalDeck> {
        match source {
            DeckSource::Archidekt => {
                if !valid_archidekt_id(id) {
                    return Err(AppError::user("Invalid Archidekt deck id"));
                }
                let value = self
                    .archidekt_json(&format!("{ARCHIDEKT_API}{id}/"))
                    .await?;
                parse_archidekt_deck(&value)
            }
        }
    }

    /// Fetches the deck and resolves every line on Scryfall. Lines Scryfall
    /// cannot match come back as issues, never silently dropped.
    pub async fn import(&self, source: DeckSource, id: &str) -> AppResult<ResolvedCards> {
        let deck = self.detail(source, id).await?;
        if deck.lines.is_empty() {
            return Err(AppError::user(
                "This deck has no cards to import. Pick another deck.",
            ));
        }
        if deck.lines.len() > 1000 {
            return Err(AppError::user("Decklists are limited to 1000 lines"));
        }
        self.providers.resolve(deck.lines).await
    }
}
