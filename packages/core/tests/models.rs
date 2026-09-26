use deckpress_core::models::{Backs, BleedMode, Paper, PrintSettings};

#[test]
fn print_settings_apply_core_defaults() {
    let settings: PrintSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(settings.dpi, 800);
    assert_eq!(settings.paper, Paper::A4);
    assert_eq!(settings.bleed_color, "#111111");
    assert_eq!(settings.bleed_mode, BleedMode::Mirror);
    assert!(settings.calibration_page);
    let stored: PrintSettings = serde_json::from_str(r#"{"bleedMode":"solid"}"#).unwrap();
    assert_eq!(stored.bleed_mode, BleedMode::Solid);
}

#[test]
fn enums_round_trip_with_core_spelling() {
    let json = serde_json::to_string(&Backs::LongEdge).unwrap();
    assert_eq!(json, "\"long-edge\"");
    let backs: Backs = serde_json::from_str("\"short-edge\"").unwrap();
    assert_eq!(backs, Backs::ShortEdge);
}
