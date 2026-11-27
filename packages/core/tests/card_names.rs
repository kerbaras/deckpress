use deckpress_core::card_names::{
    ampersand_card_alternative, canonical_card_name, card_lookup_name,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    input: String,
    canonical: String,
    lookup: String,
    alternative: Option<String>,
}

#[test]
fn normalizes_card_names_for_collection_lookup() {
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("fixtures/card-names.json")).unwrap();
    for fixture in fixtures {
        let canonical = canonical_card_name(&fixture.input);
        assert_eq!(canonical, fixture.canonical, "{:?}", fixture.input);
        assert_eq!(
            card_lookup_name(&canonical),
            fixture.lookup,
            "{:?}",
            fixture.input
        );
        assert_eq!(
            ampersand_card_alternative(&canonical),
            fixture.alternative,
            "{:?}",
            fixture.input
        );
    }
}
