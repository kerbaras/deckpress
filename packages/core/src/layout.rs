//! Port of `apps/web/src/core/layout.ts`. Preview (TypeScript) and export
//! (Rust) must agree on every point value, so keep both in sync.

use std::{collections::HashMap, sync::LazyLock};

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::models::{Backs, Guides, LayoutMode, Orientation, PrintSettings, ScmVariant};

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
    pub registration_ink: Vec<Rect>,
    pub template_name: Option<String>,
    /// Baseline of the sheet label in the bottom margin, if there is room.
    pub label_baseline: Option<f64>,
}

/// Registration targets and the label only appear when the sheet has marks
/// at all; `guides: none` means a clean page.
pub const REGISTRATION_RADIUS_MM: f64 = 1.5;
const LABEL_SIZE_PT: f64 = 5.0;
const SCM_MAX_BLEED_MM: f64 = 0.625;

#[derive(Deserialize)]
struct Dimensions {
    width: String,
    height: String,
}

#[derive(Deserialize)]
struct MarkStyle {
    inset: String,
    thickness: String,
    length: String,
}

#[derive(Deserialize)]
struct TemplateData {
    orientation: Orientation,
    version: u32,
    registration: MarkOverrides,
}

#[derive(Deserialize)]
struct MarkOverrides {
    length: String,
}

#[derive(Deserialize)]
struct Defaults {
    registration: HashMap<String, MarkStyle>,
}

#[derive(Deserialize)]
struct ScmData {
    ppi: f64,
    defaults: Defaults,
    card_sizes: HashMap<String, Dimensions>,
    paper_sizes: HashMap<String, Dimensions>,
    layouts: HashMap<String, HashMap<String, HashMap<String, TemplateData>>>,
}

static SCM_DATA: LazyLock<ScmData> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/scm/layouts.json")).expect("vendored SCM layouts")
});

fn size_mm(value: &str) -> f64 {
    let (number, unit) = value.split_at(value.len() - 2);
    number.parse::<f64>().expect("SCM dimension") * if unit == "in" { 25.4 } else { 1.0 }
}

struct TemplateMarks {
    name: String,
    count: u8,
    inset: f64,
    thickness: f64,
    length: f64,
}

impl TemplateMarks {
    fn ink(&self, width: f64, height: f64) -> Vec<Rect> {
        let mut rects = Vec::new();
        let half = self.thickness / 2.0;
        for (right, bottom) in [(false, false), (true, false), (false, true), (true, true)] {
            if self.count == 3 && right && bottom {
                continue;
            }
            let x = if right {
                width - self.inset
            } else {
                self.inset
            };
            let y = if bottom {
                height - self.inset
            } else {
                self.inset
            };
            if self.count == 3 && !right && !bottom {
                rects.push(Rect {
                    x: x - half,
                    y: y - half,
                    width: mm_to_pt(5.0) + self.thickness,
                    height: mm_to_pt(5.0) + self.thickness,
                });
            } else {
                rects.push(Rect {
                    x: if right { x - self.length } else { x - half },
                    y: y - half,
                    width: self.length + half,
                    height: self.thickness,
                });
                rects.push(Rect {
                    x: x - half,
                    y: if bottom { y - self.length } else { y + half },
                    width: self.thickness,
                    height: self.length - half,
                });
            }
        }
        rects
    }
}

struct GridTemplate {
    paper: (f64, f64),
    card: (f64, f64),
    orientation: Orientation,
    inset_mm: f64,
    gap_mm: f64,
    ppi: Option<f64>,
    corner_mm: f64,
    marks: Option<TemplateMarks>,
}

impl GridTemplate {
    fn from_settings(options: &PrintSettings) -> AppResult<Self> {
        if options.layout_mode == LayoutMode::Free {
            return Ok(Self {
                paper: options
                    .paper
                    .size_mm((options.custom_width_mm, options.custom_height_mm)),
                card: (options.card_width_mm, options.card_height_mm),
                orientation: options.orientation,
                inset_mm: options.margin_mm,
                gap_mm: options.gap_mm,
                ppi: None,
                corner_mm: 0.0,
                marks: None,
            });
        }
        let choice = &options.scm_template;
        let variant = match choice.variant {
            ScmVariant::Default => "default",
            ScmVariant::Borderless => "borderless",
        };
        let data = &*SCM_DATA;
        let layout = data
            .layouts
            .get(&choice.paper)
            .and_then(|cards| cards.get(&choice.card))
            .and_then(|variants| variants.get(variant))
            .ok_or_else(|| AppError::user("Unknown SCM template"))?;
        if !matches!(choice.marks, 3 | 4) {
            return Err(AppError::user(
                "SCM templates require 3 or 4 registration marks",
            ));
        }
        let dims = |d: &Dimensions| (size_mm(&d.width), size_mm(&d.height));
        let style = &data.defaults.registration[variant];
        let inset_mm = size_mm(&style.inset);
        let version = layout.version;
        let suffix = if choice.variant == ScmVariant::Borderless {
            "-borderless"
        } else {
            ""
        };
        Ok(Self {
            paper: dims(&data.paper_sizes[&choice.paper]),
            card: dims(&data.card_sizes[&choice.card]),
            orientation: layout.orientation,
            inset_mm,
            gap_mm: 1.25,
            ppi: Some(data.ppi),
            corner_mm: size_mm(&style.length) + 1.5,
            marks: Some(TemplateMarks {
                name: format!("{}-{}{suffix}-v{version}", choice.paper, choice.card),
                count: choice.marks,
                inset: mm_to_pt(inset_mm),
                thickness: mm_to_pt(size_mm(&style.thickness)),
                length: mm_to_pt(size_mm(&layout.registration.length).clamp(5.0, 20.0)),
            }),
        })
    }

    fn units(&self, mm: f64) -> f64 {
        self.ppi
            .map_or_else(|| mm_to_pt(mm), |ppi| (mm / 25.4 * ppi).round_ties_even())
    }

    fn points(&self, units: f64) -> f64 {
        self.ppi.map_or(units, |ppi| units * 72.0 / ppi)
    }
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
    let template = GridTemplate::from_settings(options)?;
    let (w, h) = template.paper;
    let portrait = template.orientation == Orientation::Portrait;
    let width = template.units(if portrait { w.min(h) } else { w.max(h) });
    let height = template.units(if portrait { w.max(h) } else { w.min(h) });
    let margin = template.units(template.inset_mm);
    let gap = template.units(template.gap_mm);
    let scm = template.ppi.is_some();
    let bleed = mm_to_pt(if scm {
        options.bleed_mm.min(SCM_MAX_BLEED_MM)
    } else {
        options.bleed_mm
    });
    let card_width = template.units(template.card.0);
    let card_height = template.units(template.card.1);
    let fit_bleed = if scm { 0.0 } else { bleed };
    let cell_width = card_width + 2.0 * fit_bleed;
    let cell_height = card_height + 2.0 * fit_bleed;
    let tolerance = if scm { 0.0 } else { 0.0001 };
    let max_columns = ((width - 2.0 * margin + gap + tolerance) / (cell_width + gap)).floor();
    let max_rows = ((height - 2.0 * margin + gap + tolerance) / (cell_height + gap)).floor();
    let mut columns = if !scm && options.columns > 0 {
        f64::from(options.columns)
    } else {
        max_columns
    };
    let mut rows = if !scm && options.rows > 0 {
        f64::from(options.rows)
    } else {
        max_rows
    };
    if scm {
        let corner = template.units(template.corner_mm);
        let clear =
            |page: f64, cell: f64| ((page - gap - 2.0 * (margin + corner)) / (cell + gap)).floor();
        let clear_columns = clear(width, cell_width).min(max_columns);
        let clear_rows = clear(height, cell_height).min(max_rows);
        if columns > clear_columns && rows > clear_rows {
            if clear_columns * rows >= columns * clear_rows {
                columns = clear_columns;
            } else {
                rows = clear_rows;
            }
        }
    }
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
    let center = |page, block| {
        let origin: f64 = (page - block) / 2.0;
        if scm {
            origin.round_ties_even()
        } else {
            origin
        }
    };
    let x0 = center(width, block_width);
    let y0 = center(height, block_height);
    let mut slots = Vec::new();
    for row in 0..rows as u32 {
        for column in 0..columns as u32 {
            let x = template.points(x0 + f64::from(column) * (cell_width + gap));
            let y = template.points(y0 + f64::from(row) * (cell_height + gap));
            slots.push(Slot {
                rect: Rect {
                    x: if scm { x - bleed } else { x },
                    y: if scm { y - bleed } else { y },
                    width: template.points(cell_width) + if scm { 2.0 * bleed } else { 0.0 },
                    height: template.points(cell_height) + if scm { 2.0 * bleed } else { 0.0 },
                },
                trim: Rect {
                    x: x + fit_bleed,
                    y: y + fit_bleed,
                    width: template.points(card_width),
                    height: template.points(card_height),
                },
            });
        }
    }
    if let Some(ref marks) = template.marks {
        let width = template.points(width);
        let height = template.points(height);
        return Ok(PrintLayout {
            width,
            height,
            columns: columns as u32,
            rows: rows as u32,
            slots,
            guides: Vec::new(),
            registration: Vec::new(),
            registration_ink: marks.ink(width, height),
            template_name: Some(marks.name.clone()),
            label_baseline: Some(height - mm_to_pt(1.0)),
        });
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
        registration_ink: Vec::new(),
        template_name: None,
        label_baseline,
    })
}

pub fn effective_backs(settings: &PrintSettings) -> Backs {
    if settings.layout_mode == LayoutMode::Scm && settings.backs == Backs::ShortEdge {
        Backs::LongEdge
    } else {
        settings.backs
    }
}

pub fn scm_rotates_back(layout: &PrintLayout) -> bool {
    layout.template_name.is_some() && layout.width > layout.height
}

pub fn effective_print_settings(settings: &PrintSettings, layout: &PrintLayout) -> PrintSettings {
    if layout.template_name.is_none() {
        return settings.clone();
    }
    let trim = layout.slots[0].trim;
    PrintSettings {
        card_width_mm: trim.width * 25.4 / 72.0,
        card_height_mm: trim.height * 25.4 / 72.0,
        bleed_mm: settings.bleed_mm.min(SCM_MAX_BLEED_MM),
        backs: effective_backs(settings),
        ..settings.clone()
    }
}

pub fn duplex_slot(slot: &Slot, layout: &PrintLayout, settings: &PrintSettings) -> Slot {
    let mirror_x =
        (effective_backs(settings) != Backs::ShortEdge) == (layout.height >= layout.width);
    let dx = mm_to_pt(settings.back_offset_xmm);
    let dy = mm_to_pt(settings.back_offset_ymm);
    // SCM reverses the occupied row/column indices, including the rounded grid origin.
    let bounds = if layout.template_name.is_some() {
        let first = layout.slots[0].trim;
        let last = layout.slots[layout.slots.len() - 1].trim;
        (
            first.x + last.x + last.width,
            first.y + last.y + last.height,
        )
    } else {
        (layout.width, layout.height)
    };
    let transform = |rect: Rect| Rect {
        x: if mirror_x {
            bounds.0 - rect.x - rect.width
        } else {
            rect.x
        } + dx,
        y: if mirror_x {
            rect.y
        } else {
            bounds.1 - rect.y - rect.height
        } + dy,
        ..rect
    };
    Slot {
        rect: transform(slot.rect),
        trim: transform(slot.trim),
    }
}
