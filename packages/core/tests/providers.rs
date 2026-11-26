use std::sync::Arc;

use deckpress_core::models::{
    ImportLine, PrintLanguagePolicy, PrintLanguagePreferences, Provider, Zone,
};
use deckpress_core::providers::{moxfield_status_error, normalize_scryfall, Providers};
use deckpress_core::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const BOLT: &str = "4457ed35-7c10-48c8-9776-456485fdf070";
const LOTUS: &str = "5089ec1a-f881-4d55-af14-5d996171203b";

fn sample() -> Value {
    serde_json::json!({
        "id": "6b6d5a31-b4b4-4f53-8c6b-7f1a4f3d9f01",
        "oracle_id": "f7f0d6e3-3d8e-4b32-9f68-cf45f58a0eaa",
        "name": "Lightning Bolt",
        "type_line": "Instant",
        "mana_cost": "{R}",
        "cmc": 1,
        "color_identity": ["R"],
        "image_uris": { "png": "https://cards.scryfall.io/png/front/x.png", "normal": "https://cards.scryfall.io/normal/front/x.jpg" },
        "artist": "Christopher Rush",
        "set": "lea",
        "set_name": "Limited Edition Alpha",
        "collector_number": "161",
        "frame": "1993",
        "scryfall_uri": "https://scryfall.com/card/lea/161"
    })
}

#[test]
fn normalizes_single_faced_cards() {
    let card = normalize_scryfall(&sample()).unwrap();
    assert_eq!(card.faces.len(), 1);
    assert_eq!(card.faces[0].provider, Provider::Scryfall);
    assert_eq!(
        card.faces[0].id,
        "scryfall:6b6d5a31-b4b4-4f53-8c6b-7f1a4f3d9f01:0"
    );
    assert_eq!(card.faces[0].tags, vec!["retro frame".to_string()]);
    assert_eq!(
        card.faces[0].thumbnail_url,
        "https://cards.scryfall.io/normal/front/x.jpg"
    );
}

#[test]
fn double_faced_cards_link_the_back() {
    let mut value = sample();
    value.as_object_mut().unwrap().remove("image_uris");
    value["card_faces"] = serde_json::json!([
        { "name": "Front", "image_uris": { "png": "https://cards.scryfall.io/png/front/a.png" } },
        { "name": "Back", "image_uris": { "png": "https://cards.scryfall.io/png/back/a.png" } }
    ]);
    let card = normalize_scryfall(&value).unwrap();
    assert_eq!(card.faces.len(), 2);
    assert_eq!(
        card.faces[0].back_image_url,
        "https://cards.scryfall.io/png/back/a.png"
    );
}

#[test]
fn rejects_cards_without_scans() {
    let mut value = sample();
    value.as_object_mut().unwrap().remove("image_uris");
    assert!(normalize_scryfall(&value).is_err());
}

#[test]
fn moxfield_refusals_point_at_the_exported_list() {
    let refused = moxfield_status_error(403).to_string();
    assert!(refused.contains("HTTP 403"), "{refused}");
    assert!(refused.contains("not a web browser"), "{refused}");
    assert!(refused.contains("More › Download / Export"), "{refused}");
    assert!(refused.contains("Copy Plain Text"), "{refused}");
    assert!(refused.contains("paste the list here"), "{refused}");
    assert!(moxfield_status_error(404).to_string().contains("public"));
    assert!(moxfield_status_error(502).to_string().contains("HTTP 502"));
}

#[tokio::test]
async fn suggests_printable_tokens_and_emblems_from_all_parts() {
    fn cache(store: &Store, ids: &[&str], cards: Vec<Value>) {
        let identifiers: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect();
        let body = serde_json::json!({ "identifiers": identifiers });
        let key = hex::encode(Sha256::digest(format!(
            "https://api.scryfall.com/cards/collection{body}"
        )));
        store
            .put("cache", &key, &serde_json::json!({ "data": cards }))
            .unwrap();
    }

    let store = Arc::new(Store::in_memory().unwrap());
    let mut producer = sample();
    let producer_id = producer["id"].as_str().unwrap().to_owned();
    let token_id = "15e69090-20b4-4dfb-8a8b-1214355bdf7c";
    let emblem_id = "21d78b30-64e9-4ae4-9eef-d92cc207cef5";
    producer["all_parts"] = serde_json::json!([
        {"id":token_id,"component":"token","type_line":"Token Artifact — Treasure"},
        {"id":token_id,"component":"token","type_line":"Token Artifact — Treasure"},
        {"id":emblem_id,"component":"combo_piece","type_line":"Emblem — Chandra"},
        {"id":"3cf110aa-8e4c-48da-a40a-4938790f52c7","component":"meld_result","type_line":"Creature"},
        {"id":"431fbdb1-b64f-4654-a805-6ba399bd146f","component":"combo_piece","type_line":"Creature"}
    ]);
    cache(&store, &[&producer_id], vec![producer]);
    let part = |id: &str, name: &str| {
        let mut value = sample();
        value["id"] = id.into();
        value["oracle_id"] = id.into();
        value["name"] = name.into();
        value
    };
    cache(
        &store,
        &[token_id, emblem_id],
        vec![
            part(token_id, "Treasure"),
            part(emblem_id, "Chandra Emblem"),
        ],
    );
    let providers = Providers::new(store).unwrap();
    let entries = providers
        .related_tokens(vec![producer_id.clone(), producer_id])
        .await
        .unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.card.name.as_str())
            .collect::<Vec<_>>(),
        ["Chandra Emblem", "Treasure"]
    );
    assert!(entries
        .iter()
        .all(|entry| entry.zone == Zone::Tokens && entry.quantity == 1));
}

fn lines() -> Vec<ImportLine> {
    [
        ("Lightning Bolt", "m10", "146"),
        ("Black Lotus", "lea", "232"),
        ("Lightning Bolt", "", ""),
    ]
    .into_iter()
    .map(|(name, set, collector_number)| ImportLine {
        name: name.into(),
        set: set.into(),
        collector_number: collector_number.into(),
        quantity: 1,
        zone: Zone::Main,
    })
    .collect()
}

fn preferences(languages: &[&str], policy: PrintLanguagePolicy) -> PrintLanguagePreferences {
    PrintLanguagePreferences {
        languages: languages
            .iter()
            .map(|language| (*language).into())
            .collect(),
        policy,
    }
}

fn record(store: &Store, url: &str, body: Value, response: &Value) {
    let key = hex::encode(Sha256::digest(format!("{url}{body}")));
    let data = if response.get("status").and_then(Value::as_u64) == Some(404) {
        &Value::Null
    } else {
        response
    };
    store.put("cache", &key, data).unwrap();
}

fn search_url(query: &str) -> String {
    let mut url = url::Url::parse("https://api.scryfall.com/cards/search").unwrap();
    url.query_pairs_mut().append_pair("q", query);
    format!("{url}&unique=prints&include_multilingual=true&order=released&dir=desc&page=1")
}

fn recorded_providers() -> Providers {
    let mut fixture: Value =
        serde_json::from_str(include_str!("fixtures/scryfall-languages.json")).unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    record(
        &store,
        "https://api.scryfall.com/cards/collection",
        json!({"identifiers": [
            {"set": "m10", "collector_number": "146"},
            {"set": "lea", "collector_number": "232"},
            {"name": "Lightning Bolt"}
        ]}),
        &fixture["collection"],
    );
    record(
        &store,
        "https://api.scryfall.com/cards/collection",
        json!({"identifiers": [{"set": "m10", "collector_number": "146"}]}),
        &json!({"object": "list", "not_found": [], "data": [fixture["collection"]["data"][0]]}),
    );
    for (path, key) in [
        ("m10/146/es", "exact_es"),
        ("m10/146/fr", "exact_fr"),
        ("lea/232/es", "absent_exact_es"),
    ] {
        record(
            &store,
            &format!("https://api.scryfall.com/cards/{path}"),
            Value::Null,
            &fixture[key],
        );
    }
    let placeholder = fixture["placeholder_exact_es"].clone();
    fixture["search_es"]["data"]
        .as_array_mut()
        .unwrap()
        .insert(0, placeholder);
    for (query, key) in [
        (format!("oracleid:{BOLT} game:paper lang:es"), "search_es"),
        (
            format!("oracleid:{LOTUS} game:paper lang:es"),
            "absent_search_es",
        ),
    ] {
        record(&store, &search_url(&query), Value::Null, &fixture[key]);
    }
    Providers::new(store).unwrap()
}

async fn check_spanish_import(providers: &Providers) {
    providers
        .save_print_language_preferences(preferences(&["es"], PrintLanguagePolicy::Strict))
        .unwrap();
    let strict = providers.resolve_import(lines()).await.unwrap();
    assert_eq!(strict.entries.len(), 2);
    assert_eq!(strict.entries[0].front_art().language, "es");
    assert_eq!(strict.entries[0].front_art().set, "m10");
    assert_eq!(strict.entries[0].front_art().collector_number, "146");
    assert_eq!(strict.entries[1].front_art().language, "es");
    assert_eq!(strict.entries[1].card.name, "Lightning Bolt");
    assert_eq!(strict.issues.len(), 1);
    assert_eq!(strict.issues[0].line, 2);
    assert_eq!(strict.missing_prints.len(), 1);
    assert_eq!(strict.missing_prints[0].input, "1 Black Lotus (lea) 232");
    assert_eq!(strict.missing_prints[0].languages, ["es"]);

    providers
        .save_print_language_preferences(preferences(
            &["es"],
            PrintLanguagePolicy::FallbackToEnglish,
        ))
        .unwrap();
    let fallback = providers.resolve_import(lines()).await.unwrap();
    assert!(fallback.issues.is_empty());
    assert!(fallback.missing_prints.is_empty());
    assert_eq!(fallback.entries.len(), 3);
    let lotus = &fallback.entries[1];
    assert_eq!(lotus.card.name, "Black Lotus");
    assert_eq!(lotus.front_art().language, "en");
    assert_eq!(lotus.requested_languages, ["es"]);
}

#[tokio::test]
async fn spanish_policy_and_art_search_use_recorded_scryfall_prints() {
    let providers = recorded_providers();
    assert_eq!(
        providers.print_language_preferences().unwrap(),
        PrintLanguagePreferences::default()
    );
    check_spanish_import(&providers).await;
    let art = providers.prints(BOLT, 1, 0, Some("es")).await.unwrap();
    assert_eq!(art.total, 9);
    assert_eq!(art.items.len(), 1);
    assert_eq!(art.items[0].language, "es");
    assert!(providers
        .prints(LOTUS, 1, 0, Some("es"))
        .await
        .unwrap()
        .items
        .is_empty());
}

#[tokio::test]
async fn strict_name_only_skips_distinguish_unknown_cards_from_unusable_scans() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/scryfall-languages.json")).unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let mut lotus = fixture["collection"]["data"][1].clone();
    lotus["image_status"] = json!("placeholder");
    record(
        &store,
        "https://api.scryfall.com/cards/collection",
        json!({"identifiers": [{"name": "Black Lotus"}, {"name": "Not A Card"}]}),
        &json!({"data": [lotus], "not_found": [{"name": "Not A Card"}]}),
    );
    for name in ["Black Lotus", "Not A Card"] {
        for language in ["es", "la"] {
            record(
                &store,
                &search_url(&format!("!\"{name}\" game:paper lang:{language}")),
                Value::Null,
                &fixture["absent_search_es"],
            );
        }
    }
    let providers = Providers::new(store).unwrap();
    providers
        .save_print_language_preferences(preferences(&["es", "la"], PrintLanguagePolicy::Strict))
        .unwrap();
    let result = providers
        .resolve_import(
            ["Black Lotus", "Not A Card"]
                .into_iter()
                .map(|name| ImportLine {
                    name: name.into(),
                    set: String::new(),
                    collector_number: String::new(),
                    quantity: 1,
                    zone: Zone::Main,
                })
                .collect(),
        )
        .await
        .unwrap();
    assert!(result.entries.is_empty());
    assert_eq!(result.issues.len(), 2);
    assert_eq!(
        serde_json::to_value(&result.issues[0]).unwrap(),
        json!({
            "line": 1,
            "input": "1 Black Lotus",
            "kind": "noUsableScan",
            "message": "No usable scan found in es, la.",
            "printLookup": {"set": "lea", "collectorNumber": "232", "languages": ["es", "la"]},
        })
    );
    assert_eq!(
        serde_json::to_value(&result.issues[1]).unwrap(),
        json!({
            "line": 2,
            "input": "1 Not A Card",
            "kind": "notFound",
            "message": "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.",
        })
    );
    assert_eq!(result.missing_prints.len(), 1);
    assert_eq!(result.missing_prints[0].input, "1 Black Lotus");
}

#[tokio::test]
async fn unusable_exact_scan_is_skipped_in_strict_mode_and_falls_back_to_exact_english() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/scryfall-languages.json")).unwrap();
    for status in ["placeholder", "missing"] {
        let mut unusable = fixture["placeholder_exact_es"].clone();
        unusable["image_status"] = json!(status);
        assert!(normalize_scryfall(&unusable).is_err());
        let store = Arc::new(Store::in_memory().unwrap());
        record(
            &store,
            "https://api.scryfall.com/cards/collection",
            json!({"identifiers": [{"set": "m11", "collector_number": "149"}]}),
            &json!({"data": [fixture["usable_exact_en"]]}),
        );
        record(
            &store,
            "https://api.scryfall.com/cards/m11/149/es",
            Value::Null,
            &unusable,
        );
        record(
            &store,
            &search_url(&format!("oracleid:{BOLT} game:paper lang:es")),
            Value::Null,
            &fixture["search_es"],
        );
        let providers = Providers::new(store).unwrap();
        let lines = vec![ImportLine {
            name: "Lightning Bolt".into(),
            set: "m11".into(),
            collector_number: "149".into(),
            quantity: 1,
            zone: Zone::Main,
        }];

        providers
            .save_print_language_preferences(preferences(&["es"], PrintLanguagePolicy::Strict))
            .unwrap();
        let strict = providers.resolve_import(lines.clone()).await.unwrap();
        assert!(strict.entries.is_empty(), "{status}");
        assert_eq!(strict.issues.len(), 1, "{status}");
        assert_eq!(strict.issues[0].line, 1);
        let lookup = strict.issues[0].print_lookup.as_ref().unwrap();
        assert_eq!((&*lookup.set, &*lookup.collector_number), ("m11", "149"));
        assert_eq!(strict.missing_prints[0].input, "1 Lightning Bolt (m11) 149");
        assert_eq!(strict.missing_prints[0].languages, ["es"]);

        providers
            .save_print_language_preferences(preferences(
                &["es"],
                PrintLanguagePolicy::FallbackToEnglish,
            ))
            .unwrap();
        let fallback = providers.resolve_import(lines).await.unwrap();
        assert!(fallback.issues.is_empty(), "{status}");
        assert!(fallback.missing_prints.is_empty(), "{status}");
        assert_eq!(fallback.entries.len(), 1, "{status}");
        let entry = &fallback.entries[0];
        assert_eq!(entry.front_art().language, "en");
        assert_eq!(entry.front_art().set, "m11");
        assert_eq!(entry.front_art().collector_number, "149");
        assert_eq!(entry.requested_languages, ["es"]);
    }
}

#[tokio::test]
async fn language_order_changes_exact_print_and_does_not_reuse_the_previous_locale() {
    let providers = recorded_providers();
    let mut input = lines();
    input.truncate(1);
    for (languages, expect) in [(["fr", "es"], "fr"), (["es", "fr"], "es")] {
        providers
            .save_print_language_preferences(preferences(&languages, PrintLanguagePolicy::Strict))
            .unwrap();
        let resolved = providers.resolve_import(input.clone()).await.unwrap();
        assert_eq!(resolved.entries[0].front_art().language, expect);
    }
    assert!(providers
        .save_print_language_preferences(preferences(&["es", "es"], PrintLanguagePolicy::Strict))
        .is_err());
}

#[tokio::test]
#[ignore = "talks to Scryfall"]
async fn live_spanish_import_strict_and_fallback() {
    let providers = Providers::new(Arc::new(Store::in_memory().unwrap())).unwrap();
    check_spanish_import(&providers).await;
    let art = providers.prints(BOLT, 1, 0, Some("es")).await.unwrap();
    assert!(!art.items.is_empty());
    assert!(art.items.iter().all(|item| item.language == "es"));
}
