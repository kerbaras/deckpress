//! Original image downloads, the on-disk original cache and user uploads.
//!
//! Layout under the data directory:
//! - `images/<sha256(url)>` original bytes as served by the provider
//! - `uploads/<uuid>.png` normalized uploads (`upload://<uuid>` in decks)

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use reqwest::{redirect, Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::models::{new_id, now_iso, Art, Deck, NewDeck, Provider, Upload};
use crate::providers::USER_AGENT;
use crate::raster::{
    detect_upload_bleed, encode_png, strip_bleed, to_rgb, PIPELINE_VERSION, UPLOAD_CARD_MM,
};
use crate::store::Store;
use crate::upscaler::CancelToken;

pub const UPLOAD_SCHEME: &str = "upload://";
/// Art URL prefix the Node API wrote into decks; still present in migrated
/// databases.
pub const LEGACY_UPLOAD_PREFIX: &str = "/api/uploads/";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub deck: Deck,
    pub updated_uploads: usize,
}

/// The upload id named by an art URL, if it points at a local upload.
pub fn upload_id(url: &str) -> Option<AppResult<String>> {
    let raw = url
        .strip_prefix(UPLOAD_SCHEME)
        .or_else(|| url.strip_prefix(LEGACY_UPLOAD_PREFIX))?;
    Some(
        uuid::Uuid::parse_str(raw)
            .map(|id| id.to_string())
            .map_err(|_| AppError::not_found("Uploaded image not found")),
    )
}

const MAX_DOWNLOAD: usize = 32 * 1024 * 1024;
const MAX_UPLOAD: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const UPLOAD_THUMBNAIL_EDGE: u32 = 480;

fn upload_thumbnail_name(id: &str, bleed_mm: f64) -> String {
    let key = image_key(&format!(
        "{PIPELINE_VERSION}:{UPLOAD_THUMBNAIL_EDGE}:{id}:{bleed_mm}"
    ));
    format!("{key}.png")
}

fn prune_thumbnail_files(dir: &Path, should_remove: impl Fn(&Path) -> bool) -> bool {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return true,
        Err(error) => {
            log::warn!("Could not read thumbnail cache {}: {error}", dir.display());
            return false;
        }
    };
    let mut complete = true;
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(error) => {
                log::warn!(
                    "Could not read thumbnail cache entry in {}: {error}",
                    dir.display()
                );
                complete = false;
                continue;
            }
        };
        if path.extension().is_some_and(|ext| ext == "png") && should_remove(&path) {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != ErrorKind::NotFound {
                    log::warn!(
                        "Could not remove cached thumbnail {}: {error}",
                        path.display()
                    );
                    complete = false;
                }
            }
        }
    }
    complete
}

pub fn validate_image_url(input: &str) -> AppResult<Url> {
    let url = Url::parse(input).map_err(|_| AppError::user("Invalid image URL"))?;
    let host = url.host_str().unwrap_or_default();
    let allowed = matches!(
        host,
        "cards.scryfall.io"
            | "card-images.archidekt.com"
            | "drive.google.com"
            | "drive.usercontent.google.com"
    ) || host.ends_with(".googleusercontent.com")
        || (host == "storage.googleapis.com" && url.path().starts_with("/archidekt-card-images/"));
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(AppError::user(
            "Only Scryfall, Archidekt and Google Drive image URLs are allowed",
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
        let images = Self {
            root: root.into(),
            store,
            client,
            pending: Mutex::new(HashMap::new()),
        };
        images.prune_legacy_upload_thumbnails();
        Ok(images)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn upload_path(&self, id: &str) -> PathBuf {
        self.root.join("uploads").join(format!("{id}.png"))
    }

    /// Where the original for `url` lives once `read` has fetched it.
    pub fn local_path(&self, url: &str) -> AppResult<PathBuf> {
        if let Some(id) = upload_id(url) {
            return Ok(self.upload_path(&id?));
        }
        validate_image_url(url)?;
        Ok(self.root.join("images").join(image_key(url)))
    }

    /// Returns the cached original bytes for an art URL, downloading on a miss.
    /// Concurrent readers of the same URL wait for the first download.
    pub async fn read(&self, url: &str) -> AppResult<Vec<u8>> {
        self.read_cancellable(url, &CancelToken::default()).await
    }

    pub async fn read_cancellable(&self, url: &str, cancel: &CancelToken) -> AppResult<Vec<u8>> {
        cancel.check()?;
        if let Some(id) = upload_id(url) {
            let id = id?;
            if self.store.get::<Upload>("upload", &id)?.is_none() {
                return Err(AppError::not_found("Uploaded image not found"));
            }
            let bytes = tokio::fs::read(self.upload_path(&id)).await;
            cancel.check()?;
            return Ok(bytes?);
        }
        validate_image_url(url)?;
        let key = image_key(url);
        let path = self.root.join("images").join(&key);
        loop {
            cancel.check()?;
            let cached = tokio::fs::read(&path).await;
            cancel.check()?;
            match cached {
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
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(AppError::Cancelled),
                    _ = wait_for_leader(&self.pending, &key, &notify) => {}
                }
                continue;
            }
            let result = self.download_to(url, &path, cancel).await;
            let notify = self
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&key);
            if let Some(notify) = notify {
                notify.notify_waiters();
            }
            cancel.check()?;
            return result;
        }
    }

    async fn download_to(
        &self,
        url: &str,
        path: &Path,
        cancel: &CancelToken,
    ) -> AppResult<Vec<u8>> {
        let bytes = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AppError::Cancelled),
            result = self.download(url) => result?,
        };
        cancel.check()?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        cancel.check()?;
        let tmp = path.with_extension(format!("part-{}", new_id()));
        tokio::fs::write(&tmp, &bytes).await?;
        if cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(AppError::Cancelled);
        }
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

    fn saved_upload(&self, url: &str) -> AppResult<(String, Upload)> {
        let id =
            upload_id(url).ok_or_else(|| AppError::not_found("Uploaded image not found"))??;
        let upload = self
            .store
            .get("upload", &id)?
            .ok_or_else(|| AppError::not_found("Uploaded image not found"))?;
        Ok((id, upload))
    }

    /// The declared bleed override, or None for auto-detection.
    pub fn upload_bleed(&self, url: &str) -> AppResult<Option<f64>> {
        let (_, upload) = self.saved_upload(url)?;
        Ok((!upload.bleed_auto).then_some(upload.art.bleed_mm))
    }

    /// Updates the declaration without replacing the original image or its ID.
    pub fn update_upload_bleed(&self, url: &str, bleed_mm: Option<f64>) -> AppResult<Art> {
        let (id, mut upload) = self.saved_upload(url)?;
        let previous = upload.art.bleed_mm;
        self.set_upload_bleed(&id, &mut upload, bleed_mm)?;
        self.store.put("upload", &id, &upload)?;
        if previous != upload.art.bleed_mm {
            self.prune_upload_thumbnails(&id, upload.art.bleed_mm);
        }
        Ok(upload.art)
    }

    fn set_upload_bleed(
        &self,
        id: &str,
        upload: &mut Upload,
        bleed_mm: Option<f64>,
    ) -> AppResult<()> {
        validate_upload_bleed(bleed_mm)?;
        let image = decode(&std::fs::read(self.upload_path(id))?)?;
        let (bleed, dpi) = upload_resolution(image.width(), image.height(), bleed_mm);
        upload.art.bleed_mm = bleed;
        upload.art.dpi = dpi;
        upload.bleed_auto = bleed_mm.is_none();
        Ok(())
    }

    /// Restores a backup and its explicit source bleed values for existing uploads.
    pub fn restore_deck(&self, contents: &str) -> AppResult<RestoreResult> {
        let backup: Value =
            serde_json::from_str(contents).map_err(|_| AppError::user("Invalid deck backup"))?;
        let mut bleeds = HashMap::new();
        for entry in backup["entries"].as_array().into_iter().flatten() {
            let arts = entry["card"]["faces"]
                .as_array()
                .into_iter()
                .flatten()
                .chain([&entry["selectedArt"], &entry["selectedBack"]]);
            for art in arts {
                if art["provider"] != "upload" {
                    continue;
                }
                if let (Some(Ok(id)), Some(bleed)) = (
                    art["imageUrl"].as_str().and_then(upload_id),
                    art["bleedMm"].as_f64(),
                ) {
                    bleeds.entry(id).or_insert(bleed);
                }
            }
        }
        let input: NewDeck =
            serde_json::from_value(backup).map_err(|_| AppError::user("Invalid deck backup"))?;
        let mut uploads = HashMap::new();
        let mut changed_bleeds = Vec::new();
        for (id, bleed) in bleeds {
            if let Some(mut upload) = self.store.get::<Upload>("upload", &id)? {
                if upload.art.bleed_mm != bleed {
                    self.set_upload_bleed(&id, &mut upload, Some(bleed))?;
                    changed_bleeds.push((id.clone(), upload.art.bleed_mm));
                    uploads.insert(id, upload);
                }
            }
        }
        let updated_uploads = uploads.len();
        let deck = self.store.create_deck_with_uploads(input, uploads)?;
        for (id, current) in changed_bleeds {
            self.prune_upload_thumbnails(&id, current);
        }
        Ok(RestoreResult {
            deck,
            updated_uploads,
        })
    }

    /// Renders a trim snapshot of an upload using the same crop as print export.
    pub async fn trimmed_upload(&self, url: &str, bleed_mm: f64) -> AppResult<Vec<u8>> {
        validate_upload_bleed(Some(bleed_mm))?;
        let (id, upload) = self.saved_upload(url)?;
        let bytes = tokio::fs::read(self.upload_path(&id)).await?;
        tokio::task::spawn_blocking(move || {
            if bleed_mm == 0.0 {
                return Ok(bytes);
            }
            encode_png(&trim_upload(&bytes, upload.art, bleed_mm)?)
        })
        .await?
    }

    fn upload_thumbnail_root(&self) -> PathBuf {
        self.root.join("preview").join("upload-thumbnails")
    }

    fn prune_legacy_upload_thumbnails(&self) {
        let root = self.upload_thumbnail_root();
        let marker = root.join("flat-cache-pruned-v1");
        match marker.try_exists() {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                log::warn!(
                    "Could not check thumbnail cleanup marker {}: {error}",
                    marker.display()
                );
                return;
            }
        }
        if prune_thumbnail_files(&root, |path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| {
                    stem.len() == 64 && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                })
        }) {
            if let Err(error) = std::fs::File::create_new(&marker) {
                if !matches!(error.kind(), ErrorKind::AlreadyExists | ErrorKind::NotFound) {
                    log::warn!(
                        "Could not write thumbnail cleanup marker {}: {error}",
                        marker.display()
                    );
                }
            }
        }
    }

    fn prune_upload_thumbnails(&self, id: &str, current: f64) {
        let current = upload_thumbnail_name(id, current);
        prune_thumbnail_files(&self.upload_thumbnail_root().join(id), |path| {
            path.file_name()
                .is_some_and(|name| name != current.as_str())
        });
    }

    /// Returns the cropped thumbnail for an upload at the requested bleed.
    pub async fn upload_thumbnail(&self, url: &str, bleed_mm: f64) -> AppResult<Vec<u8>> {
        validate_upload_bleed(Some(bleed_mm))?;
        let (id, upload) = self.saved_upload(url)?;
        if bleed_mm == 0.0 {
            return Ok(tokio::fs::read(self.upload_path(&id)).await?);
        }
        let dir = self.upload_thumbnail_root().join(&id);
        let path = dir.join(upload_thumbnail_name(&id, bleed_mm));
        match tokio::fs::read(&path).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let bytes = tokio::fs::read(self.upload_path(&id)).await?;
        tokio::task::spawn_blocking(move || {
            let rgb = trim_upload(&bytes, upload.art, bleed_mm)?;
            let thumbnail = if rgb.width().max(rgb.height()) > UPLOAD_THUMBNAIL_EDGE {
                DynamicImage::ImageRgb8(rgb)
                    .thumbnail(UPLOAD_THUMBNAIL_EDGE, UPLOAD_THUMBNAIL_EDGE)
                    .into_rgb8()
            } else {
                rgb
            };
            let bytes = encode_png(&thumbnail)?;
            std::fs::create_dir_all(dir)?;
            let tmp = path.with_extension(format!("part-{}", new_id()));
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(tmp, path)?;
            Ok(bytes)
        })
        .await?
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
        validate_upload_bleed(input.bleed_mm)?;
        let image = decode(bytes)?;
        let (bleed_mm, dpi) = upload_resolution(image.width(), image.height(), input.bleed_mm);
        let id = new_id();
        let path = self.upload_path(&id);
        std::fs::create_dir_all(path.parent().expect("upload dir has a parent"))?;
        image.to_rgba8().save_with_format(&path, ImageFormat::Png)?;
        let image_url = format!("{UPLOAD_SCHEME}{id}");
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
            bleed_mm,
            dpi,
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
                bleed_auto: input.bleed_mm.is_none(),
            },
        )?;
        Ok(art)
    }
}

fn trim_upload(bytes: &[u8], art: Art, bleed_mm: f64) -> AppResult<image::RgbImage> {
    let art = Art { bleed_mm, ..art };
    let rgb = to_rgb(decode(bytes)?, image::Rgb([255; 3]));
    Ok(strip_bleed(&rgb, &art, &Default::default()))
}

fn validate_upload_bleed(bleed_mm: Option<f64>) -> AppResult<()> {
    if bleed_mm.is_some_and(|bleed| !(0.0..=10.0).contains(&bleed)) {
        return Err(AppError::user("Bleed must be between 0 and 10 mm"));
    }
    Ok(())
}

fn upload_resolution(width: u32, height: u32, declared_bleed: Option<f64>) -> (f64, f64) {
    let bleed = declared_bleed.unwrap_or_else(|| detect_upload_bleed(width, height));
    let dpi = f64::min(
        f64::from(width) / ((UPLOAD_CARD_MM.0 + 2.0 * bleed) / 25.4),
        f64::from(height) / ((UPLOAD_CARD_MM.1 + 2.0 * bleed) / 25.4),
    )
    .round()
    .clamp(1.0, 10_000.0);
    (bleed, dpi)
}

#[derive(Debug, Clone)]
pub struct UploadInput {
    pub oracle_id: String,
    pub name: String,
    pub artist: String,
    pub bleed_mm: Option<f64>,
}
