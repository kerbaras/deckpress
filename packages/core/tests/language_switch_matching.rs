mod common;

use std::collections::HashMap;

use deckpress_core::{
    art_policy::{ArtPolicy, Border, Frame, Printing, Treatment},
    language_switch::{choose_printing, LanguageTier},
};

fn printing(id: &str, set: &str, language: &str) -> Printing {
    Printing {
        id: id.into(),
        oracle_id: "card".into(),
        set: set.into(),
        collector: "1".into(),
        date: "2020-06-15".into(),
        language: language.into(),
        frame: "2015".into(),
        border: "black".into(),
        full_art: false,
        showcase: false,
        treatments: vec![],
        paper: true,
        promo: false,
        illustrations: vec![None],
        scans: Some(vec![common::scryfall_art()]),
    }
}

#[test]
fn closest_style_prefers_the_anchor_traits_and_nearest_release() {
    let anchor = printing("anchor", "source", "en");
    let matched = printing("z", "target", "es");
    let mut older_match = matched.clone();
    older_match.date = "2020-06-14".into();
    let mut newer_match = matched.clone();
    newer_match.date = "2020-06-17".into();
    let mut no_date = matched.clone();
    no_date.date.clear();
    let rank = |options: &[Printing]| {
        let (tier, print) = choose_printing(
            &anchor,
            options,
            "es",
            None,
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(tier, LanguageTier::Closest);
        print.id.clone()
    };

    let mut different = printing("a", "target", "es");
    different.frame = "1997".into();
    assert_eq!(rank(&[different.clone(), matched.clone()]), "z", "frame");
    different.frame.clone_from(&anchor.frame);
    different.border = "white".into();
    assert_eq!(rank(&[different.clone(), matched.clone()]), "z", "border");
    different.border.clone_from(&anchor.border);
    different.treatments.push("etched".into());
    assert_eq!(
        rank(&[different.clone(), matched.clone()]),
        "z",
        "treatment"
    );
    different.treatments.clear();
    different.full_art = true;
    assert_eq!(rank(&[different.clone(), matched]), "z", "full art");
    older_match.id = "nearer".into();
    newer_match.id = "newer".into();
    assert_eq!(
        rank(&[older_match, no_date, newer_match]),
        "nearer",
        "release date"
    );
}

#[test]
fn style_policy_prefers_treatment_without_filtering_or_overriding_the_tier() {
    let anchor = printing("anchor", "source", "en");
    let policy = ArtPolicy::Style {
        frame: Some(Frame::Current),
        border: Some(Border::Black),
        treatment: Some(Treatment::FullArt),
    };
    let regular = printing("regular", "target", "es");
    let mut preferred = printing("preferred", "target", "es");
    preferred.full_art = true;
    let mut wrong_frame = preferred.clone();
    wrong_frame.frame = "1997".into();
    let mut wrong_border = preferred.clone();
    wrong_border.border = "white".into();
    let same_print = printing("exact", "source", "es");
    let rank = |options: &[Printing]| {
        let (tier, print) = choose_printing(
            &anchor,
            options,
            "es",
            Some(&policy),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        (tier, print.id.clone())
    };
    assert_eq!(
        rank(&[wrong_frame, wrong_border, regular.clone()]),
        (LanguageTier::Closest, "regular".into())
    );
    assert_eq!(
        rank(&[regular, preferred.clone()]),
        (LanguageTier::Closest, "preferred".into())
    );
    assert_eq!(
        rank(&[preferred, same_print]),
        (LanguageTier::SamePrinting, "exact".into())
    );
}
