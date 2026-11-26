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
    let pdf = lopdf::Document::load_mem(&output.bytes).unwrap();
    let prefs = pdf
        .catalog()
        .unwrap()
        .get(b"ViewerPreferences")
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        prefs.get(b"PrintScaling").unwrap().as_name().unwrap(),
        b"None"
    );
    assert!(!prefs.has(b"Duplex"));
    let calibration = pdf.get_pages()[&1];
    let content =
        lopdf::content::Content::decode(&pdf.get_page_content(calibration).unwrap()).unwrap();
    let mut path = Vec::new();
    let mut measured_box = false;
    let mut measured_ruler = false;
    for op in content.operations {
        match op.operator.as_str() {
            "m" | "l" => {
                let [x, y] = op.operands.as_slice() else {
                    unreachable!()
                };
                path.push((x.as_float().unwrap(), y.as_float().unwrap()));
            }
            "S" | "s" => {
                if let [(x1, y1), (x2, y2)] = path.as_slice() {
                    measured_ruler |= (y2 - y1).abs() < 0.01
                        && ((x2 - x1).abs() * 25.4 / 72.0 - 50.0).abs() < 0.05;
                }
                if path.len() == 4 {
                    let bounds = |coordinate: fn(&(f32, f32)) -> f32| {
                        let min = path.iter().map(coordinate).fold(f32::INFINITY, f32::min);
                        let max = path
                            .iter()
                            .map(coordinate)
                            .fold(f32::NEG_INFINITY, f32::max);
                        (max - min) * 25.4 / 72.0
                    };
                    measured_box |= (bounds(|p| p.0) - 63.0).abs() < 0.05
                        && (bounds(|p| p.1) - 88.0).abs() < 0.05;
                }
                path.clear();
            }
            _ => {}
        }
    }
    assert!(
        measured_ruler,
        "calibration page has a 50 mm horizontal rule"
    );
    assert!(measured_box, "calibration page has a 63 × 88 mm box");

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
    let pdf = lopdf::Document::load_mem(&output.bytes).unwrap();
    let prefs = pdf
        .catalog()
        .unwrap()
        .get(b"ViewerPreferences")
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        prefs.get(b"Duplex").unwrap().as_name().unwrap(),
        b"DuplexFlipLongEdge"
    );
}
