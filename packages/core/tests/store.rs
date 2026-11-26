mod common;

use deckpress_core::error::AppError;
use deckpress_core::models::{Deck, NewDeck, PrintSettings, PrinterProfileInput, Provider, Zone};
use deckpress_core::store::{Appearance, Store};

#[test]
fn appearance_round_trips_across_sqlite_connections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deckpress.sqlite");
    assert_eq!(Store::open(&path).unwrap().appearance().unwrap(), None);
    for appearance in [Appearance::Dark, Appearance::Light, Appearance::System] {
        Store::open(&path)
            .unwrap()
            .set_appearance(appearance)
            .unwrap();
        assert_eq!(
            Store::open(&path).unwrap().appearance().unwrap(),
            Some(appearance)
        );
    }
}

#[test]
fn printer_profiles_round_trip_across_sqlite_connections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deckpress.sqlite");
    let input = PrinterProfileInput {
        name: " Home inkjet ".into(),
        back_offset_xmm: -0.75,
        back_offset_ymm: 1.25,
        back_rotation_deg: -0.42,
    };
    let profile = Store::open(&path)
        .unwrap()
        .save_printer_profile(None, input)
        .unwrap();
    assert_eq!(profile.input.name, "Home inkjet");
    assert_eq!(profile.input.back_offset_xmm, -0.75);
    assert_eq!(profile.input.back_offset_ymm, 1.25);
    assert_eq!(profile.input.back_rotation_deg, -0.42);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.printer_profiles().unwrap(),
        std::slice::from_ref(&profile)
    );
    let updated = store
        .save_printer_profile(
            Some(profile.id.clone()),
            PrinterProfileInput {
                name: "Rear feed".into(),
                back_rotation_deg: 0.15,
                ..profile.input
            },
        )
        .unwrap();
    assert_eq!(updated.id, profile.id);
    assert_eq!(updated.input.name, "Rear feed");
    assert_eq!(updated.input.back_rotation_deg, 0.15);
    assert!(store
        .save_printer_profile(
            Some(profile.id.clone()),
            PrinterProfileInput {
                back_rotation_deg: 181.0,
                ..updated.input.clone()
            },
        )
        .is_err());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.printer_profiles().unwrap(),
        std::slice::from_ref(&updated)
    );
    store.delete_printer_profile(&profile.id).unwrap();
    assert!(matches!(
        store.save_printer_profile(Some(profile.id), updated.input),
        Err(AppError::NotFound(_))
    ));
    drop(store);
    assert!(Store::open(&path)
        .unwrap()
        .printer_profiles()
        .unwrap()
        .is_empty());
}

#[test]
fn deck_settings_keep_an_optional_profile_id_and_corrections_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deckpress.sqlite");
    let mut settings: PrintSettings =
        serde_json::from_value(serde_json::json!({"backOffsetXmm": 1.25})).unwrap();
    assert!(settings.printer_profile_id.is_none());
    assert_eq!(settings.back_offset_xmm, 1.25);
    settings.printer_profile_id = Some("642f6d09-ae39-469b-980f-4ad95b52f3af".into());
    let mut input = common::new_deck("Profile settings");
    input.print_settings = settings.clone();
    let deck = Store::open(&path).unwrap().create_deck(input).unwrap();
    let saved = Store::open(&path)
        .unwrap()
        .get::<Deck>("deck", &deck.id)
        .unwrap()
        .unwrap();
    assert_eq!(saved.print_settings, settings);
}

#[test]
fn creates_lists_and_updates_decks_with_revisions() {
    let store = Store::in_memory().unwrap();
    let deck = store.create_deck(common::new_deck("  Test  ")).unwrap();
    assert_eq!(deck.name, "Test");
    assert_eq!(deck.revision, 0);
    let decks: Vec<Deck> = store.list("deck").unwrap();
    assert_eq!(decks.len(), 1);
    let updated = store
        .update_deck(Deck {
            notes: "hello".into(),
            ..deck.clone()
        })
        .unwrap();
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.created_at, deck.created_at);
    let stale = store.update_deck(Deck {
        notes: "stale".into(),
        ..deck
    });
    assert!(matches!(stale, Err(AppError::Conflict(_))));
}

#[test]
fn restores_old_and_named_board_backups_and_persists_them_in_sqlite() {
    let backup = include_str!("fixtures/deck-backup-before-board-names.json");
    let legacy: Deck = serde_json::from_str(backup).unwrap();
    assert_eq!(legacy.entries[0].zone, Zone::Maybe);
    assert_eq!(legacy.entries[0].board, None);
    assert_eq!(legacy.entries[0].quantity, 2);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("decks.sqlite");
    let store = Store::open(&path).unwrap();
    let old = store
        .create_deck(serde_json::from_str(backup).unwrap())
        .unwrap();
    assert_eq!(old.entries, legacy.entries);

    let mut input: NewDeck = serde_json::from_str(backup).unwrap();
    let mut considering = input.entries[0].clone();
    considering.id = "considering".into();
    considering.board = Some("Considering".into());
    considering.quantity = 1;
    input.entries.push(considering);
    let saved = store.create_deck(input).unwrap();
    let json = serde_json::to_value(&saved).unwrap();
    assert!(json["entries"][0].get("board").is_none());
    assert_eq!(json["entries"][1]["board"], "Considering");
    let restored = store
        .create_deck(serde_json::from_value(json).unwrap())
        .unwrap();
    assert_ne!(restored.id, saved.id);
    let updated = store
        .update_deck(Deck {
            notes: "Restored".into(),
            ..restored
        })
        .unwrap();
    drop(store);

    let reopened = Store::open(&path).unwrap();
    let loaded: Deck = reopened.get("deck", &updated.id).unwrap().unwrap();
    assert_eq!(loaded.entries, saved.entries);
    let older: Deck = reopened.get("deck", &old.id).unwrap().unwrap();
    assert_eq!(older.entries, legacy.entries);
}

#[test]
fn companion_zone_round_trips_through_json_backups_and_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("decks.sqlite");
    let store = Store::open(&path).unwrap();
    let mut input = common::new_deck("Lurrus");
    let mut companion = common::entry(common::scryfall_art(), 1);
    companion.zone = Zone::Companion;
    input.entries.push(companion);
    let saved = store.create_deck(input).unwrap();
    let json = serde_json::to_value(&saved).unwrap();
    assert_eq!(json["entries"][0]["zone"], "companion");
    assert!(json["entries"][0].get("board").is_none());
    let restored = store
        .create_deck(serde_json::from_value(json).unwrap())
        .unwrap();
    drop(store);

    let reopened = Store::open(&path).unwrap();
    let loaded: Deck = reopened.get("deck", &restored.id).unwrap().unwrap();
    assert_eq!(loaded.entries[0].zone, Zone::Companion);
    assert_eq!(loaded.entries, saved.entries);
}

#[test]
fn rejects_decks_outside_the_ui_limits() {
    let store = Store::in_memory().unwrap();
    assert!(store.create_deck(common::new_deck("   ")).is_err());

    let mut too_many = common::new_deck("Big");
    too_many.entries = (0..1001)
        .map(|_| common::entry(common::scryfall_art(), 1))
        .collect();
    assert!(matches!(
        store.create_deck(too_many),
        Err(AppError::User(_))
    ));

    let mut too_many_cards = common::new_deck("Bulk");
    too_many_cards.entries = (0..7)
        .map(|_| common::entry(common::scryfall_art(), 250))
        .collect();
    assert!(matches!(
        store.create_deck(too_many_cards),
        Err(AppError::User(_))
    ));

    let mut bad_settings = common::new_deck("Settings");
    bad_settings.print_settings = PrintSettings {
        dpi: 5000,
        ..PrintSettings::default()
    };
    assert!(matches!(
        store.create_deck(bad_settings),
        Err(AppError::User(_))
    ));

    let mut ok = common::new_deck("Fine");
    ok.entries = vec![common::entry(common::art(0.0, Provider::Scryfall), 250)];
    assert!(store.create_deck(ok).is_ok());
}

#[test]
fn cache_entries_expire() {
    let store = Store::in_memory().unwrap();
    store
        .put("cache", "k", &serde_json::json!({"a": 1}))
        .unwrap();
    assert_eq!(
        store.cached("k").unwrap(),
        Some(serde_json::json!({"a": 1}))
    );
    store.touch("cache", "k", 0).unwrap();
    assert_eq!(store.cached("k").unwrap(), None);
}
