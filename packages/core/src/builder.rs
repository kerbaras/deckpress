//! Guided deck building. The wizard picks a format, colours, a play style and
//! a theme; this module turns that into Scryfall searches (through the
//! rate-limited, cached [`Providers::json`]) and scores every card in the pool
//! with a transparent heuristic that explains itself in plain sentences.
//!
//! Scryfall is the only data source. Its `edhrec` sort order (and the
//! `edhrec_rank` field on each card) is the popularity proxy; EDHREC's own JSON
//! endpoints are undocumented and publish no terms of use, so they are not
//! called. Everything here that does not touch the network is a pure function
//! so it can be tested against fixture JSON.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::models::{new_id, Card, DeckEntry, ImportLine, Zone};
use crate::providers::{normalize_scryfall, Providers};

const SCRYFALL_SEARCH: &str = "https://api.scryfall.com/cards/search";
const SCRYFALL_CARD: &str = "https://api.scryfall.com/cards";
const SCRYFALL_SETS: &str = "https://api.scryfall.com/sets";
/// Scryfall pages hold 175 cards; two pages per query keeps the first
/// suggestion round under a handful of rate-limited requests.
const POOL_PAGES: u32 = 2;
/// Sum of every bonus `score` can award; scores are normalised against it so
/// only a card that ticks every box reaches 1.0.
const MAX_SCORE: f64 = 0.25 + 0.45 + 0.20 + 0.15 + 0.15 + 0.05;
pub const PAGE_SIZE: usize = 30;
const CURVE_BUCKETS: usize = 7;
const COLORS: [(&str, &str, &str); 5] = [
    ("W", "White", "Plains"),
    ("U", "Blue", "Island"),
    ("B", "Black", "Swamp"),
    ("R", "Red", "Mountain"),
    ("G", "Green", "Forest"),
];

// ---------------------------------------------------------------------------
// Options: formats, styles, themes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatRules {
    pub id: &'static str,
    pub name: &'static str,
    /// Label stored on the created `Deck`.
    pub deck_format: &'static str,
    pub deck_size: u32,
    pub land_target: u32,
    pub singleton: bool,
    pub max_copies: u32,
    pub commander: bool,
    pub needs_set: bool,
    pub description: &'static str,
    #[serde(skip)]
    query: &'static str,
    #[serde(skip)]
    order: &'static str,
}

pub const FORMATS: [FormatRules; 7] = [
    FormatRules {
        id: "standard",
        name: "Standard",
        deck_format: "Standard",
        deck_size: 60,
        land_target: 24,
        singleton: false,
        max_copies: 4,
        commander: false,
        needs_set: false,
        description: "60 cards from the newest sets, up to four copies each.",
        query: "format:standard",
        order: "usd",
    },
    FormatRules {
        id: "pioneer",
        name: "Pioneer",
        deck_format: "Pioneer",
        deck_size: 60,
        land_target: 24,
        singleton: false,
        max_copies: 4,
        commander: false,
        needs_set: false,
        description: "60 cards, everything printed since Return to Ravnica.",
        query: "format:pioneer",
        order: "usd",
    },
    FormatRules {
        id: "modern",
        name: "Modern",
        deck_format: "Modern",
        deck_size: 60,
        land_target: 23,
        singleton: false,
        max_copies: 4,
        commander: false,
        needs_set: false,
        description: "60 cards, modern card frames onward. Faster and lower to the ground.",
        query: "format:modern",
        order: "usd",
    },
    FormatRules {
        id: "commander",
        name: "Commander",
        deck_format: "Commander",
        deck_size: 100,
        land_target: 37,
        singleton: true,
        max_copies: 1,
        commander: true,
        needs_set: false,
        description: "100 singleton cards led by a legendary commander whose colours you inherit.",
        query: "format:commander",
        order: "edhrec",
    },
    FormatRules {
        id: "pauper",
        name: "Pauper",
        deck_format: "Pauper",
        deck_size: 60,
        land_target: 22,
        singleton: false,
        max_copies: 4,
        commander: false,
        needs_set: false,
        description: "60 cards, commons only.",
        query: "format:pauper",
        order: "edhrec",
    },
    FormatRules {
        id: "cube",
        name: "Cube",
        deck_format: "Cube",
        deck_size: 40,
        land_target: 17,
        singleton: true,
        max_copies: 1,
        commander: false,
        needs_set: false,
        description: "A 40-card singleton draft deck from a curated pool of Vintage-legal cards.",
        query: "format:vintage",
        order: "edhrec",
    },
    FormatRules {
        id: "limited",
        name: "Draft / Limited",
        deck_format: "Casual",
        deck_size: 40,
        land_target: 17,
        singleton: false,
        max_copies: 4,
        commander: false,
        needs_set: true,
        description: "A 40-card deck built from a single set, as you would after a draft.",
        query: "",
        order: "edhrec",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleRules {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Added to the format's land target (aggro runs fewer lands).
    pub land_adjust: i32,
    /// Share of non-land cards wanted at mana value 0, 1, 2, 3, 4, 5 and 6+.
    pub curve: [f64; CURVE_BUCKETS],
    #[serde(skip)]
    favours: &'static [&'static str],
}

pub const STYLES: [StyleRules; 4] = [
    StyleRules {
        id: "aggro",
        name: "Aggro",
        description: "Cheap threats and burn; win before the opponent stabilises.",
        land_adjust: -3,
        curve: [0.02, 0.28, 0.35, 0.22, 0.10, 0.03, 0.0],
        favours: &["threat", "removal"],
    },
    StyleRules {
        id: "midrange",
        name: "Midrange",
        description: "Efficient creatures backed by removal and card advantage.",
        land_adjust: 0,
        curve: [0.02, 0.10, 0.25, 0.28, 0.20, 0.10, 0.05],
        favours: &["threat", "removal", "draw", "ramp"],
    },
    StyleRules {
        id: "control",
        name: "Control",
        description: "Answer everything, draw extra cards, then win with a few big finishers.",
        land_adjust: 2,
        curve: [0.02, 0.08, 0.22, 0.25, 0.20, 0.13, 0.10],
        favours: &["removal", "interaction", "draw", "wincon"],
    },
    StyleRules {
        id: "combo",
        name: "Combo",
        description:
            "Find the pieces with tutors and card draw, protect them, and assemble the win.",
        land_adjust: -1,
        curve: [0.05, 0.15, 0.30, 0.25, 0.15, 0.07, 0.03],
        favours: &["tutor", "draw", "ramp", "interaction"],
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeRules {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Typal decks need a creature type on top of the theme.
    pub needs_tribe: bool,
    /// Lower-case phrases looked up in oracle text and keywords.
    pub cues: &'static [&'static str],
    /// Lower-case words looked up in the type line.
    pub type_cues: &'static [&'static str],
    #[serde(skip)]
    query: &'static str,
}

pub const THEMES: [ThemeRules; 8] = [
    ThemeRules {
        id: "none",
        name: "No theme",
        description: "Good cards in your colours, ranked by popularity and curve.",
        needs_tribe: false,
        cues: &[],
        type_cues: &[],
        query: "",
    },
    ThemeRules {
        id: "typal",
        name: "Tribal / typal",
        description: "Everything shares a creature type and cares about it.",
        needs_tribe: true,
        cues: &[],
        type_cues: &[],
        query: "",
    },
    ThemeRules {
        id: "tokens",
        name: "Tokens",
        description: "Make lots of small creatures and reward yourself for it.",
        needs_tribe: false,
        cues: &[
            "token",
            "populate",
            "create a",
            "create two",
            "create x",
            "convoke",
        ],
        type_cues: &[],
        query: "(o:token or o:populate)",
    },
    ThemeRules {
        id: "counters",
        name: "+1/+1 counters",
        description: "Grow creatures with counters and proliferate them.",
        needs_tribe: false,
        cues: &[
            "+1/+1 counter",
            "proliferate",
            "counters on",
            "counter on it",
            "adapt",
            "evolve",
            "outlast",
            "mentor",
            "modified",
        ],
        type_cues: &[],
        query: "(o:\"+1/+1 counter\" or o:proliferate)",
    },
    ThemeRules {
        id: "graveyard",
        name: "Graveyard",
        description: "Fill the graveyard and bring things back from it.",
        needs_tribe: false,
        cues: &[
            "graveyard",
            "mill",
            "flashback",
            "unearth",
            "dredge",
            "delve",
            "escape",
            "disturb",
            "reanimate",
        ],
        type_cues: &[],
        query: "(o:graveyard or o:mill)",
    },
    ThemeRules {
        id: "artifacts",
        name: "Artifacts",
        description: "Artifacts and the cards that reward casting or controlling them.",
        needs_tribe: false,
        cues: &[
            "artifact",
            "treasure",
            "affinity",
            "improvise",
            "metalcraft",
        ],
        type_cues: &["artifact"],
        query: "(t:artifact or o:artifact)",
    },
    ThemeRules {
        id: "spells",
        name: "Spells",
        description: "Instants and sorceries, plus creatures that grow when you cast them.",
        needs_tribe: false,
        cues: &[
            "instant or sorcery",
            "instant and sorcery",
            "noncreature spell",
            "prowess",
            "magecraft",
            "storm",
            "copy target",
        ],
        type_cues: &["instant", "sorcery"],
        query: "(o:\"instant or sorcery\" or o:\"noncreature spell\" or kw:prowess or o:magecraft)",
    },
    ThemeRules {
        id: "lands",
        name: "Lands",
        description: "Landfall triggers, land ramp and lands that do more than tap for mana.",
        needs_tribe: false,
        cues: &[
            "landfall",
            "land card",
            "lands you control",
            "land enters",
            "play an additional land",
            "return target land",
        ],
        type_cues: &[],
        query:
            "(o:landfall or o:\"land card\" or o:\"lands you control\" or o:\"additional land\")",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorOption {
    pub id: &'static str,
    pub name: &'static str,
    pub basic: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderOptions {
    pub formats: Vec<FormatRules>,
    pub colors: Vec<ColorOption>,
    pub styles: Vec<StyleRules>,
    pub themes: Vec<ThemeRules>,
    pub source: &'static str,
}

pub fn options() -> BuilderOptions {
    BuilderOptions {
        formats: FORMATS.to_vec(),
        colors: COLORS
            .iter()
            .map(|(id, name, basic)| ColorOption { id, name, basic })
            .collect(),
        styles: STYLES.to_vec(),
        themes: THEMES.to_vec(),
        source: "Card data and popularity from Scryfall (EDHREC rank as sorted by Scryfall).",
    }
}

pub fn format_rules(id: &str) -> AppResult<&'static FormatRules> {
    FORMATS
        .iter()
        .find(|rules| rules.id == id)
        .ok_or_else(|| AppError::user("Choose a format first"))
}

pub fn style_rules(id: &str) -> AppResult<&'static StyleRules> {
    STYLES
        .iter()
        .find(|rules| rules.id == id)
        .ok_or_else(|| AppError::user("Choose a play style first"))
}

pub fn theme_rules(id: &str) -> AppResult<&'static ThemeRules> {
    THEMES
        .iter()
        .find(|rules| rules.id == id)
        .ok_or_else(|| AppError::user("Choose a theme first"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOption {
    pub code: String,
    pub name: String,
    pub released_at: String,
    pub card_count: u32,
}

// ---------------------------------------------------------------------------
// Spec and results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderSpec {
    pub format: String,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub colors: Vec<String>,
    #[serde(default)]
    pub commander: Option<Card>,
    pub style: String,
    pub theme: String,
    #[serde(default)]
    pub tribe: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub card: Card,
    /// 0..1, two decimals.
    pub score: f64,
    pub reasons: Vec<String>,
    pub role: &'static str,
    pub oracle_text: String,
    pub popularity_rank: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionPage {
    pub items: Vec<Suggestion>,
    pub page: u32,
    pub has_more: bool,
    pub total: usize,
    /// The Scryfall queries that produced the pool, for the "why these cards" line.
    pub queries: Vec<String>,
    pub colors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurveBucket {
    pub label: &'static str,
    pub count: u32,
    pub target: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorShare {
    pub color: String,
    pub pips: u32,
    pub cards: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub count: u32,
    pub target: u32,
    pub lands: u32,
    pub land_target: u32,
    pub singleton: bool,
    pub max_copies: u32,
    pub curve: Vec<CurveBucket>,
    pub colors: Vec<ColorShare>,
    pub issues: Vec<String>,
    pub complete: bool,
}

// ---------------------------------------------------------------------------
// Pool cards and scoring (pure)
// ---------------------------------------------------------------------------

/// A card from a Scryfall search plus the fields scoring needs and `Card`
/// does not carry.
#[derive(Debug, Clone)]
pub struct PoolCard {
    pub card: Card,
    pub oracle_text: String,
    pub keywords: Vec<String>,
    pub edhrec_rank: Option<u32>,
    /// Position in the search that returned it (0 = most popular).
    pub rank: usize,
    pub pool_len: usize,
}

#[derive(Debug, Deserialize)]
struct ScryfallText {
    #[serde(default)]
    oracle_text: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    edhrec_rank: Option<u32>,
    #[serde(default)]
    card_faces: Option<Vec<ScryfallFaceText>>,
}

#[derive(Debug, Deserialize)]
struct ScryfallFaceText {
    #[serde(default)]
    oracle_text: String,
}

/// Turns a Scryfall card object into a scorable pool card. Fails only when
/// `normalize_scryfall` cannot find printable imagery.
pub fn pool_card(value: &Value, rank: usize, pool_len: usize) -> AppResult<PoolCard> {
    let card = normalize_scryfall(value)?;
    let text: ScryfallText = serde_json::from_value(value.clone())
        .map_err(|error| AppError::user(format!("Unexpected Scryfall card data: {error}")))?;
    let oracle_text = match (text.oracle_text, text.card_faces) {
        (Some(oracle), _) if !oracle.is_empty() => oracle,
        (_, Some(faces)) => faces
            .into_iter()
            .map(|face| face.oracle_text)
            .filter(|face| !face.is_empty())
            .collect::<Vec<_>>()
            .join("\n//\n"),
        _ => String::new(),
    };
    Ok(PoolCard {
        card,
        oracle_text,
        keywords: text.keywords,
        edhrec_rank: text.edhrec_rank,
        rank,
        pool_len,
    })
}

/// Everything scoring needs to know about the deck being built.
pub struct Context<'a> {
    pub rules: &'a FormatRules,
    pub style: &'a StyleRules,
    pub theme: &'a ThemeRules,
    pub tribe: String,
    pub colors: Vec<String>,
    pub commander: Option<CommanderProfile>,
}

/// What the chosen commander cares about, derived from its oracle text.
#[derive(Debug, Clone)]
pub struct CommanderProfile {
    pub name: String,
    pub themes: Vec<&'static ThemeRules>,
}

pub fn commander_profile(name: &str, oracle_text: &str, type_line: &str) -> CommanderProfile {
    let haystack = format!("{}\n{}", oracle_text, type_line).to_lowercase();
    CommanderProfile {
        name: name.to_string(),
        themes: THEMES
            .iter()
            .filter(|theme| !theme.cues.is_empty())
            .filter(|theme| !theme_hits(theme, &haystack, &type_line.to_lowercase()).is_empty())
            .collect(),
    }
}

fn theme_hits<'t>(theme: &'t ThemeRules, oracle: &str, type_line: &str) -> Vec<&'t str> {
    let mut hits: Vec<&str> = theme
        .cues
        .iter()
        .copied()
        .filter(|cue| oracle.contains(cue))
        .collect();
    hits.extend(
        theme
            .type_cues
            .iter()
            .copied()
            .filter(|cue| type_line.contains(cue)),
    );
    hits.dedup();
    hits
}

pub fn is_land(type_line: &str) -> bool {
    type_line.to_lowercase().contains("land")
}

fn is_basic(type_line: &str) -> bool {
    type_line.to_lowercase().contains("basic")
}

fn curve_bucket(mana_value: f64) -> usize {
    (mana_value.max(0.0).floor() as usize).min(CURVE_BUCKETS - 1)
}

const CURVE_LABELS: [&str; CURVE_BUCKETS] = ["0", "1", "2", "3", "4", "5", "6+"];

/// Coarse job of a card in a deck, from its type line and oracle text.
pub fn classify_role(
    type_line: &str,
    oracle_text: &str,
    mana_value: f64,
    themed: bool,
) -> &'static str {
    let types = type_line.to_lowercase();
    let text = oracle_text.to_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if is_land(&types) {
        return "land";
    }
    if any(&["you win the game", "each opponent loses", "loses the game"]) {
        return "wincon";
    }
    if any(&["add {", "add one mana", "add two mana", "add three mana"])
        || (any(&["land card"]) && any(&["onto the battlefield"]))
    {
        return "ramp";
    }
    if any(&[
        "destroy target",
        "exile target",
        "destroy all",
        "exile all",
        "damage to any target",
        "damage to target creature",
        "damage to each creature",
        "gets -",
        "fights",
        "sacrifices a creature",
    ]) {
        return "removal";
    }
    if any(&[
        "counter target",
        "gain hexproof",
        "gains indestructible",
        "protection from",
        "can't be countered",
    ]) {
        return "interaction";
    }
    if any(&["search your library for a card"]) {
        return "tutor";
    }
    if any(&[
        "draw a card",
        "draw two",
        "draw three",
        "draw x",
        "draw cards",
        "draws a card",
    ]) {
        return "draw";
    }
    if types.contains("creature") {
        return if mana_value >= 5.0 {
            "wincon"
        } else {
            "threat"
        };
    }
    if themed {
        return "synergy";
    }
    "utility"
}

fn role_label(role: &str) -> &'static str {
    match role {
        "land" => "Land",
        "ramp" => "Ramp",
        "draw" => "Card draw",
        "removal" => "Removal",
        "interaction" => "Interaction",
        "tutor" => "Tutor",
        "wincon" => "Finisher",
        "threat" => "Threat",
        "synergy" => "Synergy piece",
        "commander" => "Commander",
        _ => "Utility",
    }
}

fn plural_tribe(tribe: &str) -> String {
    let lower = tribe.to_lowercase();
    if lower.ends_with('s') || lower.ends_with("folk") || lower.ends_with("kin") {
        tribe.to_string()
    } else if lower.ends_with('f') && !lower.ends_with("ff") {
        format!("{}ves", &tribe[..tribe.len() - 1])
    } else {
        format!("{tribe}s")
    }
}

fn article(word: &str) -> &'static str {
    match word.chars().next().map(|c| c.to_ascii_lowercase()) {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ => "a",
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// The heuristic. Weights sum to just over one so a card that hits every
/// mark saturates at 1.0.
pub fn score(pool: &PoolCard, ctx: &Context<'_>) -> Suggestion {
    let card = &pool.card;
    let oracle = format!("{}\n{}", pool.oracle_text, pool.keywords.join("\n")).to_lowercase();
    let types = card.type_line.to_lowercase();
    let land = is_land(&types);
    let mut total = 0.0;
    let mut reasons = Vec::new();

    // Popularity: position within the Scryfall ordering that returned it.
    let popularity = if pool.pool_len > 1 {
        1.0 - pool.rank as f64 / (pool.pool_len - 1) as f64
    } else {
        1.0
    };
    total += 0.25 * popularity;
    match (pool.edhrec_rank, ctx.rules.order) {
        (Some(rank), _) if rank <= 500 => reasons.push(format!("EDHREC rank #{rank} on Scryfall")),
        (_, "usd") if popularity >= 0.8 => reasons.push(format!(
            "Among the most sought-after {} cards",
            ctx.rules.name
        )),
        (_, _) if popularity >= 0.8 => {
            reasons.push(format!("Among the most played cards in {}", ctx.rules.name))
        }
        _ => {}
    }

    // Theme fit.
    let mut themed = false;
    if ctx.theme.needs_tribe && !ctx.tribe.is_empty() {
        let tribe = ctx.tribe.to_lowercase();
        let plural = plural_tribe(&ctx.tribe);
        if types.contains(&tribe) {
            total += 0.40;
            themed = true;
            reasons.push(format!("Is {} {}", article(&ctx.tribe), ctx.tribe));
        }
        if oracle.contains(&tribe) {
            total += if themed { 0.10 } else { 0.25 };
            themed = true;
            reasons.push(format!("Cares about {plural}"));
        }
    } else if !ctx.theme.cues.is_empty() || !ctx.theme.type_cues.is_empty() {
        let hits = theme_hits(ctx.theme, &oracle, &types);
        if !hits.is_empty() {
            themed = true;
            total += 0.35 + 0.05 * (hits.len() - 1).min(2) as f64;
            reasons.push(format!(
                "Fits {}: {}",
                ctx.theme.name.to_lowercase(),
                hits.iter()
                    .take(3)
                    .map(|hit| format!("\"{hit}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }

    // Commander synergy: themes read off the commander's own text.
    if let Some(commander) = &ctx.commander {
        let mut bonus: f64 = 0.0;
        for theme in &commander.themes {
            if !theme_hits(theme, &oracle, &types).is_empty() {
                if theme.id == ctx.theme.id {
                    bonus += 0.05;
                    reasons.push(format!(
                        "{} also cares about {}",
                        commander.name,
                        theme.name.to_lowercase()
                    ));
                } else {
                    bonus += 0.15;
                    reasons.push(format!(
                        "Works with {}'s {} text",
                        commander.name,
                        theme.name.to_lowercase()
                    ));
                }
            }
        }
        total += bonus.min(0.20);
    }

    // Role and what the play style wants.
    let role = classify_role(&card.type_line, &pool.oracle_text, card.mana_value, themed);
    if ctx.style.favours.contains(&role) {
        total += 0.10;
        reasons.push(format!(
            "{}, which {} decks want",
            role_label(role),
            ctx.style.name.to_lowercase()
        ));
    }
    if ctx.rules.commander && role == "ramp" {
        total += 0.05;
        reasons.push("Ramp is at a premium in Commander".into());
    }

    // Curve fit for non-lands.
    if !land {
        let bucket = curve_bucket(card.mana_value);
        let share = ctx.style.curve[bucket];
        let peak = ctx
            .style
            .curve
            .iter()
            .copied()
            .fold(0.0_f64, f64::max)
            .max(f64::EPSILON);
        total += 0.15 * share / peak;
        if share / peak >= 0.75 {
            reasons.push(format!(
                "Mana value {} suits the {} curve",
                card.mana_value as u32,
                ctx.style.name.to_lowercase()
            ));
        } else if share == 0.0 {
            reasons.push(format!(
                "Mana value {} is above what {} decks usually run",
                card.mana_value as u32,
                ctx.style.name.to_lowercase()
            ));
        }
    } else {
        let produces: Vec<&str> = ctx
            .colors
            .iter()
            .filter(|color| oracle.contains(&format!("{{{}}}", color.to_lowercase())))
            .map(String::as_str)
            .collect();
        if produces.len() >= 2 {
            total += 0.15;
            reasons.push(format!("Makes {} of your colours", produces.len()));
        } else if !is_basic(&types) {
            total += 0.05;
        }
    }

    // Colour fit.
    if !ctx.colors.is_empty() {
        let outside = card.colors.iter().any(|color| !ctx.colors.contains(color));
        if outside {
            total = 0.0;
            reasons.clear();
            reasons.push("Outside your colour identity".into());
        } else if card.colors.len() >= 2 {
            total += 0.05;
            reasons.push(format!("Uses {} of your colours", card.colors.len()));
        } else if card.colors.is_empty() && !land {
            total += 0.02;
        }
    }

    if reasons.is_empty() {
        reasons.push(format!("Legal in {} and in your colours", ctx.rules.name));
    }
    Suggestion {
        card: card.clone(),
        score: round2((total / MAX_SCORE).clamp(0.0, 1.0)),
        reasons,
        role,
        oracle_text: pool.oracle_text.clone(),
        popularity_rank: pool.edhrec_rank,
    }
}

/// Scores and sorts a pool; the caller paginates.
pub fn rank(pool: &[PoolCard], ctx: &Context<'_>) -> Vec<Suggestion> {
    let mut ranked: Vec<Suggestion> = pool.iter().map(|card| score(card, ctx)).collect();
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.card.name.cmp(&b.card.name))
    });
    ranked
}

// ---------------------------------------------------------------------------
// Summary and fill (pure)
// ---------------------------------------------------------------------------

pub fn land_target(rules: &FormatRules, style: &StyleRules) -> u32 {
    (rules.land_target as i32 + style.land_adjust).max(0) as u32
}

fn nonland_target(rules: &FormatRules, style: &StyleRules) -> u32 {
    let commander = u32::from(rules.commander);
    rules
        .deck_size
        .saturating_sub(land_target(rules, style))
        .saturating_sub(commander)
}

/// Coloured pips in a mana cost such as `{2}{G}{G/U}`; hybrid symbols count
/// for each colour they contain.
pub fn pips(mana_cost: &str) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    for symbol in mana_cost.split('{').skip(1) {
        let symbol = symbol.split('}').next().unwrap_or("");
        for part in symbol.split('/') {
            if COLORS.iter().any(|(id, _, _)| *id == part) {
                *counts.entry(part.to_string()).or_default() += 1;
            }
        }
    }
    counts
}

fn active(entries: &[DeckEntry]) -> impl Iterator<Item = &DeckEntry> {
    entries
        .iter()
        .filter(|entry| !entry.excluded && matches!(entry.zone, Zone::Main | Zone::Commander))
}

pub fn summarize(
    rules: &FormatRules,
    style: &StyleRules,
    colors: &[String],
    entries: &[DeckEntry],
) -> Summary {
    let mut count = 0;
    let mut lands = 0;
    let mut curve = [0u32; CURVE_BUCKETS];
    let mut pip_counts: HashMap<String, u32> = HashMap::new();
    let mut color_cards: HashMap<String, u32> = HashMap::new();
    let mut copies: HashMap<&str, (u32, &str, bool)> = HashMap::new();
    let mut has_commander = false;
    for entry in active(entries) {
        count += entry.quantity;
        let card = &entry.card;
        if matches!(entry.zone, Zone::Commander) {
            has_commander = true;
        }
        if is_land(&card.type_line) {
            lands += entry.quantity;
        } else {
            curve[curve_bucket(card.mana_value)] += entry.quantity;
        }
        for (color, pips) in pips(&card.mana_cost) {
            *pip_counts.entry(color).or_default() += pips * entry.quantity;
        }
        for color in &card.colors {
            *color_cards.entry(color.clone()).or_default() += entry.quantity;
        }
        let slot = copies.entry(card.oracle_id.as_str()).or_insert((
            0,
            card.name.as_str(),
            is_basic(&card.type_line),
        ));
        slot.0 += entry.quantity;
    }
    let target = rules.deck_size;
    let land_goal = land_target(rules, style);
    let nonland = nonland_target(rules, style) as f64;
    let mut issues = Vec::new();
    if rules.commander && !has_commander {
        issues.push("Choose a commander; it counts as one of the 100 cards.".into());
    }
    let mut over: Vec<String> = copies
        .values()
        .filter(|(quantity, _, basic)| !basic && *quantity > rules.max_copies)
        .map(|(quantity, name, _)| {
            if rules.singleton {
                format!(
                    "{name} appears {quantity} times; {} decks are singleton.",
                    rules.name
                )
            } else {
                format!(
                    "{name} has {quantity} copies; the limit is {}.",
                    rules.max_copies
                )
            }
        })
        .collect();
    over.sort();
    issues.extend(over);
    if count > target {
        issues.push(format!(
            "{} cards over the {target}-card target.",
            count - target
        ));
    }
    if count == target && lands + 3 < land_goal {
        issues.push(format!(
            "Only {lands} lands; {} decks usually run about {land_goal}.",
            style.name
        ));
    }
    let mut color_shares: Vec<ColorShare> = COLORS
        .iter()
        .filter(|(id, _, _)| colors.is_empty() || colors.iter().any(|color| color == id))
        .map(|(id, _, _)| ColorShare {
            color: id.to_string(),
            pips: pip_counts.get(*id).copied().unwrap_or(0),
            cards: color_cards.get(*id).copied().unwrap_or(0),
        })
        .collect();
    if colors.is_empty() {
        color_shares.retain(|share| share.pips > 0 || share.cards > 0);
    }
    Summary {
        count,
        target,
        lands,
        land_target: land_goal,
        singleton: rules.singleton,
        max_copies: rules.max_copies,
        curve: CURVE_LABELS
            .iter()
            .enumerate()
            .map(|(index, label)| CurveBucket {
                label,
                count: curve[index],
                target: (style.curve[index] * nonland).round() as u32,
            })
            .collect(),
        colors: color_shares,
        complete: count == target && issues.is_empty(),
        issues,
    }
}

/// Which basic lands to add so the deck reaches its target, split by the
/// coloured pips already in it (or evenly across the chosen colours).
pub fn basic_split(
    colors: &[String],
    pip_counts: &HashMap<String, u32>,
    total: u32,
) -> Vec<(&'static str, u32)> {
    if total == 0 {
        return Vec::new();
    }
    let palette: Vec<&(&str, &str, &str)> = COLORS
        .iter()
        .filter(|(id, _, _)| colors.iter().any(|color| color == id))
        .collect();
    if palette.is_empty() {
        return vec![("Wastes", total)];
    }
    let weights: Vec<f64> = palette
        .iter()
        .map(|(id, _, _)| pip_counts.get(*id).copied().unwrap_or(0) as f64)
        .collect();
    let sum: f64 = weights.iter().sum();
    let weights: Vec<f64> = if sum == 0.0 {
        vec![1.0; palette.len()]
    } else {
        weights
    };
    let sum: f64 = weights.iter().sum();
    let mut shares: Vec<(usize, u32, f64)> = weights
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            let exact = weight / sum * total as f64;
            (index, exact.floor() as u32, exact - exact.floor())
        })
        .collect();
    let assigned: u32 = shares.iter().map(|(_, whole, _)| whole).sum();
    shares.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    for share in shares.iter_mut().take((total - assigned) as usize) {
        share.1 += 1;
    }
    shares.sort_by_key(|share| share.0);
    shares
        .into_iter()
        .filter(|(_, count, _)| *count > 0)
        .map(|(index, count, _)| (palette[index].2, count))
        .collect()
}

/// Non-land suggestions to add (with quantities) and basics to fetch, so the
/// deck lands exactly on its size target.
pub struct FillPlan {
    pub entries: Vec<DeckEntry>,
    pub basics: Vec<(&'static str, u32)>,
}

pub fn plan_fill(
    rules: &FormatRules,
    style: &StyleRules,
    colors: &[String],
    entries: &[DeckEntry],
    ranked: &[Suggestion],
) -> FillPlan {
    let summary = summarize(rules, style, colors, entries);
    let mut count = summary.count;
    let lands = summary.lands;
    let land_goal = land_target(rules, style);
    let owned: HashSet<&str> = active(entries)
        .map(|entry| entry.card.oracle_id.as_str())
        .collect();
    let mut added = Vec::new();
    let nonland_room = rules
        .deck_size
        .saturating_sub(count)
        .saturating_sub(land_goal.saturating_sub(lands));
    let mut remaining = nonland_room;
    for suggestion in ranked {
        if remaining == 0 {
            break;
        }
        if suggestion.score <= 0.0
            || is_land(&suggestion.card.type_line)
            || owned.contains(suggestion.card.oracle_id.as_str())
        {
            continue;
        }
        let quantity = rules.max_copies.min(remaining);
        remaining -= quantity;
        count += quantity;
        added.push(DeckEntry {
            id: new_id(),
            card: suggestion.card.clone(),
            quantity,
            zone: Zone::Main,
            selected_art: None,
            selected_back: None,
            excluded: false,
        });
    }
    let mut pip_counts: HashMap<String, u32> = HashMap::new();
    for entry in active(entries).chain(added.iter()) {
        for (color, pips) in pips(&entry.card.mana_cost) {
            *pip_counts.entry(color).or_default() += pips * entry.quantity;
        }
    }
    let land_room = rules.deck_size.saturating_sub(count);
    FillPlan {
        entries: added,
        basics: basic_split(colors, &pip_counts, land_room),
    }
}

// ---------------------------------------------------------------------------
// Network side
// ---------------------------------------------------------------------------

pub struct Builder {
    providers: Arc<Providers>,
}

pub fn base_query(rules: &FormatRules, spec: &BuilderSpec, colors: &[String]) -> AppResult<String> {
    let mut parts = vec!["game:paper".to_string(), "-t:basic".to_string()];
    if rules.needs_set {
        if spec.set.trim().is_empty() {
            return Err(AppError::user(
                "Pick the set you drafted before asking for suggestions",
            ));
        }
        parts.push(format!("set:{}", spec.set.trim().to_lowercase()));
    } else {
        parts.push(rules.query.to_string());
    }
    if !colors.is_empty() {
        parts.push(format!("id<={}", colors.join("")));
    } else if !rules.needs_set {
        parts.push("id<=c".to_string());
    }
    Ok(parts.join(" "))
}

pub fn search_url(query: &str, order: &str, page: u32) -> String {
    Url::parse_with_params(
        SCRYFALL_SEARCH,
        [
            ("q", query),
            ("unique", "cards"),
            ("order", order),
            ("page", page.to_string().as_str()),
        ],
    )
    .map(String::from)
    .unwrap_or_default()
}

fn is_empty_search(error: &AppError) -> bool {
    matches!(error, AppError::User(message) if message.contains("returned 404"))
}

impl Builder {
    pub fn new(providers: Arc<Providers>) -> Self {
        Self { providers }
    }

    /// Runs one Scryfall search for up to `pages` pages; an empty result is
    /// not an error.
    async fn search(&self, query: &str, order: &str, pages: u32) -> AppResult<Vec<Value>> {
        let mut cards = Vec::new();
        for page in 1..=pages {
            let response = match self
                .providers
                .json(&search_url(query, order, page), None)
                .await
            {
                Ok(response) => response,
                Err(error) if is_empty_search(&error) => break,
                Err(error) => return Err(error),
            };
            cards.extend(
                response
                    .get("data")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            if !response
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                break;
            }
        }
        Ok(cards)
    }

    /// Legendary creatures (and other legal commanders) matching a name.
    pub async fn commanders(&self, query: &str, colors: &[String]) -> AppResult<Vec<Suggestion>> {
        let query = query.trim();
        let mut parts = vec!["is:commander".to_string(), "game:paper".to_string()];
        if !query.is_empty() {
            parts.push(format!("name:\"{}\"", query.replace(['"', '\\'], " ")));
        }
        if !colors.is_empty() {
            parts.push(format!("id<={}", colors.join("")));
        }
        let cards = self.search(&parts.join(" "), "edhrec", 1).await?;
        let pool_len = cards.len();
        Ok(cards
            .iter()
            .enumerate()
            .filter_map(|(rank, value)| pool_card(value, rank, pool_len).ok())
            .map(|pool| {
                let profile =
                    commander_profile(&pool.card.name, &pool.oracle_text, &pool.card.type_line);
                let mut reasons: Vec<String> = profile
                    .themes
                    .iter()
                    .map(|theme| format!("Cares about {}", theme.name.to_lowercase()))
                    .collect();
                if let Some(rank) = pool.edhrec_rank {
                    reasons.push(format!("EDHREC rank #{rank} on Scryfall"));
                }
                Suggestion {
                    card: pool.card,
                    score: 1.0,
                    reasons,
                    role: "commander",
                    oracle_text: pool.oracle_text,
                    popularity_rank: pool.edhrec_rank,
                }
            })
            .collect())
    }

    /// Draftable sets, newest first.
    pub async fn sets(&self) -> AppResult<Vec<SetOption>> {
        let response = self.providers.json(SCRYFALL_SETS, None).await?;
        let mut sets: Vec<SetOption> = response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|set| {
                matches!(
                    set.get("set_type").and_then(Value::as_str),
                    Some("expansion" | "core" | "masters" | "draft_innovation")
                ) && !set.get("digital").and_then(Value::as_bool).unwrap_or(false)
                    && set.get("card_count").and_then(Value::as_u64).unwrap_or(0) >= 100
            })
            .filter_map(|set| {
                Some(SetOption {
                    code: set.get("code")?.as_str()?.to_string(),
                    name: set.get("name")?.as_str()?.to_string(),
                    released_at: set.get("released_at")?.as_str()?.to_string(),
                    card_count: set.get("card_count")?.as_u64()? as u32,
                })
            })
            .collect();
        sets.sort_by(|a, b| b.released_at.cmp(&a.released_at));
        Ok(sets)
    }

    async fn commander_context(&self, card: &Card) -> AppResult<CommanderProfile> {
        let response = self
            .providers
            .json(&format!("{SCRYFALL_CARD}/{}", card.id), None)
            .await?;
        let pool = pool_card(&response, 0, 1)?;
        Ok(commander_profile(
            &card.name,
            &pool.oracle_text,
            &card.type_line,
        ))
    }

    fn resolve_context(
        &self,
        spec: &BuilderSpec,
    ) -> AppResult<(
        &'static FormatRules,
        &'static StyleRules,
        &'static ThemeRules,
        Vec<String>,
    )> {
        let rules = format_rules(&spec.format)?;
        let style = style_rules(&spec.style)?;
        let theme = theme_rules(&spec.theme)?;
        if theme.needs_tribe && spec.tribe.trim().is_empty() {
            return Err(AppError::user(
                "Type the creature type your deck is built around",
            ));
        }
        let colors = match &spec.commander {
            Some(commander) => commander.colors.clone(),
            None => spec.colors.clone(),
        };
        let mut colors: Vec<String> = colors
            .into_iter()
            .map(|color| color.to_uppercase())
            .filter(|color| COLORS.iter().any(|(id, _, _)| *id == color))
            .collect();
        colors.sort_by_key(|color| COLORS.iter().position(|(id, _, _)| *id == color));
        colors.dedup();
        Ok((rules, style, theme, colors))
    }

    /// The scored pool for a spec: staples plus theme-specific searches,
    /// deduplicated by oracle id.
    async fn pool(
        &self,
        spec: &BuilderSpec,
    ) -> AppResult<(Vec<Suggestion>, Vec<String>, Vec<String>)> {
        let (rules, style, theme, colors) = self.resolve_context(spec)?;
        let base = base_query(rules, spec, &colors)?;
        let commander = match &spec.commander {
            Some(card) if rules.commander => Some(self.commander_context(card).await?),
            _ => None,
        };
        let mut queries = vec![(base.clone(), rules.order)];
        if theme.needs_tribe {
            let tribe = spec.tribe.trim().replace('"', "");
            queries.push((format!("{base} (t:\"{tribe}\" or o:\"{tribe}\")"), "edhrec"));
        } else if !theme.query.is_empty() {
            queries.push((format!("{base} {}", theme.query), "edhrec"));
        }
        if let Some(profile) = &commander {
            for extra in profile
                .themes
                .iter()
                .filter(|extra| extra.id != theme.id && !extra.query.is_empty())
                .take(2)
            {
                queries.push((format!("{base} {}", extra.query), "edhrec"));
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        if let Some(card) = &spec.commander {
            seen.insert(card.oracle_id.clone());
        }
        let mut pool = Vec::new();
        for (index, (query, order)) in queries.iter().enumerate() {
            let pages = if index == 0 { POOL_PAGES } else { 1 };
            let cards = self.search(query, order, pages).await?;
            let pool_len = cards.len();
            for (rank, value) in cards.iter().enumerate() {
                let Ok(card) = pool_card(value, rank, pool_len) else {
                    continue;
                };
                if seen.insert(card.card.oracle_id.clone()) {
                    pool.push(card);
                }
            }
        }
        let ctx = Context {
            rules,
            style,
            theme,
            tribe: spec.tribe.trim().to_string(),
            colors: colors.clone(),
            commander,
        };
        Ok((
            rank(&pool, &ctx),
            queries.into_iter().map(|(query, _)| query).collect(),
            colors,
        ))
    }

    pub async fn suggest(&self, spec: &BuilderSpec, page: u32) -> AppResult<SuggestionPage> {
        let (ranked, queries, colors) = self.pool(spec).await?;
        let page = page.max(1);
        let start = ((page - 1) as usize) * PAGE_SIZE;
        let total = ranked.len();
        let items: Vec<Suggestion> = ranked.into_iter().skip(start).take(PAGE_SIZE).collect();
        Ok(SuggestionPage {
            has_more: start + items.len() < total,
            items,
            page,
            total,
            queries,
            colors,
        })
    }

    pub fn summary(&self, spec: &BuilderSpec, entries: &[DeckEntry]) -> AppResult<Summary> {
        let (rules, style, _, colors) = self.resolve_context(spec)?;
        Ok(summarize(rules, style, &colors, entries))
    }

    /// Entries to append so the deck reaches its target: top suggestions for
    /// the non-land slots, then basics in the deck's colour proportions.
    pub async fn fill(
        &self,
        spec: &BuilderSpec,
        entries: &[DeckEntry],
    ) -> AppResult<Vec<DeckEntry>> {
        let (rules, style, _, colors) = self.resolve_context(spec)?;
        let (ranked, _, _) = self.pool(spec).await?;
        let plan = plan_fill(rules, style, &colors, entries, &ranked);
        let mut added = plan.entries;
        if !plan.basics.is_empty() {
            added.extend(self.basics(spec, rules, &plan.basics).await?);
        }
        Ok(added)
    }

    /// Fetches basic lands, from the drafted set when there is one (falling
    /// back to any printing for sets without basics).
    async fn basics(
        &self,
        spec: &BuilderSpec,
        rules: &FormatRules,
        basics: &[(&'static str, u32)],
    ) -> AppResult<Vec<DeckEntry>> {
        let lines = |set: &str| -> Vec<ImportLine> {
            basics
                .iter()
                .map(|(name, quantity)| ImportLine {
                    quantity: *quantity,
                    name: name.to_string(),
                    zone: Zone::Main,
                    set: set.to_string(),
                    collector_number: String::new(),
                })
                .collect()
        };
        let set = spec.set.trim().to_lowercase();
        if rules.needs_set && !set.is_empty() {
            let resolved = self.providers.resolve(lines(&set)).await?;
            if resolved.issues.is_empty() {
                return Ok(resolved.entries);
            }
        }
        let resolved = self.providers.resolve(lines("")).await?;
        if let Some(issue) = resolved.issues.first() {
            return Err(AppError::user(format!(
                "Could not fetch basic lands from Scryfall: {}",
                issue.message
            )));
        }
        Ok(resolved.entries)
    }
}
