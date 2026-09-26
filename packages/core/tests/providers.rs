use deckpress_core::models::Provider;
use deckpress_core::providers::normalize_scryfall;
use serde_json::Value;

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
