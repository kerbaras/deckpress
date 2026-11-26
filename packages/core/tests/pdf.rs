mod common;

use deckpress_core::layout::{duplex_slot, mm_to_pixels, mm_to_pt};
use deckpress_core::models::{
    Backs, LayoutMode, Orientation, Paper, PrintSettings, ScmTemplate, ScmVariant, Zone,
};
use deckpress_core::pdf::{build_duplex_calibration_pdf, build_pdf, print_plan, PdfServices};
use deckpress_core::providers::normalize_scryfall;
use deckpress_core::scm::effective_print_settings;
use deckpress_core::upscaler::CancelToken;
use serde::Deserialize;

#[test]
fn a_single_card_face_is_singular_in_progress() {
    let dir = tempfile::tempdir().unwrap();
    let mut messages = Vec::new();
    build_pdf(
        &common::deck(1),
        &PrintSettings {
            calibration_page: false,
            dpi: 150,
            ..PrintSettings::default()
        },
        &PdfServices {
            raster_dir: dir.path(),
            upscaler: None,
        },
        &CancelToken::default(),
        &mut |_, _, message| messages.push(message),
        &mut |_| Ok(common::png(372, 520, [30, 90, 200])),
    )
    .unwrap();
    assert_eq!(
        messages.last().map(String::as_str),
        Some("Placed 1 of 1 card face")
    );
}

#[test]
fn pdf_page_tree_matches_the_print_setup_counts() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        quantity: u32,
        settings: PrintSettings,
        card_sheets: usize,
        pdf_pages: usize,
        calibration_pages: usize,
        ruler_mm: Option<usize>,
    }

    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/print-page-counts.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let png = common::png(372, 520, [30, 90, 200]);
    for case in cases {
        let mut deck = common::deck(case.quantity);
        if case.quantity == 0 {
            deck.entries.clear();
        }
        let settings = PrintSettings {
            dpi: 150,
            ..case.settings
        };
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
        );
        if case.card_sheets == 0 {
            let message = if case.quantity == 0 {
                "No cards are included in this print job"
            } else {
                "Page range is outside the deck"
            };
            assert!(
                matches!(output, Err(error) if error.to_string() == message),
                "{}",
                case.name
            );
            assert_eq!(case.pdf_pages, 0, "{}", case.name);
            assert_eq!(case.calibration_pages, 0, "{}", case.name);
            continue;
        }
        let output = output.unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let plan = print_plan(&deck, &settings).unwrap();
        let pdf = lopdf::Document::load_mem(&output.bytes).unwrap();
        let pdf_pages = pdf.get_pages().len();
        let card_sheets = plan.sides.iter().filter(|side| !side.back).count();
        assert_eq!(card_sheets, case.card_sheets, "{}", case.name);
        assert_eq!(output.pages, case.pdf_pages, "{}", case.name);
        assert_eq!(pdf_pages, case.pdf_pages, "{}", case.name);
        if let Some(ruler_mm) = case.ruler_mm {
            let calibration = pdf.extract_text(&[1]).unwrap();
            assert!(calibration.contains(&format!("{ruler_mm} mm ruler")));
            assert!(!calibration.contains("MTG reference"));
        }
        assert_eq!(
            pdf_pages - plan.sides.len(),
            case.calibration_pages,
            "{}",
            case.name
        );
    }
}

fn image_matrices(
    content: &lopdf::content::Content<Vec<lopdf::content::Operation>>,
) -> Vec<[f64; 6]> {
    let mut stack = Vec::new();
    let mut matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut images = Vec::new();
    for op in &content.operations {
        match op.operator.as_str() {
            "q" => stack.push(matrix),
            "Q" => matrix = stack.pop().unwrap(),
            "cm" => {
                let [a, b, c, d, e, f] = matrix;
                let [g, h, i, j, k, l] =
                    std::array::from_fn(|n| f64::from(op.operands[n].as_float().unwrap()));
                matrix = [
                    a * g + c * h,
                    b * g + d * h,
                    a * i + c * j,
                    b * i + d * j,
                    a * k + c * l + e,
                    b * k + d * l + f,
                ];
            }
            "Do" => images.push(matrix),
            _ => {}
        }
    }
    images
}

#[test]
fn rotates_only_back_art_about_the_sheet_centre_in_free_and_scm_layouts() {
    let dir = tempfile::tempdir().unwrap();
    let services = PdfServices {
        raster_dir: dir.path(),
        upscaler: None,
    };
    let png = common::png(372, 520, [30, 90, 200]);
    let mut deck = common::deck(1);
    deck.entries[0].selected_back = Some(common::scryfall_art());
    for (layout_mode, variant) in [
        (LayoutMode::Free, ScmVariant::Default),
        (LayoutMode::Scm, ScmVariant::Default),
        (LayoutMode::Scm, ScmVariant::Borderless),
    ] {
        let settings = PrintSettings {
            layout_mode,
            scm_template: ScmTemplate {
                variant,
                ..ScmTemplate::default()
            },
            backs: Backs::LongEdge,
            back_offset_xmm: 1.25,
            back_offset_ymm: -0.75,
            back_rotation_deg: 3.0,
            dpi: 150,
            calibration_page: false,
            ..PrintSettings::default()
        };
        let layout = print_plan(&deck, &settings).unwrap().layout;
        let output = build_pdf(
            &deck,
            &settings,
            &services,
            &CancelToken::default(),
            &mut |_, _, _| {},
            &mut |_| Ok(png.clone()),
        )
        .unwrap();
        let doc = lopdf::Document::load_mem(&output.bytes).unwrap();
        let pages = doc.get_pages();
        for (page, back) in [(1, false), (2, true)] {
            let content = doc.get_and_decode_page_content(pages[&page]).unwrap();
            let matrices = image_matrices(&content);
            assert_eq!(matrices.len(), 1);
            let [a, b, c, d, e, f] = matrices[0];
            let first = layout.slots[0];
            let rect = if back {
                duplex_slot(&first, &layout, &settings).rect
            } else {
                first.rect
            };
            let (page_x, page_y) = (layout.width / 2.0, layout.height / 2.0);
            let x = rect.x + rect.width / 2.0 - page_x;
            let y = rect.y + rect.height / 2.0 - page_y;
            let radians = if back { 3.0_f64.to_radians() } else { 0.0 };
            let (sin, cos) = radians.sin_cos();
            let sign = if back
                && layout
                    .scm
                    .as_ref()
                    .is_some_and(|scm| scm.orientation == Orientation::Landscape)
            {
                -1.0
            } else {
                1.0
            };
            for (actual, expected) in [
                (e + (a + c) / 2.0, page_x + x * cos - y * sin),
                (f + (b + d) / 2.0, page_y - x * sin - y * cos),
                (a, sign * rect.width * cos),
                (b, -sign * rect.width * sin),
                (c, sign * rect.height * sin),
                (d, sign * rect.height * cos),
            ] {
                assert!(
                    (actual - expected).abs() < 0.01,
                    "{layout_mode:?}/{variant:?}, page {page}: {actual} != {expected}"
                );
            }
        }
    }
}

#[test]
fn exports_a_two_sided_duplex_grid_for_scm_and_tiny_custom_paper() {
    for (settings, duplex, (width, height), targets) in [
        (
            PrintSettings {
                paper: Paper::Custom,
                custom_width_mm: 40.0,
                custom_height_mm: 40.0,
                backs: Backs::ShortEdge,
                back_offset_xmm: 10.0,
                back_offset_ymm: 10.0,
                back_rotation_deg: 45.0,
                ..PrintSettings::default()
            },
            b"DuplexFlipShortEdge".as_slice(),
            (40.0, 40.0),
            9,
        ),
        (
            PrintSettings {
                layout_mode: LayoutMode::Scm,
                backs: Backs::ShortEdge,
                ..PrintSettings::default()
            },
            b"DuplexFlipLongEdge".as_slice(),
            (297.0, 210.0),
            25,
        ),
    ] {
        let bytes = build_duplex_calibration_pdf(&settings).unwrap();
        let doc = lopdf::Document::load_mem(&bytes).unwrap();
        let pages = doc.get_pages();
        assert_eq!(pages.len(), 2);
        let prefs = doc
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
        assert_eq!(prefs.get(b"Duplex").unwrap().as_name().unwrap(), duplex);
        for (number, side) in [(1, "Front"), (2, "Back")] {
            let id = pages[&number];
            assert!(doc.extract_text(&[number]).unwrap().contains(side));
            let page = doc.get_dictionary(id).unwrap();
            let media = page.get(b"MediaBox").unwrap().as_array().unwrap();
            for (value, extent) in [(2, width), (3, height)] {
                assert!(
                    (f64::from(media[value].as_float().unwrap()) - mm_to_pt(extent)).abs() < 0.01
                );
            }
            let content = doc.get_and_decode_page_content(id).unwrap();
            assert_eq!(
                content
                    .operations
                    .iter()
                    .filter(|op| op.operator == "l")
                    .count(),
                targets * 2
            );
            assert_eq!(
                content
                    .operations
                    .iter()
                    .filter(|op| op.operator == "S")
                    .count(),
                targets * if number == 1 { 3 } else { 2 }
            );
        }
    }
}

#[test]
fn tiny_print_size_calibration_uses_a_short_physical_ruler() {
    let dir = tempfile::tempdir().unwrap();
    let settings = PrintSettings {
        paper: Paper::Custom,
        custom_width_mm: 40.0,
        custom_height_mm: 40.0,
        card_width_mm: 25.0,
        card_height_mm: 25.0,
        margin_mm: 0.0,
        dpi: 150,
        ..PrintSettings::default()
    };
    let output = build_pdf(
        &common::deck(1),
        &settings,
        &PdfServices {
            raster_dir: dir.path(),
            upscaler: None,
        },
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |_| Ok(common::png(256, 256, [30, 90, 200])),
    )
    .unwrap();
    let pdf = lopdf::Document::load_mem(&output.bytes).unwrap();
    assert!(pdf.extract_text(&[1]).unwrap().contains("20 mm ruler"));
    let content = pdf
        .get_and_decode_page_content(pdf.get_pages()[&1])
        .unwrap();
    let horizontal = content
        .operations
        .windows(2)
        .find(|pair| pair[0].operator == "m" && pair[1].operator == "l")
        .unwrap();
    let value =
        |op: usize, coord: usize| f64::from(horizontal[op].operands[coord].as_float().unwrap());
    assert!((value(1, 0) - value(0, 0) - mm_to_pt(20.0)).abs() < 0.01);
    for op in content
        .operations
        .iter()
        .filter(|op| ["m", "l"].contains(&op.operator.as_str()))
    {
        for coord in &op.operands {
            assert!((0.0..mm_to_pt(40.0)).contains(&f64::from(coord.as_float().unwrap())));
        }
    }
}

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
        let effective = effective_print_settings(&settings).unwrap();
        let bleed = 2.0 * effective.bleed_mm;
        assert_eq!(
            (width, height),
            (
                mm_to_pixels(effective.card_width_mm + bleed, 300),
                mm_to_pixels(effective.card_height_mm + bleed, 300)
            )
        );
        assert_eq!((width, height), (759, 1054));
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
