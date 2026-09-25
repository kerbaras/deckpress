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

#[derive(Debug, Clone, PartialEq)]
pub struct PrintLayout {
    pub width: f64,
    pub height: f64,
    pub columns: u32,
    pub rows: u32,
    pub slots: Vec<Slot>,
    pub guides: Vec<Guide>,
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
    Ok(PrintLayout {
        width,
        height,
        columns: columns as u32,
        rows: rows as u32,
        slots,
        guides,
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
        assert_eq!(layout.guides.len(), 24);
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
