mod common;

use deckpress_core::art_quality::{effective_dpi, prefer_high_res, scryfall_quality, ScanQuality};
use deckpress_core::models::{PrintSettings, Provider};
use deckpress_core::providers::normalize_scryfall;
use serde_json::json;

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
