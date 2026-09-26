use std::path::{Path, PathBuf};

use deckpress_core::error::{AppError, AppResult};
use deckpress_core::upscaler::manifest::{default_model_id, sha256_file, specs, ModelManager};
use deckpress_core::upscaler::tiling::{feather, positions, reflect, TiledUpscaler};
use deckpress_core::upscaler::{CancelToken, TileModel, Upscaler, UpscalerInfo};
use image::RgbImage;

/// The ONNX files ship with the desktop app, not with this crate.
fn bundled_resources() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources")
}

#[test]
fn manifest_has_one_default_and_bundled_files_match_their_digests() {
    let specs = specs();
    assert_eq!(specs.iter().filter(|s| s.tier == "default").count(), 1);
    for spec in specs.iter().filter(|s| s.bundled) {
        let path = bundled_resources().join("models").join(&spec.file);
        assert_eq!(sha256_file(&path).unwrap(), spec.sha256, "{}", spec.id);
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            spec.bytes,
            "{}",
            spec.id
        );
    }
    for spec in specs.iter().filter(|s| !s.bundled) {
        assert!(spec.url.is_some(), "{} needs a download URL", spec.id);
    }
}

#[test]
fn bundled_model_runs_on_cpu_and_produces_a_4x_tile() {
    let dir = tempfile::tempdir().unwrap();
    let manager = ModelManager::new(bundled_resources(), dir.path()).unwrap();
    let upscaler = manager.upscaler(&default_model_id()).unwrap();
    let info = upscaler.info();
    assert_eq!(info.scale, 4);
    assert_eq!(info.tile, 256);
    let mut image = RgbImage::new(300, 70);
    for (x, y, p) in image.enumerate_pixels_mut() {
        let v = if (x / 10 + y / 10) % 2 == 0 { 235 } else { 20 };
        *p = image::Rgb([v, v, v]);
    }
    let out = upscaler
        .upscale(&image, &CancelToken::default(), &mut |_, _| {})
        .unwrap();
    assert_eq!((out.width(), out.height()), (1200, 280));
    let center = out.get_pixel(20, 20)[0];
    let dark = out.get_pixel(60, 20)[0];
    assert!(
        center > 180 && dark < 80,
        "checkerboard should survive: {center} {dark}"
    );
}

/// Nearest-neighbour 2x "model" with a batch of 2, used to validate tiling.
struct Nearest;

impl TileModel for Nearest {
    fn tile(&self) -> u32 {
        16
    }
    fn scale(&self) -> u32 {
        2
    }
    fn batch(&self) -> usize {
        2
    }
    fn info(&self) -> UpscalerInfo {
        UpscalerInfo {
            model_id: "nearest".into(),
            model_name: "Nearest".into(),
            scale: 2,
            tile: 16,
            execution_provider: "test".into(),
        }
    }
    fn run(&mut self, input: &[f32]) -> AppResult<Vec<f32>> {
        let (t, s) = (16usize, 2usize);
        let mut out = vec![0f32; input.len() * s * s];
        for n in 0..self.batch() {
            for c in 0..3 {
                for y in 0..t * s {
                    for x in 0..t * s {
                        out[n * 3 * t * t * s * s + c * t * t * s * s + y * t * s + x] =
                            input[n * 3 * t * t + c * t * t + (y / s) * t + x / s];
                    }
                }
            }
        }
        Ok(out)
    }
}

#[test]
fn reflect_padding_mirrors_without_edge_repeat() {
    assert_eq!(reflect(5, 5), 3);
    assert_eq!(reflect(4, 5), 4);
    assert_eq!(reflect(8, 5), 0);
    assert_eq!(reflect(3, 1), 0);
}

#[test]
fn feather_is_symmetric_and_full_in_the_middle() {
    let ramp = feather(8, 2);
    assert!((ramp[0] - 0.25).abs() < 1e-6);
    assert!((ramp[1] - 0.75).abs() < 1e-6);
    assert_eq!(ramp[3], 1.0);
    assert_eq!(ramp[0], ramp[7]);
}

#[test]
fn positions_cover_the_whole_axis() {
    assert_eq!(positions(10, 16, 12), vec![0]);
    assert_eq!(positions(40, 16, 12), vec![0, 12, 24]);
    assert_eq!(positions(41, 16, 12), vec![0, 12, 24, 25]);
}

#[test]
fn tiled_nearest_reproduces_exact_upscale_on_odd_sizes() {
    let mut image = RgbImage::new(37, 29);
    for (x, y, p) in image.enumerate_pixels_mut() {
        *p = image::Rgb([
            (x * 7 % 256) as u8,
            (y * 5 % 256) as u8,
            ((x + y) % 256) as u8,
        ]);
    }
    let upscaler = TiledUpscaler::new(Nearest, 4);
    let mut calls = Vec::new();
    let out = upscaler
        .upscale(&image, &CancelToken::default(), &mut |d, t| {
            calls.push((d, t))
        })
        .unwrap();
    assert_eq!((out.width(), out.height()), (74, 58));
    for (x, y, p) in out.enumerate_pixels() {
        assert_eq!(p, image.get_pixel(x / 2, y / 2), "pixel {x},{y}");
    }
    assert_eq!(calls.first().unwrap().0, 0);
    assert_eq!(calls.last().unwrap().0, calls.last().unwrap().1);
}

#[test]
fn cancellation_stops_before_inference() {
    let token = CancelToken::default();
    token.cancel();
    let upscaler = TiledUpscaler::new(Nearest, 4);
    let result = upscaler.upscale(&RgbImage::new(8, 8), &token, &mut |_, _| {});
    assert!(matches!(result, Err(AppError::Cancelled)));
}
