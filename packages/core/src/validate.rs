//! Bounds for user-supplied payloads. The React UI validates the same limits
//! with Zod, but IPC callers are not limited to the UI, so anything that
//! reaches the store or the raster pipeline is checked here as well.

use crate::error::{AppError, AppResult};
use crate::models::{ArtPreference, DeckEntry, PrintSettings};

pub const MAX_ENTRIES: usize = 1000;
pub const MAX_CARDS: u32 = 1500;
pub const MAX_QUANTITY: u32 = 250;
pub const MAX_TAGS: usize = 20;
pub const MAX_TAG_CHARS: usize = 40;

fn range(name: &str, value: f64, min: f64, max: f64) -> AppResult<()> {
    if !value.is_finite() || value < min || value > max {
        return Err(AppError::user(format!(
            "{name} must be between {min} and {max}"
        )));
    }
    Ok(())
}

fn hex_color(name: &str, value: &str) -> AppResult<()> {
    let ok = value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        return Err(AppError::user(format!("{name} must be a #rrggbb color")));
    }
    Ok(())
}

impl PrintSettings {
    pub fn validate(&self) -> AppResult<()> {
        range("Custom paper width", self.custom_width_mm, 40.0, 1000.0)?;
        range("Custom paper height", self.custom_height_mm, 40.0, 1000.0)?;
        range("Card width", self.card_width_mm, 25.0, 200.0)?;
        range("Card height", self.card_height_mm, 25.0, 250.0)?;
        range("Margin", self.margin_mm, 0.0, 50.0)?;
        range("Gap", self.gap_mm, 0.0, 20.0)?;
        range("Bleed", self.bleed_mm, 0.0, 5.0)?;
        range("Columns", f64::from(self.columns), 0.0, 20.0)?;
        range("Rows", f64::from(self.rows), 0.0, 20.0)?;
        range("Guide length", self.guide_length_mm, 0.5, 10.0)?;
        range("Guide offset", self.guide_offset_mm, 0.0, 5.0)?;
        range("Guide width", self.guide_width_pt, 0.1, 2.0)?;
        range("DPI", f64::from(self.dpi), 150.0, 1200.0)?;
        range("JPEG quality", f64::from(self.quality), 60.0, 100.0)?;
        range("Back offset X", self.back_offset_xmm, -10.0, 10.0)?;
        range("Back offset Y", self.back_offset_ymm, -10.0, 10.0)?;
        range("First page", f64::from(self.page_from), 1.0, 1000.0)?;
        range("Last page", f64::from(self.page_to), 0.0, 1000.0)?;
        hex_color("Bleed color", &self.bleed_color)?;
        hex_color("Guide color", &self.guide_color)?;
        if self.upscale_model.chars().count() > 100 {
            return Err(AppError::user("Model id is too long"));
        }
        Ok(())
    }
}

pub fn validate_entries(entries: &[DeckEntry]) -> AppResult<()> {
    if entries.len() > MAX_ENTRIES {
        return Err(AppError::user(format!(
            "A deck can contain at most {MAX_ENTRIES} entries"
        )));
    }
    let mut total: u32 = 0;
    for entry in entries {
        if entry.quantity < 1 || entry.quantity > MAX_QUANTITY {
            return Err(AppError::user(format!(
                "Card quantities must be between 1 and {MAX_QUANTITY}"
            )));
        }
        if entry.card.faces.is_empty() || entry.card.faces.len() > 2 {
            return Err(AppError::user("Cards must have one or two faces"));
        }
        total = total.saturating_add(entry.quantity);
    }
    if total > MAX_CARDS {
        return Err(AppError::user(format!(
            "A deck can contain at most {MAX_CARDS} cards"
        )));
    }
    Ok(())
}

impl ArtPreference {
    /// Trims and deduplicates labels, rejecting anything outside the bounds the
    /// UI enforces so saved preferences always parse again.
    pub fn normalized(mut self) -> AppResult<Self> {
        if self.rating > 5 {
            return Err(AppError::user("Rating must be 0-5"));
        }
        let mut tags: Vec<String> = Vec::with_capacity(self.tags.len());
        for tag in self.tags.drain(..) {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            if tag.chars().count() > MAX_TAG_CHARS {
                return Err(AppError::user(format!(
                    "Labels are limited to {MAX_TAG_CHARS} characters"
                )));
            }
            if !tags.iter().any(|t| t == tag) {
                tags.push(tag.to_string());
            }
        }
        if tags.len() > MAX_TAGS {
            return Err(AppError::user(format!(
                "You can add at most {MAX_TAGS} labels per artwork"
            )));
        }
        self.tags = tags;
        Ok(self)
    }
}
