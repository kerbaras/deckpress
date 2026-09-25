//! Original image downloads, the on-disk original cache and user uploads.
//!
//! Layout under the data directory:
//! - `images/<sha256(url)>` original bytes as served by the provider
//! - `uploads/<uuid>.png` normalized uploads (`upload://<uuid>` in decks)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use reqwest::{redirect, Client, StatusCode};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::models::{new_id, now_iso, Art, Provider, Upload};
use crate::providers::USER_AGENT;
use crate::store::Store;

pub const UPLOAD_SCHEME: &str = "upload://";
const MAX_DOWNLOAD: usize = 32 * 1024 * 1024;
const MAX_UPLOAD: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

pub fn validate_image_url(input: &str) -> AppResult<Url> {
    let url = Url::parse(input).map_err(|_| AppError::user("Invalid image URL"))?;
    let host = url.host_str().unwrap_or_default();
    let allowed = matches!(
        host,
        "cards.scryfall.io" | "drive.google.com" | "drive.usercontent.google.com"
    ) || host.ends_with(".googleusercontent.com");
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(AppError::user(
            "Only Scryfall and Google Drive image URLs are allowed",
        ));
    }
    Ok(url)
}

pub fn image_key(url: &str) -> String {
    hex::encode(Sha256::digest(url.as_bytes()))
}

/// Waits until the task that owns `key` in `pending` removes it. Registering
/// the waiter before re-checking the map means a `notify_waiters` that fires
/// between the lookup and the await cannot be missed.
pub async fn wait_for_leader(
    pending: &Mutex<HashMap<String, Arc<Notify>>>,
    key: &str,
    notify: &Arc<Notify>,
) {
    let notified = notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    let still_pending = pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, notify));
    if still_pending {
        notified.await;
    }
}

fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok().filter(|format| {
        matches!(
            format,
            ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
        )
    })
}

pub fn mime_for(bytes: &[u8]) -> &'static str {
    match sniff(bytes) {
        Some(ImageFormat::Jpeg) => "image/jpeg",
        Some(ImageFormat::WebP) => "image/webp",
        _ => "image/png",
    }
}

/// Decodes with size limits and applies the EXIF orientation, so camera
/// photos come out upright.
pub fn decode(bytes: &[u8]) -> AppResult<DynamicImage> {
    let mut reader = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(600 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

pub struct Images {
    root: PathBuf,
    store: Arc<Store>,
    client: Client,
    pending: Mutex<HashMap<String, Arc<Notify>>>,
}

impl Images {
    pub fn new(root: impl Into<PathBuf>, store: Arc<Store>) -> AppResult<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(45))
            .build()?;
        Ok(Self {
            root: root.into(),
            store,
            client,
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn upload_path(&self, id: &str) -> PathBuf {
        self.root.join("uploads").join(format!("{id}.png"))
    }

    /// Where the original for `url` lives once `read` has fetched it.
    pub fn local_path(&self, url: &str) -> AppResult<PathBuf> {
        if let Some(id) = url.strip_prefix(UPLOAD_SCHEME) {
            let id = uuid::Uuid::parse_str(id)
                .map_err(|_| AppError::not_found("Uploaded image not found"))?;
            return Ok(self.upload_path(&id.to_string()));
        }
        validate_image_url(url)?;
        Ok(self.root.join("images").join(image_key(url)))
    }

    /// Returns the cached original bytes for an art URL, downloading on a miss.
    /// Concurrent readers of the same URL wait for the first download.
    pub async fn read(&self, url: &str) -> AppResult<Vec<u8>> {
        if let Some(id) = url.strip_prefix(UPLOAD_SCHEME) {
            let id = uuid::Uuid::parse_str(id)
                .map_err(|_| AppError::not_found("Uploaded image not found"))?
                .to_string();
            if self.store.get::<Upload>("upload", &id)?.is_none() {
                return Err(AppError::not_found("Uploaded image not found"));
            }
            return Ok(tokio::fs::read(self.upload_path(&id)).await?);
        }
        validate_image_url(url)?;
        let key = image_key(url);
        let path = self.root.join("images").join(&key);
        loop {
            match tokio::fs::read(&path).await {
                Ok(bytes) => return Ok(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let waiter = {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.get(&key) {
                    Some(notify) => Some(notify.clone()),
                    None => {
                        pending.insert(key.clone(), Arc::new(Notify::new()));
                        None
                    }
                }
            };
            if let Some(notify) = waiter {
                wait_for_leader(&self.pending, &key, &notify).await;
                continue;
            }
            let result = self.download_to(url, &path).await;
            let notify = self
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&key);
            if let Some(notify) = notify {
                notify.notify_waiters();
            }
            return result;
        }
    }

    async fn download_to(&self, url: &str, path: &Path) -> AppResult<Vec<u8>> {
        let bytes = self.download(url).await?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = path.with_extension(format!("part-{}", new_id()));
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, path).await?;
        Ok(bytes)
    }

    async fn download(&self, input: &str) -> AppResult<Vec<u8>> {
        let mut url = validate_image_url(input)?;
        for _ in 0..MAX_REDIRECTS {
            let response = self
                .client
                .get(url.clone())
                .header("Accept", "image/*")
                .send()
                .await
                .map_err(|error| {
                    AppError::user(if error.is_timeout() {
                        "Image download timed out"
                    } else {
                        "Image download failed. Check your connection and retry."
                    })
                })?;
            let status = response.status();
            if matches!(
                status,
                StatusCode::MOVED_PERMANENTLY
                    | StatusCode::FOUND
                    | StatusCode::SEE_OTHER
                    | StatusCode::TEMPORARY_REDIRECT
                    | StatusCode::PERMANENT_REDIRECT
            ) {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| AppError::user("Image provider returned an invalid redirect"))?;
                let next = url
                    .join(location)
                    .map_err(|_| AppError::user("Image provider returned an invalid redirect"))?;
                url = validate_image_url(next.as_str())?;
                continue;
            }
            if !status.is_success() {
                return Err(AppError::user(format!(
                    "Image download failed ({}). Google Drive may be rate limited; retry later or upload the file.",
                    status.as_u16()
                )));
            }
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| AppError::user("Image download was interrupted"))?;
                if bytes.len() + chunk.len() > MAX_DOWNLOAD {
                    return Err(AppError::user("Image exceeds 32 MB"));
                }
                bytes.extend_from_slice(&chunk);
            }
            if sniff(&bytes).is_none() {
                return Err(AppError::user(
                    "Provider returned an unsupported image or a Google Drive download page. Download it manually and use Upload art.",
                ));
            }
            let bytes = tokio::task::spawn_blocking(move || {
                decode(&bytes).map(|_| bytes).map_err(|_| {
                    AppError::user(
                        "Provider returned a damaged image. Retry later or upload the file.",
                    )
                })
            })
            .await
            .map_err(|error| AppError::internal(error.to_string()))??;
            return Ok(bytes);
        }
        Err(AppError::user("Too many image redirects"))
    }

    pub fn uploads_for(&self, oracle_id: &str) -> AppResult<Vec<Art>> {
        Ok(self
            .store
            .list::<Upload>("upload")?
            .into_iter()
            .filter(|upload| upload.oracle_id == oracle_id)
            .map(|upload| upload.art)
            .collect())
    }

    pub fn upload(&self, bytes: &[u8], input: UploadInput) -> AppResult<Art> {
        if bytes.len() > MAX_UPLOAD {
            return Err(AppError::user("Uploads are limited to 16 MB"));
        }
        if sniff(bytes).is_none() {
            return Err(AppError::user("Use PNG, JPEG or WebP"));
        }
        if input.name.trim().is_empty() || input.name.chars().count() > 300 {
            return Err(AppError::user("Give the upload a name"));
        }
        if !(0.0..=10.0).contains(&input.bleed_mm) {
            return Err(AppError::user("Bleed must be between 0 and 10 mm"));
        }
        let image = decode(bytes)?;
        let (width, height) = (image.width(), image.height());
        let id = new_id();
        let path = self.upload_path(&id);
        std::fs::create_dir_all(path.parent().expect("upload dir has a parent"))?;
        image.to_rgba8().save_with_format(&path, ImageFormat::Png)?;
        let image_url = format!("{UPLOAD_SCHEME}{id}");
        let dpi = f64::min(
            f64::from(width) / ((63.0 + 2.0 * input.bleed_mm) / 25.4),
            f64::from(height) / ((88.0 + 2.0 * input.bleed_mm) / 25.4),
        )
        .round();
        let art = Art {
            id: format!("upload:{id}"),
            provider: Provider::Upload,
            name: input.name.trim().to_string(),
            artist: if input.artist.trim().is_empty() {
                "My upload".into()
            } else {
                input.artist.trim().chars().take(200).collect()
            },
            source: "My uploads".into(),
            source_url: String::new(),
            art_crop_url: String::new(),
            thumbnail_url: image_url.clone(),
            image_url,
            set: String::new(),
            collector_number: String::new(),
            language: "en".into(),
            bleed_mm: input.bleed_mm,
            dpi: dpi.clamp(1.0, 10_000.0),
            released_at: now_iso(),
            tags: vec!["custom".into()],
            back_image_url: String::new(),
            back_thumbnail_url: String::new(),
        };
        self.store.put(
            "upload",
            &id,
            &Upload {
                oracle_id: input.oracle_id,
                art: art.clone(),
            },
        )?;
        Ok(art)
    }
}

#[derive(Debug, Clone)]
pub struct UploadInput {
    pub oracle_id: String,
    pub name: String,
    pub artist: String,
    pub bleed_mm: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_known_https_image_hosts() {
        assert!(validate_image_url("https://cards.scryfall.io/png/front/a.png").is_ok());
        assert!(validate_image_url("https://lh3.googleusercontent.com/d/abc").is_ok());
        assert!(validate_image_url("http://cards.scryfall.io/png/front/a.png").is_err());
        assert!(validate_image_url("https://example.com/a.png").is_err());
        assert!(validate_image_url("https://user@cards.scryfall.io/a.png").is_err());
        assert!(validate_image_url("https://cards.scryfall.io:8443/a.png").is_err());
    }

    #[tokio::test]
    async fn uploads_are_normalized_to_png_and_listed_by_oracle() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::in_memory().unwrap());
        let images = Images::new(dir.path(), store).unwrap();
        let mut png = Vec::new();
        image::RgbImage::from_pixel(40, 56, image::Rgb([200, 10, 10]))
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
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
        assert!(images.read("upload://not-a-uuid").await.is_err());
    }
}
