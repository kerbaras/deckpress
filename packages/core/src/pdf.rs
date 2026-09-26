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
use crate::layout::{create_layout, duplex_slot, mm_to_pt, PrintLayout, Slot};
use crate::models::{Art, Backs, Deck, DeckEntry, PrintSettings};
use crate::raster::{encode_jpeg, parse_hex_color, rasterize};
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
        if matches!(settings.backs, Backs::LongEdge | Backs::ShortEdge) {
            sides.push(Side {
                entries: sheet.clone(),
                back: true,
                sheet: first + offset + 1,
            });
        }
    }
    if settings.backs == Backs::Separate {
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
    settings: &PrintSettings,
    font: &Font,
    color: rgb::Color,
    text: &str,
) {
    let Some(baseline) = layout.label_baseline else {
        return;
    };
    let x = layout
        .slots
        .first()
        .map(|slot| slot.rect.x)
        .unwrap_or(mm_to_pt(settings.margin_mm));
    surface.set_fill(Some(fill(color)));
    surface.draw_text(
        Point::from_xy(x as f32, baseline as f32),
        font.clone(),
        5.0,
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

/// A page the user prints first to confirm the viewer is not scaling. Shows a
/// 50 mm square, a 100 mm rule and the exact card outline.
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
    let mut y = margin;
    let text = |surface: &mut krilla::surface::Surface<'_>,
                x: f64,
                y: f64,
                size: f32,
                s: &str,
                c: rgb::Color| {
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
    text(&mut surface, margin, y + 9.0, 8.5, &format!(
        "Paper {:.0} x {:.0} mm. Measure the square and the rule with a ruler before printing cards.",
        layout.width / mm_to_pt(1.0),
        layout.height / mm_to_pt(1.0)
    ), muted);
    y += 30.0;

    let square = mm_to_pt(50.0);
    if let Some(path) = rect_path(margin, y, square, square) {
        surface.set_fill(None);
        surface.set_stroke(Some(stroke(ink, 0.5)));
        surface.draw_path(&path);
    }
    text(
        &mut surface,
        margin + square + 10.0,
        y + 12.0,
        9.0,
        "50 x 50 mm square",
        ink,
    );
    text(
        &mut surface,
        margin + square + 10.0,
        y + 26.0,
        8.0,
        "Wrong size? The viewer is scaling. Disable it and reprint.",
        muted,
    );
    y += square + 24.0;

    let rule_y = y;
    if let Some(path) = line_path(margin, rule_y, margin + mm_to_pt(100.0), rule_y) {
        surface.set_stroke(Some(stroke(ink, 0.5)));
        surface.draw_path(&path);
    }
    for mm in 0..=100u32 {
        let x = margin + mm_to_pt(f64::from(mm));
        let len = if mm % 10 == 0 {
            5.0
        } else if mm % 5 == 0 {
            3.0
        } else {
            1.5
        };
        if let Some(path) = line_path(x, rule_y, x, rule_y + mm_to_pt(len)) {
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
        "100 mm rule, 1 mm ticks",
        ink,
    );
    y = rule_y + mm_to_pt(5.0) + 40.0;

    let (cw, ch) = (
        mm_to_pt(settings.card_width_mm),
        mm_to_pt(settings.card_height_mm),
    );
    let bleed = mm_to_pt(settings.bleed_mm);
    surface.set_fill(None);
    if let Some(path) = rect_path(margin, y, cw + 2.0 * bleed, ch + 2.0 * bleed) {
        surface.set_stroke(Some(stroke(muted, 0.3)));
        surface.draw_path(&path);
    }
    if let Some(path) = rect_path(margin + bleed, y + bleed, cw, ch) {
        surface.set_stroke(Some(stroke(ink, 0.5)));
        surface.draw_path(&path);
    }
    surface.set_stroke(None);
    text(
        &mut surface,
        margin + cw + 2.0 * bleed + 10.0,
        y + 12.0,
        9.0,
        &format!(
            "Card {} x {} mm, {} mm bleed",
            settings.card_width_mm, settings.card_height_mm, settings.bleed_mm
        ),
        ink,
    );
    text(
        &mut surface,
        margin + cw + 2.0 * bleed + 10.0,
        y + 26.0,
        8.0,
        &format!(
            "{} DPI raster, {}",
            settings.dpi,
            if settings.upscale {
                "AI upscaled"
            } else {
                "no upscaling"
            }
        ),
        muted,
    );
    text(
        &mut surface,
        margin + cw + 2.0 * bleed + 10.0,
        y + 40.0,
        8.0,
        "Lay a real card inside the inner outline: it must match exactly.",
        muted,
    );
    surface.finish();
    page.finish();
    if matches!(settings.backs, Backs::LongEdge | Backs::ShortEdge) {
        draw_blank_back(document, layout, font)?;
    }
    Ok(())
}

/// Keeps front/back pairs aligned when the calibration sheet is printed in a
/// duplex run: its back is a page with a single note.
fn draw_blank_back(document: &mut Document, layout: &PrintLayout, font: &Font) -> AppResult<()> {
    let mut page = document.start_page_with(
        PageSettings::from_wh(layout.width as f32, layout.height as f32)
            .ok_or_else(|| AppError::user("Paper size is invalid"))?,
    );
    let mut surface = page.surface();
    let margin = mm_to_pt(15.0);
    surface.set_fill(Some(fill(rgb::Color::new(110, 110, 110))));
    surface.draw_text(
        Point::from_xy(margin as f32, (margin + 9.0) as f32),
        font.clone(),
        8.5,
        "Back of the calibration page. Intentionally blank.",
        false,
        TextDirection::LeftToRight,
    );
    surface.finish();
    page.finish();
    Ok(())
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

    for side in &sides {
        cancel.check()?;
        let mut page = document.start_page_with(page_settings.clone());
        let mut surface = page.surface();
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
            completed += 1;
            progress(
                completed,
                total,
                format!("Placed {completed} of {total} card faces"),
            );
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
        draw_sheet_label(
            &mut surface,
            &layout,
            settings,
            &font,
            guide_color,
            &format!(
                "{} / sheet {} of {} / {} / {} x {} mm + {} mm bleed / {} dpi / print at 100%",
                deck.name
                    .to_uppercase()
                    .chars()
                    .filter(|c| c.is_ascii_graphic() || *c == ' ')
                    .take(40)
                    .collect::<String>()
                    .trim(),
                side.sheet,
                total_sheets,
                if side.back { "BACKS" } else { "FRONTS" },
                settings.card_width_mm,
                settings.card_height_mm,
                settings.bleed_mm,
                settings.dpi
            ),
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
        bytes: document.finish()?,
        pages,
        unique_images: embedded.len(),
    })
}
