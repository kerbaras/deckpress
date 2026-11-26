//! Print planning and PDF output with krilla: raster card faces, vector cut
//! guides, an optional calibration page and "print at actual size" metadata.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use krilla::color::rgb;
use krilla::geom::{Path as KPath, PathBuilder, Point, Rect, Size, Transform};
use krilla::image::Image;
use krilla::metadata::Metadata;
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, LineCap, Stroke};
use krilla::text::{Font, TextDirection};
use krilla::Document;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::format_count;
use crate::layout::{
    create_layout, duplex_mirrors_x, duplex_offset, duplex_rotation, duplex_slot, fit_sheet_label,
    free_page_size, mm_to_pt, sheet_label, PrintLayout, Registration, Slot,
};
use crate::models::{Art, Backs, Deck, DeckEntry, LayoutMode, PrintSettings};
use crate::raster::{encode_jpeg, parse_hex_color, rasterize};
use crate::scm;
use crate::upscaler::{CancelToken, Upscaler};

const FONT: &[u8] = include_bytes!("../fonts/JetBrainsMono-Regular.ttf");
const MAX_IMAGE_BYTES: usize = 250 * 1024 * 1024;

pub struct Side {
    pub entries: Vec<DeckEntry>,
    pub back: bool,
    /// 1-based sheet number within the whole deck, for the sheet label.
    pub sheet: usize,
}

pub struct PrintPlan {
    pub layout: PrintLayout,
    pub sides: Vec<Side>,
    pub total_sheets: usize,
}

pub fn print_plan(deck: &Deck, settings: &PrintSettings) -> AppResult<PrintPlan> {
    let layout = create_layout(settings)?;
    let backs = scm::effective_backs(settings);
    let entries: Vec<DeckEntry> = deck
        .printable_entries(settings)
        .into_iter()
        .flat_map(|entry| std::iter::repeat_n(entry.clone(), entry.quantity as usize))
        .collect();
    if entries.is_empty() {
        return Err(AppError::user("No cards are included in this print job"));
    }
    let per_sheet = layout.slots.len();
    let total_sheets = entries.len().div_ceil(per_sheet);
    let first = settings.page_from.saturating_sub(1) as usize;
    let last = if settings.page_to > 0 {
        total_sheets.min(settings.page_to as usize)
    } else {
        total_sheets
    };
    if first >= last {
        return Err(AppError::user("Page range is outside the deck"));
    }
    let sheets: Vec<Vec<DeckEntry>> = (first..last)
        .map(|index| {
            entries[(index * per_sheet)..((index + 1) * per_sheet).min(entries.len())].to_vec()
        })
        .collect();
    let mut sides = Vec::new();
    for (offset, sheet) in sheets.iter().enumerate() {
        sides.push(Side {
            entries: sheet.clone(),
            back: false,
            sheet: first + offset + 1,
        });
        if matches!(backs, Backs::LongEdge | Backs::ShortEdge) {
            sides.push(Side {
                entries: sheet.clone(),
                back: true,
                sheet: first + offset + 1,
            });
        }
    }
    if backs == Backs::Separate {
        for (offset, sheet) in sheets.into_iter().enumerate() {
            sides.push(Side {
                entries: sheet,
                back: true,
                sheet: first + offset + 1,
            });
        }
    }
    Ok(PrintPlan {
        layout,
        sides,
        total_sheets,
    })
}

pub struct PdfServices<'a> {
    pub upscaler: Option<&'a dyn Upscaler>,
    pub raster_dir: &'a Path,
}

pub struct PdfOutput {
    pub bytes: Vec<u8>,
    pub pages: usize,
    pub unique_images: usize,
}

fn color(hex: &str) -> rgb::Color {
    let c = parse_hex_color(hex);
    rgb::Color::new(c[0], c[1], c[2])
}

fn rect_path(x: f64, y: f64, w: f64, h: f64) -> Option<KPath> {
    let mut builder = PathBuilder::new();
    builder.push_rect(Rect::from_xywh(x as f32, y as f32, w as f32, h as f32)?);
    builder.finish()
}

fn line_path(x1: f64, y1: f64, x2: f64, y2: f64) -> Option<KPath> {
    let mut builder = PathBuilder::new();
    builder.move_to(x1 as f32, y1 as f32);
    builder.line_to(x2 as f32, y2 as f32);
    builder.finish()
}

fn circle_path(cx: f64, cy: f64, r: f64) -> Option<KPath> {
    // Four cubic segments; 0.5523 is the standard control-point ratio.
    let (cx, cy, r) = (cx as f32, cy as f32, r as f32);
    let k = 0.5523 * r;
    let mut builder = PathBuilder::new();
    builder.move_to(cx + r, cy);
    builder.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
    builder.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
    builder.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
    builder.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
    builder.close();
    builder.finish()
}

/// Registration target: a circle with a crosshair that overshoots it, the
/// shape press operators line up when checking front/back register.
fn draw_registration(
    surface: &mut krilla::surface::Surface<'_>,
    mark: &crate::layout::Registration,
    color: rgb::Color,
) {
    surface.set_fill(None);
    surface.set_stroke(Some(stroke(color, 0.25)));
    let reach = mark.radius * 1.6;
    for path in [
        circle_path(mark.x, mark.y, mark.radius),
        line_path(mark.x - reach, mark.y, mark.x + reach, mark.y),
        line_path(mark.x, mark.y - reach, mark.x, mark.y + reach),
    ]
    .into_iter()
    .flatten()
    {
        surface.draw_path(&path);
    }
    surface.set_stroke(None);
}

/// Slug line in the bottom margin: which deck and sheet this is, and the
/// facts a print shop asks for before running it.
fn draw_sheet_label(
    surface: &mut krilla::surface::Surface<'_>,
    layout: &PrintLayout,
    font: &Font,
    color: rgb::Color,
    text: &str,
) {
    let Some(placement) = fit_sheet_label(layout, text) else {
        return;
    };
    surface.set_fill(Some(fill(color)));
    surface.draw_text(
        Point::from_xy(placement.x as f32, placement.baseline as f32),
        font.clone(),
        placement.font_size_pt as f32,
        text,
        false,
        TextDirection::LeftToRight,
    );
    surface.set_fill(None);
}

fn stroke(color: rgb::Color, width: f64) -> Stroke {
    Stroke {
        paint: color.into(),
        width: width as f32,
        line_cap: LineCap::Butt,
        ..Stroke::default()
    }
}

fn fill(color: rgb::Color) -> Fill {
    Fill {
        paint: color.into(),
        opacity: NormalizedF32::ONE,
        rule: Default::default(),
    }
}

fn font() -> AppResult<Font> {
    Font::new(FONT.into(), 0).ok_or_else(|| AppError::internal("Bundled font failed to load"))
}

fn raster_key(source: &[u8], art: &Art, settings: &PrintSettings, model: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source);
    let params = serde_json::json!([
        crate::raster::PIPELINE_VERSION,
        art.bleed_mm,
        art.provider,
        settings.card_width_mm,
        settings.card_height_mm,
        settings.bleed_mm,
        settings.bleed_mode,
        settings.bleed_color,
        settings.dpi,
        settings.quality,
        settings.upscale,
        model,
    ]);
    hasher.update(params.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

fn draw_placeholder(surface: &mut krilla::surface::Surface<'_>, slot: &Slot, font: &Font) {
    if let Some(path) = rect_path(slot.rect.x, slot.rect.y, slot.rect.width, slot.rect.height) {
        surface.set_fill(Some(fill(rgb::Color::new(20, 23, 26))));
        surface.draw_path(&path);
    }
    if let Some(path) = rect_path(
        slot.trim.x + 8.0,
        slot.trim.y + 8.0,
        slot.trim.width - 16.0,
        slot.trim.height - 16.0,
    ) {
        surface.set_fill(None);
        surface.set_stroke(Some(stroke(rgb::Color::new(204, 161, 82), 1.0)));
        surface.draw_path(&path);
        surface.set_stroke(None);
    }
    surface.set_fill(Some(fill(rgb::Color::new(224, 178, 89))));
    surface.draw_text(
        Point::from_xy(
            (slot.trim.x + 22.0) as f32,
            (slot.trim.y + slot.trim.height / 2.0) as f32,
        ),
        font.clone(),
        13.0,
        "DECKPRESS",
        false,
        TextDirection::LeftToRight,
    );
    surface.set_fill(Some(fill(rgb::Color::new(178, 178, 178))));
    surface.draw_text(
        Point::from_xy(
            (slot.trim.x + 22.0) as f32,
            (slot.trim.y + slot.trim.height / 2.0 + 17.0) as f32,
        ),
        font.clone(),
        7.0,
        "PLAYTEST CARD",
        false,
        TextDirection::LeftToRight,
    );
}

/// A 50 mm ruler and a fixed MTG reference box for checking printer scaling.
fn draw_calibration_page(
    document: &mut Document,
    layout: &PrintLayout,
    settings: &PrintSettings,
    font: &Font,
) -> AppResult<()> {
    let mut page = document.start_page_with(
        PageSettings::from_wh(layout.width as f32, layout.height as f32)
            .ok_or_else(|| AppError::user("Paper size is invalid"))?,
    );
    let mut surface = page.surface();
    let ink = rgb::Color::new(20, 20, 20);
    let muted = rgb::Color::new(110, 110, 110);
    let margin = mm_to_pt(15.0);
    if layout.width < mm_to_pt(135.0) || layout.height < mm_to_pt(145.0) {
        draw_compact_size_calibration(&mut surface, layout, font);
        surface.finish();
        page.finish();
        if matches!(settings.backs, Backs::LongEdge | Backs::ShortEdge) {
            draw_blank_back(document, layout, font)?;
        }
        return Ok(());
    }
    let mut y = margin;
    let text = |surface: &mut krilla::surface::Surface<'_>,
                x: f64,
                y: f64,
                size: f32,
                s: &str,
                c: rgb::Color| {
        surface.set_stroke(None);
        surface.set_fill(Some(fill(c)));
        surface.draw_text(
            Point::from_xy(x as f32, y as f32),
            font.clone(),
            size,
            s,
            false,
            TextDirection::LeftToRight,
        );
    };
    text(
        &mut surface,
        margin,
        y + 14.0,
        14.0,
        "Deckpress calibration page",
        ink,
    );
    y += 24.0;
    text(
        &mut surface,
        margin,
        y + 9.0,
        8.5,
        "Print this page at 100% / Actual size (no \"fit to page\").",
        muted,
    );
    y += 12.0;
    text(
        &mut surface,
        margin,
        y + 9.0,
        8.5,
        "Measure from line centre to line centre before printing cards.",
        muted,
    );

    let rule_y = y + 23.0;
    surface.set_fill(None);
    if let Some(path) = line_path(margin, rule_y, margin + mm_to_pt(50.0), rule_y) {
        surface.set_stroke(Some(stroke(ink, 0.5)));
        surface.draw_path(&path);
    }
    for mm in 0..=50u32 {
        let x = margin + mm_to_pt(f64::from(mm));
        let len = if mm % 10 == 0 {
            5.0
        } else if mm % 5 == 0 {
            3.0
        } else {
            1.5
        };
        if let Some(path) = line_path(x, rule_y, x, rule_y + mm_to_pt(len)) {
            surface.set_fill(None);
            surface.set_stroke(Some(stroke(ink, if mm % 10 == 0 { 0.5 } else { 0.3 })));
            surface.draw_path(&path);
        }
        if mm % 10 == 0 {
            text(
                &mut surface,
                x - 4.0,
                rule_y + mm_to_pt(5.0) + 9.0,
                6.5,
                &mm.to_string(),
                muted,
            );
        }
    }
    text(
        &mut surface,
        margin,
        rule_y + mm_to_pt(5.0) + 22.0,
        8.0,
        "50 mm ruler, 1 mm ticks",
        ink,
    );
    y = rule_y + mm_to_pt(5.0) + 33.0;

    surface.set_fill(None);
    if let Some(path) = rect_path(margin, y, mm_to_pt(63.0), mm_to_pt(88.0)) {
        surface.set_stroke(Some(stroke(ink, 0.5)));
        surface.draw_path(&path);
    }
    surface.set_stroke(None);
    text(
        &mut surface,
        margin + 10.0,
        y + 18.0,
        9.0,
        "63 × 88 mm MTG reference",
        ink,
    );
    text(
        &mut surface,
        margin + 10.0,
        y + 32.0,
        8.0,
        "Measure me with a ruler.",
        muted,
    );
    text(
        &mut surface,
        margin + 10.0,
        y + 55.0,
        8.0,
        &format!(
            "Selected trim: {} × {} mm",
            settings.card_width_mm, settings.card_height_mm
        ),
        muted,
    );
    surface.finish();
    page.finish();
    if matches!(settings.backs, Backs::LongEdge | Backs::ShortEdge) {
        draw_blank_back(document, layout, font)?;
    }
    Ok(())
}

fn draw_compact_size_calibration(
    surface: &mut krilla::surface::Surface<'_>,
    layout: &PrintLayout,
    font: &Font,
) {
    let ruler_mm = if layout.width >= mm_to_pt(60.0) {
        50
    } else {
        20
    };
    draw_fitted_text(
        surface,
        font,
        layout.width,
        mm_to_pt(6.0),
        10.0,
        "Deckpress print-size check",
    );
    draw_fitted_text(
        surface,
        font,
        layout.width,
        mm_to_pt(11.0),
        8.0,
        "Print at actual size (100%).",
    );
    draw_fitted_text(
        surface,
        font,
        layout.width,
        mm_to_pt(15.0),
        8.0,
        &format!("{ruler_mm} mm ruler, 5 mm ticks"),
    );
    let (x, y) = (mm_to_pt(5.0), mm_to_pt(20.0));
    let ink = rgb::Color::new(20, 20, 20);
    surface.set_fill(None);
    surface.set_stroke(Some(stroke(ink, 0.5)));
    if let Some(path) = line_path(x, y, x + mm_to_pt(f64::from(ruler_mm)), y) {
        surface.draw_path(&path);
    }
    for tick in (0..=ruler_mm).step_by(5) {
        let tx = x + mm_to_pt(f64::from(tick));
        if let Some(path) = line_path(tx, y, tx, y + mm_to_pt(3.0)) {
            surface.draw_path(&path);
        }
    }
    if layout.width >= mm_to_pt(73.0) && layout.height >= mm_to_pt(122.0) {
        let box_y = mm_to_pt(29.0);
        if let Some(path) = rect_path(x, box_y, mm_to_pt(63.0), mm_to_pt(88.0)) {
            surface.draw_path(&path);
        }
        draw_fitted_text(
            surface,
            font,
            mm_to_pt(68.0),
            box_y + mm_to_pt(6.0),
            8.0,
            "    63 × 88 mm MTG reference",
        );
    }
}

/// Keeps front/back pairs aligned when the calibration sheet is printed in a
/// duplex run: its back is a page with a single note.
fn draw_blank_back(document: &mut Document, layout: &PrintLayout, font: &Font) -> AppResult<()> {
    let mut page = document.start_page_with(
        PageSettings::from_wh(layout.width as f32, layout.height as f32)
            .ok_or_else(|| AppError::user("Paper size is invalid"))?,
    );
    let mut surface = page.surface();
    draw_fitted_text(
        &mut surface,
        font,
        layout.width,
        mm_to_pt(6.0),
        8.5,
        "Back of the calibration page. Intentionally blank.",
    );
    surface.finish();
    page.finish();
    Ok(())
}

fn set_print_preferences(bytes: &[u8], backs: Backs) -> Result<Vec<u8>, lopdf::Error> {
    let mut pdf = lopdf::Document::load_mem(bytes)?;
    let mut preferences = lopdf::Dictionary::new();
    preferences.set("PrintScaling", lopdf::Object::Name(b"None".to_vec()));
    if let Some(duplex) = match backs {
        Backs::None => None,
        Backs::LongEdge => Some("DuplexFlipLongEdge"),
        Backs::ShortEdge => Some("DuplexFlipShortEdge"),
        Backs::Separate => Some("Simplex"),
    } {
        preferences.set("Duplex", lopdf::Object::Name(duplex.as_bytes().to_vec()));
    }
    pdf.catalog_mut()?.set("ViewerPreferences", preferences);
    let mut output = Vec::with_capacity(bytes.len());
    pdf.save_to(&mut output)?;
    Ok(output)
}

pub fn build_duplex_calibration_pdf(settings: &PrintSettings) -> AppResult<Vec<u8>> {
    settings.validate()?;
    let (width, height) = if settings.layout_mode == LayoutMode::Scm {
        let layout = create_layout(settings)?;
        (layout.width, layout.height)
    } else {
        free_page_size(settings)
    };
    let backs = match scm::effective_backs(settings) {
        Backs::ShortEdge => Backs::ShortEdge,
        _ => Backs::LongEdge,
    };
    let font = font()?;
    let page_settings = PageSettings::from_wh(width as f32, height as f32)
        .ok_or_else(|| AppError::user("Paper size is invalid"))?;
    let mut document = Document::new();
    document.set_metadata(
        Metadata::new()
            .title("Deckpress duplex calibration".into())
            .creator("Deckpress".into()),
    );
    let (dx, dy) = duplex_offset(settings);
    let (cx, cy) = (width / 2.0, height / 2.0);
    let (span_x, span_y) = (cx - mm_to_pt(12.0), cy - mm_to_pt(12.0));
    let (sin, cos) = settings.back_rotation_deg.to_radians().sin_cos();
    let rotated_x = span_x * cos.abs() + span_y * sin.abs();
    let rotated_y = span_x * sin.abs() + span_y * cos.abs();
    let correction_x = dx * cos - dy * sin;
    let correction_y = dx * sin + dy * cos;
    let clearance = mm_to_pt(5.0);
    let scale = 1.0_f64
        .min((cx - correction_x.abs() - clearance) / rotated_x)
        .min((cy - correction_y.abs() - clearance) / rotated_y);
    let mirror_x = duplex_mirrors_x(width, height, backs);
    let rotation = pdf_duplex_rotation(width, height, settings);
    let steps = if span_x.min(span_y) * scale < mm_to_pt(20.0) {
        1
    } else {
        2
    };
    let radius = mm_to_pt(0.9).min(span_x.min(span_y) * scale / f64::from(steps) / 4.0);
    let ink = rgb::Color::new(20, 20, 20);
    let flip = if backs == Backs::ShortEdge {
        "short"
    } else {
        "long"
    };

    for back in [false, true] {
        let mut page = document.start_page_with(page_settings.clone());
        let mut surface = page.surface();
        let side = if back { "Back" } else { "Front" };
        draw_fitted_text(
            &mut surface,
            &font,
            width,
            mm_to_pt(4.5),
            10.0,
            &format!("Deckpress duplex calibration / {side}"),
        );
        draw_fitted_text(
            &mut surface,
            &font,
            width,
            height - mm_to_pt(3.0),
            8.0,
            &format!("Print at actual size (100%) / Flip {flip} edge"),
        );
        let back_rotation = rotation.as_ref().filter(|_| back);
        if let Some(transform) = back_rotation {
            surface.push_transform(transform);
        }
        for row in -steps..=steps {
            for col in -steps..=steps {
                let x = cx + f64::from(col) / f64::from(steps) * span_x * scale;
                let y = cy + f64::from(row) / f64::from(steps) * span_y * scale;
                let (x, y) = if back {
                    (
                        if mirror_x { width - x } else { x } + dx,
                        if mirror_x { y } else { height - y } + dy,
                    )
                } else {
                    (x, y)
                };
                if back {
                    surface.set_fill(None);
                    surface.set_stroke(Some(stroke(ink, 0.25)));
                    let reach = radius * 1.6;
                    for path in [
                        line_path(x - reach, y, x + reach, y),
                        line_path(x, y - reach, x, y + reach),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        surface.draw_path(&path);
                    }
                } else {
                    draw_registration(&mut surface, &Registration { x, y, radius }, ink);
                }
            }
        }
        if back_rotation.is_some() {
            surface.pop();
        }
        surface.finish();
        page.finish();
    }
    set_print_preferences(&document.finish()?, backs).map_err(AppError::internal)
}

fn draw_fitted_text(
    surface: &mut krilla::surface::Surface<'_>,
    font: &Font,
    width: f64,
    y: f64,
    max_size: f64,
    text: &str,
) {
    let margin = mm_to_pt(3.0);
    let size = ((width - 2.0 * margin) / (0.6 * text.chars().count() as f64)).min(max_size);
    surface.set_stroke(None);
    surface.set_fill(Some(fill(rgb::Color::new(20, 20, 20))));
    surface.draw_text(
        Point::from_xy(margin as f32, y as f32),
        font.clone(),
        size as f32,
        text,
        false,
        TextDirection::LeftToRight,
    );
}

pub fn build_pdf(
    deck: &Deck,
    settings: &PrintSettings,
    services: &PdfServices<'_>,
    cancel: &CancelToken,
    progress: &mut dyn FnMut(usize, usize, String),
    read_source: &mut dyn FnMut(&str) -> AppResult<Vec<u8>>,
) -> AppResult<PdfOutput> {
    let PrintPlan {
        layout,
        sides,
        total_sheets,
    } = print_plan(deck, settings)?;
    let effective_settings = scm::effective_print_settings(settings)?;
    let settings = &effective_settings;
    if settings.upscale && services.upscaler.is_none() {
        return Err(AppError::user(
            "Upscaling is enabled but no model is loaded",
        ));
    }
    let model = services
        .upscaler
        .map(|u| u.info().model_id)
        .unwrap_or_default();
    let font = font()?;
    let mut document = Document::new();
    document.set_metadata(
        Metadata::new()
            .title(format!("{} - playtest proxies", deck.name))
            .creator("Deckpress".into())
            .producer("Deckpress / krilla".into())
            .description(format!(
                "PRINT AT 100% / ACTUAL SIZE. {} x {} mm cards, {} DPI raster. {}.",
                settings.card_width_mm,
                settings.card_height_mm,
                settings.dpi,
                if settings.upscale {
                    "AI 4x upscaling enabled"
                } else {
                    "Lanczos resizing; source detail unchanged"
                }
            )),
    );
    if settings.calibration_page {
        draw_calibration_page(&mut document, &layout, settings, &font)?;
    }
    std::fs::create_dir_all(services.raster_dir)?;
    let total: usize = sides.iter().map(|side| side.entries.len()).sum();
    let mut completed = 0;
    let mut image_bytes = 0usize;
    let mut embedded: HashMap<String, Image> = HashMap::new();
    let guide_color = color(&settings.guide_color);
    let page_settings = PageSettings::from_wh(layout.width as f32, layout.height as f32)
        .ok_or_else(|| AppError::user("Paper size is invalid"))?;
    let back_rotation = pdf_duplex_rotation(layout.width, layout.height, settings);

    for side in &sides {
        cancel.check()?;
        let mut page = document.start_page_with(page_settings.clone());
        let mut surface = page.surface();
        let rotation = back_rotation.as_ref().filter(|_| side.back);
        if let Some(rotation) = rotation {
            surface.push_transform(rotation);
        }
        for (index, entry) in side.entries.iter().enumerate() {
            cancel.check()?;
            let original = layout
                .slots
                .get(index)
                .ok_or_else(|| AppError::internal("Print layout slot missing"))?;
            let slot = if side.back {
                duplex_slot(original, &layout, settings)
            } else {
                *original
            };
            let art = if side.back {
                entry.back_art()
            } else {
                Some(entry.front_art().clone())
            };
            progress(
                completed,
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
            let rotate = side.back
                && layout
                    .scm
                    .as_ref()
                    .is_some_and(|scm| scm.orientation == crate::models::Orientation::Landscape);
            if rotate {
                surface.push_transform(&Transform::from_row(
                    -1.0,
                    0.0,
                    0.0,
                    -1.0,
                    (2.0 * slot.rect.x + slot.rect.width) as f32,
                    (2.0 * slot.rect.y + slot.rect.height) as f32,
                ));
            }
            match art {
                Some(art) => {
                    let source = read_source(&art.image_url)?;
                    let key = raster_key(&source, &art, settings, &model);
                    let image = match embedded.get(&key) {
                        Some(image) => image.clone(),
                        None => {
                            let path: PathBuf = services.raster_dir.join(format!("{key}.jpg"));
                            let bytes = match std::fs::read(&path) {
                                Ok(bytes) => bytes,
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                    let mut tile_progress = |done: usize, tiles: usize| {
                                        if tiles > 0 {
                                            progress(
                                                completed,
                                                total,
                                                format!(
                                                    "AI upscaling {} · tile {done}/{tiles}",
                                                    entry.card.name
                                                ),
                                            );
                                        }
                                    };
                                    let output = rasterize(
                                        &source,
                                        &art,
                                        settings,
                                        services.upscaler,
                                        cancel,
                                        &mut tile_progress,
                                    )?;
                                    let bytes = encode_jpeg(&output.image, settings.quality)?;
                                    let tmp = path.with_extension("part");
                                    std::fs::write(&tmp, &bytes)?;
                                    std::fs::rename(&tmp, &path)?;
                                    bytes
                                }
                                Err(error) => return Err(error.into()),
                            };
                            image_bytes += bytes.len();
                            if image_bytes > MAX_IMAGE_BYTES {
                                return Err(AppError::user(
                                    "PDF exceeds 250 MB. Export a smaller page range or lower DPI.",
                                ));
                            }
                            let image = Image::from_jpeg(bytes.into(), true).map_err(|e| {
                                AppError::internal(format!("JPEG embed failed: {e}"))
                            })?;
                            embedded.insert(key, image.clone());
                            image
                        }
                    };
                    surface.push_transform(&Transform::from_translate(
                        slot.rect.x as f32,
                        slot.rect.y as f32,
                    ));
                    surface.draw_image(
                        image,
                        Size::from_wh(slot.rect.width as f32, slot.rect.height as f32)
                            .ok_or_else(|| AppError::user("Card slot has no size"))?,
                    );
                    surface.pop();
                }
                None => draw_placeholder(&mut surface, &slot, &font),
            }
            if rotate {
                surface.pop();
            }
            completed += 1;
            progress(
                completed,
                total,
                format!(
                    "Placed {completed} of {}",
                    format_count(total, "card face", "card faces")
                ),
            );
        }
        if rotation.is_some() {
            surface.pop();
        }
        if !side.back {
            surface.set_fill(None);
            surface.set_stroke(Some(stroke(guide_color, settings.guide_width_pt)));
            for line in &layout.guides {
                if let Some(path) = line_path(line.x1, line.y1, line.x2, line.y2) {
                    surface.draw_path(&path);
                }
            }
            surface.set_stroke(None);
        }
        for mark in &layout.registration {
            draw_registration(&mut surface, mark, guide_color);
        }
        if let Some(scm) = &layout.scm {
            let black = color("#000000");
            surface.set_fill(Some(fill(black)));
            for mark in &scm.marks {
                if let Some(path) = rect_path(mark.x, mark.y, mark.width, mark.height) {
                    surface.draw_path(&path);
                }
            }
            surface.set_fill(None);
        }
        let label = match &layout.scm {
            Some(scm) => format!("sheet: {}, template: {}", side.sheet, scm.name),
            None => sheet_label(settings, &deck.name, side.sheet, total_sheets, side.back),
        };
        draw_sheet_label(
            &mut surface,
            &layout,
            &font,
            if layout.scm.is_some() {
                color("#000000")
            } else {
                guide_color
            },
            &label,
        );
        surface.finish();
        page.finish();
    }
    cancel.check()?;
    let calibration_pages = if settings.calibration_page {
        1 + usize::from(matches!(settings.backs, Backs::LongEdge | Backs::ShortEdge))
    } else {
        0
    };
    let pages = sides.len() + calibration_pages;
    Ok(PdfOutput {
        bytes: set_print_preferences(&document.finish()?, settings.backs)
            .map_err(AppError::internal)?,
        pages,
        unique_images: embedded.len(),
    })
}

fn pdf_duplex_rotation(width: f64, height: f64, settings: &PrintSettings) -> Option<Transform> {
    let [a, b, c, d, e, f] = duplex_rotation(width, height, settings)?.map(|n| n as f32);
    Some(Transform::from_row(a, b, c, d, e, f))
}
