mod common;

use deckpress_core::layout::{duplex_slot, mm_to_pt, scm_rotates_back};
use deckpress_core::models::{Backs, LayoutMode, PrintSettings, ScmTemplate, ScmVariant};
use deckpress_core::pdf::{build_pdf, print_plan, PdfServices};
use deckpress_core::upscaler::CancelToken;

#[test]
fn plans_sheets_and_duplex_sides() {
    let settings = PrintSettings::default();
    let plan = print_plan(&common::deck(10), &settings).unwrap();
    assert_eq!(plan.total_sheets, 2);
    assert_eq!(plan.sides.len(), 2);
    let duplex = PrintSettings {
        backs: Backs::LongEdge,
        ..PrintSettings::default()
    };
    let plan = print_plan(&common::deck(10), &duplex).unwrap();
    assert_eq!(plan.sides.len(), 4);
    assert!(plan.sides[1].back);
    let ranged = PrintSettings {
        page_from: 3,
        ..PrintSettings::default()
    };
    assert!(print_plan(&common::deck(10), &ranged).is_err());
}

#[test]
fn builds_a_pdf_with_calibration_page_and_cached_rasters() {
    let dir = tempfile::tempdir().unwrap();
    let settings = PrintSettings {
        dpi: 150,
        ..PrintSettings::default()
    };
    let png = common::png(372, 520, [30, 90, 200]);
    let raster_dir = dir.path().join("raster");
    let services = PdfServices {
        upscaler: None,
        raster_dir: &raster_dir,
    };
    let mut messages = Vec::new();
    let output = build_pdf(
        &common::deck(4),
        &settings,
        &services,
        &CancelToken::default(),
        &mut |_, _, message| messages.push(message),
        &mut |_| Ok(png.clone()),
    )
    .unwrap();
    assert_eq!(output.pages, 2);
    assert_eq!(output.unique_images, 1);
    assert!(output.bytes.starts_with(b"%PDF"));
    assert_eq!(std::fs::read_dir(&raster_dir).unwrap().count(), 1);
    assert!(messages.iter().any(|m| m.contains("Placed 4 of 4")));

    let duplex = PrintSettings {
        dpi: 150,
        backs: Backs::LongEdge,
        ..PrintSettings::default()
    };
    let output = build_pdf(
        &common::deck(4),
        &duplex,
        &services,
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |_| Ok(png.clone()),
    )
    .unwrap();
    assert_eq!(
        output.pages, 4,
        "calibration sheet keeps front/back pairs aligned"
    );
}

#[test]
fn builds_scm_standard_pdfs_with_registered_duplex() {
    let dir = tempfile::tempdir().unwrap();
    let png = common::png(372, 520, [30, 90, 200]);
    let services = PdfServices {
        upscaler: None,
        raster_dir: dir.path(),
    };
    for (paper, version) in [("a4", 5), ("letter", 6)] {
        for marks in [3, 4] {
            let settings = PrintSettings {
                layout_mode: LayoutMode::Scm,
                scm_template: ScmTemplate {
                    paper: paper.into(),
                    marks,
                    ..ScmTemplate::default()
                },
                backs: Backs::ShortEdge,
                dpi: 150,
                calibration_page: false,
                bleed_mm: 4.0,
                ..PrintSettings::default()
            };
            let deck = common::deck(4);
            let plan = print_plan(&deck, &settings).unwrap();
            let layout = plan.layout;
            let template = format!("{paper}-standard-v{version}");
            assert_eq!(layout.template_name.as_deref(), Some(template.as_str()));
            assert_eq!(
                layout.registration_ink.len(),
                if marks == 3 { 5 } else { 8 }
            );
            assert!(layout.guides.is_empty() && layout.registration.is_empty());
            assert!(scm_rotates_back(&layout));
            let first = &layout.slots[0];
            let back = duplex_slot(first, &layout, &settings);
            assert!((back.trim.y - layout.slots[layout.columns as usize].trim.y).abs() < 1e-8);
            assert_eq!(first.trim.x, back.trim.x);
            assert!((first.trim.x - first.rect.x - mm_to_pt(0.625)).abs() < 1e-8);
            let output = build_pdf(
                &deck,
                &settings,
                &services,
                &CancelToken::default(),
                &mut |_, _, _| {},
                &mut |_| Ok(png.clone()),
            )
            .unwrap();
            assert_eq!(output.pages, 2);
            assert!(output.bytes.starts_with(b"%PDF"));
            if let Some(evidence_dir) = std::env::var_os("DECKPRESS_SCM_EVIDENCE_DIR") {
                std::fs::write(
                    std::path::PathBuf::from(evidence_dir)
                        .join(format!("deckpress-{paper}-{marks}.pdf")),
                    output.bytes,
                )
                .unwrap();
            }
        }
    }
}

#[test]
fn scm_portrait_duplex_reverses_columns_without_rotating_art() {
    let settings = PrintSettings {
        layout_mode: LayoutMode::Scm,
        scm_template: ScmTemplate {
            variant: ScmVariant::Borderless,
            ..ScmTemplate::default()
        },
        backs: Backs::LongEdge,
        ..PrintSettings::default()
    };
    let layout = print_plan(&common::deck(4), &settings).unwrap().layout;
    assert_eq!(
        layout.template_name.as_deref(),
        Some("a4-standard-borderless-v2")
    );
    assert!(!scm_rotates_back(&layout));
    let back = duplex_slot(&layout.slots[0], &layout, &settings);
    assert!((back.trim.x - layout.slots[2].trim.x).abs() < 1e-8);
    assert_eq!(back.trim.y, layout.slots[0].trim.y);
}
