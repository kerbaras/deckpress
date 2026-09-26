//! Card face rasterization: strip provider bleed, upscale (optional), resize
//! to the physical card size at the target DPI, fill the corners and add bleed.

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{Rgb, RgbImage};

use crate::error::{AppError, AppResult};
use crate::layout::mm_to_pixels;
use crate::models::{Art, BleedMode, PrintSettings, Provider};
use crate::upscaler::{CancelToken, Upscaler};

/// Physical size MPC Autofill scans describe (2.5 x 3.5 inches).
const MPC_CARD_MM: (f64, f64) = (63.5, 88.9);

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
    if radius == 0 {
        return;
    }
    let (w, h) = (image.width() as i64, image.height() as i64);
    let r = radius as i64;
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
                    image.put_pixel(x as u32, y as u32, color);
                }
            }
        }
    }
}

pub fn extend(image: &RgbImage, bleed: u32, mode: BleedMode, color: Rgb<u8>) -> RgbImage {
    if bleed == 0 {
        return image.clone();
    }
    let (w, h) = (image.width(), image.height());
    let (ow, oh) = (w + 2 * bleed, h + 2 * bleed);
    let mut out = RgbImage::from_pixel(ow, oh, color);
    image::imageops::replace(&mut out, image, i64::from(bleed), i64::from(bleed));
    if mode == BleedMode::Solid {
        return out;
    }
    let sample = |x: i64, y: i64| -> Rgb<u8> {
        let (sx, sy) = match mode {
            BleedMode::Edge => (x.clamp(0, w as i64 - 1), y.clamp(0, h as i64 - 1)),
            _ => {
                let mirror = |v: i64, len: i64| {
                    if len <= 1 {
                        return 0;
                    }
                    let m = v.rem_euclid(2 * len);
                    if m < len {
                        m
                    } else {
                        2 * len - 1 - m
                    }
                };
                (mirror(x, w as i64), mirror(y, h as i64))
            }
        };
        *image.get_pixel(sx as u32, sy as u32)
    };
    let b = bleed as i64;
    for oy in 0..oh as i64 {
        for ox in 0..ow as i64 {
            let (x, y) = (ox - b, oy - b);
            if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                out.put_pixel(ox as u32, oy as u32, sample(x, y));
            }
        }
    }
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
    let mut face = contain(&face, target_w, target_h, background)?;
    fill_corners(&mut face, mm_to_pixels(3.0, settings.dpi), background);
    let bleed = mm_to_pixels(settings.bleed_mm, settings.dpi);
    Ok(RasterOutput {
        image: extend(&face, bleed, settings.bleed_mode, background),
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

    #[test]
    fn extend_mirror_and_edge_sample_the_face() {
        let mut image = RgbImage::new(4, 4);
        for (x, y, p) in image.enumerate_pixels_mut() {
            *p = Rgb([(x * 60) as u8, (y * 60) as u8, 0]);
        }
        let mirrored = extend(&image, 2, BleedMode::Mirror, Rgb([0, 0, 0]));
        assert_eq!(mirrored.dimensions(), (8, 8));
        assert_eq!(mirrored.get_pixel(1, 2), image.get_pixel(0, 0));
        assert_eq!(mirrored.get_pixel(0, 2), image.get_pixel(1, 0));
        let edge = extend(&image, 2, BleedMode::Edge, Rgb([0, 0, 0]));
        assert_eq!(edge.get_pixel(0, 0), image.get_pixel(0, 0));
        assert_eq!(edge.get_pixel(7, 7), image.get_pixel(3, 3));
        let solid = extend(&image, 2, BleedMode::Solid, Rgb([9, 9, 9]));
        assert_eq!(*solid.get_pixel(0, 0), Rgb([9, 9, 9]));
        assert_eq!(solid.get_pixel(2, 2), image.get_pixel(0, 0));
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
