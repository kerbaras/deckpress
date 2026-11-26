use deckpress_core::layout::{create_layout, duplex_slot, fit_sheet_label, mm_to_pt, sheet_label};
use deckpress_core::models::{Backs, Guides, Paper, PrintSettings};

#[test]
fn labels_the_exact_trim_bleed_and_dpi_on_a_back_sheet() {
    let settings = PrintSettings {
        card_width_mm: 63.5,
        card_height_mm: 88.9,
        bleed_mm: 0.625,
        dpi: 600,
        ..PrintSettings::default()
    };
    assert_eq!(
        sheet_label(&settings, " Proof ★ ", 2, 3, true),
        "PROOF / SHEET 2 OF 3 / BACKS / TRIM 63.5 × 88.9 mm / 0.625 mm BLEED / 600 DPI / PRINT AT 100%"
    );
}

#[test]
fn formats_label_numbers_from_the_shared_vectors() {
    #[derive(serde::Deserialize)]
    struct Case {
        settings: PrintSettings,
        expected: String,
    }

    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/sheet-label-numbers.json")).unwrap();
    for Case { settings, expected } in cases {
        settings.validate().unwrap();
        assert_eq!(
            sheet_label(&settings, "Proof", 1, 1, false),
            format!("PROOF / SHEET 1 OF 1 / FRONTS / {expected} / PRINT AT 100%"),
        );
    }
}

#[test]
fn fits_the_complete_sheet_label_at_the_first_slot_on_narrow_paper() {
    let cases = [
        (
            PrintSettings {
                paper: Paper::Custom,
                custom_width_mm: 115.0,
                custom_height_mm: 180.0,
                card_width_mm: 63.5,
                card_height_mm: 88.9,
                bleed_mm: 0.625,
                dpi: 300,
                ..PrintSettings::default()
            },
            "QA PRINT PROOF / SHEET 1 OF 11 / FRONTS / TRIM 63.5 × 88.9 mm / 0.625 mm BLEED / 300 DPI / PRINT AT 100%",
        ),
        (
            PrintSettings {
                paper: Paper::Custom,
                custom_width_mm: 40.0,
                custom_height_mm: 40.0,
                card_width_mm: 25.0,
                card_height_mm: 25.0,
                bleed_mm: 0.0,
                dpi: 150,
                guides: Guides::Full,
                ..PrintSettings::default()
            },
            "QA PRINT PROOF / SHEET 1 OF 11 / FRONTS / TRIM 25 × 25 mm / 0 mm BLEED / 150 DPI / PRINT AT 100%",
        ),
    ];
    for (settings, expected) in cases {
        settings.validate().unwrap();
        let layout = create_layout(&settings).unwrap();
        let sheets = 11_usize.div_ceil(layout.slots.len());
        let text = sheet_label(&settings, "QA print proof ★", 1, sheets, false);
        assert_eq!(text, expected);
        let placement = fit_sheet_label(&layout, &text).unwrap();
        assert_eq!(placement.x, layout.slots[0].rect.x);
        assert_eq!(Some(placement.baseline), layout.label_baseline);
        assert!(placement.font_size_pt > 0.0 && placement.font_size_pt < 5.0);
        let right = placement.x + text.chars().count() as f64 * 0.6 * placement.font_size_pt;
        assert!((right - (layout.width - mm_to_pt(4.0))).abs() < 1e-6);
    }
}

#[test]
fn a4_fits_nine_cards_with_default_settings() {
    let layout = create_layout(&PrintSettings::default()).unwrap();
    assert_eq!((layout.columns, layout.rows), (3, 3));
    assert_eq!(layout.slots.len(), 9);
    assert!((layout.width - 595.2756).abs() < 0.001);
    assert!((layout.height - 841.8898).abs() < 0.001);
    // 24 outer marks plus a tick on every trim line in each of the two
    // interior gutters: 2 gutters x 6 trim lines, both ways.
    assert_eq!(layout.guides.len(), 48);
    assert!(layout.registration.is_empty());
    assert!(layout.label_baseline.is_some());
}

#[test]
fn interior_marks_stay_inside_the_bleed() {
    let layout = create_layout(&PrintSettings::default()).unwrap();
    let first = layout.slots[0].trim;
    let below = layout.slots[3].trim;
    let tick = layout
        .guides
        .iter()
        .find(|g| g.x1 == first.x && g.y1 > first.y + first.height && g.y2 < below.y)
        .expect("tick between rows");
    assert!((tick.y1 - (first.y + first.height + mm_to_pt(0.5))).abs() < 1e-9);
    assert!((tick.y2 - (below.y - mm_to_pt(0.5))).abs() < 1e-9);
}

#[test]
fn no_interior_marks_without_bleed_or_gap() {
    let settings = PrintSettings {
        bleed_mm: 0.0,
        ..PrintSettings::default()
    };
    // Shared trim edges collapse to 4 lines each way: 16 outer marks.
    assert_eq!(create_layout(&settings).unwrap().guides.len(), 16);
}

#[test]
fn duplex_sheets_get_registration_targets() {
    let settings = PrintSettings {
        backs: Backs::LongEdge,
        ..PrintSettings::default()
    };
    let layout = create_layout(&settings).unwrap();
    assert_eq!(layout.registration.len(), 3);
    let clean = PrintSettings {
        guides: Guides::None,
        ..settings
    };
    let layout = create_layout(&clean).unwrap();
    assert!(layout.registration.is_empty());
    assert!(layout.label_baseline.is_none());
}

#[test]
fn rejects_grids_that_do_not_fit() {
    let settings = PrintSettings {
        columns: 5,
        ..PrintSettings::default()
    };
    assert!(create_layout(&settings).is_err());
}

#[test]
fn long_edge_duplex_mirrors_horizontally_on_portrait_paper() {
    let settings = PrintSettings {
        backs: Backs::LongEdge,
        ..PrintSettings::default()
    };
    let layout = create_layout(&settings).unwrap();
    let first = layout.slots[0];
    let back = duplex_slot(&first, &layout, &settings);
    assert!((back.rect.x - (layout.width - first.rect.x - first.rect.width)).abs() < 1e-9);
    assert!((back.rect.y - first.rect.y).abs() < 1e-9);
}
