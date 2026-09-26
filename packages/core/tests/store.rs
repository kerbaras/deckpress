mod common;

use deckpress_core::error::AppError;
use deckpress_core::models::{Deck, PrintSettings, Provider};
use deckpress_core::store::Store;

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
