use deckpress_core::decksearch::{
    archidekt_format, archidekt_format_id, archidekt_search_url, check_import_limits,
    parse_archidekt_deck, parse_archidekt_search, pick_card_name, plain_description,
    valid_archidekt_id, DeckSearchPage, DeckSource, SearchField, MAX_DESCRIPTION,
};
use deckpress_core::models::{ImportLine, Zone};
use deckpress_core::validate::{MAX_ENTRIES, MAX_QUANTITY};
use serde_json::Value;

fn search_fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/archidekt_search.json")).unwrap()
}

fn deck_fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/archidekt_deck.json")).unwrap()
}

#[test]
fn builds_search_urls_with_archidekt_parameter_names() {
    let url = archidekt_search_url(
        "Atraxa, Praetors' Voice",
        SearchField::Commander,
        Some(3),
        2,
    );
    assert_eq!(
        url,
        "https://archidekt.com/api/decks/v3/?commanderName=Atraxa%2C+Praetors%27+Voice&deckFormat=3&orderBy=-viewCount&page=2"
    );
    let url = archidekt_search_url("Sol Ring", SearchField::Card, None, 0);
    assert!(url.contains("cardName=Sol+Ring"));
    assert!(!url.contains("deckFormat"));
    assert!(url.ends_with("page=1"));
    assert!(archidekt_search_url("Atraxa", SearchField::Name, None, 1).contains("?name=Atraxa&"));
}

#[test]
fn normalises_search_results() {
    let page = parse_archidekt_search(&search_fixture(), 1);
    assert_eq!(page.total, 1000);
    assert!(page.has_more);
    assert_eq!(page.page, 1);
    assert_eq!(page.items.len(), 3);
    let first = &page.items[0];
    assert_eq!(first.source, DeckSource::Archidekt);
    assert_eq!(first.id, "3949764");
    assert_eq!(first.name, "Upping the Average - Atraxa Infect");
    assert_eq!(first.format, "Commander");
    assert_eq!(first.deckpress_format, "Commander");
    assert_eq!(first.author, "JoeyDH");
    assert_eq!(first.color_identity, ["W", "U", "B", "G"]);
    assert_eq!(first.card_count, 100);
    assert_eq!(first.updated_at, "2023-02-08T09:32:52.172427Z");
    assert_eq!(first.url, "https://archidekt.com/decks/3949764");
    assert!(first
        .cover_url
        .starts_with("https://storage.googleapis.com/archidekt-card-images/"));
    assert_eq!(first.views, 62387);
}

#[test]
fn hides_private_decks_and_reads_missing_card_filters_as_empty() {
    let mut value = search_fixture();
    value["results"][1]["private"] = Value::Bool(true);
    value["results"][2]["unlisted"] = Value::Bool(true);
    assert_eq!(parse_archidekt_search(&value, 1).items.len(), 1);

    for deck in value["results"].as_array_mut().unwrap() {
        deck["private"] = Value::Bool(true);
    }
    let hidden = parse_archidekt_search(&value, 1);
    assert!(hidden.items.is_empty());
    assert!(hidden.has_more);

    let none: Value = serde_json::json!({ "count": -1, "next": null, "results": [] });
    let page = parse_archidekt_search(&none, 1);
    assert_eq!(
        page,
        DeckSearchPage {
            page: 1,
            ..DeckSearchPage::default()
        }
    );
}

#[test]
fn maps_archidekt_formats_onto_deckpress_formats() {
    assert_eq!(archidekt_format(3), ("Commander", "Commander"));
    assert_eq!(archidekt_format(14), ("Oathbreaker", "Casual"));
    assert_eq!(archidekt_format(12), ("Duel Commander", "Commander"));
    assert_eq!(archidekt_format(99), ("Unknown", "Casual"));
    assert_eq!(archidekt_format_id("Pioneer"), Some(15));
    assert_eq!(archidekt_format_id("Cube"), None);
}

#[test]
fn normalises_deck_details_into_zoned_import_lines() {
    let deck = parse_archidekt_deck(&deck_fixture()).unwrap();
    assert_eq!(deck.summary.id, "3949764");
    assert_eq!(deck.summary.author, "JoeyDH");
    assert_eq!(deck.summary.format, "Commander");
    assert_eq!(deck.summary.color_identity, ["W", "U", "B", "G"]);
    assert_eq!(deck.summary.card_count, 5);
    assert_eq!(deck.lines.len(), 5);
    let by_name = |name: &str| deck.lines.iter().find(|line| line.name == name).unwrap();
    let commander = by_name("Atraxa, Praetors' Voice");
    assert_eq!(commander.zone, Zone::Commander);
    assert_eq!(commander.set, "2xm");
    assert_eq!(commander.collector_number, "190");
    assert_eq!(by_name("Plains").quantity, 2);
    assert_eq!(by_name("Plains").zone, Zone::Main);
    assert_eq!(by_name("Anguished Unmaking").zone, Zone::Main);
    assert_eq!(by_name("Plague Myr").zone, Zone::Maybe);
    assert!(deck.description.starts_with("https://youtu.be/"));
    assert!(deck.description.contains("Cards Added:\nPath of Ancestry"));
    assert!(!deck.description.contains("\"ops\""));
}

#[test]
fn descriptions_flatten_quill_deltas_and_keep_plain_text() {
    assert_eq!(
        plain_description(
            r#"{"ops":[{"insert":"Hello ","attributes":{"bold":true}},{"insert":{"image":"x"}},{"insert":"world\n"}]}"#
        ),
        "Hello world"
    );
    assert_eq!(plain_description("  just text  "), "just text");
    assert_eq!(
        plain_description("{\"not\": \"a delta\"}"),
        "{\"not\": \"a delta\"}"
    );
    let long = "x".repeat(MAX_DESCRIPTION + 5);
    let cut = plain_description(&long);
    assert_eq!(cut.chars().count(), MAX_DESCRIPTION + 1);
    assert!(cut.ends_with('…'));
}

#[test]
fn sideboard_categories_and_empty_quantities() {
    let mut value = deck_fixture();
    value["cards"][1]["categories"] = serde_json::json!(["Sideboard", "Creature"]);
    value["cards"][3]["quantity"] = serde_json::json!(0);
    let deck = parse_archidekt_deck(&value).unwrap();
    assert_eq!(
        deck.lines
            .iter()
            .find(|l| l.name == "Phyrexian Swarmlord")
            .unwrap()
            .zone,
        Zone::Side
    );
    assert!(deck.lines.iter().all(|l| l.name != "Anguished Unmaking"));
    assert_eq!(deck.summary.card_count, 4);
}

#[test]
fn excluded_categories_win_over_commander_and_sideboard() {
    let mut value = deck_fixture();
    value["cards"][0]["categories"] = serde_json::json!(["Maybeboard", "Commander"]);
    value["cards"][1]["categories"] = serde_json::json!(["Sideboard", "Maybeboard"]);
    let deck = parse_archidekt_deck(&value).unwrap();
    assert_eq!(deck.lines[0].zone, Zone::Maybe);
    assert_eq!(deck.lines[1].zone, Zone::Maybe);
    assert_eq!(deck.summary.card_count, 3);
}

#[test]
fn rejects_decks_without_ids_or_that_are_not_public() {
    assert!(parse_archidekt_deck(&serde_json::json!({ "name": "x", "cards": [] })).is_err());
    for flag in ["private", "unlisted"] {
        let mut value = deck_fixture();
        value[flag] = Value::Bool(true);
        assert!(parse_archidekt_deck(&value).is_err(), "{flag}");
    }
}

#[test]
fn import_limits_mirror_deck_validation() {
    let line = |quantity: u32| ImportLine {
        quantity,
        name: "Plains".into(),
        zone: Zone::Main,
        set: String::new(),
        collector_number: String::new(),
    };
    assert!(check_import_limits(&[]).is_err());
    assert!(check_import_limits(&[line(4)]).is_ok());
    assert!(check_import_limits(&[line(MAX_QUANTITY + 1)]).is_err());
    assert!(check_import_limits(&vec![line(1); MAX_ENTRIES + 1]).is_err());
    assert!(check_import_limits(&vec![line(MAX_QUANTITY); 7]).is_err());
}

#[test]
fn picks_commander_names_from_scryfall_candidates() {
    let candidates: Vec<String> = [
        "Atraxa's Fall",
        "Atraxa, Grand Unifier",
        "Atraxa's Skitterfang",
        "Atraxa, Praetors' Voice",
        "Ixhel, Scion of Atraxa",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(
        pick_card_name("atraxa", &candidates, SearchField::Commander).as_deref(),
        Some("Atraxa, Grand Unifier")
    );
    assert_eq!(
        pick_card_name("atraxa", &candidates, SearchField::Card).as_deref(),
        Some("Atraxa's Fall")
    );
    assert_eq!(
        pick_card_name("ATRAXA, PRAETORS' VOICE", &candidates, SearchField::Card).as_deref(),
        Some("Atraxa, Praetors' Voice")
    );
    assert_eq!(
        pick_card_name("scion", &candidates, SearchField::Card).as_deref(),
        Some("Atraxa's Fall")
    );
    assert_eq!(pick_card_name("x", &[], SearchField::Card), None);
}

#[test]
fn validates_archidekt_ids() {
    assert!(valid_archidekt_id("3949764"));
    assert!(!valid_archidekt_id(""));
    assert!(!valid_archidekt_id("39a4"));
    assert!(!valid_archidekt_id("../decks"));
}

#[test]
fn serialises_camel_case() {
    let page = parse_archidekt_search(&search_fixture(), 1);
    let json = serde_json::to_value(&page).unwrap();
    assert!(json.get("hasMore").is_some());
    assert!(json["items"][0].get("deckpressFormat").is_some());
    assert!(json["items"][0].get("colorIdentity").is_some());
    assert_eq!(json["items"][0]["source"], "archidekt");
    let deck = parse_archidekt_deck(&deck_fixture()).unwrap();
    let json = serde_json::to_value(&deck).unwrap();
    assert_eq!(json["lines"][0]["collectorNumber"], "190");
    assert_eq!(json["lines"][0]["zone"], "commander");
}
