mod common;

use std::sync::Arc;

use deckpress_core::images::{
    mime_for, upload_id, validate_image_url, Images, UploadInput, UPLOAD_SCHEME,
};
use deckpress_core::models::Provider;
use deckpress_core::store::Store;

#[test]
fn only_allows_known_https_image_hosts() {
    assert!(validate_image_url("https://cards.scryfall.io/png/front/a.png").is_ok());
    assert!(validate_image_url("https://lh3.googleusercontent.com/d/abc").is_ok());
    assert!(validate_image_url("http://cards.scryfall.io/png/front/a.png").is_err());
    assert!(validate_image_url("https://example.com/a.png").is_err());
    assert!(validate_image_url("https://user@cards.scryfall.io/a.png").is_err());
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
                bleed_mm: 0.0,
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
