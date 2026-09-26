//! Port of `packages/core/src/layout.ts`. Preview (TypeScript) and export
//! (Rust) must agree on every point value, so keep both in sync.

use crate::error::{AppError, AppResult};
use crate::models::{Backs, Guides, Orientation, PrintSettings};

pub fn mm_to_pt(mm: f64) -> f64 {
    mm * 72.0 / 25.4
}

pub fn mm_to_pixels(mm: f64, dpi: u32) -> u32 {
    (mm * f64::from(dpi) / 25.4).round() as u32
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
    /// Baseline of the sheet label in the bottom margin, if there is room.
    pub label_baseline: Option<f64>,
}

/// Registration targets and the label only appear when the sheet has marks
/// at all; `guides: none` means a clean page.
pub const REGISTRATION_RADIUS_MM: f64 = 1.5;
const LABEL_SIZE_PT: f64 = 5.0;

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
    let (w, h) = options
        .paper
        .size_mm((options.custom_width_mm, options.custom_height_mm));
    let portrait = options.orientation == Orientation::Portrait;
    let width = mm_to_pt(if portrait { w.min(h) } else { w.max(h) });
    let height = mm_to_pt(if portrait { w.max(h) } else { w.min(h) });
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
        label_baseline,
    })
}

pub fn duplex_slot(slot: &Slot, layout: &PrintLayout, settings: &PrintSettings) -> Slot {
    let mirror_x = (settings.backs != Backs::ShortEdge) == (layout.height >= layout.width);
    let dx = mm_to_pt(settings.back_offset_xmm);
    let dy = mm_to_pt(settings.back_offset_ymm);
    let transform = |rect: Rect| Rect {
        x: if mirror_x {
            layout.width - rect.x - rect.width
        } else {
            rect.x
        } + dx,
        y: if mirror_x {
            rect.y
        } else {
            layout.height - rect.y - rect.height
        } + dy,
        ..rect
    };
    Slot {
        rect: transform(slot.rect),
        trim: transform(slot.trim),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_fits_nine_cards_with_default_settings() {
        let layout = create_layout(&PrintSettings::default()).unwrap();
        assert_eq!((layout.columns, layout.rows), (3, 3));
        assert_eq!(layout.slots.len(), 9);
        assert!((layout.width - 595.2756).abs() < 0.001);
        assert!((layout.height - 841.8898).abs() < 0.001);
        // 24 outer marks plus a tick on every trim line in each of the two
        // interior gutters: 2 gutters x 6 trim lines, both ways.
        assert_eq!(layout.guides.len(), 48);
        assert!(layout.registration.is_empty());
        assert!(layout.label_baseline.is_some());
    }

    #[test]
    fn interior_marks_stay_inside_the_bleed() {
        let layout = create_layout(&PrintSettings::default()).unwrap();
        let first = layout.slots[0].trim;
        let below = layout.slots[3].trim;
        let tick = layout
            .guides
            .iter()
            .find(|g| g.x1 == first.x && g.y1 > first.y + first.height && g.y2 < below.y)
            .expect("tick between rows");
        assert!((tick.y1 - (first.y + first.height + mm_to_pt(0.5))).abs() < 1e-9);
        assert!((tick.y2 - (below.y - mm_to_pt(0.5))).abs() < 1e-9);
    }

    #[test]
    fn no_interior_marks_without_bleed_or_gap() {
        let settings = PrintSettings {
            bleed_mm: 0.0,
            ..PrintSettings::default()
        };
        // Shared trim edges collapse to 4 lines each way: 16 outer marks.
        assert_eq!(create_layout(&settings).unwrap().guides.len(), 16);
    }

    #[test]
    fn duplex_sheets_get_registration_targets() {
        let settings = PrintSettings {
            backs: Backs::LongEdge,
            ..PrintSettings::default()
        };
        let layout = create_layout(&settings).unwrap();
        assert_eq!(layout.registration.len(), 3);
        let clean = PrintSettings {
            guides: Guides::None,
            ..settings
        };
        let layout = create_layout(&clean).unwrap();
        assert!(layout.registration.is_empty());
        assert!(layout.label_baseline.is_none());
    }

    #[test]
    fn rejects_grids_that_do_not_fit() {
        let settings = PrintSettings {
            columns: 5,
            ..PrintSettings::default()
        };
        assert!(create_layout(&settings).is_err());
    }

    #[test]
    fn long_edge_duplex_mirrors_horizontally_on_portrait_paper() {
        let settings = PrintSettings {
            backs: Backs::LongEdge,
            ..PrintSettings::default()
        };
        let layout = create_layout(&settings).unwrap();
        let first = layout.slots[0];
        let back = duplex_slot(&first, &layout, &settings);
        assert!((back.rect.x - (layout.width - first.rect.x - first.rect.width)).abs() < 1e-9);
        assert!((back.rect.y - first.rect.y).abs() < 1e-9);
    }
}
