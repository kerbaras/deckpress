//! Silhouette Card Maker geometry, mirrored by apps/web/src/core/scm.ts.
//! Port of the pinned SCM page_manager.py (see assets/scm/README.md).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::layout::{mm_to_pt, PrintLayout, Rect, Slot};
use crate::models::{Backs, LayoutMode, Orientation, PrintSettings, ScmVariant};

pub const MAX_BLEED_MM: f64 = 0.625;
const GAP_MM: f64 = 1.25;
const CORNER_PADDING_MM: f64 = 1.5;

#[derive(Debug, Clone, PartialEq)]
pub struct ScmSheet {
    pub name: String,
    pub marks: Vec<Rect>,
    pub orientation: Orientation,
}

#[derive(Deserialize)]
struct Config {
    ppi: f64,
    defaults: Defaults,
    paper_sizes: HashMap<String, Dimensions>,
    card_sizes: HashMap<String, Dimensions>,
    layouts: HashMap<String, HashMap<String, Variants>>,
}

#[derive(Deserialize)]
struct Defaults {
    registration: VariantRegistration,
}

#[derive(Deserialize)]
struct VariantRegistration {
    default: Registration,
    borderless: Registration,
}

#[derive(Deserialize)]
struct Registration {
    inset: String,
    thickness: String,
    length: String,
}

#[derive(Deserialize)]
struct Dimensions {
    width: String,
    height: String,
}

#[derive(Deserialize)]
struct Variants {
    default: Template,
    borderless: Template,
}

#[derive(Deserialize)]
struct Template {
    orientation: Orientation,
    version: u32,
    registration: RegistrationOverride,
}

#[derive(Deserialize)]
struct RegistrationOverride {
    inset: Option<String>,
    thickness: Option<String>,
    length: Option<String>,
}

static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/scm/layouts.json")).expect("vendored SCM layouts")
});

fn size_mm(size: &str) -> f64 {
    if let Some(inches) = size.strip_suffix("in") {
        return inches.parse::<f64>().expect("SCM inches") * 25.4;
    }
    size.trim_end_matches("mm")
        .parse()
        .expect("SCM millimeters")
}

fn size_px(size: &str) -> f64 {
    let inches = size.strip_suffix("in").map_or_else(
        || size_mm(size) / 25.4,
        |inches| inches.parse().expect("SCM inches"),
    );
    (inches * CONFIG.ppi).round_ties_even()
}

fn px_to_mm(px: f64) -> f64 {
    px * 25.4 / CONFIG.ppi
}

struct ResolvedTemplate<'a> {
    paper: &'a Dimensions,
    card: &'a Dimensions,
    template: &'a Template,
    inset: f64,
    thickness: f64,
    length: f64,
}

fn resolve(settings: &PrintSettings) -> AppResult<ResolvedTemplate<'static>> {
    let selection = &settings.scm_template;
    if !matches!(selection.marks, 3 | 4) {
        return Err(AppError::user("SCM requires 3 or 4 registration marks"));
    }
    let Some(variants) = CONFIG
        .layouts
        .get(&selection.paper)
        .and_then(|cards| cards.get(&selection.card))
    else {
        return Err(AppError::user("Unknown SCM paper and card template"));
    };
    let defaults = &CONFIG.defaults.registration;
    let (template, defaults) = match selection.variant {
        ScmVariant::Default => (&variants.default, &defaults.default),
        ScmVariant::Borderless => (&variants.borderless, &defaults.borderless),
    };
    let overrides = &template.registration;
    Ok(ResolvedTemplate {
        paper: &CONFIG.paper_sizes[&selection.paper],
        card: &CONFIG.card_sizes[&selection.card],
        template,
        inset: size_mm(overrides.inset.as_deref().unwrap_or(&defaults.inset)),
        thickness: size_mm(
            overrides
                .thickness
                .as_deref()
                .unwrap_or(&defaults.thickness),
        ),
        length: size_mm(overrides.length.as_deref().unwrap_or(&defaults.length)),
    })
}

pub fn validate_template(settings: &PrintSettings) -> AppResult<()> {
    resolve(settings).map(|_| ())
}

pub(crate) fn effective_backs(settings: &PrintSettings) -> Backs {
    if settings.layout_mode == LayoutMode::Scm && settings.backs == Backs::ShortEdge {
        Backs::LongEdge
    } else {
        settings.backs
    }
}

fn template_bleed_mm(settings: &PrintSettings) -> f64 {
    settings.bleed_mm.min(MAX_BLEED_MM)
}

pub fn effective_print_settings(settings: &PrintSettings) -> AppResult<PrintSettings> {
    if settings.layout_mode != LayoutMode::Scm {
        return Ok(settings.clone());
    }
    let ResolvedTemplate { card, .. } = resolve(settings)?;
    Ok(PrintSettings {
        card_width_mm: px_to_mm(size_px(&card.width)),
        card_height_mm: px_to_mm(size_px(&card.height)),
        bleed_mm: template_bleed_mm(settings),
        backs: effective_backs(settings),
        ..settings.clone()
    })
}

fn grid(page: [f64; 2], card: [f64; 2], gap: f64, inset: f64, corner: f64) -> Option<[f64; 2]> {
    let [w, h] = page;
    let [cw, ch] = card;
    let mut best = None;
    let mut best_count = 0.0;
    for [mx, my] in [
        [inset, inset],
        [inset + corner, inset],
        [inset, inset + corner],
    ] {
        let usable_width = w - 2.0 * mx;
        let usable_height = h - 2.0 * my;
        let cols = ((usable_width + gap) / (cw + gap)).floor();
        let rows = ((usable_height + gap) / (ch + gap)).floor();
        let cols_clear = ((usable_width - gap - 2.0 * (corner - mx + inset)) / (cw + gap)).floor();
        let rows_clear = ((usable_height - gap - 2.0 * (corner - my + inset)) / (ch + gap)).floor();
        for [c, r] in [[cols, rows], [cols_clear, rows], [cols, rows_clear]] {
            let clearance_x = (w - c * (cw + gap) - gap) / 2.0 - inset;
            let clearance_y = (h - r * (ch + gap) - gap) / 2.0 - inset;
            if c > 0.0
                && r > 0.0
                && c * r > best_count
                && (clearance_x >= corner || clearance_y >= corner)
            {
                best = Some([c, r]);
                best_count = c * r;
            }
        }
    }
    best
}

fn registration_marks(
    page: [f64; 2],
    inset: f64,
    length: f64,
    thickness: f64,
    marks: u8,
) -> Vec<Rect> {
    let [w, h] = page;
    let half = thickness / 2.0;
    let rect = |x, y, width, height| Rect {
        x: mm_to_pt(x),
        y: mm_to_pt(y),
        width: mm_to_pt(width),
        height: mm_to_pt(height),
    };
    let mut out = Vec::new();
    for (right, bottom) in [(false, false), (true, false), (false, true), (true, true)] {
        let x = if right { w - inset } else { inset };
        let y = if bottom { h - inset } else { inset };
        if marks == 3 && !right && !bottom {
            out.push(rect(x - half, y - half, 5.0 + thickness, 5.0 + thickness));
        } else if marks == 4 || !right || !bottom {
            out.push(rect(
                if right { x - length } else { x - half },
                y - half,
                length + half,
                thickness,
            ));
            out.push(rect(
                x - half,
                if bottom { y - length } else { y - half },
                thickness,
                length + half,
            ));
        }
    }
    out
}

pub fn create_layout(settings: &PrintSettings) -> AppResult<PrintLayout> {
    let ResolvedTemplate {
        paper,
        card,
        template,
        inset,
        thickness,
        length,
    } = resolve(settings)?;
    let mut page_mm = [size_mm(&paper.width), size_mm(&paper.height)];
    let mut page_px = [size_px(&paper.width), size_px(&paper.height)];
    if template.orientation == Orientation::Portrait {
        page_mm.swap(0, 1);
        page_px.swap(0, 1);
    }
    let card_px = [size_px(&card.width), size_px(&card.height)];
    let mm_to_scm_px = |mm: f64| (mm / 25.4 * CONFIG.ppi).round_ties_even();
    let gap = mm_to_scm_px(GAP_MM);
    let exclusion = size_mm(&CONFIG.defaults.registration.default.length) + CORNER_PADDING_MM;
    let [columns, rows] = grid(
        page_px,
        card_px,
        gap,
        mm_to_scm_px(inset),
        mm_to_scm_px(exclusion),
    )
    .ok_or_else(|| AppError::user("Cards do not fit the SCM template"))?;
    let [cw, ch] = card_px;
    let [wp, hp] = page_px;
    let x0 = ((wp - columns * cw - (columns - 1.0) * gap) / 2.0).round_ties_even();
    let y0 = ((hp - rows * ch - (rows - 1.0) * gap) / 2.0).round_ties_even();
    let px_to_pt = |px| mm_to_pt(px_to_mm(px));
    let bleed = mm_to_pt(template_bleed_mm(settings));
    let mut slots = Vec::new();
    for row in 0..rows as u32 {
        for col in 0..columns as u32 {
            let trim = Rect {
                x: px_to_pt(x0 + f64::from(col) * (cw + gap)),
                y: px_to_pt(y0 + f64::from(row) * (ch + gap)),
                width: px_to_pt(cw),
                height: px_to_pt(ch),
            };
            slots.push(Slot {
                trim,
                rect: Rect {
                    x: trim.x - bleed,
                    y: trim.y - bleed,
                    width: trim.width + 2.0 * bleed,
                    height: trim.height + 2.0 * bleed,
                },
            });
        }
    }
    let selection = &settings.scm_template;
    let variant = match selection.variant {
        ScmVariant::Default => "",
        ScmVariant::Borderless => "-borderless",
    };
    let [width, height] = page_mm.map(mm_to_pt);
    Ok(PrintLayout {
        width,
        height,
        columns: columns as u32,
        rows: rows as u32,
        slots,
        guides: Vec::new(),
        registration: Vec::new(),
        label_baseline: Some(height - mm_to_pt(1.0)),
        scm: Some(ScmSheet {
            name: format!(
                "{}-{}{variant}-v{}",
                selection.paper, selection.card, template.version
            ),
            marks: registration_marks(
                page_mm,
                inset,
                length.clamp(5.0, 20.0),
                thickness,
                selection.marks,
            ),
            orientation: template.orientation,
        }),
    })
}

pub fn duplex_slot(slot: &Slot, layout: &PrintLayout, settings: &PrintSettings) -> Slot {
    let first = &layout.slots[0];
    let last = &layout.slots[layout.slots.len() - 1];
    let transform = |rect: Rect, first: Rect, last: Rect| {
        let portrait = layout.height >= layout.width;
        Rect {
            x: (if portrait {
                first.x + last.x - rect.x
            } else {
                rect.x
            }) + mm_to_pt(settings.back_offset_xmm),
            y: (if portrait {
                rect.y
            } else {
                first.y + last.y - rect.y
            }) + mm_to_pt(settings.back_offset_ymm),
            ..rect
        }
    };
    Slot {
        rect: transform(slot.rect, first.rect, last.rect),
        trim: transform(slot.trim, first.trim, last.trim),
    }
}
