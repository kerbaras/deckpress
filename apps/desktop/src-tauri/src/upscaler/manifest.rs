//! Model manifest: which models exist, where they live, and downloading and
//! verifying the ones that are not bundled with the app.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::ort_backend::OrtModel;
use super::tiling::{TiledUpscaler, DEFAULT_OVERLAP};
use super::Upscaler;
use crate::error::{AppError, AppResult};

const MANIFEST: &str = include_str!("../../resources/models/models.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub file: String,
    pub scale: u32,
    pub tile: u32,
    pub bytes: u64,
    pub sha256: String,
    pub bundled: bool,
    pub url: Option<String>,
    pub license: String,
    pub license_url: String,
    pub source: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub spec: ModelSpec,
    pub installed: bool,
    pub downloading: bool,
}

pub fn specs() -> Vec<ModelSpec> {
    serde_json::from_str(MANIFEST).expect("models.json is valid")
}

pub fn default_model_id() -> String {
    specs()
        .into_iter()
        .find(|spec| spec.tier == "default")
        .map(|spec| spec.id)
        .expect("manifest has a default model")
}

pub struct ModelManager {
    specs: Vec<ModelSpec>,
    resource_dir: PathBuf,
    models_dir: PathBuf,
    cache_dir: PathBuf,
    client: reqwest::Client,
    downloading: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    loaded: Mutex<HashMap<String, Arc<dyn Upscaler>>>,
}

pub fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

impl ModelManager {
    /// `resource_dir` holds bundled models, `data_dir` receives downloads and
    /// the execution-provider cache.
    pub fn new(resource_dir: impl Into<PathBuf>, data_dir: &Path) -> AppResult<Self> {
        let data_dir = data_dir.to_path_buf();
        Ok(Self {
            specs: specs(),
            resource_dir: resource_dir.into(),
            models_dir: data_dir.join("models"),
            cache_dir: data_dir.join("model-cache"),
            client: reqwest::Client::builder()
                .user_agent(crate::providers::USER_AGENT)
                .connect_timeout(Duration::from_secs(20))
                .build()?,
            downloading: Mutex::new(HashMap::new()),
            loaded: Mutex::new(HashMap::new()),
        })
    }

    pub fn spec(&self, id: &str) -> AppResult<&ModelSpec> {
        self.specs
            .iter()
            .find(|spec| spec.id == id)
            .ok_or_else(|| AppError::user(format!("Unknown upscaling model '{id}'")))
    }

    pub fn path(&self, spec: &ModelSpec) -> Option<PathBuf> {
        let bundled = self.resource_dir.join("models").join(&spec.file);
        if spec.bundled && bundled.is_file() {
            return Some(bundled);
        }
        let downloaded = self.models_dir.join(&spec.file);
        downloaded.is_file().then_some(downloaded)
    }

    pub fn status(&self) -> Vec<ModelStatus> {
        let downloading = self.downloading.lock().unwrap_or_else(|e| e.into_inner());
        self.specs
            .iter()
            .map(|spec| ModelStatus {
                installed: self.path(spec).is_some(),
                downloading: downloading.contains_key(&spec.id),
                spec: spec.clone(),
            })
            .collect()
    }

    /// Downloads a model to `models/` and verifies its SHA-256 before it is
    /// made visible. Returns immediately when the model is already installed.
    pub async fn install(
        &self,
        id: &str,
        mut progress: impl FnMut(u64, u64),
    ) -> AppResult<PathBuf> {
        let spec = self.spec(id)?.clone();
        if let Some(path) = self.path(&spec) {
            return Ok(path);
        }
        let url = spec.url.clone().ok_or_else(|| {
            AppError::user(format!(
                "{} is not bundled and has no download URL",
                spec.name
            ))
        })?;
        let waiter = {
            let mut downloading = self.downloading.lock().unwrap_or_else(|e| e.into_inner());
            match downloading.get(id) {
                Some(notify) => Some(notify.clone()),
                None => {
                    downloading.insert(id.to_string(), Arc::new(tokio::sync::Notify::new()));
                    None
                }
            }
        };
        if let Some(notify) = waiter {
            notify.notified().await;
            return self
                .path(&spec)
                .ok_or_else(|| AppError::user("Model download failed"));
        }
        let result = self.download(&spec, &url, &mut progress).await;
        if let Some(notify) = self
            .downloading
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            notify.notify_waiters();
        }
        result
    }

    async fn download(
        &self,
        spec: &ModelSpec,
        url: &str,
        progress: &mut impl FnMut(u64, u64),
    ) -> AppResult<PathBuf> {
        tokio::fs::create_dir_all(&self.models_dir).await?;
        let target = self.models_dir.join(&spec.file);
        let partial = self.models_dir.join(format!("{}.part", spec.file));
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| AppError::user("Could not reach the model download server"))?;
        if !response.status().is_success() {
            return Err(AppError::user(format!(
                "Model download failed ({})",
                response.status().as_u16()
            )));
        }
        let total = response.content_length().unwrap_or(spec.bytes);
        let mut file = tokio::fs::File::create(&partial).await?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        let mut stream = response.bytes_stream();
        progress(0, total);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AppError::user("Model download was interrupted"))?;
            received += chunk.len() as u64;
            if received > spec.bytes.saturating_mul(2) {
                drop(file);
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(AppError::user("Model download is larger than expected"));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            progress(received, total);
        }
        file.flush().await?;
        drop(file);
        let digest = hex::encode(hasher.finalize());
        if digest != spec.sha256 {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(AppError::user(format!(
                "Downloaded {} failed its SHA-256 check and was discarded",
                spec.name
            )));
        }
        tokio::fs::rename(&partial, &target).await?;
        Ok(target)
    }

    /// Execution-provider details for a model that has already been loaded
    /// this session, preferring the default model.
    pub fn loaded_info(&self) -> Option<super::UpscalerInfo> {
        let loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        loaded
            .get(&default_model_id())
            .or_else(|| loaded.values().next())
            .map(|upscaler| upscaler.info())
    }

    /// Returns a ready-to-run upscaler, loading the session on first use.
    pub fn upscaler(&self, id: &str) -> AppResult<Arc<dyn Upscaler>> {
        if let Some(existing) = self
            .loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
        {
            return Ok(existing.clone());
        }
        let spec = self.spec(id)?;
        let path = self.path(spec).ok_or_else(|| {
            AppError::user(format!(
                "{} is not installed. Download it from Print setup first.",
                spec.name
            ))
        })?;
        std::fs::create_dir_all(&self.cache_dir)?;
        let model = OrtModel::load(spec, &path, &self.cache_dir)?;
        let upscaler: Arc<dyn Upscaler> = Arc::new(TiledUpscaler::new(model, DEFAULT_OVERLAP));
        self.loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), upscaler.clone());
        Ok(upscaler)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_one_default_and_bundled_files_match_their_digests() {
        let specs = specs();
        assert_eq!(specs.iter().filter(|s| s.tier == "default").count(), 1);
        for spec in specs.iter().filter(|s| s.bundled) {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources/models")
                .join(&spec.file);
            assert_eq!(sha256_file(&path).unwrap(), spec.sha256, "{}", spec.id);
            assert_eq!(
                std::fs::metadata(&path).unwrap().len(),
                spec.bytes,
                "{}",
                spec.id
            );
        }
        for spec in specs.iter().filter(|s| !s.bundled) {
            assert!(spec.url.is_some(), "{} needs a download URL", spec.id);
        }
    }

    #[test]
    fn bundled_model_runs_on_cpu_and_produces_a_4x_tile() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let dir = tempfile::tempdir().unwrap();
        let manager = ModelManager::new(root.join("resources"), dir.path()).unwrap();
        let upscaler = manager.upscaler(&default_model_id()).unwrap();
        let info = upscaler.info();
        assert_eq!(info.scale, 4);
        assert_eq!(info.tile, 256);
        let mut image = image::RgbImage::new(300, 70);
        for (x, y, p) in image.enumerate_pixels_mut() {
            let v = if (x / 10 + y / 10) % 2 == 0 { 235 } else { 20 };
            *p = image::Rgb([v, v, v]);
        }
        let out = upscaler
            .upscale(
                &image,
                &super::super::CancelToken::default(),
                &mut |_, _| {},
            )
            .unwrap();
        assert_eq!((out.width(), out.height()), (1200, 280));
        let center = out.get_pixel(20, 20)[0];
        let dark = out.get_pixel(60, 20)[0];
        assert!(
            center > 180 && dark < 80,
            "checkerboard should survive: {center} {dark}"
        );
    }
}
