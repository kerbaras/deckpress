mod common;

use std::sync::Arc;

use deckpress_core::art_policy::{ArtChangeKind, ArtPolicies, ArtPolicy, Border, Frame, Treatment};
use deckpress_core::models::{PrintLanguagePolicy, PrintLanguagePreferences};
use deckpress_core::providers::{normalize_scryfall, Providers};
use deckpress_core::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ORACLE: &str = "4457ed35-7c10-48c8-9776-456485fdf070";

fn cards() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/scryfall-art-policy.json")).unwrap()
}

fn printing<'a>(cards: &'a [Value], set: &str, language: &str) -> &'a Value {
    cards
        .iter()
        .find(|card| card["set"] == set && card["lang"] == language)
        .unwrap()
}

fn record(store: &Store, url: &str, value: &Value) {
    let key = hex::encode(Sha256::digest(format!("{url}null")));
    store.put("cache", &key, value).unwrap();
}

fn search(store: &Store, language: Option<&str>, page: u32, has_more: bool, data: &[Value]) {
    let mut url = url::Url::parse("https://api.scryfall.com/cards/search").unwrap();
    let suffix = language.map_or(String::new(), |lang| format!(" lang:{lang}"));
    url.query_pairs_mut()
        .append_pair("q", &format!("oracleid:{ORACLE} game:paper{suffix}"));
    record(
        store,
        &format!(
            "{url}&unique=prints&include_multilingual=true&order=released&dir=desc&page={page}"
        ),
        &json!({"data": data, "has_more": has_more}),
    );
}

fn entry(raw: &Value) -> deckpress_core::models::DeckEntry {
    let mut entry = common::entry(common::scryfall_art(), 1);
    entry.id = deckpress_core::models::new_id();
    entry.card = normalize_scryfall(raw).unwrap();
    entry
}

fn preferences(providers: &Providers, language: &str, policy: PrintLanguagePolicy) {
    providers
        .save_print_language_preferences(PrintLanguagePreferences {
            languages: vec![language.into()],
            policy,
        })
        .unwrap();
}

#[tokio::test]
async fn previews_original_latest_set_and_style_then_applies_and_undoes_without_touching_pins() {
    let cards = cards();
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers);
    search(&store, None, 1, true, &cards[..4]);
    search(&store, None, 2, false, &cards[4..]);

    let original = entry(printing(&cards, "m10", "en"));
    let mut pinned = entry(printing(&cards, "m11", "en"));
    pinned.selected_art = Some(pinned.front_art().clone());
    let mut input = common::new_deck("Art policy");
    input.entries = vec![original, pinned.clone()];
    let deck = store.create_deck(input).unwrap();
    let mut last_preview = None;
    for (policy, set) in [
        (ArtPolicy::Latest, "slc"),
        (ArtPolicy::MatchSet { set: "m11".into() }, "m11"),
        (
            ArtPolicy::Style {
                frame: Some(Frame::Modern),
                border: Some(Border::Black),
                treatment: Some(Treatment::None),
            },
            "m11",
        ),
        (
            ArtPolicy::Style {
                frame: None,
                border: Some(Border::Borderless),
                treatment: Some(Treatment::FullArt),
            },
            "slc",
        ),
        (ArtPolicy::Original, "lea"),
    ] {
        let preview = service
            .preview_policy(&deck.id, deck.revision, policy)
            .await
            .unwrap();
        assert_eq!(preview.changes[0].after.as_ref().unwrap().set, set);
        assert_eq!(preview.changes[1].kind, ArtChangeKind::Pinned);
        assert_eq!(
            store
                .get::<deckpress_core::models::Deck>("deck", &deck.id)
                .unwrap()
                .unwrap(),
            deck
        );
        if let Some(stale) = last_preview.replace(preview.preview_id) {
            assert!(service.apply(&deck.id, deck.revision, &stale).is_err());
        }
    }

    let applied = service
        .apply(&deck.id, deck.revision, &last_preview.unwrap())
        .unwrap();
    assert_eq!(applied.entries[0].front_art().set, "lea");
    assert_eq!(applied.entries[0].card.faces[0].set, "m10");
    assert_eq!(applied.entries[1], pinned);
    assert_eq!(applied.art_policy, Some(ArtPolicy::Original));
    let restored = service.undo(&deck.id, applied.revision).unwrap();
    assert_eq!(restored.entries, deck.entries);
    assert_eq!(restored.art_policy, deck.art_policy);
    assert!(service.undo(&deck.id, restored.revision).is_err());

    let preview = service
        .preview_policy(&deck.id, restored.revision, ArtPolicy::Latest)
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, restored.revision, &preview.preview_id)
        .unwrap();
    let edited = store
        .update_deck(deckpress_core::models::Deck {
            notes: "Later edits".into(),
            ..applied
        })
        .unwrap();
    assert!(matches!(
        service.undo(&deck.id, edited.revision),
        Err(deckpress_core::AppError::Conflict(_))
    ));
}

#[tokio::test]
async fn same_illustration_localization_skips_placeholder_and_looks_through_search_pages() {
    let cards = cards();
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    let en = printing(&cards, "m11", "en");
    let placeholder = printing(&cards, "m11", "es");
    let es = printing(&cards, "m10", "es");
    record(
        &store,
        &format!(
            "https://api.scryfall.com/cards/{}",
            en["id"].as_str().unwrap()
        ),
        en,
    );
    record(
        &store,
        "https://api.scryfall.com/cards/m11/149/es",
        placeholder,
    );
    search(
        &store,
        Some("es"),
        1,
        true,
        &[placeholder.clone(), printing(&cards, "4ed", "es").clone()],
    );
    search(&store, Some("es"), 2, false, std::slice::from_ref(es));
    let mut input = common::new_deck("Same art");
    input.entries = vec![entry(en)];
    let deck = store.create_deck(input).unwrap();
    let entry = &deck.entries[0];
    preferences(&providers, "es", PrintLanguagePolicy::Strict);

    let preview = service
        .preview_localization(&deck.id, deck.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    let after = preview.changes[0].after.as_ref().unwrap();
    assert_eq!((&*after.set, &*after.language), ("m10", "es"));
    assert_eq!(after.illustration_id, entry.front_art().illustration_id);
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    assert!(applied.entries[0].is_art_pinned());

    search(&store, Some("es"), 2, false, &[]);
    let strict = service
        .preview_localization(&deck.id, applied.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    assert_eq!(strict.changes[0].kind, ArtChangeKind::Unmatched);
    assert!(!strict.can_apply);
    preferences(&providers, "es", PrintLanguagePolicy::FallbackToEnglish);
    let fallback = service
        .preview_localization(&deck.id, applied.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    let after = fallback.changes[0].after.as_ref().unwrap();
    assert_eq!((&*after.set, &*after.language), ("m11", "en"));
    assert_eq!(fallback.changes[0].kind, ArtChangeKind::Fallback);
    let applied_fallback = service
        .apply(&deck.id, applied.revision, &fallback.preview_id)
        .unwrap();
    assert!(applied_fallback.entries[0].front_art().english_fallback);
    let restored = service.undo(&deck.id, applied_fallback.revision).unwrap();
    assert!(!restored.entries[0].front_art().english_fallback);
}

#[tokio::test]
async fn double_faced_localization_requires_both_illustrations() {
    let data: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy-dfc.json")).unwrap();
    let en = &data[0];
    let es = &data[1];
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    record(
        &store,
        &format!(
            "https://api.scryfall.com/cards/{}",
            en["id"].as_str().unwrap()
        ),
        en,
    );
    record(&store, "https://api.scryfall.com/cards/isd/51/es", es);
    preferences(&providers, "es", PrintLanguagePolicy::Strict);
    let mut input = common::new_deck("Both faces");
    input.entries = vec![entry(en)];
    let deck = store.create_deck(input).unwrap();
    let old = &deck.entries[0];
    let preview = service
        .preview_localization(&deck.id, deck.revision, &old.id, &old.front_art().id)
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    let back = applied.entries[0].back_art().unwrap();
    assert_eq!(back.language, "es");
    assert_eq!(back.illustration_id, old.card.faces[1].illustration_id);

    let mut wrong_back = es.clone();
    wrong_back["card_faces"][1]["illustration_id"] = es["card_faces"][0]["illustration_id"].clone();
    record(
        &store,
        "https://api.scryfall.com/cards/isd/51/es",
        &wrong_back,
    );
    let mut search_url = url::Url::parse("https://api.scryfall.com/cards/search").unwrap();
    search_url.query_pairs_mut().append_pair(
        "q",
        &format!("oracleid:{} game:paper lang:es", old.card.oracle_id),
    );
    record(
        &store,
        &format!(
            "{search_url}&unique=prints&include_multilingual=true&order=released&dir=desc&page=1"
        ),
        &json!({"data": [wrong_back], "has_more": false}),
    );
    let mismatch = service
        .preview_localization(&deck.id, applied.revision, &old.id, &old.front_art().id)
        .await
        .unwrap();
    assert_eq!(mismatch.changes[0].kind, ArtChangeKind::Unmatched);
    assert!(!mismatch.can_apply);
}

#[tokio::test]
#[ignore = "calls live Scryfall"]
async fn live_same_illustration_and_deck_policy() {
    let data = cards();
    let mut input = common::new_deck("Live art verification");
    input.entries = vec![entry(printing(&data, "m11", "en"))];
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    let deck = store.create_deck(input).unwrap();
    let entry = &deck.entries[0];
    preferences(&providers, "es", PrintLanguagePolicy::Strict);
    let localized = service
        .preview_localization(&deck.id, deck.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    let after = localized.changes[0]
        .after
        .as_ref()
        .expect("usable same-art Spanish Lightning Bolt");
    assert_eq!(after.language, "es");
    assert_eq!(after.illustration_id, entry.front_art().illustration_id);
    preferences(&providers, "en", PrintLanguagePolicy::Strict);
    let preview = service
        .preview_policy(&deck.id, deck.revision, ArtPolicy::Original)
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    assert_eq!(applied.entries[0].front_art().set, "lea");
}
