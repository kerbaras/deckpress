mod common;

use deckpress_core::layout::mm_to_pixels;
use deckpress_core::models::{BleedMode, PrintSettings, Provider};
use deckpress_core::raster::{
    extend, fill_corners, fill_corners_within, finish_face, parse_hex_color, rasterize, reflect,
    square_corners, strip_bleed, CORNER_RADIUS_MM,
};
use deckpress_core::upscaler::CancelToken;
use image::{Rgb, RgbImage};

use common::art;
#[test]
fn parses_hex_colors() {
    assert_eq!(parse_hex_color("#ff0080"), Rgb([255, 0, 128]));
    assert_eq!(parse_hex_color("bad"), Rgb([17, 17, 17]));
}

#[test]
fn strips_mpc_bleed_using_the_mpc_card_size() {
    let image = RgbImage::new(816, 1110);
    let settings = PrintSettings::default();
    let out = strip_bleed(&image, &art(3.048, Provider::Mpc), &settings);
    assert_eq!((out.width(), out.height()), (816 - 2 * 36, 1110 - 2 * 36));
    let untouched = strip_bleed(&image, &art(0.0, Provider::Scryfall), &settings);
    assert_eq!(untouched.dimensions(), image.dimensions());
}

/// Every pixel gets a unique colour so reflections can be traced exactly.
fn labelled(width: u32, height: u32) -> RgbImage {
    let mut image = RgbImage::new(width, height);
    for (x, y, p) in image.enumerate_pixels_mut() {
        *p = Rgb([(x + 1) as u8, (y + 1) as u8, 200]);
    }
    image
}

const BACKGROUND: Rgb<u8> = Rgb([255, 0, 255]);

#[test]
fn reflect_uses_the_outermost_pixel_as_the_axis() {
    assert_eq!(reflect(-1, 5), 1);
    assert_eq!(reflect(-2, 5), 2);
    assert_eq!(reflect(-4, 5), 4);
    assert_eq!(reflect(5, 5), 3);
    assert_eq!(reflect(6, 5), 2);
    assert_eq!(reflect(8, 5), 0);
    assert_eq!(reflect(-5, 5), 3);
    assert_eq!(reflect(-8, 5), 0);
    assert_eq!(reflect(-9, 5), 1);
    assert_eq!(reflect(-1, 1), 0);
    assert_eq!(reflect(3, 1), 0);
}

#[test]
fn extend_mirror_reflects_without_repeating_the_seam_pixel() {
    let image = labelled(5, 3);
    let out = extend(&image, 3, BleedMode::Mirror, BACKGROUND);
    assert_eq!(out.dimensions(), (11, 9));
    let row = 3 + 1;
    let expected_columns = [3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1];
    for (ox, sx) in expected_columns.into_iter().enumerate() {
        assert_eq!(
            out.get_pixel(ox as u32, row),
            image.get_pixel(sx, 1),
            "column {ox}"
        );
    }
    let column = 3 + 2;
    let expected_rows = [1, 2, 1, 0, 1, 2, 1, 0, 1];
    for (oy, sy) in expected_rows.into_iter().enumerate() {
        assert_eq!(
            out.get_pixel(column, oy as u32),
            image.get_pixel(2, sy),
            "row {oy}"
        );
    }
    assert_eq!(out.get_pixel(0, 0), image.get_pixel(3, 1));
    assert!(out.pixels().all(|p| *p != BACKGROUND));
}

#[test]
fn extend_edge_and_solid_keep_their_fills() {
    let image = labelled(4, 4);
    let edge = extend(&image, 2, BleedMode::Edge, BACKGROUND);
    assert_eq!(edge.get_pixel(0, 0), image.get_pixel(0, 0));
    assert_eq!(edge.get_pixel(7, 7), image.get_pixel(3, 3));
    assert_eq!(edge.get_pixel(0, 4), image.get_pixel(0, 2));
    assert_eq!(edge.get_pixel(4, 0), image.get_pixel(2, 0));
    let solid = extend(&image, 2, BleedMode::Solid, Rgb([9, 9, 9]));
    assert_eq!(*solid.get_pixel(0, 0), Rgb([9, 9, 9]));
    assert_eq!(*solid.get_pixel(1, 4), Rgb([9, 9, 9]));
    assert_eq!(solid.get_pixel(2, 2), image.get_pixel(0, 0));
    assert_eq!(extend(&image, 0, BleedMode::Mirror, BACKGROUND), image);
}

#[test]
fn extend_mirror_keeps_folding_when_bleed_exceeds_the_face() {
    let image = labelled(2, 3);
    let out = extend(&image, 7, BleedMode::Mirror, BACKGROUND);
    assert_eq!(out.dimensions(), (16, 17));
    assert!(out.pixels().all(|p| *p != BACKGROUND));
    for ox in 0..16i64 {
        for oy in 0..17i64 {
            assert_eq!(
                out.get_pixel(ox as u32, oy as u32),
                image.get_pixel(reflect(ox - 7, 2) as u32, reflect(oy - 7, 3) as u32)
            );
        }
    }
    let tiny = extend(
        &RgbImage::from_pixel(1, 1, Rgb([1, 2, 3])),
        3,
        BleedMode::Mirror,
        BACKGROUND,
    );
    assert!(tiny.pixels().all(|p| *p == Rgb([1, 2, 3])));
}

#[test]
fn one_mm_bleed_at_800_dpi_is_reflected_face_not_background() {
    let settings = PrintSettings {
        dpi: 800,
        bleed_mm: 1.0,
        bleed_mode: BleedMode::Mirror,
        ..PrintSettings::default()
    };
    let (w, h) = (mm_to_pixels(63.0, 800), mm_to_pixels(88.0, 800));
    let mut face = RgbImage::from_pixel(w, h, Rgb([240, 240, 240]));
    for (x, y, p) in face.enumerate_pixels_mut() {
        let border = 60;
        if x < border || y < border || x >= w - border || y >= h - border {
            *p = Rgb([10, 10, (x % 200) as u8]);
        }
    }
    let out = finish_face(&face, &settings, BACKGROUND);
    let bleed = mm_to_pixels(1.0, 800);
    assert_eq!(bleed, 31);
    assert_eq!(out.dimensions(), (w + 2 * bleed, h + 2 * bleed));
    let radius = mm_to_pixels(CORNER_RADIUS_MM, 800);
    for y in radius..h - radius {
        for k in 0..bleed {
            assert_eq!(
                out.get_pixel(bleed - 1 - k, bleed + y),
                face.get_pixel(k + 1, y),
                "left bleed column {k} row {y}"
            );
            assert_eq!(
                out.get_pixel(bleed + w + k, bleed + y),
                face.get_pixel(w - 2 - k, y),
                "right bleed column {k} row {y}"
            );
        }
    }
    for x in radius..w - radius {
        for k in 0..bleed {
            assert_eq!(
                out.get_pixel(bleed + x, bleed - 1 - k),
                face.get_pixel(x, k + 1)
            );
            assert_eq!(
                out.get_pixel(bleed + x, bleed + h + k),
                face.get_pixel(x, h - 2 - k)
            );
        }
    }
    assert!(out.pixels().filter(|p| **p == BACKGROUND).count() > 0);
}

#[test]
fn corner_fill_stays_inside_the_trim_and_is_not_reflected() {
    let settings = PrintSettings {
        dpi: 300,
        bleed_mm: 1.0,
        bleed_mode: BleedMode::Mirror,
        ..PrintSettings::default()
    };
    let face = RgbImage::from_pixel(120, 160, Rgb([250, 250, 250]));
    let out = finish_face(&face, &settings, BACKGROUND);
    let bleed = mm_to_pixels(1.0, 300);
    assert_eq!(*out.get_pixel(bleed, bleed), BACKGROUND);
    assert_eq!(*out.get_pixel(bleed + 119, bleed + 159), BACKGROUND);
    assert_eq!(*out.get_pixel(bleed - 1, bleed), Rgb([250, 250, 250]));
    assert_eq!(*out.get_pixel(bleed, bleed - 1), Rgb([250, 250, 250]));
    assert_eq!(*out.get_pixel(0, 0), Rgb([250, 250, 250]));
    assert!(out
        .enumerate_pixels()
        .filter(|(_, _, p)| **p == BACKGROUND)
        .all(|(x, y, _)| { x >= bleed && y >= bleed && x < bleed + 120 && y < bleed + 160 }));
    let radius = mm_to_pixels(CORNER_RADIUS_MM, 300);
    assert_eq!(
        *out.get_pixel(bleed + radius, bleed + radius),
        Rgb([250, 250, 250])
    );
}

#[test]
fn scan_corners_are_squared_from_the_border_before_mirroring() {
    let settings = PrintSettings {
        dpi: 300,
        bleed_mm: 1.0,
        bleed_mode: BleedMode::Mirror,
        ..PrintSettings::default()
    };
    let border = Rgb([12, 12, 12]);
    let art = Rgb([200, 180, 90]);
    let (w, h) = (300u32, 420u32);
    let radius = mm_to_pixels(CORNER_RADIUS_MM, 300);
    let mut face = RgbImage::from_pixel(w, h, art);
    for (x, y, p) in face.enumerate_pixels_mut() {
        if x < 20 || y < 20 || x >= w - 20 || y >= h - 20 {
            *p = border;
        }
    }
    // Transparent scan corners arrive flattened to the bleed colour.
    fill_corners(&mut face, radius, BACKGROUND);
    assert_eq!(*face.get_pixel(0, 0), BACKGROUND);

    let mut squared = face.clone();
    square_corners(&mut squared, radius);
    assert!(squared.pixels().all(|p| *p != BACKGROUND));
    assert_eq!(*squared.get_pixel(0, 0), border);
    assert_eq!(*squared.get_pixel(w - 1, h - 1), border);
    assert_eq!(
        squared.get_pixel(radius, radius),
        face.get_pixel(radius, radius)
    );
    assert_eq!(
        squared.get_pixel(w / 2, h / 2),
        face.get_pixel(w / 2, h / 2)
    );

    let out = finish_face(&face, &settings, BACKGROUND);
    let bleed = mm_to_pixels(1.0, 300);
    let magenta_outside_trim = out
        .enumerate_pixels()
        .filter(|(x, y, p)| {
            **p == BACKGROUND && !(*x >= bleed && *y >= bleed && *x < bleed + w && *y < bleed + h)
        })
        .count();
    assert_eq!(magenta_outside_trim, 0);
    assert_eq!(*out.get_pixel(0, 0), border);
    assert_eq!(*out.get_pixel(bleed, bleed), BACKGROUND);

    let edge = finish_face(
        &face,
        &PrintSettings {
            bleed_mode: BleedMode::Edge,
            ..settings
        },
        BACKGROUND,
    );
    assert_eq!(*edge.get_pixel(0, 0), border);
    assert_eq!(*edge.get_pixel(0, bleed), border);
}

#[test]
fn fill_corners_within_matches_fill_corners_on_the_full_image() {
    let mut whole = RgbImage::from_pixel(40, 60, Rgb([255, 255, 255]));
    fill_corners(&mut whole, 8, Rgb([0, 0, 0]));
    let mut inset = RgbImage::from_pixel(50, 70, Rgb([255, 255, 255]));
    fill_corners_within(&mut inset, 5, 5, 40, 60, 8, Rgb([0, 0, 0]));
    for (x, y, p) in whole.enumerate_pixels() {
        assert_eq!(inset.get_pixel(x + 5, y + 5), p);
    }
    assert_eq!(*inset.get_pixel(0, 0), Rgb([255, 255, 255]));
    assert_eq!(*inset.get_pixel(49, 69), Rgb([255, 255, 255]));
}

#[test]
fn provider_bleed_is_cropped_before_our_bleed_is_added() {
    let settings = PrintSettings {
        dpi: 300,
        bleed_mm: 1.0,
        bleed_mode: BleedMode::Mirror,
        card_width_mm: 63.5,
        card_height_mm: 88.9,
        ..PrintSettings::default()
    };
    let provider_bleed = Rgb([220, 30, 30]);
    let card = Rgb([30, 60, 220]);
    let mut scan = RgbImage::from_pixel(816, 1110, provider_bleed);
    for (x, y, p) in scan.enumerate_pixels_mut() {
        if (36..816 - 36).contains(&x) && (36..1110 - 36).contains(&y) {
            *p = card;
        }
    }
    let mut png = Vec::new();
    scan.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let out = rasterize(
        &png,
        &art(3.048, Provider::Mpc),
        &settings,
        None,
        &CancelToken::default(),
        &mut |_, _| {},
    )
    .unwrap();
    let bleed = mm_to_pixels(1.0, 300);
    let (w, h) = (mm_to_pixels(63.5, 300), mm_to_pixels(88.9, 300));
    assert_eq!(out.image.dimensions(), (w + 2 * bleed, h + 2 * bleed));
    let near = |p: &Rgb<u8>, q: Rgb<u8>| (0..3).all(|c| p[c].abs_diff(q[c]) <= 2);
    assert!(out.image.pixels().all(|p| !near(p, provider_bleed)));
    let mid = (h + 2 * bleed) / 2;
    for k in 0..bleed {
        assert!(near(out.image.get_pixel(k, mid), card), "left bleed {k}");
        assert!(
            near(out.image.get_pixel(w + 2 * bleed - 1 - k, mid), card),
            "right bleed {k}"
        );
    }
}

#[test]
fn corners_are_filled_outside_the_radius_only() {
    let mut image = RgbImage::from_pixel(40, 60, Rgb([255, 255, 255]));
    fill_corners(&mut image, 8, Rgb([0, 0, 0]));
    assert_eq!(*image.get_pixel(0, 0), Rgb([0, 0, 0]));
    assert_eq!(*image.get_pixel(39, 59), Rgb([0, 0, 0]));
    assert_eq!(*image.get_pixel(8, 8), Rgb([255, 255, 255]));
    assert_eq!(*image.get_pixel(20, 0), Rgb([255, 255, 255]));
}

#[test]
fn rasterizes_to_physical_size_plus_bleed_without_upscaling() {
    let settings = PrintSettings {
        dpi: 300,
        bleed_mm: 1.0,
        ..PrintSettings::default()
    };
    let mut png = Vec::new();
    RgbImage::from_pixel(372, 520, Rgb([200, 40, 40]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let out = rasterize(
        &png,
        &art(0.0, Provider::Scryfall),
        &settings,
        None,
        &CancelToken::default(),
        &mut |_, _| {},
    )
    .unwrap();
    let bleed = mm_to_pixels(1.0, 300);
    assert_eq!(
        out.image.dimensions(),
        (
            mm_to_pixels(63.0, 300) + 2 * bleed,
            mm_to_pixels(88.0, 300) + 2 * bleed
        )
    );
    assert!(!out.upscaled);
}
