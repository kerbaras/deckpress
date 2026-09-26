//! Serializable mirror of the `apps/web/src/core` models. The webview validates
//! everything with zod before it reaches a command, so these types apply the
//! same defaults but stay lenient about unknown fields.

use serde::{Deserialize, Serialize};

fn default_dpi() -> f64 {
    300.0
}
fn default_language() -> String {
    "en".into()
}
fn default_artist() -> String {
    "Unknown".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Art {
    pub id: String,
    pub provider: Provider,
    #[serde(default)]
    pub name: String,
    pub image_url: String,
    pub thumbnail_url: String,
    #[serde(default)]
    pub art_crop_url: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub source: String,
    #[serde(default = "default_artist")]
    pub artist: String,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub collector_number: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub released_at: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_dpi")]
    pub dpi: f64,
    #[serde(default)]
    pub bleed_mm: f64,
    #[serde(default)]
    pub back_image_url: String,
    #[serde(default)]
    pub back_thumbnail_url: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Scryfall,
    Mpc,
    Upload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub type_line: String,
    #[serde(default)]
    pub mana_cost: String,
    #[serde(default)]
    pub mana_value: f64,
    #[serde(default)]
    pub colors: Vec<String>,
    pub faces: Vec<Art>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Main,
    Commander,
    Side,
    Maybe,
    Tokens,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckEntry {
    pub id: String,
    pub card: Card,
    pub quantity: u32,
    pub zone: Zone,
    #[serde(default)]
    pub selected_art: Option<Art>,
    #[serde(default)]
    pub selected_back: Option<Art>,
    #[serde(default)]
    pub excluded: bool,
}

impl DeckEntry {
    pub fn front_art(&self) -> &Art {
        self.selected_art
            .as_ref()
            .or(self.card.faces.first())
            .expect("deck entries always carry at least one face")
    }

    pub fn back_art(&self) -> Option<Art> {
        if let Some(back) = &self.selected_back {
            return Some(back.clone());
        }
        let front = self.front_art();
        if !front.back_image_url.is_empty() {
            return Some(Art {
                id: format!("{}:back", front.id),
                image_url: front.back_image_url.clone(),
                thumbnail_url: if front.back_thumbnail_url.is_empty() {
                    front.back_image_url.clone()
                } else {
                    front.back_thumbnail_url.clone()
                },
                ..front.clone()
            });
        }
        self.card.faces.get(1).cloned()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    A4,
    Letter,
    A3,
    A5,
    Legal,
    Tabloid,
    Custom,
}

impl Paper {
    pub fn size_mm(self, custom: (f64, f64)) -> (f64, f64) {
        match self {
            Paper::A4 => (210.0, 297.0),
            Paper::Letter => (215.9, 279.4),
            Paper::A3 => (297.0, 420.0),
            Paper::A5 => (148.0, 210.0),
            Paper::Legal => (215.9, 355.6),
            Paper::Tabloid => (279.4, 431.8),
            Paper::Custom => custom,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BleedMode {
    Solid,
    Mirror,
    Edge,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Guides {
    Crop,
    Full,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Backs {
    None,
    LongEdge,
    ShortEdge,
    Separate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PrintSettings {
    pub paper: Paper,
    pub custom_width_mm: f64,
    pub custom_height_mm: f64,
    pub orientation: Orientation,
    pub card_width_mm: f64,
    pub card_height_mm: f64,
    pub margin_mm: f64,
    pub gap_mm: f64,
    pub bleed_mm: f64,
    pub bleed_mode: BleedMode,
    pub bleed_color: String,
    pub columns: u32,
    pub rows: u32,
    pub guides: Guides,
    pub guide_length_mm: f64,
    pub guide_offset_mm: f64,
    pub guide_width_pt: f64,
    pub guide_color: String,
    pub dpi: u32,
    pub quality: u8,
    pub upscale: bool,
    pub upscale_model: String,
    pub calibration_page: bool,
    pub backs: Backs,
    pub back_offset_xmm: f64,
    pub back_offset_ymm: f64,
    pub include_sideboard: bool,
    pub include_maybeboard: bool,
    pub skip_basics: bool,
    pub page_from: u32,
    pub page_to: u32,
}

impl Default for PrintSettings {
    fn default() -> Self {
        Self {
            paper: Paper::A4,
            custom_width_mm: 210.0,
            custom_height_mm: 297.0,
            orientation: Orientation::Portrait,
            card_width_mm: 63.0,
            card_height_mm: 88.0,
            margin_mm: 4.0,
            gap_mm: 0.0,
            bleed_mm: 1.0,
            bleed_mode: BleedMode::Mirror,
            bleed_color: "#111111".into(),
            columns: 0,
            rows: 0,
            guides: Guides::Crop,
            guide_length_mm: 2.0,
            guide_offset_mm: 0.5,
            guide_width_pt: 0.25,
            guide_color: "#222222".into(),
            dpi: 800,
            quality: 92,
            upscale: false,
            upscale_model: String::new(),
            calibration_page: true,
            backs: Backs::None,
            back_offset_xmm: 0.0,
            back_offset_ymm: 0.0,
            include_sideboard: false,
            include_maybeboard: false,
            skip_basics: false,
            page_from: 1,
            page_to: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub id: String,
    pub name: String,
    pub format: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub entries: Vec<DeckEntry>,
    #[serde(default)]
    pub cover_entry_id: String,
    #[serde(default)]
    pub print_settings: PrintSettings,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

impl Deck {
    pub fn printable_entries(&self, settings: &PrintSettings) -> Vec<&DeckEntry> {
        self.entries
            .iter()
            .filter(|entry| {
                !entry.excluded
                    && (entry.zone != Zone::Side || settings.include_sideboard)
                    && (entry.zone != Zone::Maybe || settings.include_maybeboard)
                    && (!settings.skip_basics || !entry.card.type_line.starts_with("Basic Land"))
            })
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDeck {
    pub name: String,
    pub format: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub entries: Vec<DeckEntry>,
    #[serde(default)]
    pub cover_entry_id: String,
    #[serde(default)]
    pub print_settings: PrintSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ArtPreference {
    pub rating: u8,
    pub favorite: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrintJob {
    pub id: String,
    pub deck_id: String,
    pub deck_name: String,
    pub status: JobStatus,
    pub completed: u32,
    pub total: u32,
    pub message: String,
    pub created_at: String,
    pub file_name: String,
    pub bytes: u64,
    pub pages: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLine {
    pub quantity: u32,
    pub name: String,
    pub zone: Zone,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub collector_number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportIssue {
    pub line: u32,
    pub input: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedCards {
    pub entries: Vec<DeckEntry>,
    pub issues: Vec<ImportIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtPage {
    pub items: Vec<Art>,
    pub page: u32,
    pub has_more: bool,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub oracle_id: String,
    pub art: Art,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
