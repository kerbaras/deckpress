use deckpress_core::card_names::{card_lookup_name, split_card_alternative};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    input: String,
    lookup: String,
    alternative: Option<String>,
}

#[test]
fn looks_up_card_names_and_prepares_split_fallbacks() {
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("fixtures/card-names.json")).unwrap();
    for fixture in fixtures {
        assert_eq!(
            card_lookup_name(&fixture.input),
            fixture.lookup,
            "{:?}",
            fixture.input
        );
        assert_eq!(
            split_card_alternative(&fixture.input),
            fixture.alternative,
            "{:?}",
            fixture.input
        );
    }
}
