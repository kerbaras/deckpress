mod common;

use std::{io::Cursor, sync::Arc};
use std::{net::TcpListener, process::Command, time::Duration};

use deckpress_core::error::AppError;
use deckpress_core::images::{
    mime_for, upload_id, validate_image_url, Images, UploadInput, UPLOAD_SCHEME,
};
use deckpress_core::layout::{create_layout, mm_to_pixels, mm_to_pt};
use deckpress_core::models::{BleedMode, PrintSettings, Provider};
use deckpress_core::pdf::{build_pdf, PdfServices};
use deckpress_core::store::Store;
use deckpress_core::upscaler::CancelToken;
use image::{ImageFormat, Rgb, RgbImage};

#[test]
fn cancelling_a_scan_fetch_releases_its_cache_entry() {
    if std::env::var_os("DECKPRESS_PROXY_TEST").is_some() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(cancelled_scan_fetch_proxy_client());
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let (connected, connections) = std::sync::mpsc::channel();
    let (done, finished) = std::sync::mpsc::channel();
    let address = listener.local_addr().unwrap();
    let proxy = std::thread::spawn(move || {
        let _connections: Vec<_> = listener
            .incoming()
            .take(2)
            .map(|client| {
                let client = client.unwrap();
                connected.send(()).unwrap();
                client
            })
            .collect();
        let _ = finished.recv();
    });
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "cancelling_a_scan_fetch_releases_its_cache_entry",
        ])
        .env("HTTPS_PROXY", format!("http://{address}"))
        .env("NO_PROXY", "")
        .env("DECKPRESS_PROXY_TEST", "1")
        .spawn()
        .unwrap();
    let status = child.wait().unwrap();
    done.send(()).unwrap();
    assert!(status.success());
    assert_eq!(connections.try_iter().count(), 2);
    proxy.join().unwrap();
}

async fn cancelled_scan_fetch_proxy_client() {
    let dir = tempfile::tempdir().unwrap();
    let images = Images::new(dir.path(), Arc::new(Store::in_memory().unwrap())).unwrap();
    let url = "https://cards.scryfall.io/scan.png";
    for _ in 0..2 {
        let cancel = CancelToken::default();
        let (result, _) = tokio::join!(
            tokio::time::timeout(
                Duration::from_millis(900),
                images.read_cancellable(url, &cancel)
            ),
            async {
                tokio::time::sleep(Duration::from_millis(250)).await;
                cancel.cancel();
            },
        );
        assert!(matches!(result, Ok(Err(AppError::Cancelled))));
        assert!(!images.local_path(url).unwrap().exists());
    }
}

#[test]
fn only_allows_known_https_image_hosts() {
    assert!(validate_image_url("https://cards.scryfall.io/png/front/a.png").is_ok());
    assert!(validate_image_url("https://lh3.googleusercontent.com/d/abc").is_ok());
    assert!(validate_image_url("http://cards.scryfall.io/png/front/a.png").is_err());
    assert!(validate_image_url("https://example.com/a.png").is_err());
    assert!(validate_image_url("https://user@cards.scryfall.io/a.png").is_err());
    assert!(validate_image_url(
        "https://storage.googleapis.com/archidekt-card-images/mom/abc_art_crop.jpg"
    )
    .is_ok());
    assert!(
        validate_image_url("https://card-images.archidekt.com/art/front/d/0/d0d3.webp").is_ok()
    );
    assert!(validate_image_url("https://storage.googleapis.com/other-bucket/a.jpg").is_err());
    assert!(validate_image_url("https://cards.scryfall.io:8443/a.png").is_err());
}

#[test]
fn upload_ids_accept_the_new_scheme_and_the_migrated_api_path() {
    let id = "6b6d5a31-b4b4-4f53-8c6b-7f1a4f3d9f01";
    assert_eq!(
        upload_id(&format!("upload://{id}")).unwrap().unwrap(),
        id.to_string()
    );
    assert_eq!(
        upload_id(&format!("/api/uploads/{id}")).unwrap().unwrap(),
        id.to_string()
    );
    assert!(upload_id("upload://not-a-uuid").unwrap().is_err());
    assert!(upload_id("https://cards.scryfall.io/a.png").is_none());
}

#[tokio::test]
async fn uploads_are_normalized_to_png_and_listed_by_oracle() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let images = Images::new(dir.path(), store).unwrap();
    let png = common::png(40, 56, [200, 10, 10]);
    let art = images
        .upload(
            &png,
            UploadInput {
                oracle_id: "oracle".into(),
                name: "Custom".into(),
                artist: String::new(),
                bleed_mm: Some(0.0),
            },
        )
        .unwrap();
    assert_eq!(art.provider, Provider::Upload);
    assert_eq!(art.artist, "My upload");
    assert!(art.image_url.starts_with(UPLOAD_SCHEME));
    assert_eq!(images.uploads_for("oracle").unwrap().len(), 1);
    assert!(images.uploads_for("other").unwrap().is_empty());
    let bytes = images.read(&art.image_url).await.unwrap();
    assert_eq!(mime_for(&bytes), "image/png");
    let legacy = art.image_url.replace(UPLOAD_SCHEME, "/api/uploads/");
    assert_eq!(images.read(&legacy).await.unwrap(), bytes);
    assert!(images.read("upload://not-a-uuid").await.is_err());
}

fn upload_input(bleed_mm: Option<f64>) -> UploadInput {
    UploadInput {
        oracle_id: "o".into(),
        name: "Custom".into(),
        artist: String::new(),
        bleed_mm,
    }
}

#[test]
fn upload_detects_common_bleed_sizes_unless_overridden() {
    let dir = tempfile::tempdir().unwrap();
    let images = Images::new(dir.path(), Arc::new(Store::in_memory().unwrap())).unwrap();
    for (width, height, expected) in [
        (690, 940, 3.048),
        (822, 1122, 3.048),
        (819, 1114, 3.175),
        (744, 1040, 0.0),
        (1000, 1000, 0.0),
    ] {
        let art = images
            .upload(
                &common::png(width, height, [180, 100, 60]),
                upload_input(None),
            )
            .unwrap();
        assert_eq!(art.bleed_mm, expected, "{width} × {height}");
        assert!(images.uploads_for("o").unwrap().contains(&art));
    }

    let png = common::png(822, 1122, [180, 100, 60]);
    for bleed in [0.0, 1.25] {
        let art = images.upload(&png, upload_input(Some(bleed))).unwrap();
        assert_eq!(art.bleed_mm, bleed);
    }
    assert!(images.upload(&png, upload_input(Some(10.01))).is_err());
}

#[tokio::test]
async fn detected_bleed_upload_fills_physical_trim_in_pdf_export() {
    assert_edge_bleed_in_export(816, 1112, 36, 3.048, 300.0).await;
}

#[tokio::test]
async fn detected_mpc_scan_fills_physical_trim_in_pdf_export() {
    assert_edge_bleed_in_export(822, 1122, 36, 3.048, 302.0).await;
}

#[tokio::test]
async fn detected_eighth_inch_upload_fills_physical_trim_in_pdf_export() {
    assert_edge_bleed_in_export(819, 1114, 37, 3.175, 300.0).await;
}

async fn assert_edge_bleed_in_export(
    width: u32,
    height: u32,
    inset: u32,
    source_bleed: f64,
    dpi: f64,
) {
    let dir = tempfile::tempdir().unwrap();
    let images = Images::new(dir.path(), Arc::new(Store::in_memory().unwrap())).unwrap();
    let upload = RgbImage::from_fn(width, height, |x, y| {
        if !(inset..width - inset).contains(&x) || !(inset..height - inset).contains(&y) {
            Rgb([40, 170, 65])
        } else if !(inset + 8..width - inset - 8).contains(&x)
            || !(inset + 8..height - inset - 8).contains(&y)
        {
            Rgb([225, 28, 32])
        } else {
            Rgb([240, 238, 216])
        }
    });
    let mut png = Vec::new();
    upload
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    let art = images.upload(&png, upload_input(None)).unwrap();
    assert_eq!(art.bleed_mm, source_bleed);
    assert_eq!(art.dpi, dpi);
    let url = art.image_url.clone();
    let source = images.read(&url).await.unwrap();
    let mut deck = common::deck(1);
    deck.entries[0].selected_art = Some(art);
    let settings = PrintSettings {
        dpi: 300,
        bleed_mm: 2.0,
        bleed_mode: BleedMode::Edge,
        calibration_page: false,
        ..PrintSettings::default()
    };
    let slot = create_layout(&settings).unwrap().slots[0];
    assert_eq!(slot.trim.width, mm_to_pt(63.0));
    assert_eq!(slot.trim.height, mm_to_pt(88.0));
    let raster_dir = dir.path().join("rasters");
    let pdf = build_pdf(
        &deck,
        &settings,
        &PdfServices {
            upscaler: None,
            raster_dir: &raster_dir,
        },
        &CancelToken::default(),
        &mut |_, _, _| {},
        &mut |requested| {
            assert_eq!(requested, url);
            Ok(source.clone())
        },
    )
    .unwrap();
    assert_eq!(pdf.unique_images, 1);
    let jpeg = std::fs::read(
        std::fs::read_dir(raster_dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap();
    assert!(pdf.bytes.windows(jpeg.len()).any(|window| window == jpeg));
    let embedded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
    let bleed = mm_to_pixels(settings.bleed_mm, settings.dpi);
    let (w, h) = (mm_to_pixels(63.0, 300), mm_to_pixels(88.0, 300));
    assert_eq!(embedded.dimensions(), (w + 2 * bleed, h + 2 * bleed));
    let is_outline = |x, y| {
        let [r, g, b] = embedded.get_pixel(x, y).0;
        r > 160 && g < 100 && b < 100
    };
    let assert_trim_outline = |length, is_outline: &dyn Fn(u32) -> bool| {
        let mut outline = (bleed..bleed + length).filter(|&p| is_outline(p));
        let first = outline.next().unwrap();
        let last = outline.next_back().unwrap();
        assert!(first - bleed <= 1, "outline starts at {first}");
        assert!(bleed + length - 1 - last <= 1, "outline ends at {last}");
    };
    assert_trim_outline(w, &|x| is_outline(x, bleed + h / 2));
    assert_trim_outline(h, &|y| is_outline(bleed + w / 2, y));
    assert!(is_outline(0, bleed + h / 2));
    assert!(is_outline(bleed + w / 2, 0));
    assert!(is_outline(w + 2 * bleed - 1, bleed + h / 2));
    assert!(is_outline(bleed + w / 2, h + 2 * bleed - 1));
    let corner = mm_to_pixels(3.0, settings.dpi) + 2;
    for (x, y, pixel) in embedded.enumerate_pixels().filter(|(x, y, _)| {
        (bleed + corner..bleed + w - corner).contains(x)
            || (bleed + corner..bleed + h - corner).contains(y)
    }) {
        assert!(
            pixel.0.into_iter().max().unwrap() > 128,
            "{width} × {height}: background band at ({x}, {y})"
        );
    }
}
