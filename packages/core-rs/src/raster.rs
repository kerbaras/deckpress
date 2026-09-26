//! Card face rasterization: strip provider bleed, upscale (optional), resize
//! to the physical card size at the target DPI, add bleed, then fill the
//! corners of the trim area. Mirror and edge bleed sample the face with its
//! corner zones squared off from the border, before the corners are painted,
//! so the bleed carries border pixels rather than the scan's rounded corners
//! or the corner fill colour.

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{Rgb, RgbImage};

use crate::error::{AppError, AppResult};
use crate::layout::mm_to_pixels;
use crate::models::{Art, BleedMode, PrintSettings, Provider};
use crate::upscaler::{CancelToken, Upscaler};

/// Physical size MPC Autofill scans describe (2.5 x 3.5 inches).
const MPC_CARD_MM: (f64, f64) = (63.5, 88.9);

/// Bump when `rasterize` output changes for identical inputs so cached
/// previews and PDF rasters are regenerated.
pub const PIPELINE_VERSION: u32 = 2;

/// Corner radius of a real card.
pub const CORNER_RADIUS_MM: f64 = 3.0;

pub fn parse_hex_color(input: &str) -> Rgb<u8> {
    let hex = input.trim().trim_start_matches('#');
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    if hex.len() == 6 {
        Rgb([channel(0), channel(2), channel(4)])
    } else {
        Rgb([17, 17, 17])
    }
}

fn to_rgb(image: image::DynamicImage, background: Rgb<u8>) -> RgbImage {
    match image {
        image::DynamicImage::ImageRgb8(rgb) => rgb,
        other if other.color().has_alpha() => {
            let rgba = other.to_rgba8();
            let mut out = RgbImage::new(rgba.width(), rgba.height());
            for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
                let alpha = f32::from(src[3]) / 255.0;
                for c in 0..3 {
                    dst[c] = (f32::from(src[c]) * alpha + f32::from(background[c]) * (1.0 - alpha))
                        .round() as u8;
                }
            }
            out
        }
        other => other.to_rgb8(),
    }
}

/// Removes the bleed a provider already baked into the scan so every source
/// starts as a bare card face.
pub fn strip_bleed(image: &RgbImage, art: &Art, settings: &PrintSettings) -> RgbImage {
    if art.bleed_mm <= 0.0 {
        return image.clone();
    }
    let (native_w, native_h) = if art.provider == Provider::Mpc {
        MPC_CARD_MM
    } else {
        (settings.card_width_mm, settings.card_height_mm)
    };
    let (w, h) = (image.width(), image.height());
    let x = (f64::from(w) * art.bleed_mm / (native_w + art.bleed_mm * 2.0)).round() as u32;
    let y = (f64::from(h) * art.bleed_mm / (native_h + art.bleed_mm * 2.0)).round() as u32;
    if 2 * x >= w || 2 * y >= h {
        return image.clone();
    }
    image::imageops::crop_imm(image, x, y, w - 2 * x, h - 2 * y).to_image()
}

pub fn resize(image: &RgbImage, width: u32, height: u32) -> AppResult<RgbImage> {
    if image.width() == width && image.height() == height {
        return Ok(image.clone());
    }
    let mut out = RgbImage::new(width, height);
    let mut resizer = Resizer::new();
    resizer.resize(
        image,
        &mut out,
        &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
    )?;
    Ok(out)
}

/// Fits `image` into `width x height` preserving aspect ratio, centered on
/// `background` (sharp `fit: contain`).
pub fn contain(
    image: &RgbImage,
    width: u32,
    height: u32,
    background: Rgb<u8>,
) -> AppResult<RgbImage> {
    let scale = f64::min(
        f64::from(width) / f64::from(image.width()),
        f64::from(height) / f64::from(image.height()),
    );
    let w = ((f64::from(image.width()) * scale).round() as u32).clamp(1, width);
    let h = ((f64::from(image.height()) * scale).round() as u32).clamp(1, height);
    let resized = resize(image, w, h)?;
    if w == width && h == height {
        return Ok(resized);
    }
    let mut out = RgbImage::from_pixel(width, height, background);
    image::imageops::replace(
        &mut out,
        &resized,
        i64::from((width - w) / 2),
        i64::from((height - h) / 2),
    );
    Ok(out)
}

/// Paints the rounded corners of a scan with `color` so white/transparent
/// corners do not show once the card is cut. Radius is 3 mm on a real card.
pub fn fill_corners(image: &mut RgbImage, radius: u32, color: Rgb<u8>) {
    let (w, h) = image.dimensions();
    fill_corners_within(image, 0, 0, w, h, radius, color);
}

/// [`fill_corners`] for the `width x height` trim area whose top-left pixel
/// is `(left, top)`, leaving pixels outside that area (the bleed) untouched.
pub fn fill_corners_within(
    image: &mut RgbImage,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    radius: u32,
    color: Rgb<u8>,
) {
    if radius == 0 || width == 0 || height == 0 {
        return;
    }
    let (w, h) = (
        i64::from(width.min(image.width().saturating_sub(left))),
        i64::from(height.min(image.height().saturating_sub(top))),
    );
    let r = i64::from(radius);
    let r2 = r * r;
    for corner in 0..4 {
        let (cx, cy) = match corner {
            0 => (r, r),
            1 => (w - 1 - r, r),
            2 => (r, h - 1 - r),
            _ => (w - 1 - r, h - 1 - r),
        };
        let (x0, x1) = if corner % 2 == 0 {
            (0, r)
        } else {
            (w - 1 - r, w)
        };
        let (y0, y1) = if corner < 2 { (0, r) } else { (h - 1 - r, h) };
        for y in y0.max(0)..y1.min(h) {
            for x in x0.max(0)..x1.min(w) {
                let (dx, dy) = (x - cx, y - cy);
                if dx * dx + dy * dy > r2 {
                    image.put_pixel(left + x as u32, top + y as u32, color);
                }
            }
        }
    }
}

/// Replaces the pixels outside each corner arc of `radius` with the pixel on
/// the arc along the ray from the arc's centre, so the rounded (transparent or
/// white) corners of a scan become an extension of the border. Used before
/// mirror/edge bleed sampling; the real corners are painted afterwards.
pub fn square_corners(image: &mut RgbImage, radius: u32) {
    let (w, h) = (i64::from(image.width()), i64::from(image.height()));
    let r = i64::from(radius);
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    let source = image.clone();
    for corner in 0..4 {
        let (cx, cy) = match corner {
            0 => (r, r),
            1 => (w - 1 - r, r),
            2 => (r, h - 1 - r),
            _ => (w - 1 - r, h - 1 - r),
        };
        let (x0, x1) = if corner % 2 == 0 {
            (0, r)
        } else {
            (w - 1 - r, w)
        };
        let (y0, y1) = if corner < 2 { (0, r) } else { (h - 1 - r, h) };
        for y in y0.max(0)..y1.min(h) {
            for x in x0.max(0)..x1.min(w) {
                let (dx, dy) = (x - cx, y - cy);
                let d2 = dx * dx + dy * dy;
                if d2 <= r * r {
                    continue;
                }
                // One pixel inside the arc so rounding never lands back outside it.
                let scale = ((r - 1) as f64) / (d2 as f64).sqrt();
                let sx = (cx as f64 + dx as f64 * scale).round() as i64;
                let sy = (cy as f64 + dy as f64 * scale).round() as i64;
                let pixel = source.get_pixel(sx.clamp(0, w - 1) as u32, sy.clamp(0, h - 1) as u32);
                image.put_pixel(x as u32, y as u32, *pixel);
            }
        }
    }
}

/// Maps a coordinate outside `0..len` back inside by reflecting about the
/// outermost pixels: `-1 -> 1`, `-2 -> 2`, `len -> len - 2`. The outermost
/// pixel is the axis and is not repeated, and the reflection keeps folding
/// for offsets larger than `len`.
fn reflect(v: i64, len: i64) -> i64 {
    if len <= 1 {
        return 0;
    }
    let period = 2 * (len - 1);
    let m = v.rem_euclid(period);
    if m < len {
        m
    } else {
        period - m
    }
}

/// Adds `bleed` pixels on every side. `Solid` paints `color`; `Edge` repeats
/// the outermost row/column; `Mirror` reflects the face about its outer edge.
pub fn extend(image: &RgbImage, bleed: u32, mode: BleedMode, color: Rgb<u8>) -> RgbImage {
    if bleed == 0 {
        return image.clone();
    }
    let (w, h) = (image.width(), image.height());
    let (ow, oh) = (w + 2 * bleed, h + 2 * bleed);
    let mut out = RgbImage::from_pixel(ow, oh, color);
    image::imageops::replace(&mut out, image, i64::from(bleed), i64::from(bleed));
    if mode == BleedMode::Solid || w == 0 || h == 0 {
        return out;
    }
    let (wi, hi) = (i64::from(w), i64::from(h));
    let sample = |x: i64, y: i64| -> Rgb<u8> {
        let (sx, sy) = match mode {
            BleedMode::Edge => (x.clamp(0, wi - 1), y.clamp(0, hi - 1)),
            _ => (reflect(x, wi), reflect(y, hi)),
        };
        *image.get_pixel(sx as u32, sy as u32)
    };
    let b = i64::from(bleed);
    for oy in 0..i64::from(oh) {
        let y = oy - b;
        let inside_y = (0..hi).contains(&y);
        for ox in 0..i64::from(ow) {
            let x = ox - b;
            if !inside_y || !(0..wi).contains(&x) {
                out.put_pixel(ox as u32, oy as u32, sample(x, y));
            }
        }
    }
    out
}

/// Adds bleed to a bare card face and then paints the rounded corners of the
/// trim area. Mirror and edge bleed sample a copy of the face whose corner
/// zones were squared off from the border, so neither the scan's own rounded
/// corners nor the corner fill colour end up in the bleed.
pub fn finish_face(face: &RgbImage, settings: &PrintSettings, background: Rgb<u8>) -> RgbImage {
    let bleed = mm_to_pixels(settings.bleed_mm, settings.dpi);
    let radius = mm_to_pixels(CORNER_RADIUS_MM, settings.dpi);
    let mut out = if settings.bleed_mode == BleedMode::Solid {
        extend(face, bleed, settings.bleed_mode, background)
    } else {
        let mut squared = face.clone();
        square_corners(&mut squared, radius);
        extend(&squared, bleed, settings.bleed_mode, background)
    };
    fill_corners_within(
        &mut out,
        bleed,
        bleed,
        face.width(),
        face.height(),
        radius,
        background,
    );
    out
}

pub struct RasterOutput {
    pub image: RgbImage,
    pub upscaled: bool,
}

/// Full face pipeline. `upscaler` is only used when `settings.upscale` is set
/// and the source is smaller than 95% of the target in both dimensions.
pub fn rasterize(
    source: &[u8],
    art: &Art,
    settings: &PrintSettings,
    upscaler: Option<&dyn Upscaler>,
    cancel: &CancelToken,
    progress: &mut dyn FnMut(usize, usize),
) -> AppResult<RasterOutput> {
    let background = parse_hex_color(&settings.bleed_color);
    let decoded = to_rgb(crate::images::decode(source)?, background);
    let mut face = strip_bleed(&decoded, art, settings);
    let target_w = mm_to_pixels(settings.card_width_mm, settings.dpi);
    let target_h = mm_to_pixels(settings.card_height_mm, settings.dpi);
    if target_w == 0 || target_h == 0 {
        return Err(AppError::user("Card dimensions are too small to print"));
    }
    let mut upscaled = false;
    if settings.upscale
        && f64::from(face.width()) < f64::from(target_w) * 0.95
        && f64::from(face.height()) < f64::from(target_h) * 0.95
    {
        let upscaler = upscaler.ok_or_else(|| AppError::user("Upscaling model is not loaded"))?;
        face = upscaler.upscale(&face, cancel, progress)?;
        upscaled = true;
    }
    cancel.check()?;
    let face = contain(&face, target_w, target_h, background)?;
    Ok(RasterOutput {
        image: finish_face(&face, settings, background),
        upscaled,
    })
}

pub fn encode_jpeg(image: &RgbImage, quality: u8) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
    encoder.encode_image(image)?;
    Ok(bytes)
}

pub fn encode_png(image: &RgbImage) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    image.write_to(
        &mut std::io::Cursor::new(&mut bytes),
        image::ImageFormat::Png,
    )?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Provider;

    fn art(bleed_mm: f64, provider: Provider) -> Art {
        Art {
            id: "a".into(),
            provider,
            name: "a".into(),
            image_url: String::new(),
            thumbnail_url: String::new(),
            art_crop_url: String::new(),
            source_url: String::new(),
            source: String::new(),
            artist: String::new(),
            set: String::new(),
            collector_number: String::new(),
            language: String::new(),
            released_at: String::new(),
            dpi: 300.0,
            tags: vec![],
            bleed_mm,
            back_image_url: String::new(),
            back_thumbnail_url: String::new(),
        }
    }

    #[test]
    fn parses_hex_colors() {
        assert_eq!(parse_hex_color("#ff0080"), Rgb([255, 0, 128]));
        assert_eq!(parse_hex_color("bad"), Rgb([17, 17, 17]));
    }

    #[test]
    fn strips_mpc_bleed_using_the_mpc_card_size() {
        let image = RgbImage::new(816, 1110);
        let settings = PrintSettings::default();
        let out = strip_bleed(&image, &art(3.048, Provider::Mpc), &settings);
        assert_eq!((out.width(), out.height()), (816 - 2 * 36, 1110 - 2 * 36));
        let untouched = strip_bleed(&image, &art(0.0, Provider::Scryfall), &settings);
        assert_eq!(untouched.dimensions(), image.dimensions());
    }

    /// Every pixel gets a unique colour so reflections can be traced exactly.
    fn labelled(width: u32, height: u32) -> RgbImage {
        let mut image = RgbImage::new(width, height);
        for (x, y, p) in image.enumerate_pixels_mut() {
            *p = Rgb([(x + 1) as u8, (y + 1) as u8, 200]);
        }
        image
    }

    const BACKGROUND: Rgb<u8> = Rgb([255, 0, 255]);

    #[test]
    fn reflect_uses_the_outermost_pixel_as_the_axis() {
        assert_eq!(reflect(-1, 5), 1);
        assert_eq!(reflect(-2, 5), 2);
        assert_eq!(reflect(-4, 5), 4);
        assert_eq!(reflect(5, 5), 3);
        assert_eq!(reflect(6, 5), 2);
        assert_eq!(reflect(8, 5), 0);
        assert_eq!(reflect(-5, 5), 3);
        assert_eq!(reflect(-8, 5), 0);
        assert_eq!(reflect(-9, 5), 1);
        assert_eq!(reflect(-1, 1), 0);
        assert_eq!(reflect(3, 1), 0);
    }

    #[test]
    fn extend_mirror_reflects_without_repeating_the_seam_pixel() {
        let image = labelled(5, 3);
        let out = extend(&image, 3, BleedMode::Mirror, BACKGROUND);
        assert_eq!(out.dimensions(), (11, 9));
        let row = 3 + 1;
        let expected_columns = [3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1];
        for (ox, sx) in expected_columns.into_iter().enumerate() {
            assert_eq!(
                out.get_pixel(ox as u32, row),
                image.get_pixel(sx, 1),
                "column {ox}"
            );
        }
        let column = 3 + 2;
        let expected_rows = [1, 2, 1, 0, 1, 2, 1, 0, 1];
        for (oy, sy) in expected_rows.into_iter().enumerate() {
            assert_eq!(
                out.get_pixel(column, oy as u32),
                image.get_pixel(2, sy),
                "row {oy}"
            );
        }
        assert_eq!(out.get_pixel(0, 0), image.get_pixel(3, 1));
        assert!(out.pixels().all(|p| *p != BACKGROUND));
    }

    #[test]
    fn extend_edge_and_solid_keep_their_fills() {
        let image = labelled(4, 4);
        let edge = extend(&image, 2, BleedMode::Edge, BACKGROUND);
        assert_eq!(edge.get_pixel(0, 0), image.get_pixel(0, 0));
        assert_eq!(edge.get_pixel(7, 7), image.get_pixel(3, 3));
        assert_eq!(edge.get_pixel(0, 4), image.get_pixel(0, 2));
        assert_eq!(edge.get_pixel(4, 0), image.get_pixel(2, 0));
        let solid = extend(&image, 2, BleedMode::Solid, Rgb([9, 9, 9]));
        assert_eq!(*solid.get_pixel(0, 0), Rgb([9, 9, 9]));
        assert_eq!(*solid.get_pixel(1, 4), Rgb([9, 9, 9]));
        assert_eq!(solid.get_pixel(2, 2), image.get_pixel(0, 0));
        assert_eq!(extend(&image, 0, BleedMode::Mirror, BACKGROUND), image);
    }

    #[test]
    fn extend_mirror_keeps_folding_when_bleed_exceeds_the_face() {
        let image = labelled(2, 3);
        let out = extend(&image, 7, BleedMode::Mirror, BACKGROUND);
        assert_eq!(out.dimensions(), (16, 17));
        assert!(out.pixels().all(|p| *p != BACKGROUND));
        for ox in 0..16i64 {
            for oy in 0..17i64 {
                assert_eq!(
                    out.get_pixel(ox as u32, oy as u32),
                    image.get_pixel(reflect(ox - 7, 2) as u32, reflect(oy - 7, 3) as u32)
                );
            }
        }
        let tiny = extend(
            &RgbImage::from_pixel(1, 1, Rgb([1, 2, 3])),
            3,
            BleedMode::Mirror,
            BACKGROUND,
        );
        assert!(tiny.pixels().all(|p| *p == Rgb([1, 2, 3])));
    }

    #[test]
    fn one_mm_bleed_at_800_dpi_is_reflected_face_not_background() {
        let settings = PrintSettings {
            dpi: 800,
            bleed_mm: 1.0,
            bleed_mode: BleedMode::Mirror,
            ..PrintSettings::default()
        };
        let (w, h) = (mm_to_pixels(63.0, 800), mm_to_pixels(88.0, 800));
        let mut face = RgbImage::from_pixel(w, h, Rgb([240, 240, 240]));
        for (x, y, p) in face.enumerate_pixels_mut() {
            let border = 60;
            if x < border || y < border || x >= w - border || y >= h - border {
                *p = Rgb([10, 10, (x % 200) as u8]);
            }
        }
        let out = finish_face(&face, &settings, BACKGROUND);
        let bleed = mm_to_pixels(1.0, 800);
        assert_eq!(bleed, 31);
        assert_eq!(out.dimensions(), (w + 2 * bleed, h + 2 * bleed));
        let radius = mm_to_pixels(CORNER_RADIUS_MM, 800);
        for y in radius..h - radius {
            for k in 0..bleed {
                assert_eq!(
                    out.get_pixel(bleed - 1 - k, bleed + y),
                    face.get_pixel(k + 1, y),
                    "left bleed column {k} row {y}"
                );
                assert_eq!(
                    out.get_pixel(bleed + w + k, bleed + y),
                    face.get_pixel(w - 2 - k, y),
                    "right bleed column {k} row {y}"
                );
            }
        }
        for x in radius..w - radius {
            for k in 0..bleed {
                assert_eq!(
                    out.get_pixel(bleed + x, bleed - 1 - k),
                    face.get_pixel(x, k + 1)
                );
                assert_eq!(
                    out.get_pixel(bleed + x, bleed + h + k),
                    face.get_pixel(x, h - 2 - k)
                );
            }
        }
        assert!(out.pixels().filter(|p| **p == BACKGROUND).count() > 0);
    }

    #[test]
    fn corner_fill_stays_inside_the_trim_and_is_not_reflected() {
        let settings = PrintSettings {
            dpi: 300,
            bleed_mm: 1.0,
            bleed_mode: BleedMode::Mirror,
            ..PrintSettings::default()
        };
        let face = RgbImage::from_pixel(120, 160, Rgb([250, 250, 250]));
        let out = finish_face(&face, &settings, BACKGROUND);
        let bleed = mm_to_pixels(1.0, 300);
        assert_eq!(*out.get_pixel(bleed, bleed), BACKGROUND);
        assert_eq!(*out.get_pixel(bleed + 119, bleed + 159), BACKGROUND);
        assert_eq!(*out.get_pixel(bleed - 1, bleed), Rgb([250, 250, 250]));
        assert_eq!(*out.get_pixel(bleed, bleed - 1), Rgb([250, 250, 250]));
        assert_eq!(*out.get_pixel(0, 0), Rgb([250, 250, 250]));
        assert!(out
            .enumerate_pixels()
            .filter(|(_, _, p)| **p == BACKGROUND)
            .all(|(x, y, _)| { x >= bleed && y >= bleed && x < bleed + 120 && y < bleed + 160 }));
        let radius = mm_to_pixels(CORNER_RADIUS_MM, 300);
        assert_eq!(
            *out.get_pixel(bleed + radius, bleed + radius),
            Rgb([250, 250, 250])
        );
    }

    #[test]
    fn scan_corners_are_squared_from_the_border_before_mirroring() {
        let settings = PrintSettings {
            dpi: 300,
            bleed_mm: 1.0,
            bleed_mode: BleedMode::Mirror,
            ..PrintSettings::default()
        };
        let border = Rgb([12, 12, 12]);
        let art = Rgb([200, 180, 90]);
        let (w, h) = (300u32, 420u32);
        let radius = mm_to_pixels(CORNER_RADIUS_MM, 300);
        let mut face = RgbImage::from_pixel(w, h, art);
        for (x, y, p) in face.enumerate_pixels_mut() {
            if x < 20 || y < 20 || x >= w - 20 || y >= h - 20 {
                *p = border;
            }
        }
        // Transparent scan corners arrive flattened to the bleed colour.
        fill_corners(&mut face, radius, BACKGROUND);
        assert_eq!(*face.get_pixel(0, 0), BACKGROUND);

        let mut squared = face.clone();
        square_corners(&mut squared, radius);
        assert!(squared.pixels().all(|p| *p != BACKGROUND));
        assert_eq!(*squared.get_pixel(0, 0), border);
        assert_eq!(*squared.get_pixel(w - 1, h - 1), border);
        assert_eq!(
            squared.get_pixel(radius, radius),
            face.get_pixel(radius, radius)
        );
        assert_eq!(
            squared.get_pixel(w / 2, h / 2),
            face.get_pixel(w / 2, h / 2)
        );

        let out = finish_face(&face, &settings, BACKGROUND);
        let bleed = mm_to_pixels(1.0, 300);
        let magenta_outside_trim = out
            .enumerate_pixels()
            .filter(|(x, y, p)| {
                **p == BACKGROUND
                    && !(*x >= bleed && *y >= bleed && *x < bleed + w && *y < bleed + h)
            })
            .count();
        assert_eq!(magenta_outside_trim, 0);
        assert_eq!(*out.get_pixel(0, 0), border);
        assert_eq!(*out.get_pixel(bleed, bleed), BACKGROUND);

        let edge = finish_face(
            &face,
            &PrintSettings {
                bleed_mode: BleedMode::Edge,
                ..settings
            },
            BACKGROUND,
        );
        assert_eq!(*edge.get_pixel(0, 0), border);
        assert_eq!(*edge.get_pixel(0, bleed), border);
    }

    #[test]
    fn fill_corners_within_matches_fill_corners_on_the_full_image() {
        let mut whole = RgbImage::from_pixel(40, 60, Rgb([255, 255, 255]));
        fill_corners(&mut whole, 8, Rgb([0, 0, 0]));
        let mut inset = RgbImage::from_pixel(50, 70, Rgb([255, 255, 255]));
        fill_corners_within(&mut inset, 5, 5, 40, 60, 8, Rgb([0, 0, 0]));
        for (x, y, p) in whole.enumerate_pixels() {
            assert_eq!(inset.get_pixel(x + 5, y + 5), p);
        }
        assert_eq!(*inset.get_pixel(0, 0), Rgb([255, 255, 255]));
        assert_eq!(*inset.get_pixel(49, 69), Rgb([255, 255, 255]));
    }

    #[test]
    fn provider_bleed_is_cropped_before_our_bleed_is_added() {
        let settings = PrintSettings {
            dpi: 300,
            bleed_mm: 1.0,
            bleed_mode: BleedMode::Mirror,
            card_width_mm: 63.5,
            card_height_mm: 88.9,
            ..PrintSettings::default()
        };
        let provider_bleed = Rgb([220, 30, 30]);
        let card = Rgb([30, 60, 220]);
        let mut scan = RgbImage::from_pixel(816, 1110, provider_bleed);
        for (x, y, p) in scan.enumerate_pixels_mut() {
            if (36..816 - 36).contains(&x) && (36..1110 - 36).contains(&y) {
                *p = card;
            }
        }
        let mut png = Vec::new();
        scan.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let out = rasterize(
            &png,
            &art(3.048, Provider::Mpc),
            &settings,
            None,
            &CancelToken::default(),
            &mut |_, _| {},
        )
        .unwrap();
        let bleed = mm_to_pixels(1.0, 300);
        let (w, h) = (mm_to_pixels(63.5, 300), mm_to_pixels(88.9, 300));
        assert_eq!(out.image.dimensions(), (w + 2 * bleed, h + 2 * bleed));
        let near = |p: &Rgb<u8>, q: Rgb<u8>| (0..3).all(|c| p[c].abs_diff(q[c]) <= 2);
        assert!(out.image.pixels().all(|p| !near(p, provider_bleed)));
        let mid = (h + 2 * bleed) / 2;
        for k in 0..bleed {
            assert!(near(out.image.get_pixel(k, mid), card), "left bleed {k}");
            assert!(
                near(out.image.get_pixel(w + 2 * bleed - 1 - k, mid), card),
                "right bleed {k}"
            );
        }
    }

    #[test]
    fn corners_are_filled_outside_the_radius_only() {
        let mut image = RgbImage::from_pixel(40, 60, Rgb([255, 255, 255]));
        fill_corners(&mut image, 8, Rgb([0, 0, 0]));
        assert_eq!(*image.get_pixel(0, 0), Rgb([0, 0, 0]));
        assert_eq!(*image.get_pixel(39, 59), Rgb([0, 0, 0]));
        assert_eq!(*image.get_pixel(8, 8), Rgb([255, 255, 255]));
        assert_eq!(*image.get_pixel(20, 0), Rgb([255, 255, 255]));
    }

    #[test]
    fn rasterizes_to_physical_size_plus_bleed_without_upscaling() {
        let settings = PrintSettings {
            dpi: 300,
            bleed_mm: 1.0,
            ..PrintSettings::default()
        };
        let mut png = Vec::new();
        RgbImage::from_pixel(372, 520, Rgb([200, 40, 40]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let out = rasterize(
            &png,
            &art(0.0, Provider::Scryfall),
            &settings,
            None,
            &CancelToken::default(),
            &mut |_, _| {},
        )
        .unwrap();
        let bleed = mm_to_pixels(1.0, 300);
        assert_eq!(
            out.image.dimensions(),
            (
                mm_to_pixels(63.0, 300) + 2 * bleed,
                mm_to_pixels(88.0, 300) + 2 * bleed
            )
        );
        assert!(!out.upscaled);
    }
}
