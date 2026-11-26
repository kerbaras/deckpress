use std::path::{Path, PathBuf};
use std::sync::Arc;

use deckpress_core::error::{AppError, AppResult};
use deckpress_core::models::{PrintSettings, Provider};
use deckpress_core::upscaler::manifest::{
    default_model_id, sha256_file, specs, ModelKind, ModelManager,
};
use deckpress_core::upscaler::preview::{
    compare, compare_at, compare_models, thumbnail, CropPosition, CropResult,
};
use deckpress_core::upscaler::tiling::{feather, positions, reflect, TiledUpscaler};
use deckpress_core::upscaler::{CancelToken, TileModel, Upscaler, UpscalerInfo};
use image::RgbImage;

mod common;

/// The ONNX files ship with the desktop app, not with this crate.
fn bundled_resources() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources")
}

#[test]
fn manifest_has_one_default_and_bundled_files_match_their_digests() {
    let specs = specs();
    assert_eq!(specs.iter().filter(|s| s.tier == "default").count(), 1);
    assert_eq!(
        specs
            .iter()
            .filter(|s| s.kind == ModelKind::StyleEmbedding)
            .count(),
        1
    );
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

#[tokio::test]
#[ignore = "downloads release assets from the network"]
async fn install_downloadable_models_from_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let data_dir = std::env::var_os("DECKPRESS_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| temp.path().to_path_buf());
    let manager = ModelManager::new(bundled_resources(), &data_dir).unwrap();
    for spec in specs().into_iter().filter(|spec| spec.url.is_some()) {
        assert!(manager.path(&spec).is_none(), "use an empty data directory");
        let installed = manager
            .install(&spec.id, |_, _| {})
            .await
            .unwrap_or_else(|err| panic!("{}: {err}", spec.id));
        assert_eq!(sha256_file(&installed).unwrap(), spec.sha256);
        assert_eq!(std::fs::metadata(&installed).unwrap().len(), spec.bytes);
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

#[test]
fn comparison_renders_lanczos_and_each_installed_upscaler() {
    let dir = tempfile::tempdir().unwrap();
    let manager = ModelManager::new(bundled_resources(), dir.path()).unwrap();
    let settings = PrintSettings::default();
    let art = common::art(0.0, Provider::Scryfall);
    let scan = RgbImage::from_fn(256, 360, |x, y| {
        let value = if (x / 4 + y / 5) % 2 == 0 { 225 } else { 35 };
        image::Rgb([value, value, value])
    });
    let png = deckpress_core::raster::encode_png(&scan).unwrap();
    let models = compare(&png, &art, &settings, &manager, &CancelToken::default()).unwrap();
    let ids: Vec<_> = models
        .iter()
        .map(|model| model.model_id.as_deref())
        .collect();
    assert_eq!(
        ids,
        [
            None,
            Some("realesr-general-x4v3"),
            Some("realesr-animevideov3")
        ]
    );
    let mut outputs = Vec::new();
    for model in models {
        let CropResult::Ready { crop } = model.result else {
            panic!("comparison failed for {:?}", model.model_id)
        };
        let decoded = deckpress_core::images::decode(&crop.png).unwrap();
        assert_eq!((crop.width, crop.height), (224, 144));
        assert_eq!(
            (decoded.width(), decoded.height()),
            (crop.width, crop.height)
        );
        assert!(crop.elapsed_ms.is_finite() && crop.elapsed_ms >= 0.0);
        outputs.push(crop.png);
    }
    assert_ne!(outputs[0], outputs[1]);
    assert_ne!(outputs[0], outputs[2]);
}

#[test]
fn comparison_moves_every_model_from_the_rules_area_to_the_selected_region() {
    let dir = tempfile::tempdir().unwrap();
    let manager = ModelManager::new(bundled_resources(), dir.path()).unwrap();
    let settings = PrintSettings::default();
    let art = common::art(0.0, Provider::Scryfall);
    let scan = RgbImage::from_fn(360, 500, |x, y| {
        if x < 120 && y < 120 {
            image::Rgb([230, 10, 20])
        } else {
            image::Rgb([10, 20, 230])
        }
    });
    let source = deckpress_core::raster::encode_png(&scan).unwrap();
    let thumb = deckpress_core::images::decode(&thumbnail(&source, &art, &settings).unwrap())
        .unwrap()
        .to_rgb8();
    assert_eq!(thumb.dimensions(), (130, 180));
    assert!(thumb.get_pixel(13, 18)[0] > 200);
    let cancel = CancelToken::default();
    let default = compare(&source, &art, &settings, &manager, &cancel).unwrap();
    let moved = compare_at(
        &source,
        &art,
        &settings,
        &manager,
        CropPosition { x: 0.1, y: 0.1 },
        &cancel,
    )
    .unwrap();
    assert_eq!(default.len(), 3);
    assert_eq!(moved.len(), default.len());
    for (default, moved) in default.into_iter().zip(moved) {
        assert_eq!(default.model_id, moved.model_id);
        for (result, channel) in [(default.result, 2), (moved.result, 0)] {
            let CropResult::Ready { crop } = result else {
                panic!("comparison failed for {:?}", default.model_id);
            };
            assert_eq!((crop.width, crop.height), (224, 144));
            let image = deckpress_core::images::decode(&crop.png).unwrap().to_rgb8();
            assert!(
                image.get_pixel(112, 72)[channel] > 180,
                "{:?}",
                default.model_id
            );
        }
    }
}

#[test]
fn comparison_cancels_during_inference_without_loading_later_models() {
    struct CancellingModel;
    impl Upscaler for CancellingModel {
        fn info(&self) -> UpscalerInfo {
            Nearest.info()
        }

        fn upscale(
            &self,
            image: &RgbImage,
            cancel: &CancelToken,
            _: &mut dyn FnMut(usize, usize),
        ) -> AppResult<RgbImage> {
            cancel.cancel();
            Ok(image.clone())
        }
    }

    let png = deckpress_core::raster::encode_png(&RgbImage::new(32, 48)).unwrap();
    let cancel = CancelToken::default();
    let result = compare_models(
        &png,
        &common::art(0.0, Provider::Scryfall),
        &PrintSettings::default(),
        ["first".into(), "second".into()],
        |id| {
            assert_eq!(id, "first", "loaded a model after cancellation");
            Ok(Arc::new(CancellingModel))
        },
        &cancel,
    );
    assert!(cancel.is_cancelled());
    assert!(matches!(result, Err(AppError::Cancelled)));
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
    fn run(&mut self, input: &[f32], _cancel: &CancelToken) -> AppResult<Vec<f32>> {
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
