//! Card face rasterization: strip provider bleed, upscale (optional), resize
//! to the physical card size at the target DPI, add bleed, then fill the
//! corners of the trim area. Mirror and edge bleed sample the face with its
//! corner zones squared off from the border, before the corners are painted,
//! so the bleed carries border pixels rather than the scan's rounded corners
//! or the corner fill colour.

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage};

use crate::error::{AppError, AppResult};
use crate::layout::{face_pixels, mm_to_pixels};
use crate::models::{Art, BleedMode, PrintSettings, Provider};
use crate::upscaler::{CancelToken, Upscaler};

/// Physical size MPC Autofill scans describe (2.5 x 3.5 inches).
const MPC_CARD_MM: (f64, f64) = (63.5, 88.9);
pub(crate) const UPLOAD_CARD_MM: (f64, f64) = (63.0, 88.0);
const MPC_BLEED_MM: f64 = 3.048;
const EIGHTH_INCH_MM: f64 = 3.175;
const BLEED_ASPECT_TOLERANCE: f64 = 0.0015;
const TRIM_ASPECT_TOLERANCE: f64 = 0.01;

/// Bump when `rasterize` output changes for identical inputs so cached
/// previews and PDF rasters are regenerated.
pub const PIPELINE_VERSION: u32 = 6;

/// Corner radius of a real card.
pub const CORNER_RADIUS_MM: f64 = 3.0;

/// Decodes with size limits and applies the EXIF orientation, so camera
/// photos come out upright.
pub fn decode(bytes: &[u8]) -> AppResult<DynamicImage> {
    let mut reader = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(600 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

pub fn parse_hex_color(input: &str) -> Rgb<u8> {
    let hex = input.trim().trim_start_matches('#');
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    if hex.len() == 6 {
        Rgb([channel(0), channel(2), channel(4)])
    } else {
        Rgb([17, 17, 17])
    }
}

pub(crate) fn to_rgb(image: image::DynamicImage, background: Rgb<u8>) -> RgbImage {
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

/// Match common full-bleed formats without treating any wide image as bleed.
pub(crate) fn detect_upload_bleed(width: u32, height: u32) -> f64 {
    let ratio = f64::from(width) / f64::from(height);
    let formats = [
        (UPLOAD_CARD_MM, MPC_BLEED_MM),
        (MPC_CARD_MM, MPC_BLEED_MM),
        (UPLOAD_CARD_MM, EIGHTH_INCH_MM),
    ];
    formats
        .into_iter()
        .map(|((w, h), bleed)| {
            let expected = (w + 2.0 * bleed) / (h + 2.0 * bleed);
            (((ratio / expected) - 1.0).abs(), bleed)
        })
        .filter(|(error, _)| *error <= BLEED_ASPECT_TOLERANCE)
        .min_by(|(a, _), (b, _)| a.total_cmp(b))
        .map_or(0.0, |(_, bleed)| bleed)
}

/// Removes the bleed baked into the source before fitting it to the print trim.
pub fn strip_bleed(image: &RgbImage, art: &Art, settings: &PrintSettings) -> RgbImage {
    let (x, y, w, h) = trim_bounds(image.width(), image.height(), art, settings);
    if x == 0 && y == 0 {
        return image.clone();
    }
    image::imageops::crop_imm(image, x, y, w, h).to_image()
}

pub(crate) fn trim_bounds(
    w: u32,
    h: u32,
    art: &Art,
    settings: &PrintSettings,
) -> (u32, u32, u32, u32) {
    if art.bleed_mm <= 0.0 {
        return (0, 0, w, h);
    }
    let (native_w, native_h) = match art.provider {
        Provider::Mpc => MPC_CARD_MM,
        Provider::Upload => UPLOAD_CARD_MM,
        _ => (settings.card_width_mm, settings.card_height_mm),
    };
    let x = (f64::from(w) * art.bleed_mm / (native_w + art.bleed_mm * 2.0)).round() as u32;
    let y = (f64::from(h) * art.bleed_mm / (native_h + art.bleed_mm * 2.0)).round() as u32;
    if 2 * x >= w || 2 * y >= h {
        return (0, 0, w, h);
    }
    (x, y, w - 2 * x, h - 2 * y)
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
    let fitted = contain_dimensions(image.dimensions(), (width, height));
    place_face(image, (width, height), fitted, background)
}

fn contain_dimensions((w, h): (u32, u32), (width, height): (u32, u32)) -> (u32, u32) {
    let scale = (f64::from(width) / f64::from(w)).min(f64::from(height) / f64::from(h));
    let round = |input, max| ((f64::from(input) * scale).round() as u32).clamp(1, max);
    (round(w, width), round(h, height))
}

fn place_face(
    image: &RgbImage,
    (width, height): (u32, u32),
    (w, h): (u32, u32),
    background: Rgb<u8>,
) -> AppResult<RgbImage> {
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
pub fn reflect(v: i64, len: i64) -> i64 {
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
    let bleed = face_pixels(
        settings.card_width_mm,
        settings.card_height_mm,
        settings.bleed_mm,
        settings.dpi,
    )
    .bleed;
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

pub(crate) fn trim_pixels(settings: &PrintSettings) -> (u32, u32) {
    let pixels = face_pixels(
        settings.card_width_mm,
        settings.card_height_mm,
        settings.bleed_mm,
        settings.dpi,
    );
    (pixels.trim_width, pixels.trim_height)
}

pub(crate) fn fitted_art_dimensions(
    source: (u32, u32),
    target: (u32, u32),
    art: &Art,
    settings: &PrintSettings,
) -> (u32, u32) {
    let trim_aspect = settings.card_width_mm / settings.card_height_mm;
    let expected_width = f64::from(source.1) * trim_aspect;
    // Rounding the two crop edges can cost a source pixel per axis.
    let crop_rounding = if art.bleed_mm > 0.0 {
        1.0 + trim_aspect
    } else {
        0.0
    };
    if (f64::from(source.0) - expected_width).abs()
        <= expected_width * TRIM_ASPECT_TOLERANCE + crop_rounding
    {
        target
    } else {
        contain_dimensions(source, target)
    }
}

pub(crate) fn below_upscale_threshold(
    width: u32,
    height: u32,
    target_w: u32,
    target_h: u32,
) -> bool {
    f64::from(width) < f64::from(target_w) * 0.95 && f64::from(height) < f64::from(target_h) * 0.95
}

/// Full face pipeline. `upscaler` is only used when `settings.upscale` is set
/// and the source is smaller than 95% of its fitted area in both dimensions.
pub fn rasterize(
    source: &[u8],
    art: &Art,
    settings: &PrintSettings,
    upscaler: Option<&dyn Upscaler>,
    cancel: &CancelToken,
    progress: &mut dyn FnMut(usize, usize),
) -> AppResult<RasterOutput> {
    let background = parse_hex_color(&settings.bleed_color);
    let decoded = to_rgb(decode(source)?, background);
    let mut face = strip_bleed(&decoded, art, settings);
    let target = trim_pixels(settings);
    if target.0 == 0 || target.1 == 0 {
        return Err(AppError::user("Card dimensions are too small to print"));
    }
    let fitted = fitted_art_dimensions(face.dimensions(), target, art, settings);
    let mut upscaled = false;
    if settings.upscale && below_upscale_threshold(face.width(), face.height(), fitted.0, fitted.1)
    {
        let upscaler = upscaler.ok_or_else(|| AppError::user("Upscaling model is not loaded"))?;
        face = upscaler.upscale(&face, cancel, progress)?;
        upscaled = true;
    }
    cancel.check()?;
    let face = place_face(&face, target, fitted, background)?;
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

/// [`encode_png`] plus a `pHYs` chunk so layout and print tools place the
/// image at its physical size instead of assuming 72 or 96 DPI.
pub fn encode_png_at_dpi(image: &RgbImage, dpi: u32) -> AppResult<Vec<u8>> {
    let bytes = encode_png(image)?;
    // Signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 CRC).
    const IHDR_END: usize = 33;
    if bytes.get(12..16) != Some(b"IHDR".as_slice()) {
        return Err(AppError::internal("PNG encoder wrote no IHDR chunk"));
    }
    let pixels_per_metre = (f64::from(dpi) / 0.0254).round() as u32;
    let mut body = Vec::with_capacity(13);
    body.extend_from_slice(b"pHYs");
    body.extend_from_slice(&pixels_per_metre.to_be_bytes());
    body.extend_from_slice(&pixels_per_metre.to_be_bytes());
    body.push(1);
    let mut out = Vec::with_capacity(bytes.len() + 21);
    out.extend_from_slice(&bytes[..IHDR_END]);
    out.extend_from_slice(&9u32.to_be_bytes());
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32fast::hash(&body).to_be_bytes());
    out.extend_from_slice(&bytes[IHDR_END..]);
    Ok(out)
}
