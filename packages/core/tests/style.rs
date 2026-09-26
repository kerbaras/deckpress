mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use deckpress_core::images::{Images, UploadInput};
use deckpress_core::models::{Art, Provider};
use deckpress_core::store::Store;
use deckpress_core::style::embed::{normalize, prepare, similarity};
use deckpress_core::style::heuristic::score;
use deckpress_core::style::{
    visual_from_cosine, StyleEntry, StyleMatcher, StyleMethod, StyleRequest,
};
use deckpress_core::upscaler::manifest::ModelManager;
use image::{DynamicImage, RgbImage};

fn bundled_resources() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources")
}

fn art(id: &str, artist: &str, set: &str, year: &str, tags: &[&str]) -> Art {
    Art {
        id: id.into(),
        provider: Provider::Scryfall,
        name: "Forest".into(),
        image_url: format!("https://cards.scryfall.io/png/front/{id}.png"),
        thumbnail_url: String::new(),
        art_crop_url: String::new(),
        source_url: String::new(),
        source: format!("Set {set}"),
        artist: artist.into(),
        set: set.into(),
        collector_number: "1".into(),
        language: "en".into(),
        released_at: format!("{year}-01-01"),
        tags: tags.iter().map(|t| t.to_string()).collect(),
        dpi: 300.0,
        bleed_mm: 0.0,
        back_image_url: String::new(),
        back_thumbnail_url: String::new(),
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    images: Arc<Images>,
    matcher: Arc<StyleMatcher>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let images = Arc::new(Images::new(dir.path(), Arc::clone(&store)).unwrap());
    let models = Arc::new(ModelManager::new(bundled_resources(), dir.path()).unwrap());
    let matcher = Arc::new(StyleMatcher::new(store, Arc::clone(&images), models));
    Fixture {
        _dir: dir,
        images,
        matcher,
    }
}

fn upload(images: &Images, name: &str, pixel: [u8; 3]) -> Art {
    images
        .upload(
            &common::png(120, 168, pixel),
            UploadInput {
                oracle_id: "oracle".into(),
                name: name.into(),
                artist: "Seb McKinnon".into(),
                bleed_mm: 0.0,
            },
        )
        .unwrap()
}

#[test]
fn same_artist_and_labels_outrank_strangers() {
    let reference = art(
        "r",
        "Seb McKinnon",
        "eld",
        "2019",
        &["showcase", "borderless"],
    );
    let twin = art("t", "Seb McKinnon", "thb", "2020", &["borderless"]);
    let stranger = art("s", "John Avon", "m19", "2018", &[]);
    let twin_score = score(&reference, &twin);
    let stranger_score = score(&reference, &stranger);
    assert!(twin_score.score > stranger_score.score);
    assert!(twin_score
        .reasons
        .iter()
        .any(|r| r.starts_with("Same artist")));
    assert!(twin_score
        .reasons
        .iter()
        .any(|r| r == "Shares labels: borderless"));
    assert!(stranger_score.reasons.is_empty() || stranger_score.score < 0.3);
}

#[test]
fn identical_printings_score_near_one() {
    let reference = art("r", "Rebecca Guay", "mor", "2008", &[]);
    let result = score(&reference, &reference);
    assert!(result.score > 0.85, "{result:?}");
    assert!(result.reasons.contains(&"Both regular frames".to_string()));
}

#[test]
fn unknown_artists_do_not_match_each_other() {
    let a = art("a", "Unknown", "mpc", "", &[]);
    let b = art("b", "Unknown", "mpc", "", &["full art"]);
    let result = score(&a, &b);
    assert!(!result.reasons.iter().any(|r| r.contains("artist")));
    assert!(result.score < 0.3);
}

#[test]
fn prepare_squares_and_resizes() {
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(488, 680, image::Rgb([9, 9, 9])));
    let art = prepare(&image, true, 224);
    assert_eq!((art.width(), art.height()), (224, 224));
    let crop = prepare(&image, false, 32);
    assert_eq!((crop.width(), crop.height()), (32, 32));
}

#[test]
fn similarity_of_normalized_vectors() {
    let a = normalize(vec![3.0, 4.0]);
    let b = normalize(vec![-3.0, -4.0]);
    assert!((similarity(&a, &a) - 1.0).abs() < 1e-5);
    assert!((similarity(&a, &b) + 1.0).abs() < 1e-5);
    assert_eq!(normalize(vec![0.0, 0.0]), vec![0.0, 0.0]);
}

#[test]
fn visual_mapping_covers_the_observed_cosine_range() {
    assert_eq!(visual_from_cosine(0.2), 0.0);
    assert_eq!(visual_from_cosine(0.95), 1.0);
    assert!((visual_from_cosine(0.625) - 0.5).abs() < 1e-6);
}

#[tokio::test]
async fn heuristic_ranking_prefers_the_same_artist() {
    let fixture = fixture();
    let request = StyleRequest {
        reference: art("ref", "Seb McKinnon", "ref", "2020", &["borderless"]),
        entries: vec![StyleEntry {
            entry_id: "e1".into(),
            options: vec![
                art("a", "John Avon", "a", "2020", &[]),
                art("b", "Seb McKinnon", "b", "2020", &["borderless"]),
            ],
        }],
        use_model: false,
    };
    let report = fixture.matcher.rank(request, |_, _| {}).await.unwrap();
    assert_eq!(report.method, StyleMethod::Heuristic);
    assert!(report.model.is_none());
    let ranked = &report.matches[0].ranked;
    assert_eq!(ranked[0].art.id, "b");
    assert!(ranked[0].visual.is_none());
    assert!(ranked[0].score > ranked[1].score);
}

#[test]
fn bundled_style_model_embeds_prepared_images() {
    let fixture = fixture();
    let embedder = fixture.matcher.embedder().unwrap();
    assert_eq!(embedder.dims(), 1024);
    let mut warm = RgbImage::new(300, 200);
    let mut cool = RgbImage::new(300, 200);
    for (x, y, p) in warm.enumerate_pixels_mut() {
        let v = ((x * 7 + y * 3) % 90) as u8;
        *p = image::Rgb([200 + v / 3, 90 + v, 40]);
    }
    for (x, y, p) in cool.enumerate_pixels_mut() {
        let v = ((x / 25 + y / 25) % 2 * 120) as u8;
        *p = image::Rgb([20, 60 + v / 2, 140 + v / 2]);
    }
    let embed = |image: &RgbImage| {
        embedder
            .embed(&embedder.prepare(&DynamicImage::ImageRgb8(image.clone()), false))
            .unwrap()
    };
    let (a, b) = (embed(&warm), embed(&cool));
    let norm = a.iter().map(|v| v * v).sum::<f32>().sqrt();
    assert!((norm - 1.0).abs() < 1e-3, "unit vector, got {norm}");
    let self_similarity = similarity(&a, &a);
    let cross = similarity(&a, &b);
    assert!(self_similarity > 0.999);
    assert!(cross < self_similarity - 0.05, "{cross}");
}
