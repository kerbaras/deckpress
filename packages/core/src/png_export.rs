//! Print-ready PNG export: one lossless PNG per printed card face, packed into
//! a ZIP. Walks the same [`print_plan`] as the PDF and rasterizes each face
//! with [`rasterize`], so exclusions, quantities, page range, back mode, DPI,
//! bleed and upscaling match the PDF exactly.

use std::collections::HashMap;
use std::io::{Read, Seek, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::error::{AppError, AppResult};
use crate::format_count;
use crate::models::{Deck, PrintFailureTarget, PrintSettings};
use crate::pdf::{print_plan, raster_key, PrintPlan};
use crate::raster::{encode_png_at_dpi, rasterize};
use crate::scm;
use crate::upscaler::{CancelToken, Upscaler};

pub struct PngExport {
    /// PNG files written, one per printed face.
    pub faces: usize,
    /// Faces with no art (the PDF prints a placeholder there), not exported,
    /// e.g. "Delver of Secrets back (sheet 1, slot 4)".
    pub skipped: Vec<String>,
}

impl PngExport {
    /// Job result line, naming the first few faces left out for missing art.
    pub fn summary(&self) -> String {
        const LISTED: usize = 3;
        let mut message = format!(
            "{} ready",
            format_count(self.faces, "PNG file", "PNG files")
        );
        if !self.skipped.is_empty() {
            let count = self.skipped.len();
            message.push_str(&format!(
                " · {} without art skipped: {}",
                format_count(count, "face", "faces"),
                self.skipped[..count.min(LISTED)].join("; ")
            ));
            if count > LISTED {
                message.push_str(&format!("; {} more", count - LISTED));
            }
        }
        message
    }
}

/// Byte cap for the card part of an entry name. The rest of [`face_name`] is
/// ASCII and at most 63 bytes even for `usize::MAX` sheets and slots, so a
/// whole entry name stays at or under 143 bytes, well inside the 255-byte
/// file name limit of common filesystems.
const MAX_SLUG_BYTES: usize = 80;

/// The longest prefix of `text` that fits in `max_bytes` without splitting a
/// character.
pub(crate) fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    let end = text
        .char_indices()
        .map(|(index, c)| index + c.len_utf8())
        .take_while(|&end| end <= max_bytes)
        .last()
        .unwrap_or(0);
    &text[..end]
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = truncate_utf8(out.trim_matches('-'), MAX_SLUG_BYTES).trim_end_matches('-');
    if out.is_empty() {
        "card".into()
    } else {
        out.into()
    }
}

/// Archive entry name for a face: 1-based sheet and front slot (a back keeps
/// its front's slot so pairs sort together), the face, then the card.
pub fn face_name(sheet: usize, slot: usize, back: bool, card: &str) -> String {
    format!(
        "sheet-{sheet:03}-slot-{slot:02}-{}-{}.png",
        if back { "back" } else { "front" },
        slug(card)
    )
}

pub fn build_png_zip<W: Read + Write + Seek>(
    deck: &Deck,
    settings: &PrintSettings,
    upscaler: Option<&dyn Upscaler>,
    cancel: &CancelToken,
    progress: &mut dyn FnMut(usize, usize, String),
    read_source: &mut dyn FnMut(&str) -> AppResult<Vec<u8>>,
    writer: W,
) -> AppResult<PngExport> {
    let PrintPlan { sides, .. } = print_plan(deck, settings)?;
    let settings = &scm::effective_print_settings(settings)?;
    if settings.upscale && upscaler.is_none() {
        return Err(AppError::user(
            "Upscaling is enabled but no model is loaded",
        ));
    }
    let model = upscaler.map(|u| u.info().model_id).unwrap_or_default();
    // PNG data is already deflated; storing keeps the export fast and the
    // archive byte-for-byte reproducible.
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(false);
    let mut zip = ZipWriter::new(writer);
    let mut written: HashMap<String, String> = HashMap::new();
    let total: usize = sides.iter().map(|side| side.entries.len()).sum();
    let (mut completed, mut faces, mut skipped) = (0, 0, Vec::new());
    for side in &sides {
        for (index, entry) in side.entries.iter().enumerate() {
            cancel.check()?;
            let art = if side.back {
                entry.back_art()
            } else {
                Some(entry.front_art().clone())
            };
            completed += 1;
            let Some(art) = art else {
                skipped.push(format!(
                    "{}{} (sheet {}, slot {})",
                    entry.card.name,
                    if side.back { " back" } else { "" },
                    side.sheet,
                    index + 1
                ));
                continue;
            };
            let name = face_name(side.sheet, index + 1, side.back, &entry.card.name);
            progress(
                completed - 1,
                total,
                format!(
                    "{} {}{}",
                    if settings.upscale {
                        "Preparing / AI upscaling"
                    } else {
                        "Preparing"
                    },
                    entry.card.name,
                    if side.back { " · back" } else { "" }
                ),
            );
            let card_error = |error: AppError| {
                error.at_print_target(PrintFailureTarget::Card {
                    entry_id: entry.id.clone(),
                    back: side.back,
                })
            };
            let source = read_source(&art.image_url).map_err(card_error)?;
            let key = raster_key(&source, &art, settings, &model);
            match written.get(&key) {
                Some(first) => zip.deep_copy_file(first, &name).map_err(zip_error)?,
                None => {
                    let mut tile_progress = |done: usize, tiles: usize| {
                        if tiles > 0 {
                            progress(
                                completed - 1,
                                total,
                                format!("AI upscaling {} · tile {done}/{tiles}", entry.card.name),
                            );
                        }
                    };
                    let output = rasterize(
                        &source,
                        &art,
                        settings,
                        upscaler,
                        cancel,
                        &mut tile_progress,
                    )
                    .map_err(card_error)?;
                    let bytes = encode_png_at_dpi(&output.image, settings.dpi)?;
                    cancel.check()?;
                    zip.start_file(name.as_str(), options).map_err(zip_error)?;
                    zip.write_all(&bytes)?;
                    written.insert(key, name);
                }
            }
            faces += 1;
            progress(
                completed,
                total,
                format!(
                    "Wrote {completed} of {}",
                    format_count(total, "card face", "card faces")
                ),
            );
        }
    }
    cancel.check()?;
    if faces == 0 {
        return Err(AppError::user(
            "None of the selected faces have art to export",
        ));
    }
    zip.finish().map_err(zip_error)?;
    Ok(PngExport { faces, skipped })
}

fn zip_error(error: zip::result::ZipError) -> AppError {
    AppError::internal(format!("ZIP write failed: {error}"))
}
