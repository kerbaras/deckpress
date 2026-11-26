use std::sync::Arc;

use deckpress_core::models::{Provider, Zone};
use deckpress_core::providers::{moxfield_status_error, normalize_scryfall, Providers};
use deckpress_core::store::Store;
use serde_json::Value;
use sha2::{Digest, Sha256};

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
            "commanders\n1 Jori En, Ruin Diver\nCommander\n// Board: companions\n1 Lurrus of the Dream-Den\n",
            "mainboard\n4 Lightning Bolt (m10) 146\nsideboard\n2 Negate\n",
            "Deck\n// Board: sideboard2\n1 Shock\nDeck\n// Board: testing Pool\n1 Opt"
        )
    );
}

#[tokio::test]
async fn moxfield_companion_section_does_not_depend_on_board_order() {
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

    for (commander_key, commander_cards, companion_key, custom_key, expected) in [
        (
            "commanders",
            &commander,
            "companions",
            "testing Pool",
            "Commander",
        ),
        (
            "commanders",
            &commander,
            "companions",
            "commanders2",
            "Commander",
        ),
        (
            "Commanders",
            &commander,
            "COMPANIONS",
            "testing Pool",
            "Commander",
        ),
        ("commanders", &empty, "companions", "testing Pool", "Deck"),
        ("commanders", &empty, "companions", "commanders2", "Deck"),
    ] {
        let boards = [
            (commander_key, commander_cards),
            (companion_key, &companion),
            (custom_key, &custom),
            ("empty Board", &empty),
        ];
        let companion_label = format!("// Board: {companion_key}");
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
                            .windows(3)
                            .any(|section| {
                                section
                                    == [
                                        expected,
                                        companion_label.as_str(),
                                        "1 Lurrus of the Dream-Den",
                                    ]
                            }),
                        "order {:?}: {output}",
                        order.map(|i| boards[i].0)
                    );
                    assert!(!output.contains("empty Board"));
                }
            }
        }
    }
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
