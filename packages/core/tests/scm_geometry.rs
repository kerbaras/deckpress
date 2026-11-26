use std::collections::HashSet;

use deckpress_core::layout::{create_layout, PrintLayout};
use deckpress_core::models::{Guides, LayoutMode, Orientation, Paper, PrintSettings, ScmTemplate};
use serde::Deserialize;

const TOLERANCE_MM: f64 = 0.01;

// Deckpress auto-fit uses a uniform inset and does not exclude SCM's registration corners.
const KNOWN_AUTO_GRID_MISMATCHES: [(&str, (u32, u32)); 7] = [
    ("a3-micro", (12, 6)),
    ("a4-domino", (6, 2)),
    ("a4-domino_square", (6, 4)),
    ("arch_b-70mm_square", (6, 4)),
    ("arch_b-micro", (13, 6)),
    ("legal-micro", (10, 4)),
    ("tabloid-mini", (9, 4)),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    gap_mm: f64,
    layouts: Vec<ScmLayout>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScmLayout {
    id: String,
    paper: String,
    card: String,
    orientation: Orientation,
    paper_mm: [f64; 2],
    inset_mm: f64,
    drawn_arm_mm: f64,
    columns: u32,
    rows: u32,
    trim_rects: Vec<TrimRect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrimRect {
    exact_mm: [f64; 4],
    scm_mm: [f64; 4],
}

fn assert_trim_matches(actual: &PrintLayout, expected: &ScmLayout) {
    let id = &expected.id;
    let to_mm = |pt: f64| pt * 25.4 / 72.0;
    assert_eq!(
        actual.slots.len(),
        expected.trim_rects.len(),
        "{id}: trim count"
    );
    for (index, (slot, rect)) in actual.slots.iter().zip(&expected.trim_rects).enumerate() {
        let trim = slot.trim;
        for ((field, actual_pt), expected_mm) in [
            ("x", trim.x),
            ("y", trim.y),
            ("width", trim.width),
            ("height", trim.height),
        ]
        .into_iter()
        .zip(rect.exact_mm)
        {
            let actual_mm = to_mm(actual_pt);
            assert!(
                (actual_mm - expected_mm).abs() <= TOLERANCE_MM,
                "{id} slot {index} {field}: expected {expected_mm:.4} mm, got {actual_mm:.4} mm (tolerance {TOLERANCE_MM} mm)"
            );
        }
    }
}

#[test]
fn scm_default_trim_geometry_matches_exact_mm() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../assets/scm/trim-rects.json")).unwrap();
    assert_eq!(fixture.layouts.len(), 114);
    let mut ids = HashSet::new();
    let mut known_mismatches_seen = 0;

    for expected in &fixture.layouts {
        let id = expected.id.as_str();
        assert!(ids.insert(id), "duplicate SCM layout {id}");
        let paper = match expected.paper.as_str() {
            "a3" => Paper::A3,
            "a4" => Paper::A4,
            "legal" => Paper::Legal,
            "letter" => Paper::Letter,
            "tabloid" => Paper::Tabloid,
            "arch_b" => Paper::Custom,
            other => panic!("unrecognized SCM paper {other}"),
        };
        let [_, _, card_width_mm, card_height_mm] = expected.trim_rects[0].exact_mm;
        let settings = PrintSettings {
            paper,
            custom_width_mm: expected.paper_mm[0],
            custom_height_mm: expected.paper_mm[1],
            card_width_mm,
            card_height_mm,
            orientation: expected.orientation,
            margin_mm: expected.inset_mm,
            gap_mm: fixture.gap_mm,
            bleed_mm: 0.0,
            guides: Guides::None,
            ..PrintSettings::default()
        };
        let auto = create_layout(&settings).unwrap_or_else(|err| panic!("{id}: {err}"));
        let scm_grid = (expected.columns, expected.rows);
        let auto_grid = (auto.columns, auto.rows);

        if let Some((_, known_grid)) = KNOWN_AUTO_GRID_MISMATCHES
            .iter()
            .find(|(name, _)| *name == id)
        {
            known_mismatches_seen += 1;
            assert_ne!(auto_grid, scm_grid, "{id}: remove stale known mismatch");
            assert_eq!(auto_grid, *known_grid, "{id}: known auto-fit grid changed");
            let fixed = create_layout(&PrintSettings {
                columns: expected.columns,
                rows: expected.rows,
                ..settings
            })
            .unwrap_or_else(|err| panic!("{id}: {err}"));
            assert_trim_matches(&fixed, expected);
        } else {
            assert_eq!(auto_grid, scm_grid, "{id}: auto-fit grid");
            assert_trim_matches(&auto, expected);
        }
    }

    assert_eq!(known_mismatches_seen, KNOWN_AUTO_GRID_MISMATCHES.len());
}

#[test]
fn scm_mode_matches_all_pixel_rounded_default_templates() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../assets/scm/trim-rects.json")).unwrap();
    assert_eq!(fixture.layouts.len(), 114);
    for expected in fixture.layouts {
        let actual = create_layout(&PrintSettings {
            layout_mode: LayoutMode::Scm,
            scm_template: ScmTemplate {
                paper: expected.paper,
                card: expected.card,
                ..ScmTemplate::default()
            },
            ..PrintSettings::default()
        })
        .unwrap_or_else(|err| panic!("{}: {err}", expected.id));
        assert_eq!(
            (actual.columns, actual.rows),
            (expected.columns, expected.rows),
            "{}",
            expected.id
        );
        assert_eq!(
            actual.slots.len(),
            expected.trim_rects.len(),
            "{}",
            expected.id
        );
        assert!(actual.guides.is_empty());
        let arm_mm = actual.registration_ink[1].width * 25.4 / 72.0 - 0.5;
        assert!(
            (arm_mm - expected.drawn_arm_mm.clamp(5.0, 20.0)).abs() < 1e-8,
            "{}",
            expected.id
        );
        for (index, (slot, rect)) in actual.slots.iter().zip(expected.trim_rects).enumerate() {
            let trim = slot.trim;
            for (pt, mm) in [trim.x, trim.y, trim.width, trim.height]
                .into_iter()
                .zip(rect.scm_mm)
            {
                assert!(
                    (pt * 25.4 / 72.0 - mm).abs() <= 0.02,
                    "{} slot {index}: {pt} pt != {mm} mm",
                    expected.id
                );
            }
        }
    }
}
