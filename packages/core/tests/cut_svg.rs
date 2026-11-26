use deckpress_core::cut_svg::build_cut_svg;
use deckpress_core::layout::create_layout;
use deckpress_core::models::{LayoutMode, Orientation, Paper, PrintSettings};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

fn attr<'a>(element: &'a BytesStart<'_>, key: &str) -> &'a str {
    let value = element.try_get_attribute(key).unwrap().unwrap().value;
    match value {
        std::borrow::Cow::Borrowed(text) => text,
        std::borrow::Cow::Owned(_) => unreachable!(),
    }
}

#[test]
fn svg_sheet_size_and_trim_paths_match_print_layout() {
    for (settings, width, height) in [
        (PrintSettings::default(), 210.0, 297.0),
        (
            PrintSettings {
                paper: Paper::Custom,
                orientation: Orientation::Landscape,
                custom_width_mm: 204.5,
                custom_height_mm: 321.75,
                bleed_mm: 2.25,
                gap_mm: 3.5,
                ..PrintSettings::default()
            },
            321.75,
            204.5,
        ),
    ] {
        let layout = create_layout(&settings).unwrap();
        let svg = build_cut_svg(&settings).unwrap();
        let mut reader = Reader::from_str(&svg);
        reader.config_mut().trim_text(true);
        let Event::Start(root) = reader.read_event().unwrap() else {
            panic!("expected SVG root");
        };
        assert_eq!(root.name().as_ref(), "svg");
        assert_eq!(attr(&root, "xmlns"), "http://www.w3.org/2000/svg");
        let mm = |value: &str| value.strip_suffix("mm").unwrap().parse::<f64>().unwrap();
        assert_eq!(mm(attr(&root, "width")), width);
        assert_eq!(mm(attr(&root, "height")), height);
        assert_eq!(
            attr(&root, "viewBox")
                .split_whitespace()
                .map(|value| value.parse::<f64>().unwrap())
                .collect::<Vec<_>>(),
            [0.0, 0.0, width, height]
        );
        for slot in layout.slots {
            let Event::Empty(path) = reader.read_event().unwrap() else {
                panic!("expected a trim path for every slot");
            };
            assert_eq!(path.name().as_ref(), "path");
            assert_eq!(attr(&path, "fill"), "none");
            let d = attr(&path, "d");
            let tokens: Vec<_> = d.split_whitespace().collect();
            assert_eq!(
                tokens
                    .iter()
                    .copied()
                    .filter(|t| t.len() == 1 && t.as_bytes()[0].is_ascii_uppercase())
                    .collect::<Vec<_>>(),
                ["M", "H", "A", "V", "A", "H", "A", "V", "A", "Z"]
            );
            let trim = slot.trim;
            let mm = |pt: f64| pt / (72.0 / 25.4);
            let (x0, y0) = (mm(trim.x), mm(trim.y));
            let (x1, y1) = (mm(trim.x + trim.width), mm(trim.y + trim.height));
            let r = 3.0;
            let (left, right, top, bottom) = (x0 + r, x1 - r, y0 + r, y1 - r);
            let expected = [
                left, y0, right, r, r, 0.0, 0.0, 1.0, x1, top, bottom, r, r, 0.0, 0.0, 1.0, right,
                y1, left, r, r, 0.0, 0.0, 1.0, x0, bottom, top, r, r, 0.0, 0.0, 1.0, left, y0,
            ];
            let numbers: Vec<f64> = tokens.iter().filter_map(|t| t.parse().ok()).collect();
            assert_eq!(numbers.len(), expected.len());
            for (actual, expected) in numbers.into_iter().zip(expected) {
                assert!((actual - expected).abs() < 0.01, "{actual} ≠ {expected}");
            }
        }
        assert!(
            matches!(reader.read_event().unwrap(), Event::End(end) if end.name().as_ref() == "svg")
        );
        assert_eq!(reader.read_event().unwrap(), Event::Eof);
    }
}

#[test]
fn svg_rejects_scm_and_impossible_free_layouts() {
    assert!(build_cut_svg(&PrintSettings {
        layout_mode: LayoutMode::Scm,
        ..PrintSettings::default()
    })
    .unwrap_err()
    .to_string()
    .contains(".studio3"));
    assert!(build_cut_svg(&PrintSettings {
        columns: 10,
        ..PrintSettings::default()
    })
    .is_err());
}
