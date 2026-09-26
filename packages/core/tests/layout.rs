use deckpress_core::layout::{create_layout, duplex_slot, mm_to_pt};
use deckpress_core::models::{Backs, Guides, PrintSettings};

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
