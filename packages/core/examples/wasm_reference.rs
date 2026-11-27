use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

use deckpress_core::models::{Deck, PrintSettings};
use deckpress_core::pdf::{build_pdf, PdfServices};
use deckpress_core::upscaler::CancelToken;
use deckpress_core::AppResult;
use lopdf::{Document, Object};

fn geometry(path: &Path) -> (Vec<f64>, Vec<[f64; 4]>) {
    let pdf = Document::load(path).unwrap();
    let pages = pdf.get_pages();
    assert_eq!(pages.len(), 1);
    let page = pages[&1];
    let media = pdf
        .get_dictionary(page)
        .unwrap()
        .get(b"MediaBox")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|box_coord| f64::from(box_coord.as_float().unwrap()))
        .collect();
    let mut stack = Vec::new();
    let mut matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut boxes = Vec::new();
    for op in pdf.get_and_decode_page_content(page).unwrap().operations {
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
            "Do" => {
                let [a, b, c, d, e, f] = matrix;
                let corners = [
                    (e, f),
                    (a + e, b + f),
                    (c + e, d + f),
                    (a + c + e, b + d + f),
                ];
                let limits = |coordinate: fn((f64, f64)) -> f64| {
                    let min = corners
                        .into_iter()
                        .map(coordinate)
                        .fold(f64::INFINITY, f64::min);
                    let max = corners
                        .into_iter()
                        .map(coordinate)
                        .fold(f64::NEG_INFINITY, f64::max);
                    (min, max)
                };
                let (x0, x1) = limits(|(x, _)| x);
                let (y0, y1) = limits(|(_, y)| y);
                boxes.push([x0, y0, x1, y1]);
            }
            _ => {}
        }
    }
    let catalog = pdf.catalog().unwrap();
    assert_eq!(
        catalog
            .get(b"ViewerPreferences")
            .and_then(Object::as_dict)
            .and_then(|dict| dict.get(b"PrintScaling"))
            .and_then(Object::as_name)
            .unwrap(),
        b"None"
    );
    (media, boxes)
}

fn close_mm(a: f64, b: f64) {
    let difference = (a - b).abs() * 25.4 / 72.0;
    assert!(
        difference <= 0.01,
        "{a} vs {b} pt differs by {difference} mm"
    );
}

fn main() -> AppResult<()> {
    let dir = std::env::args_os().nth(1).expect("fixture directory");
    let dir = Path::new(&dir);
    let deck: Deck = serde_json::from_slice(&fs::read(dir.join("deck.json"))?)?;
    let settings: PrintSettings = serde_json::from_slice(&fs::read(dir.join("settings.json"))?)?;
    let cache = tempfile::tempdir()?;
    let native = build_pdf(
        &deck,
        &settings,
        &PdfServices {
            raster_dir: cache.path(),
            upscaler: None,
        },
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |key| Ok(fs::read(dir.join(key))?),
    )?;
    assert_eq!(native.unique_images, 8);
    fs::write(dir.join("native.pdf"), native.bytes)?;

    let (native_page, native_boxes) = geometry(&dir.join("native.pdf"));
    let (wasm_page, wasm_boxes) = geometry(&dir.join("wasm.pdf"));
    assert_eq!(native_page.len(), 4);
    assert_eq!(wasm_page.len(), 4);
    let mut paper = [
        native_page[2] - native_page[0],
        native_page[3] - native_page[1],
    ];
    paper.sort_by(f64::total_cmp);
    close_mm(paper[0], 210.0 * 72.0 / 25.4);
    close_mm(paper[1], 297.0 * 72.0 / 25.4);
    assert_eq!(native_boxes.len(), 8);
    assert_eq!(wasm_boxes.len(), 8);
    for (native, wasm) in native_page
        .into_iter()
        .chain(native_boxes.into_iter().flatten())
        .zip(
            wasm_page
                .into_iter()
                .chain(wasm_boxes.into_iter().flatten()),
        )
    {
        close_mm(native, wasm);
    }

    let mut zip = zip::ZipArchive::new(Cursor::new(fs::read(dir.join("wasm.zip"))?))
        .map_err(deckpress_core::AppError::internal)?;
    assert_eq!(zip.len(), 8);
    let effective = deckpress_core::scm::effective_print_settings(&settings)?;
    let expected = deckpress_core::layout::face_pixels(
        effective.card_width_mm,
        effective.card_height_mm,
        effective.bleed_mm,
        effective.dpi,
    );
    for index in 0..zip.len() {
        let mut png = Vec::new();
        let mut entry = zip
            .by_index(index)
            .map_err(deckpress_core::AppError::internal)?;
        assert!(entry.name().ends_with(".png"));
        entry.read_to_end(&mut png)?;
        assert_eq!(
            deckpress_core::raster::decode(&png)?
                .into_rgb8()
                .dimensions(),
            (
                expected.trim_width + 2 * expected.bleed,
                expected.trim_height + 2 * expected.bleed
            )
        );
    }
    println!("A4 MediaBox and all 8 card boxes match within 0.01 mm; 8 print-sized PNGs verified");
    Ok(())
}
