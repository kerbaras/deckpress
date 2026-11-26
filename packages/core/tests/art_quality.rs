mod common;

use deckpress_core::art_quality::{
    assess_source, effective_dpi, picker_dpi, prefer_high_res, scryfall_quality, ScanQuality,
};
use deckpress_core::images::Images;
use deckpress_core::models::{PrintSettings, Provider};
use deckpress_core::providers::normalize_scryfall;
use deckpress_core::raster::{encode_png, rasterize};
use deckpress_core::store::Store;
use deckpress_core::upscaler::CancelToken;
use image::{Rgb, RgbImage};
use serde_json::json;
use std::sync::Arc;

#[test]
fn ranks_scryfall_status_and_uses_the_highres_flag_when_status_is_absent() {
    let missing = scryfall_quality(Some("missing"), Some(false));
    let placeholder = scryfall_quality(Some("placeholder"), Some(true));
    let low = scryfall_quality(Some("lowres"), Some(false));
    let high = scryfall_quality(Some("highres_scan"), Some(true));
    assert_eq!(missing, Some(ScanQuality::Missing));
    assert_eq!(placeholder, Some(ScanQuality::Placeholder));
    assert!(missing < placeholder && placeholder < low && low < high);
    assert_eq!(scryfall_quality(None, Some(false)), low);
    assert_eq!(scryfall_quality(None, Some(true)), high);
    assert_eq!(scryfall_quality(None, None), None);
}

#[test]
fn upgrades_only_to_a_better_print_of_the_same_illustration_and_language() {
    let artwork = uuid::Uuid::new_v4();
    let base = common::scryfall_art();
    let selected = deckpress_core::models::Art {
        illustration_id: Some(artwork),
        language: "es".into(),
        scan_quality: Some(ScanQuality::Lowres),
        ..base
    };
    let unrelated = deckpress_core::models::Art {
        illustration_id: Some(uuid::Uuid::new_v4()),
        scan_quality: Some(ScanQuality::HighresScan),
        ..selected.clone()
    };
    let english = deckpress_core::models::Art {
        illustration_id: Some(artwork),
        language: "en".into(),
        ..unrelated.clone()
    };
    let spanish = deckpress_core::models::Art {
        language: "es".into(),
        ..english.clone()
    };
    // The quality preference cannot turn a localized selection into a fallback.
    assert!(std::ptr::eq(
        prefer_high_res(&selected, [&unrelated, &english, &selected.clone()]),
        &selected
    ));
    assert!(std::ptr::eq(
        prefer_high_res(&selected, [&unrelated, &english, &spanish]),
        &spanish
    ));
    let english_fallback = deckpress_core::models::Art {
        language: "en".into(),
        ..selected
    };
    // Once the resolver has chosen English, a localized scan cannot override it.
    assert!(std::ptr::eq(
        prefer_high_res(&english_fallback, [&spanish]),
        &english_fallback
    ));
}

#[test]
fn prefers_highres_when_illustration_and_language_are_equal() {
    let illustration = uuid::Uuid::new_v4();
    let low = deckpress_core::models::Art {
        illustration_id: Some(illustration),
        scan_quality: Some(ScanQuality::Lowres),
        ..common::scryfall_art()
    };
    let high = deckpress_core::models::Art {
        id: "scryfall:high:0".into(),
        scan_quality: Some(ScanQuality::HighresScan),
        ..low.clone()
    };
    assert_eq!(prefer_high_res(&low, [&low, &high]).id, high.id);
    assert_eq!(prefer_high_res(&low, [&high, &low]).id, high.id);
    assert_eq!(prefer_high_res(&high, [&low]).id, high.id);
}

#[test]
fn stores_face_specific_illustrations_and_scan_quality() {
    let front = uuid::Uuid::new_v4();
    let back = uuid::Uuid::new_v4();
    let card = normalize_scryfall(&json!({
        "id": "test", "name": "Front // Back", "set": "tst", "set_name": "Test",
        "collector_number": "1", "image_status": "lowres", "highres_image": false,
        "card_faces": [
            {"name": "Front", "illustration_id": front, "image_uris": {"png": "front"}},
            {"name": "Back", "illustration_id": back, "image_uris": {"png": "back"}}
        ]
    }))
    .unwrap();
    assert_eq!(card.faces[0].illustration_id, Some(front));
    assert_eq!(card.faces[1].illustration_id, Some(back));
    assert_eq!(card.faces[1].scan_quality, Some(ScanQuality::Lowres));
}

#[test]
fn effective_dpi_accounts_for_trim_and_removes_provider_bleed() {
    let art = common::art(3.048, Provider::Mpc);
    let mut settings = PrintSettings {
        card_width_mm: 63.5,
        card_height_mm: 88.9,
        ..PrintSettings::default()
    };
    assert!((effective_dpi(822, 1122, &art, &settings) - 300.0).abs() < 0.2);
    settings.card_width_mm *= 2.0;
    settings.card_height_mm *= 2.0;
    assert!((effective_dpi(822, 1122, &art, &settings) - 150.0).abs() < 0.1);
}

#[test]
fn source_upscale_threshold_uses_trimmed_dimensions_and_both_axes() {
    let mpc = common::art(3.048, Provider::Mpc);
    let mut settings = PrintSettings {
        card_width_mm: 63.5,
        card_height_mm: 88.9,
        dpi: 300,
        ..PrintSettings::default()
    };
    assert!(!assess_source(822, 1122, &mpc, &settings).below_upscale_threshold);
    assert!(assess_source(740, 1000, &mpc, &settings).below_upscale_threshold);
    settings.dpi = 800;
    assert!(assess_source(822, 1122, &mpc, &settings).below_upscale_threshold);

    let scan = common::scryfall_art();
    settings.card_width_mm = 100.0;
    settings.card_height_mm = 100.0;
    settings.dpi = 254;
    assert!(assess_source(949, 949, &scan, &settings).below_upscale_threshold);
    assert!(!assess_source(940, 950, &scan, &settings).below_upscale_threshold);
    assert!(!assess_source(950, 940, &scan, &settings).below_upscale_threshold);
}

#[test]
fn letterboxed_scan_dpi_and_ai_eligibility_match_the_raster_fitted_area() {
    let art = common::scryfall_art();
    let mut settings = PrintSettings {
        card_width_mm: 80.0,
        card_height_mm: 80.0,
        bleed_mm: 0.0,
        dpi: 340,
        upscale: true,
        ..PrintSettings::default()
    };
    let scan = RgbImage::from_pixel(744, 1040, Rgb([200, 128, 63]));
    let reading = assess_source(744, 1040, &art, &settings);
    assert!(
        (reading.effective_dpi - 330.16).abs() < 0.3,
        "{}",
        reading.effective_dpi
    );
    assert!(!reading.below_upscale_threshold);
    let raster = rasterize(
        &encode_png(&scan).unwrap(),
        &art,
        &settings,
        None,
        &CancelToken::default(),
        &mut |_, _| {},
    )
    .unwrap();
    assert!(!raster.upscaled);
    let (w, h) = raster.image.dimensions();
    let active_width = (0..w)
        .filter(|x| raster.image.get_pixel(*x, h / 2) == &Rgb([200, 128, 63]))
        .count();
    let printed_dpi = 744.0 * 25.4 / (80.0 * active_width as f64 / f64::from(w));
    assert!((reading.effective_dpi - printed_dpi).abs() < 0.3);
    assert!(active_width < w as usize);
    assert!((effective_dpi(1040, 1040, &art, &settings) - 330.2).abs() < 0.1);
    settings.dpi = 400;
    assert!(assess_source(744, 1040, &art, &settings).below_upscale_threshold);
}

#[tokio::test]
async fn picker_uses_cached_original_dimensions_or_a_labeled_format_estimate() {
    let dir = tempfile::tempdir().unwrap();
    let images = Images::new(dir.path(), Arc::new(Store::in_memory().unwrap())).unwrap();
    let mut cached = common::scryfall_art();
    cached.image_url = "https://cards.scryfall.io/png/front/real.png".into();
    let mut uncached = cached.clone();
    uncached.image_url = "https://cards.scryfall.io/large/front/another.jpg".into();
    let path = images.local_path(&cached.image_url).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbImage::new(744, 1040)
        .write_to(
            &mut std::fs::File::create(path).unwrap(),
            image::ImageFormat::Png,
        )
        .unwrap();
    let settings = PrintSettings {
        card_width_mm: 80.0,
        card_height_mm: 80.0,
        ..PrintSettings::default()
    };
    let mut unknown = cached.clone();
    unknown.image_url = "https://cards.scryfall.io/art_crop/front/unknown.jpg".into();
    let readings = picker_dpi(&images, vec![cached, uncached, unknown], &settings).await;
    let measured = readings[0].as_ref().unwrap();
    let estimate = readings[1].as_ref().unwrap();
    assert!(!measured.estimated && (measured.effective_dpi - 330.16).abs() < 0.3);
    assert!(estimate.estimated && (estimate.effective_dpi - 297.18).abs() < 0.3);
    assert!(readings[2].is_none());
}
