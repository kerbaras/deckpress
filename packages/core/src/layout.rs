//! Port of `apps/web/src/core/layout.ts`. Preview (TypeScript) and export
//! (Rust) must agree on every point value, so keep both in sync.

use crate::error::{AppError, AppResult};
use crate::models::{Backs, Guides, LayoutMode, Orientation, PrintSettings};
use crate::scm::{self, ScmSheet};

pub fn mm_to_pt(mm: f64) -> f64 {
    mm * 72.0 / 25.4
}

pub fn mm_to_pixels(mm: f64, dpi: u32) -> u32 {
    (mm * f64::from(dpi) / 25.4).round() as u32
}

/// Pixel size of one printed face: a trim area plus a whole-pixel bleed band
/// per side. The full trim + 2 × bleed size is rounded once, so the raster
/// measures exactly what its PDF slot draws it at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FacePixels {
    pub trim_width: u32,
    pub trim_height: u32,
    pub bleed: u32,
}

pub fn face_pixels(width_mm: f64, height_mm: f64, bleed_mm: f64, dpi: u32) -> FacePixels {
    let bleed = mm_to_pixels(bleed_mm, dpi);
    let trim = |mm: f64| mm_to_pixels(mm + 2.0 * bleed_mm, dpi).saturating_sub(2 * bleed);
    FacePixels {
        trim_width: trim(width_mm),
        trim_height: trim(height_mm),
        bleed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Slot {
    pub rect: Rect,
    pub trim: Rect,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Guide {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// Circle-and-crosshair target printed on both sides of a duplex sheet so
/// front/back alignment can be checked against the light.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Registration {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrintLayout {
    pub width: f64,
    pub height: f64,
    pub columns: u32,
    pub rows: u32,
    pub slots: Vec<Slot>,
    pub guides: Vec<Guide>,
    pub registration: Vec<Registration>,
    pub scm: Option<ScmSheet>,
    /// Baseline of the sheet label in the bottom margin, if there is room.
    pub label_baseline: Option<f64>,
}

/// Registration targets and the label only appear when the sheet has marks
/// at all; `guides: none` means a clean page.
pub const REGISTRATION_RADIUS_MM: f64 = 1.5;
const LABEL_SIZE_PT: f64 = 5.0;
const LABEL_GLYPH_ADVANCE_EM: f64 = 0.6;

pub struct SheetLabelPlacement {
    pub x: f64,
    pub baseline: f64,
    pub font_size_pt: f64,
    pub width: f64,
}

pub fn fit_sheet_label(layout: &PrintLayout, text: &str) -> Option<SheetLabelPlacement> {
    let baseline = layout.label_baseline?;
    let left = if layout.scm.is_some() {
        mm_to_pt(4.0)
    } else {
        layout.slots.first()?.rect.x
    };
    let advance = text.chars().count() as f64 * LABEL_GLYPH_ADVANCE_EM;
    let width = (advance * LABEL_SIZE_PT).min(layout.width - left - mm_to_pt(4.0));
    if width <= 0.0 {
        return None;
    }
    Some(SheetLabelPlacement {
        x: if layout.scm.is_some() {
            (layout.width - width) / 2.0
        } else {
            left
        },
        baseline,
        font_size_pt: width / advance,
        width,
    })
}

fn fixed_label(value: f64, places: i32) -> String {
    // Keep half-units stable across small float differences at the JSON boundary.
    let scale = 10_u32.pow(places as u32);
    let scaled = (value * f64::from(scale) + 1e-9).round() as u32;
    let whole = scaled / scale;
    let fraction = scaled % scale;
    if fraction == 0 {
        return whole.to_string();
    }
    let fraction = format!("{fraction:0width$}", width = places as usize);
    format!("{whole}.{}", fraction.trim_end_matches('0'))
}

fn label_number(value: f64) -> String {
    fixed_label(value, 3)
}

/// Millimetres for on-page text: at most 2 decimals, trailing zeros trimmed.
pub fn mm_label(value: f64) -> String {
    fixed_label(value, 2)
}

pub fn sheet_label(
    settings: &PrintSettings,
    deck_name: &str,
    sheet: usize,
    total_sheets: usize,
    back: bool,
) -> String {
    let name: String = deck_name
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(40)
        .collect();
    format!(
        "{} / SHEET {sheet} OF {total_sheets} / {} / TRIM {} × {} mm / {} mm BLEED / {} DPI / PRINT AT 100%",
        name.trim(),
        if back { "BACKS" } else { "FRONTS" },
        label_number(settings.card_width_mm),
        label_number(settings.card_height_mm),
        label_number(settings.bleed_mm),
        label_number(f64::from(settings.dpi))
    )
}

fn dedup(values: impl Iterator<Item = f64>) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for value in values {
        if !out.iter().any(|v| v.to_bits() == value.to_bits()) {
            out.push(value);
        }
    }
    out
}

pub fn create_layout(options: &PrintSettings) -> AppResult<PrintLayout> {
    if options.layout_mode == LayoutMode::Scm {
        return scm::create_layout(options);
    }
    let (width, height) = free_page_size(options);
    let margin = mm_to_pt(options.margin_mm);
    let gap = mm_to_pt(options.gap_mm);
    let bleed = mm_to_pt(options.bleed_mm);
    let card_width = mm_to_pt(options.card_width_mm);
    let card_height = mm_to_pt(options.card_height_mm);
    let cell_width = card_width + 2.0 * bleed;
    let cell_height = card_height + 2.0 * bleed;
    let max_columns = ((width - 2.0 * margin + gap + 0.0001) / (cell_width + gap)).floor();
    let max_rows = ((height - 2.0 * margin + gap + 0.0001) / (cell_height + gap)).floor();
    let columns = if options.columns > 0 {
        f64::from(options.columns)
    } else {
        max_columns
    };
    let rows = if options.rows > 0 {
        f64::from(options.rows)
    } else {
        max_rows
    };
    if columns < 1.0
        || rows < 1.0
        || columns > max_columns
        || rows > max_rows
        || columns * rows > 400.0
    {
        return Err(AppError::user(
            "Cards do not fit. Reduce the grid, margins, bleed or gap, or choose larger paper.",
        ));
    }
    let block_width = columns * cell_width + (columns - 1.0) * gap;
    let block_height = rows * cell_height + (rows - 1.0) * gap;
    let x0 = (width - block_width) / 2.0;
    let y0 = (height - block_height) / 2.0;
    let mut slots = Vec::new();
    for row in 0..rows as u32 {
        for column in 0..columns as u32 {
            let x = x0 + f64::from(column) * (cell_width + gap);
            let y = y0 + f64::from(row) * (cell_height + gap);
            slots.push(Slot {
                rect: Rect {
                    x,
                    y,
                    width: cell_width,
                    height: cell_height,
                },
                trim: Rect {
                    x: x + bleed,
                    y: y + bleed,
                    width: card_width,
                    height: card_height,
                },
            });
        }
    }
    let xs = dedup(
        slots
            .iter()
            .flat_map(|slot| [slot.trim.x, slot.trim.x + card_width]),
    );
    let ys = dedup(
        slots
            .iter()
            .flat_map(|slot| [slot.trim.y, slot.trim.y + card_height]),
    );
    let mut guides = Vec::new();
    let mut registration = Vec::new();
    let mut label_baseline = None;
    match options.guides {
        Guides::Full => {
            for &x in &xs {
                guides.push(Guide {
                    x1: x,
                    x2: x,
                    y1: 0.0,
                    y2: height,
                });
            }
            for &y in &ys {
                guides.push(Guide {
                    y1: y,
                    y2: y,
                    x1: 0.0,
                    x2: width,
                });
            }
        }
        Guides::Crop => {
            let offset = mm_to_pt(options.guide_offset_mm);
            let length = mm_to_pt(options.guide_length_mm);
            let vertical = length.min(y0 - offset - 0.5);
            let horizontal = length.min(x0 - offset - 0.5);
            // Corner marks for every card: a tick along each trim-line
            // extension inside every interior gutter, inset by the offset so
            // no ink reaches the trim edge. Nothing fits when bleed and gap
            // are both zero; the outer marks still line up every cut.
            let gutter = 2.0 * bleed + gap;
            if gutter - 2.0 * offset > mm_to_pt(0.2) {
                for row in 1..rows as u32 {
                    let top = y0 + f64::from(row) * (cell_height + gap);
                    for &x in &xs {
                        guides.push(Guide {
                            x1: x,
                            x2: x,
                            y1: top - gap - bleed + offset,
                            y2: top + bleed - offset,
                        });
                    }
                }
                for column in 1..columns as u32 {
                    let left = x0 + f64::from(column) * (cell_width + gap);
                    for &y in &ys {
                        guides.push(Guide {
                            y1: y,
                            y2: y,
                            x1: left - gap - bleed + offset,
                            x2: left + bleed - offset,
                        });
                    }
                }
            }
            if vertical > 0.0 {
                for &x in &xs {
                    guides.push(Guide {
                        x1: x,
                        x2: x,
                        y1: y0 - offset - vertical,
                        y2: y0 - offset,
                    });
                    guides.push(Guide {
                        x1: x,
                        x2: x,
                        y1: height - y0 + offset,
                        y2: height - y0 + offset + vertical,
                    });
                }
            }
            if horizontal > 0.0 {
                for &y in &ys {
                    guides.push(Guide {
                        y1: y,
                        y2: y,
                        x1: x0 - offset - horizontal,
                        x2: x0 - offset,
                    });
                    guides.push(Guide {
                        y1: y,
                        y2: y,
                        x1: width - x0 + offset,
                        x2: width - x0 + offset + horizontal,
                    });
                }
            }
        }
        Guides::None => {}
    }
    if options.guides != Guides::None {
        let radius = mm_to_pt(REGISTRATION_RADIUS_MM);
        let clearance = radius + mm_to_pt(1.0);
        let duplex = matches!(options.backs, Backs::LongEdge | Backs::ShortEdge);
        if duplex {
            if y0 / 2.0 >= clearance {
                registration.push(Registration {
                    x: width / 2.0,
                    y: y0 / 2.0,
                    radius,
                });
            }
            if x0 / 2.0 >= clearance {
                registration.push(Registration {
                    x: x0 / 2.0,
                    y: height / 2.0,
                    radius,
                });
                registration.push(Registration {
                    x: width - x0 / 2.0,
                    y: height / 2.0,
                    radius,
                });
            }
        }
        let marks_end = match options.guides {
            Guides::Crop => mm_to_pt(options.guide_offset_mm + options.guide_length_mm),
            _ => 0.0,
        };
        let baseline = height - y0 + marks_end + LABEL_SIZE_PT * 1.6;
        if height - baseline >= mm_to_pt(4.0) {
            label_baseline = Some(baseline);
        }
    }
    Ok(PrintLayout {
        width,
        height,
        columns: columns as u32,
        rows: rows as u32,
        slots,
        guides,
        registration,
        scm: None,
        label_baseline,
    })
}

pub fn duplex_slot(slot: &Slot, layout: &PrintLayout, settings: &PrintSettings) -> Slot {
    let (dx, dy) = duplex_offset(settings);
    let backs = if layout.scm.is_some() {
        Backs::LongEdge
    } else {
        settings.backs
    };
    let mirror_x = duplex_mirrors_x(layout.width, layout.height, backs);
    let transform = |rect: Rect, first: Rect, last: Rect| {
        let (right, bottom) = if layout.scm.is_some() {
            (first.x + last.x, first.y + last.y)
        } else {
            (layout.width - rect.width, layout.height - rect.height)
        };
        Rect {
            x: (if mirror_x { right - rect.x } else { rect.x }) + dx,
            y: (if mirror_x { rect.y } else { bottom - rect.y }) + dy,
            ..rect
        }
    };
    let first = layout.slots.first().unwrap_or(slot);
    let last = layout.slots.last().unwrap_or(slot);
    Slot {
        rect: transform(slot.rect, first.rect, last.rect),
        trim: transform(slot.trim, first.trim, last.trim),
    }
}

pub(crate) fn free_page_size(settings: &PrintSettings) -> (f64, f64) {
    let (w, h) = settings
        .paper
        .size_mm((settings.custom_width_mm, settings.custom_height_mm));
    if settings.orientation == Orientation::Portrait {
        (mm_to_pt(w.min(h)), mm_to_pt(w.max(h)))
    } else {
        (mm_to_pt(w.max(h)), mm_to_pt(w.min(h)))
    }
}

pub(crate) fn duplex_mirrors_x(width: f64, height: f64, backs: Backs) -> bool {
    (backs != Backs::ShortEdge) == (height >= width)
}

pub(crate) fn duplex_offset(settings: &PrintSettings) -> (f64, f64) {
    (
        mm_to_pt(settings.back_offset_xmm),
        mm_to_pt(settings.back_offset_ymm),
    )
}

pub fn duplex_rotation(width: f64, height: f64, settings: &PrintSettings) -> Option<[f64; 6]> {
    if settings.back_rotation_deg == 0.0 {
        return None;
    }
    let (x, y) = (width / 2.0, height / 2.0);
    let (sin, cos) = settings.back_rotation_deg.to_radians().sin_cos();
    Some([
        cos,
        sin,
        -sin,
        cos,
        x - cos * x + sin * y,
        y - sin * x - cos * y,
    ])
}
