mod common;

use std::io::{Cursor, Read};

use deckpress_core::error::AppError;
use deckpress_core::layout::mm_to_pixels;
use deckpress_core::models::{
    Art, Backs, Deck, DeckEntry, LayoutMode, PrintFailureTarget, PrintSettings, Provider,
    ScmTemplate, Zone,
};
use deckpress_core::png_export::{build_png_zip, face_name, PngExport};
use deckpress_core::scm::effective_print_settings;
use deckpress_core::upscaler::CancelToken;

fn art(url: &str) -> Art {
    Art {
        id: url.into(),
        image_url: url.into(),
        ..common::art(0.0, Provider::Scryfall)
    }
}

fn entry(name: &str, faces: Vec<Art>, quantity: u32) -> DeckEntry {
    let mut entry = common::entry(faces[0].clone(), quantity);
    entry.id = name.into();
    entry.card.name = name.into();
    entry.card.faces = faces;
    entry
}

/// Bolt x3, a double-faced Delver, an excluded card and a sideboard card.
fn deck() -> Deck {
    let mut excluded = entry("Excluded Card", vec![art("excluded")], 2);
    excluded.excluded = true;
    let mut side = entry("Sideboard Card", vec![art("side")], 1);
    side.zone = Zone::Side;
    Deck {
        entries: vec![
            entry("Lightning Bolt", vec![art("bolt")], 3),
            entry(
                "Delver of Secrets // Insectile Aberration",
                vec![art("delver"), art("insectile")],
                1,
            ),
            excluded,
            side,
        ],
        ..common::deck(1)
    }
}

fn source(url: &str) -> Vec<u8> {
    let color = match url {
        "bolt" => [200, 30, 30],
        "delver" => [30, 30, 200],
        "insectile" => [30, 200, 30],
        _ => [0, 0, 0],
    };
    common::png(372, 520, color)
}

fn export(
    deck: &Deck,
    settings: &PrintSettings,
    cancel: &CancelToken,
) -> Result<(PngExport, Vec<u8>), AppError> {
    let mut buffer = Cursor::new(Vec::new());
    let output = build_png_zip(
        deck,
        settings,
        None,
        cancel,
        &mut |_, _, _| {},
        &mut |url| Ok(source(url)),
        &mut buffer,
    )?;
    Ok((output, buffer.into_inner()))
}

fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut file = archive.by_index(index).unwrap();
            let mut data = Vec::new();
            file.read_to_end(&mut data).unwrap();
            (file.name().to_string(), data)
        })
        .collect()
}

fn names(bytes: &[u8]) -> Vec<String> {
    entries(bytes).into_iter().map(|(name, _)| name).collect()
}

fn settings(backs: Backs) -> PrintSettings {
    PrintSettings {
        dpi: 150,
        backs,
        ..PrintSettings::default()
    }
}

#[test]
fn names_are_deterministic_and_slugged() {
    assert_eq!(
        face_name(2, 7, true, "Delver of Secrets // Insectile Aberration"),
        "sheet-002-slot-07-back-delver-of-secrets-insectile-aberration.png"
    );
    assert_eq!(
        face_name(1, 1, false, "Æther Vial"),
        "sheet-001-slot-01-front-æther-vial.png"
    );
    assert_eq!(
        face_name(1, 1, false, "?!"),
        "sheet-001-slot-01-front-card.png"
    );
}

#[test]
fn long_names_are_cut_by_bytes_on_a_char_boundary() {
    let prefix = "sheet-001-slot-01-front-".len();
    for card in ["𝔞".repeat(200), "ñ".repeat(200), "a".repeat(200)] {
        let name = face_name(1, 1, false, &card);
        let slug = &name[prefix..name.len() - ".png".len()];
        assert!(slug.len() <= 80 && slug.len() > 76, "{} bytes", slug.len());
        assert!(name.len() < 255);
        assert!(card.starts_with(slug));
    }
    assert_eq!(
        face_name(1, 1, false, &format!("{}-x", "a".repeat(79))),
        format!("sheet-001-slot-01-front-{}.png", "a".repeat(79))
    );
}

#[test]
fn whole_entry_names_stay_within_a_safe_byte_limit() {
    for card in ["𝔞".repeat(200), "ñ".repeat(200), "a".repeat(300)] {
        for back in [false, true] {
            let name = face_name(usize::MAX, usize::MAX, back, &card);
            assert!(name.len() <= 143, "{} bytes: {name}", name.len());
        }
    }
}

#[test]
fn writes_one_png_per_printed_front_honouring_quantities_and_exclusions() {
    let (output, bytes) = export(&deck(), &settings(Backs::None), &CancelToken::default()).unwrap();
    assert_eq!(output.faces, 4);
    assert!(output.skipped.is_empty());
    assert_eq!(
        names(&bytes),
        [
            "sheet-001-slot-01-front-lightning-bolt.png",
            "sheet-001-slot-02-front-lightning-bolt.png",
            "sheet-001-slot-03-front-lightning-bolt.png",
            "sheet-001-slot-04-front-delver-of-secrets-insectile-aberration.png",
        ]
    );
    let with_side = PrintSettings {
        include_sideboard: true,
        ..settings(Backs::None)
    };
    let (_, bytes) = export(&deck(), &with_side, &CancelToken::default()).unwrap();
    assert_eq!(
        names(&bytes).last().unwrap(),
        "sheet-001-slot-05-front-sideboard-card.png"
    );
}

#[test]
fn rasters_are_trim_plus_bleed_at_the_chosen_dpi_and_carry_it() {
    let deck = Deck {
        entries: vec![entry("Bolt", vec![art("bolt")], 1)],
        ..common::deck(1)
    };
    for ((width, height), dpi) in [(63.0, 88.0), (63.5, 88.9)]
        .into_iter()
        .flat_map(|size| [300, 800, 1200].map(|dpi| (size, dpi)))
    {
        let bleed_mm = 1.0;
        let settings = PrintSettings {
            dpi,
            bleed_mm,
            card_width_mm: width,
            card_height_mm: height,
            ..PrintSettings::default()
        };
        let (_, bytes) = export(&deck, &settings, &CancelToken::default()).unwrap();
        let expected = (
            mm_to_pixels(width + 2.0 * bleed_mm, dpi),
            mm_to_pixels(height + 2.0 * bleed_mm, dpi),
        );
        let pixels_per_metre = ((f64::from(dpi) / 0.0254).round() as u32).to_be_bytes();
        for (name, data) in entries(&bytes) {
            let image = image::load_from_memory(&data).unwrap();
            assert_eq!(
                (image.width(), image.height()),
                expected,
                "{name} {width}x{height} mm at {dpi} DPI"
            );
            let phys = data.windows(4).position(|w| w == b"pHYs").unwrap();
            assert_eq!(&data[phys + 4..phys + 8], &pixels_per_metre);
            assert_eq!(&data[phys + 8..phys + 12], &pixels_per_metre);
            assert_eq!(data[phys + 12], 1);
        }
    }
}

#[test]
fn duplex_and_separate_backs_add_back_faces_and_skip_faces_without_art() {
    for backs in [Backs::LongEdge, Backs::ShortEdge, Backs::Separate] {
        let (output, bytes) = export(&deck(), &settings(backs), &CancelToken::default()).unwrap();
        assert_eq!(output.faces, 5, "{backs:?}");
        assert_eq!(
            output.skipped,
            [
                "Lightning Bolt back (sheet 1, slot 1)",
                "Lightning Bolt back (sheet 1, slot 2)",
                "Lightning Bolt back (sheet 1, slot 3)",
            ],
            "{backs:?}"
        );
        assert_eq!(
            output.summary(),
            "5 PNG files ready · 3 faces without art skipped: \
             Lightning Bolt back (sheet 1, slot 1); Lightning Bolt back (sheet 1, slot 2); \
             Lightning Bolt back (sheet 1, slot 3)"
        );
        let files = entries(&bytes);
        let (name, data) = files.last().unwrap();
        assert_eq!(
            name,
            "sheet-001-slot-04-back-delver-of-secrets-insectile-aberration.png"
        );
        let pixel = image::load_from_memory(data).unwrap().to_rgb8();
        let (w, h) = pixel.dimensions();
        assert_eq!(pixel.get_pixel(w / 2, h / 2).0, [30, 200, 30]);
    }
}

#[test]
fn repeated_faces_are_identical_copies_and_archives_are_reproducible() {
    let (_, first) = export(&deck(), &settings(Backs::None), &CancelToken::default()).unwrap();
    let (_, second) = export(&deck(), &settings(Backs::None), &CancelToken::default()).unwrap();
    assert_eq!(first, second);
    let files = entries(&first);
    assert_eq!(files[0].1, files[1].1);
    assert_eq!(files[0].1, files[2].1);
    assert_ne!(files[0].1, files[3].1);
}

#[test]
fn page_range_limits_the_exported_sheets() {
    let deck = Deck {
        entries: vec![entry("Bolt", vec![art("bolt")], 12)],
        ..common::deck(1)
    };
    let ranged = PrintSettings {
        page_from: 2,
        page_to: 2,
        ..settings(Backs::None)
    };
    let (output, bytes) = export(&deck, &ranged, &CancelToken::default()).unwrap();
    assert_eq!(output.faces, 3);
    assert_eq!(names(&bytes)[0], "sheet-002-slot-01-front-bolt.png");
}

#[test]
fn scm_exports_use_the_template_card_size_and_bleed() {
    let scm = PrintSettings {
        layout_mode: LayoutMode::Scm,
        scm_template: ScmTemplate::default(),
        dpi: 300,
        ..PrintSettings::default()
    };
    let effective = effective_print_settings(&scm).unwrap();
    let (_, bytes) = export(&deck(), &scm, &CancelToken::default()).unwrap();
    let (_, data) = &entries(&bytes)[0];
    let image = image::load_from_memory(data).unwrap();
    let bleed = 2.0 * effective.bleed_mm;
    assert_eq!(
        (image.width(), image.height()),
        (
            mm_to_pixels(effective.card_width_mm + bleed, 300),
            mm_to_pixels(effective.card_height_mm + bleed, 300)
        )
    );
}

#[test]
fn a_failed_back_raster_identifies_its_card_and_face() {
    let result = build_png_zip(
        &deck(),
        &settings(Backs::LongEdge),
        None,
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |url| {
            Ok(if url == "insectile" {
                Vec::new()
            } else {
                source(url)
            })
        },
        Cursor::new(Vec::new()),
    );
    assert!(matches!(
        result,
        Err(AppError::PrintTarget {
            target: PrintFailureTarget::Card { entry_id, back: true },
            ..
        }) if entry_id == "Delver of Secrets // Insectile Aberration"
    ));
}

#[test]
fn cancelling_stops_the_export() {
    let cancel = CancelToken::default();
    cancel.cancel();
    assert!(matches!(
        export(&deck(), &settings(Backs::None), &cancel),
        Err(AppError::Cancelled)
    ));

    let cancel = CancelToken::default();
    let mut written = 0;
    let result = build_png_zip(
        &deck(),
        &settings(Backs::None),
        None,
        &cancel,
        &mut |completed, _, _| {
            written = completed;
            if completed == 1 {
                cancel.cancel();
            }
        },
        &mut |url| Ok(source(url)),
        Cursor::new(Vec::new()),
    );
    assert!(matches!(result, Err(AppError::Cancelled)));
    assert_eq!(written, 1);
}

#[test]
fn upscaling_without_a_model_is_refused() {
    let upscale = PrintSettings {
        upscale: true,
        ..settings(Backs::None)
    };
    assert!(matches!(
        export(&deck(), &upscale, &CancelToken::default()),
        Err(AppError::User(_))
    ));
}

#[test]
fn summaries_list_the_first_skipped_faces() {
    let summary = |skipped: usize| {
        PngExport {
            faces: 2,
            skipped: (1..=skipped)
                .map(|slot| format!("Card (sheet 1, slot {slot})"))
                .collect(),
        }
        .summary()
    };
    assert_eq!(summary(0), "2 PNG files ready");
    assert_eq!(
        summary(1),
        "2 PNG files ready · 1 face without art skipped: Card (sheet 1, slot 1)"
    );
    assert!(summary(5).ends_with("Card (sheet 1, slot 3); 2 more"));
    let single = PngExport {
        faces: 1,
        skipped: vec![],
    };
    assert_eq!(single.summary(), "1 PNG file ready");
}
