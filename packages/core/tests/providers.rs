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
async fn moxfield_import_labels_nonempty_boards() {
    let store = Arc::new(Store::in_memory().unwrap());
    let key = hex::encode(Sha256::digest(
        "https://api2.moxfield.com/v3/decks/all/exampleDecknull",
    ));
    store
        .put(
            "cache",
            &key,
            &serde_json::json!({
                "boards": {
                    "commanders": {"cards": {"jori": {"card": {"name": "Jori En, Ruin Diver"}}}},
                    "companions": {"cards": {"lurrus": {"card": {
                        "name": "Lurrus of the Dream-Den"
                    }}}},
                    "mainboard": {"cards": {"bolt": {"quantity": 4, "card": {
                        "name": "Lightning Bolt", "set": "m10", "cn": "146"
                    }}}},
                    "sideboard": {"cards": {"negate": {"quantity": 2, "card": {
                        "name": "Negate"
                    }}}},
                    "sideboard2": {"cards": {"shock": {"card": {"name": "Shock"}}}},
                    "testing Pool": {"cards": {"opt": {"card": {"name": "Opt"}}}},
                    "empty Board": {"cards": {}}
                }
            }),
        )
        .unwrap();
    let text = Providers::new(store)
        .unwrap()
        .import_url("https://moxfield.com/decks/exampleDeck")
        .await
        .unwrap();
    assert_eq!(
        text,
        concat!(
            "commanders\n1 Jori En, Ruin Diver\nCompanion\n1 Lurrus of the Dream-Den\n",
            "mainboard\n4 Lightning Bolt (m10) 146\nsideboard\n2 Negate\n",
            "Deck\n// Board: sideboard2\n1 Shock\nDeck\n// Board: testing Pool\n1 Opt"
        )
    );
}

#[tokio::test]
async fn moxfield_companion_section_is_a_companion_heading_in_any_board_order() {
    struct OrderedBoards<'a>([(&'a str, &'a Value); 4]);
    impl serde::Serialize for OrderedBoards<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_map(self.0)
        }
    }
    #[derive(serde::Serialize)]
    struct Fixture<'a> {
        boards: OrderedBoards<'a>,
    }

    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Providers::new(store.clone()).unwrap();
    let key = hex::encode(Sha256::digest(
        "https://api2.moxfield.com/v3/decks/all/exampleDecknull",
    ));
    let card = |name: &str| serde_json::json!({"cards": {"id": {"card": {"name": name}}}});
    let commander = card("Jori En, Ruin Diver");
    let companion = card("Lurrus of the Dream-Den");
    let custom = card("Opt");
    let empty = serde_json::json!({"cards": {}});

    for (commander_key, commander_cards, companion_key, custom_key) in [
        ("commanders", &commander, "companions", "testing Pool"),
        ("commanders", &commander, "companions", "commanders2"),
        ("Commanders", &commander, "COMPANIONS", "testing Pool"),
        ("commanders", &empty, "companions", "testing Pool"),
        ("commanders", &empty, "companion", "commanders2"),
    ] {
        let boards = [
            (commander_key, commander_cards),
            (companion_key, &companion),
            (custom_key, &custom),
            ("empty Board", &empty),
        ];
        for a in 0..4 {
            for b in (0..4).filter(|b| *b != a) {
                for c in (0..4).filter(|c| *c != a && *c != b) {
                    let order = [a, b, c, 6 - a - b - c];
                    let fixture = Fixture {
                        boards: OrderedBoards(order.map(|i| boards[i])),
                    };
                    store.put("cache", &key, &fixture).unwrap();
                    let output = providers
                        .import_url("https://moxfield.com/decks/exampleDeck")
                        .await
                        .unwrap();
                    assert!(
                        output
                            .lines()
                            .collect::<Vec<_>>()
                            .windows(2)
                            .any(|section| section == ["Companion", "1 Lurrus of the Dream-Den"]),
                        "order {:?}: {output}",
                        order.map(|i| boards[i].0)
                    );
                    assert!(!output.contains("empty Board"));
                    assert!(!output.contains("// Board: companion"), "{output}");
                }
            }
        }
    }
}

#[tokio::test]
async fn archidekt_import_puts_companion_categories_under_a_companion_heading() {
    let store = Arc::new(Store::in_memory().unwrap());
    let key = hex::encode(Sha256::digest("https://archidekt.com/api/decks/42/null"));
    let card = |name: &str, categories: &[&str], set: &str, cn: &str| {
        serde_json::json!({"quantity": 1, "categories": categories, "card": {
            "oracleCard": {"name": name},
            "edition": {"editioncode": set},
            "collectorNumber": cn
        }})
    };
    store
        .put(
            "cache",
            &key,
            &serde_json::json!({
                "categories": [
                    {"name": "Companion", "includedInDeck": false},
                    {"name": "Maybeboard", "includedInDeck": false},
                    {"name": "Considering", "includedInDeck": false},
                    {"name": "Creature", "includedInDeck": true}
                ],
                "cards": [
                    card("Lurrus of the Dream-Den", &["Companion"], "iko", "226"),
                    card("Ranger-Captain of Eos", &["Creature"], "mh1", "21"),
                    card("Yorion, Sky Nomad", &["Companion", "Creature"], "iko", "232"),
                    card("Kaheera, the Orphanguard", &["Companion", "Maybeboard"], "iko", "7"),
                    card("Jegantha, the Wellspring", &["Considering", "Companion"], "iko", "222"),
                ]
            }),
        )
        .unwrap();
    let text = Providers::new(store)
        .unwrap()
        .import_url("https://archidekt.com/decks/42/lurrus")
        .await
        .unwrap();
    assert_eq!(
        text,
        [
            "Companion",
            "1 Lurrus of the Dream-Den (iko) 226",
            "Deck",
            "1 Ranger-Captain of Eos (mh1) 21",
            "Companion",
            "1 Yorion, Sky Nomad (iko) 232",
            "Maybeboard",
            "1 Kaheera, the Orphanguard (iko) 7",
            "Maybeboard",
            "1 Jegantha, the Wellspring (iko) 222",
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn moxfield_board_keys_are_exact_not_pasted_heading_variants() {
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Providers::new(store.clone()).unwrap();
    let key = hex::encode(Sha256::digest(
        "https://api2.moxfield.com/v3/decks/all/exampleDecknull",
    ));
    for (board, heading) in [
        ("SIDEBOARD", "SIDEBOARD"),
        ("Side Board", "Deck\n// Board: Side Board"),
        ("side-board", "Deck\n// Board: side-board"),
        ("Sideboard:", "Deck\n// Board: Sideboard:"),
        ("sideboard2", "Deck\n// Board: sideboard2"),
        ("Commanders:", "Deck\n// Board: Commanders:"),
        ("Maybe Board", "Deck\n// Board: Maybe Board"),
        ("Tokens:", "Deck\n// Board: Tokens:"),
    ] {
        store
            .put(
                "cache",
                &key,
                &serde_json::json!({
                    "boards": {(board): {"cards": {"id": {"card": {"name": "Negate"}}}}}
                }),
            )
            .unwrap();
        let output = providers
            .import_url("https://moxfield.com/decks/exampleDeck")
            .await
            .unwrap();
        assert_eq!(output, format!("{heading}\n1 Negate"), "board {board}");
    }
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
        board: None,
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
async fn resolves_front_face_identifiers_and_retries_unmatched_ampersands() {
    let store = Arc::new(Store::in_memory().unwrap());
    let delver: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy-dfc.json")).unwrap();
    let mut fire = sample();
    fire["name"] = json!("Fire // Ice");
    fire["set"] = json!("mh2");
    fire["lang"] = json!("en");
    let mut krang = sample();
    krang["name"] = json!("Krang & Shredder");
    krang["lang"] = json!("en");
    let collection = "https://api.scryfall.com/cards/collection";
    record(
        &store,
        collection,
        json!({"identifiers": [
            {"name": "Delver of Secrets"},
            {"name": "Fire & Ice", "set": "mh2"},
            {"name": "Krang & Shredder"},
            {"name": "Fire & Wrong Face"}
        ]}),
        &json!({"data": [delver[0], krang]}),
    );
    for identifier in [
        json!({"name": "Fire", "set": "mh2"}),
        json!({"name": "Fire"}),
    ] {
        record(
            &store,
            collection,
            json!({"identifiers": [identifier]}),
            &json!({"data": [fire]}),
        );
    }
    let input = [
        ("Delver of Secrets/Insectile Aberration", "", Zone::Main),
        ("Fire & Ice", "mh2", Zone::Side),
        ("Krang & Shredder", "", Zone::Main),
        ("Fire & Wrong Face", "", Zone::Main),
    ]
    .into_iter()
    .map(|(name, set, zone)| ImportLine {
        name: name.into(),
        set: set.into(),
        collector_number: String::new(),
        quantity: 2,
        zone,
        board: None,
    })
    .collect();
    let resolved = Providers::new(store).unwrap().resolve(input).await.unwrap();
    assert_eq!(
        resolved
            .entries
            .iter()
            .map(|entry| (entry.card.name.as_str(), entry.quantity, entry.zone))
            .collect::<Vec<_>>(),
        [
            ("Delver of Secrets // Insectile Aberration", 2, Zone::Main),
            ("Fire // Ice", 2, Zone::Side),
            ("Krang & Shredder", 2, Zone::Main),
        ]
    );
    assert_eq!(resolved.issues.len(), 1);
    assert_eq!(resolved.issues[0].line, 4);
    assert_eq!(resolved.issues[0].input, "2 Fire & Wrong Face");
    assert_eq!(
        resolved.issues[0].kind,
        deckpress_core::models::ImportIssueKind::NotFound
    );
}

#[tokio::test]
async fn resolves_named_boards_without_changing_their_zones() {
    let mut input = lines();
    input[0].zone = Zone::Maybe;
    input[0].board = Some("Maybeboard".into());
    input[1].zone = Zone::Companion;
    input[2].zone = Zone::Maybe;
    input[2].board = Some("Considering".into());
    let resolved = recorded_providers().resolve(input).await.unwrap();
    assert!(resolved.issues.is_empty());
    assert_eq!(
        resolved
            .entries
            .iter()
            .map(|entry| (entry.zone, entry.board.as_deref()))
            .collect::<Vec<_>>(),
        [
            (Zone::Maybe, Some("Maybeboard")),
            (Zone::Companion, None),
            (Zone::Maybe, Some("Considering"))
        ]
    );
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
                    board: None,
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
            board: None,
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
