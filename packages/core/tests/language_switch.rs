mod common;

use std::sync::Arc;

use deckpress_core::{
    art_policy::{ArtPolicies, ArtPolicy},
    language_switch::LanguageTier,
    models::{new_id, DeckEntry, PrintLanguagePolicy, PrintLanguagePreferences, Zone},
    providers::{normalize_scryfall, Providers},
    store::Store,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

fn record(store: &Store, url: &str, body: &Value, result: &Value) {
    let key = hex::encode(Sha256::digest(format!("{url}{body}")));
    store.put("cache", &key, result).unwrap();
}

fn collection(store: &Store, prints: &[Value]) {
    let mut ids: Vec<_> = prints
        .iter()
        .map(|raw| raw["id"].as_str().unwrap())
        .collect();
    ids.sort_unstable();
    let identifiers: Vec<_> = ids.into_iter().map(|id| json!({ "id": id })).collect();
    record(
        store,
        "https://api.scryfall.com/cards/collection",
        &json!({ "identifiers": identifiers }),
        &json!({ "data": prints }),
    );
}

fn search(store: &Store, sources: &[Value], language: &str, pages: &[&[Value]]) {
    let mut oracles: Vec<_> = sources
        .iter()
        .map(|raw| raw["oracle_id"].as_str().unwrap())
        .collect();
    oracles.sort_unstable();
    oracles.dedup();
    let terms = oracles
        .iter()
        .map(|id| format!("oracleid:{id}"))
        .collect::<Vec<_>>()
        .join(" or ");
    for (index, prints) in pages.iter().enumerate() {
        let mut url = Url::parse("https://api.scryfall.com/cards/search").unwrap();
        url.query_pairs_mut()
            .append_pair("q", &format!("({terms}) lang:{language} game:paper"))
            .append_pair("unique", "prints")
            .append_pair("include_multilingual", "true")
            .append_pair("order", "released")
            .append_pair("dir", "desc")
            .append_pair("page", &(index + 1).to_string());
        record(
            store,
            url.as_str(),
            &Value::Null,
            &json!({ "data": prints, "has_more": index + 1 < pages.len() }),
        );
    }
}

fn sets(store: &Store) {
    let entry = |code: &str, set_type: &str, parent: Option<&str>| {
        json!({
            "code": code, "name": code, "set_type": set_type, "parent_set_code": parent,
            "digital": false, "released_at": "2026-01-01", "icon_svg_uri": "", "card_count": 100
        })
    };
    record(
        store,
        "https://api.scryfall.com/sets",
        &Value::Null,
        &json!({ "data": [
        entry("fdn", "core", None), entry("fdc", "commander", Some("fdn")),
        entry("tfdc", "token", Some("fdc")), entry("tfdn", "token", Some("fdn"))
    ] }),
    );
}

fn entry(raw: &Value) -> DeckEntry {
    let mut entry = common::entry(common::scryfall_art(), 1);
    entry.id = new_id();
    entry.card = normalize_scryfall(raw).unwrap();
    entry
}

fn variant(raw: &Value, set: &str, number: &str, language: &str) -> Value {
    let mut copy = raw.clone();
    copy["id"] = json!(new_id());
    copy["set"] = json!(set);
    copy["collector_number"] = json!(number);
    copy["lang"] = json!(language);
    copy
}

#[tokio::test]
async fn ranks_batched_prints_restores_both_faces_and_keeps_pins_through_the_round_trip() {
    let bolts: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy.json")).unwrap();
    let delvers: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy-dfc.json")).unwrap();
    let bolt = &bolts[1];
    let mut family = variant(bolt, "fdc", "80", "en");
    family["oracle_id"] = json!(new_id());
    let mut same_art = variant(bolt, "m10", "146", "en");
    same_art["oracle_id"] = json!(new_id());
    let mut closest = variant(bolt, "lea", "161", "en");
    closest["oracle_id"] = json!(new_id());
    let mut none = variant(bolt, "tfdc", "1", "en");
    none["oracle_id"] = json!(new_id());
    let sources = vec![delvers[0].clone(), family, same_art, closest, none];
    let mut family_es = variant(&sources[1], "fdn", "200", "es");
    family_es["illustration_id"] = json!(new_id());
    let outside_es = variant(&sources[1], "m11", "149", "es");
    let same_art_es = variant(&sources[2], "m11", "149", "es");
    let mut closest_es = variant(&sources[3], "m11", "149", "es");
    closest_es["illustration_id"] = json!(new_id());
    let mut far_es = variant(&closest_es, "m10", "146", "es");
    far_es["frame"] = json!("1993");
    let mut incomplete = variant(&delvers[1], "m11", "12", "es");
    incomplete["card_faces"][1]["image_uris"] = Value::Null;
    let page1 = [outside_es, far_es, incomplete];
    let page2 = [
        delvers[1].clone(),
        family_es.clone(),
        same_art_es,
        closest_es.clone(),
    ];
    let store = Arc::new(Store::in_memory().unwrap());
    sets(&store);
    collection(&store, &sources);
    search(&store, &sources, "es", &[&page1, &page2]);
    search(&store, &sources, "en", &[&sources]);
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    let mut input = common::new_deck("Language ladder");
    input.entries = sources.iter().map(entry).collect();
    input.entries[4].zone = Zone::Tokens;
    let mut pinned = entry(bolt);
    let pinned_print = variant(bolt, "m10", "146", "es");
    pinned.selected_art = Some(normalize_scryfall(&pinned_print).unwrap().faces.remove(0));
    input.entries.push(pinned.clone());
    let deck = store.create_deck(input).unwrap();
    let preview = service
        .preview_language(&deck.id, 0, "es".into())
        .await
        .unwrap();
    assert_eq!(
        preview
            .changes
            .iter()
            .map(|row| row.tier.unwrap())
            .collect::<Vec<_>>(),
        [
            LanguageTier::SamePrinting,
            LanguageTier::SameSet,
            LanguageTier::SameArt,
            LanguageTier::Closest,
            LanguageTier::KeptEnglish,
            LanguageTier::Pinned
        ]
    );
    assert_eq!(preview.changes[1].after.as_ref().unwrap().set, "fdn");
    assert_eq!(preview.changes[3].after.as_ref().unwrap().set, "m11");
    assert_eq!(
        preview.changes[0].after_back.as_ref().unwrap().language,
        "es"
    );
    assert_eq!(store.deck(&deck.id).unwrap(), deck);
    let changed = service.apply(&deck.id, 0, &preview.preview_id).unwrap();
    assert_eq!(changed.print_language.as_deref(), Some("es"));
    assert_eq!(changed.entries[0].back_art().unwrap().language, "es");
    assert!(changed.entries[4].front_art().english_fallback);
    assert_eq!(changed.entries[5], pinned);
    let english = service
        .preview_language(&deck.id, 1, "en".into())
        .await
        .unwrap();
    assert_eq!(english.changes[5].tier, Some(LanguageTier::Pinned));
    let restored = service.apply(&deck.id, 1, &english.preview_id).unwrap();
    assert_eq!(restored.entries[5], pinned);
    assert_eq!(restored.entries[5].front_art().language, "es");
    for (before, after) in deck.entries.iter().zip(&restored.entries) {
        assert_eq!(before.front_art(), after.front_art());
        assert_eq!(
            before.back_art().map(|art| art.image_url),
            after.back_art().map(|art| art.image_url)
        );
    }
    let undo = service.undo(&deck.id, 2).unwrap();
    assert_eq!(undo.entries, changed.entries);
    assert_eq!(undo.print_language, changed.print_language);
    providers
        .save_print_language_preferences(PrintLanguagePreferences {
            languages: vec!["en".into()],
            policy: PrintLanguagePolicy::Strict,
        })
        .unwrap();
    let strict = service
        .preview_language(&deck.id, 3, "es".into())
        .await
        .unwrap();
    assert_eq!(strict.changes[4].tier, Some(LanguageTier::KeptCurrent));
    assert!(!strict.changes[4].after.as_ref().unwrap().english_fallback);
}

#[tokio::test]
async fn exact_set_limits_candidates_and_a_preview_override_applies_only_to_its_language() {
    let cards: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy.json")).unwrap();
    let source = variant(&cards[1], "fdc", "80", "en");
    let spanish = variant(&source, "fdn", "200", "es");
    let store = Arc::new(Store::in_memory().unwrap());
    sets(&store);
    collection(&store, std::slice::from_ref(&source));
    search(
        &store,
        std::slice::from_ref(&source),
        "es",
        &[std::slice::from_ref(&spanish)],
    );
    search(
        &store,
        std::slice::from_ref(&source),
        "en",
        &[std::slice::from_ref(&source)],
    );
    collection(&store, &[source.clone(), spanish.clone()]);
    record(
        &store,
        &format!(
            "https://api.scryfall.com/cards/{}",
            spanish["id"].as_str().unwrap()
        ),
        &Value::Null,
        &spanish,
    );
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    let mut input = common::new_deck("Exact set");
    input.art_policy = Some(ArtPolicy::MatchSet {
        set: "fdc".into(),
        family: false,
    });
    input.entries = vec![entry(&source)];
    let deck = store.create_deck(input).unwrap();
    let preview = service
        .preview_language(&deck.id, 0, "es".into())
        .await
        .unwrap();
    assert_eq!(preview.changes[0].tier, Some(LanguageTier::KeptEnglish));
    let art = normalize_scryfall(&spanish).unwrap().faces.remove(0);
    let override_row = service
        .override_language_print(
            &deck.id,
            0,
            &preview.preview_id,
            &deck.entries[0].id,
            &art.id,
        )
        .await
        .unwrap();
    assert_eq!(override_row.tier, Some(LanguageTier::Override));
    assert_eq!(store.deck(&deck.id).unwrap(), deck);
    let applied = service.apply(&deck.id, 0, &preview.preview_id).unwrap();
    assert!(!applied.entries[0].is_art_pinned());
    assert_eq!(applied.entries[0].front_art(), &art);
    assert_eq!(
        applied.entries[0].language_anchor.as_deref(),
        Some(deck.entries[0].front_art().id.as_str())
    );

    let service = ArtPolicies::new(store.clone(), providers);
    let english = service
        .preview_language(&deck.id, applied.revision, "en".into())
        .await
        .unwrap();
    assert_eq!(english.changes[0].tier, Some(LanguageTier::SamePrinting));
    let restored = service
        .apply(&deck.id, applied.revision, &english.preview_id)
        .unwrap();
    assert_eq!(restored.entries[0].front_art(), deck.entries[0].front_art());
    let spanish_again = service
        .preview_language(&deck.id, restored.revision, "es".into())
        .await
        .unwrap();
    assert_eq!(spanish_again.changes[0].tier, Some(LanguageTier::Override));
    assert_eq!(spanish_again.changes[0].after.as_ref(), Some(&art));

    let adjusted = store
        .update_deck(deckpress_core::models::Deck {
            art_policy: Some(ArtPolicy::MatchSet {
                set: "fdc".into(),
                family: true,
            }),
            entries: deck.entries,
            ..restored
        })
        .unwrap();
    let preview = service
        .preview_language(&adjusted.id, adjusted.revision, "es".into())
        .await
        .unwrap();
    assert_eq!(preview.changes[0].tier, Some(LanguageTier::SameSet));
}
