mod common;

use deckpress_core::layout::duplex_slot;
use deckpress_core::models::{Backs, LayoutMode, PrintSettings, ScmTemplate, ScmVariant, Zone};
use deckpress_core::pdf::{build_pdf, print_plan, PdfServices};
use deckpress_core::providers::normalize_scryfall;
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
fn builds_an_arch_b_scm_duplex_sheet_with_clamped_raster_bleed() {
    let dir = tempfile::tempdir().unwrap();
    let settings = PrintSettings {
        layout_mode: LayoutMode::Scm,
        scm_template: ScmTemplate {
            paper: "arch_b".into(),
            marks: 4,
            ..ScmTemplate::default()
        },
        bleed_mm: 4.0,
        dpi: 300,
        backs: Backs::LongEdge,
        calibration_page: false,
        ..PrintSettings::default()
    };
    let png = common::png(372, 520, [30, 90, 200]);
    let output = build_pdf(
        &common::deck(4),
        &settings,
        &PdfServices {
            raster_dir: dir.path(),
            upscaler: None,
        },
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |_| Ok(png.clone()),
    )
    .unwrap();
    assert_eq!(output.pages, 2);
    assert!(output.bytes.starts_with(b"%PDF"));
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let (width, height) = image::image_dimensions(entry.unwrap().path()).unwrap();
        assert_eq!((width, height), (744 + 2 * 7, 1039 + 2 * 7));
    }
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

#[test]
fn scm_portrait_pdf_reverses_back_columns_without_rotating_art() {
    let dir = tempfile::tempdir().unwrap();
    let settings = PrintSettings {
        layout_mode: LayoutMode::Scm,
        scm_template: ScmTemplate {
            variant: ScmVariant::Borderless,
            ..ScmTemplate::default()
        },
        backs: Backs::ShortEdge,
        dpi: 150,
        calibration_page: false,
        ..PrintSettings::default()
    };
    let mut deck = common::deck(3);
    deck.entries[0].selected_back = Some(common::scryfall_art());
    let layout = print_plan(&deck, &settings).unwrap().layout;
    assert!(layout.height > layout.width);
    assert_eq!(layout.columns, 3);
    let png = common::png(372, 520, [30, 90, 200]);
    let output = build_pdf(
        &deck,
        &settings,
        &PdfServices {
            raster_dir: dir.path(),
            upscaler: None,
        },
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |_| Ok(png.clone()),
    )
    .unwrap();
    let pdf = lopdf::Document::load_mem(&output.bytes).unwrap();
    let pages = pdf.get_pages();
    assert_eq!(pages.len(), 2);
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

    for (page, indices) in [(1, [0, 1, 2]), (2, [2, 1, 0])] {
        assert!(pdf
            .extract_text(&[page])
            .unwrap()
            .contains("sheet: 1, template: a4-standard-borderless-v2"));
        let content = pdf.get_and_decode_page_content(pages[&page]).unwrap();
        let placements: Vec<_> = content
            .operations
            .windows(2)
            .filter(|ops| ops[1].operator == "Do")
            .map(|ops| {
                assert_eq!(ops[0].operator, "cm");
                &ops[0].operands
            })
            .collect();
        assert_eq!(placements.len(), indices.len());
        for (matrix, index) in placements.into_iter().zip(indices) {
            let rect = layout.slots[index].rect;
            // Upright image scale and translation in PDF's bottom-left coordinates.
            let expected = [
                rect.width,
                0.0,
                0.0,
                rect.height,
                rect.x,
                layout.height - rect.y - rect.height,
            ];
            assert_eq!(matrix.len(), expected.len());
            for (value, want) in matrix.iter().zip(expected) {
                let got = f64::from(value.as_float().unwrap());
                assert!(
                    (got - want).abs() < 0.001,
                    "page {page}, slot {index}: {got} != {want}"
                );
            }
        }
    }
}

#[test]
fn prints_scryfall_dfc_back_in_the_mirrored_slot() {
    let mut deck = common::deck(1);
    let mut token = common::entry(common::scryfall_art(), 1);
    token.zone = Zone::Tokens;
    let front_url = "https://cards.scryfall.io/png/front/dfc.png";
    let back_url = "https://cards.scryfall.io/png/back/dfc.png";
    deck.entries[0].card = normalize_scryfall(&serde_json::json!({
        "id": "22bd1585-826a-4029-8cf8-354d320f2924",
        "name": "Delver of Secrets // Insectile Aberration",
        "set": "isd",
        "set_name": "Innistrad",
        "collector_number": "51",
        "card_faces": [
            {"name": "Delver of Secrets", "image_uris": {"png": front_url}},
            {"name": "Insectile Aberration", "image_uris": {"png": back_url}}
        ]
    }))
    .unwrap();
    deck.entries.push(token);
    let dir = tempfile::tempdir().unwrap();
    let services = PdfServices {
        upscaler: None,
        raster_dir: dir.path(),
    };
    for backs in [Backs::LongEdge, Backs::ShortEdge] {
        let settings = PrintSettings {
            backs,
            back_offset_xmm: 1.0,
            back_offset_ymm: -0.5,
            calibration_page: false,
            dpi: 150,
            ..PrintSettings::default()
        };
        let mut requested = Vec::new();
        let output = build_pdf(
            &deck,
            &settings,
            &services,
            &CancelToken::default(),
            &mut |_, _, _| {},
            &mut |url| {
                requested.push(url.to_owned());
                let color = match url {
                    url if url == front_url => [34, 119, 204],
                    url if url == back_url => [204, 85, 34],
                    _ => [34, 166, 102],
                };
                Ok(common::png(372, 520, color))
            },
        )
        .unwrap();
        assert_eq!(
            requested,
            [front_url, &deck.entries[1].front_art().image_url, back_url]
        );
        assert_eq!(output.pages, 2);
        assert_eq!(output.unique_images, 3);

        let plan = print_plan(&deck, &settings).unwrap();
        let doc = lopdf::Document::load_mem(&output.bytes).unwrap();
        let pages = doc.get_pages();
        for (page, back) in [(1, false), (2, true)] {
            let content = doc.get_and_decode_page_content(pages[&page]).unwrap();
            let mut state = Vec::new();
            let mut ctm = [1.0_f32, 1.0, 0.0, 0.0];
            let mut images = Vec::new();
            for op in &content.operations {
                match op.operator.as_str() {
                    "q" => state.push(ctm),
                    "Q" => ctm = state.pop().unwrap(),
                    "cm" => {
                        let get = |i: usize| op.operands[i].as_float().unwrap();
                        ctm = [
                            ctm[0] * get(0),
                            ctm[1] * get(3),
                            ctm[0] * get(4) + ctm[2],
                            ctm[1] * get(5) + ctm[3],
                        ];
                    }
                    "Do" => images.push(ctm),
                    _ => {}
                }
            }
            assert_eq!(images.len(), if back { 1 } else { 2 });
            let first = plan.layout.slots[0];
            let expected = if back {
                duplex_slot(&first, &plan.layout, &settings)
            } else {
                first
            };
            let [w, h, x, y] = images[0];
            for (actual, expected) in [
                (w, expected.rect.width),
                (h, expected.rect.height),
                (x, expected.rect.x),
                (
                    y,
                    plan.layout.height - expected.rect.y - expected.rect.height,
                ),
            ] {
                assert!(
                    (f64::from(actual) - expected).abs() < 0.01,
                    "{actual} != {expected}"
                );
            }
        }
    }
}
