mod common;

use deckpress_core::models::{Backs, PrintSettings};
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
