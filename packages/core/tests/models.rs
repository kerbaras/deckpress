mod common;

use deckpress_core::models::{Backs, BleedMode, Paper, PrintSettings, Zone};

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

#[test]
fn companion_zone_uses_core_spelling_and_prints_by_default() {
    assert_eq!(
        serde_json::to_string(&Zone::Companion).unwrap(),
        "\"companion\""
    );
    let zone: Zone = serde_json::from_str("\"companion\"").unwrap();
    assert_eq!(zone, Zone::Companion);
    let mut deck = common::deck(1);
    deck.entries[0].zone = Zone::Companion;
    let settings = PrintSettings::default();
    assert!(!settings.include_sideboard && !settings.include_maybeboard);
    assert_eq!(deck.printable_entries(&settings).len(), 1);
    deck.entries[0].excluded = true;
    assert!(deck.printable_entries(&settings).is_empty());
}
