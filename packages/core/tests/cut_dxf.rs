use deckpress_core::cut_dxf::build_cut_dxf;
use deckpress_core::layout::create_layout;
use deckpress_core::models::{LayoutMode, Orientation, Paper, PrintSettings, ScmVariant};

#[test]
fn dxf_uses_closed_rounded_trim_paths_in_millimeters() {
    for settings in [
        PrintSettings::default(),
        PrintSettings {
            paper: Paper::Custom,
            orientation: Orientation::Landscape,
            custom_width_mm: 204.5,
            custom_height_mm: 321.75,
            bleed_mm: 2.25,
            gap_mm: 3.5,
            ..PrintSettings::default()
        },
        PrintSettings {
            layout_mode: LayoutMode::Scm,
            scm_template: deckpress_core::models::ScmTemplate {
                paper: "arch_b".into(),
                variant: ScmVariant::Borderless,
                ..PrintSettings::default().scm_template
            },
            ..PrintSettings::default()
        },
    ] {
        let layout = create_layout(&settings).unwrap();
        let dxf = build_cut_dxf(&settings).unwrap();
        assert!(dxf.contains("9\n$INSUNITS\n70\n4\n"));
        let mut entities = dxf.split("0\nLWPOLYLINE\n").skip(1);
        let mm = |pt: f64| pt * 25.4 / 72.0;
        let height = mm(layout.height);
        for slot in layout.slots {
            let mut lines = entities.next().unwrap().lines();
            let mut points = Vec::new();
            while let (Some(code), Some(value)) = (lines.next(), lines.next()) {
                if code == "70" {
                    assert_eq!(value, "1");
                }
                if code == "10" {
                    assert_eq!(lines.next(), Some("20"));
                    let y: f64 = lines.next().unwrap().parse().unwrap();
                    assert_eq!(lines.next(), Some("42"));
                    let bulge: f64 = lines.next().unwrap().parse().unwrap();
                    points.push((value.parse::<f64>().unwrap(), height - y, bulge));
                }
            }
            let trim = slot.trim;
            let (x0, y0) = (mm(trim.x), mm(trim.y));
            let (x1, y1) = (mm(trim.x + trim.width), mm(trim.y + trim.height));
            let r = 3.0;
            let expected = [
                (x0 + r, y0),
                (x1 - r, y0),
                (x1, y0 + r),
                (x1, y1 - r),
                (x1 - r, y1),
                (x0 + r, y1),
                (x0, y1 - r),
                (x0, y0 + r),
            ];
            assert_eq!(points.len(), expected.len());
            for (i, ((x, y, bulge), (ex, ey))) in points.into_iter().zip(expected).enumerate() {
                assert!((x - ex).abs().max((y - ey).abs()) < 0.01);
                let angle = if i % 2 == 0 { 0.0 } else { -90.0 };
                assert!((4.0 * bulge.atan().to_degrees() - angle).abs() < 1e-6);
            }
        }
        assert!(entities.next().is_none());
    }
}

#[test]
fn dxf_rejects_invalid_free_layouts_and_scm_layouts_with_a_studio_file() {
    assert!(build_cut_dxf(&PrintSettings {
        columns: 10,
        ..PrintSettings::default()
    })
    .is_err());
    assert!(build_cut_dxf(&PrintSettings {
        layout_mode: LayoutMode::Scm,
        ..PrintSettings::default()
    })
    .unwrap_err()
    .to_string()
    .contains(".studio3"));
}
