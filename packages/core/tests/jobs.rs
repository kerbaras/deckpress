mod common;

use deckpress_core::jobs::file_name;
use deckpress_core::models::{Deck, PrintSettings};

#[test]
fn file_names_are_safe_and_carry_the_dpi() {
    let deck = Deck {
        name: "Mono/Red: Burn!".into(),
        entries: vec![],
        ..common::deck(1)
    };
    assert_eq!(
        file_name(&deck, &PrintSettings::default()),
        "Mono-Red--Burn-800dpi.pdf"
    );
}
