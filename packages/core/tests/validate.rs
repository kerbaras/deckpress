use deckpress_core::models::{ArtPreference, PrintSettings};

#[test]
fn print_settings_follow_the_ui_bounds() {
    assert!(PrintSettings::default().validate().is_ok());
    let cases = [
        PrintSettings {
            dpi: 149,
            ..PrintSettings::default()
        },
        PrintSettings {
            dpi: 1201,
            ..PrintSettings::default()
        },
        PrintSettings {
            custom_width_mm: 5000.0,
            ..PrintSettings::default()
        },
        PrintSettings {
            card_width_mm: f64::NAN,
            ..PrintSettings::default()
        },
        PrintSettings {
            bleed_mm: 6.0,
            ..PrintSettings::default()
        },
        PrintSettings {
            columns: 21,
            ..PrintSettings::default()
        },
        PrintSettings {
            guide_width_pt: 0.0,
            ..PrintSettings::default()
        },
        PrintSettings {
            bleed_color: "red".into(),
            ..PrintSettings::default()
        },
        PrintSettings {
            quality: 20,
            ..PrintSettings::default()
        },
        PrintSettings {
            page_from: 0,
            ..PrintSettings::default()
        },
    ];
    for (index, settings) in cases.iter().enumerate() {
        assert!(settings.validate().is_err(), "case {index}");
    }
}

#[test]
fn preferences_are_trimmed_deduplicated_and_bounded() {
    let saved = ArtPreference {
        rating: 3,
        favorite: true,
        tags: vec![" gritty ".into(), "gritty".into(), String::new()],
    }
    .normalized()
    .unwrap();
    assert_eq!(saved.tags, vec!["gritty".to_string()]);

    assert!(ArtPreference {
        rating: 6,
        ..ArtPreference::default()
    }
    .normalized()
    .is_err());
    assert!(ArtPreference {
        tags: (0..21).map(|i| format!("tag {i}")).collect(),
        ..ArtPreference::default()
    }
    .normalized()
    .is_err());
    assert!(ArtPreference {
        tags: vec!["x".repeat(41)],
        ..ArtPreference::default()
    }
    .normalized()
    .is_err());
    assert!(ArtPreference {
        tags: vec!["x".repeat(40)],
        ..ArtPreference::default()
    }
    .normalized()
    .is_ok());
}
