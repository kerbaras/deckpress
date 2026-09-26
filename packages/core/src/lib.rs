//! Deckpress core. Everything the desktop app does that is not window
//! plumbing lives here: the deck store, art providers, image cache, ONNX
//! upscaling and the raster/PDF print pipeline. The crate has no knowledge of
//! Tauri; the app maps its commands onto these types.

pub mod builder;
pub mod error;
pub mod images;
pub mod jobs;
pub mod layout;
pub mod models;
pub mod pdf;
pub mod providers;
pub mod raster;
pub mod store;
pub mod style;
pub mod upscaler;
pub mod validate;

use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use error::{AppError, AppResult};

/// Every long-lived service, wired together once at startup.
pub struct Core {
    pub data_dir: PathBuf,
    pub store: Arc<store::Store>,
    pub providers: Arc<providers::Providers>,
    pub images: Arc<images::Images>,
    pub models: Arc<upscaler::manifest::ModelManager>,
    pub jobs: Arc<jobs::Jobs>,
    pub style: Arc<style::StyleMatcher>,
    pub builder: Arc<builder::Builder>,
}

impl Core {
    /// Opens the store and caches under `data_dir` and reads bundled model
    /// weights from `resource_dir`. Print jobs run on `runtime`.
    pub fn open(
        data_dir: &Path,
        resource_dir: &Path,
        runtime: tokio::runtime::Handle,
    ) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let store = Arc::new(store::Store::open(&data_dir.join("deckpress.sqlite"))?);
        let providers = Arc::new(providers::Providers::new(Arc::clone(&store))?);
        let images = Arc::new(images::Images::new(data_dir, Arc::clone(&store))?);
        let models = Arc::new(upscaler::manifest::ModelManager::new(
            resource_dir,
            data_dir,
        )?);
        let jobs = Arc::new(jobs::Jobs::new(
            Arc::clone(&store),
            Arc::clone(&images),
            Arc::clone(&models),
            data_dir,
            runtime,
        )?);
        jobs.start();
        let style = Arc::new(style::StyleMatcher::new(
            Arc::clone(&store),
            Arc::clone(&images),
            Arc::clone(&models),
        ));
        let builder = Arc::new(builder::Builder::new(Arc::clone(&providers)));
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            store,
            providers,
            images,
            models,
            jobs,
            style,
            builder,
        })
    }
}
