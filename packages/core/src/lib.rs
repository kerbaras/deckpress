//! Deckpress core. Everything the desktop app does that is not window
//! plumbing lives here: the deck store, art providers, image cache, ONNX
//! upscaling and the raster/PDF print pipeline. The crate has no knowledge of
//! Tauri; the app maps its commands onto these types.

pub mod art_policy;
pub mod art_quality;
#[cfg(feature = "native")]
pub mod builder;
pub mod cut_dxf;
pub mod cut_svg;
#[cfg(feature = "native")]
pub mod decksearch;
pub mod error;
#[cfg(feature = "native")]
pub mod images;
#[cfg(feature = "native")]
pub mod jobs;
pub mod layout;
pub mod models;
pub mod pdf;
pub mod png_export;
#[cfg(feature = "native")]
pub mod providers;
pub mod raster;
pub mod scm;
pub mod scm_cut;
#[cfg(feature = "native")]
pub mod store;
#[cfg(feature = "native")]
pub mod style;
pub mod upscaler;
pub mod validate;

#[cfg(feature = "native")]
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub use error::{AppError, AppResult};

/// Formats an English count with its singular or plural noun.
pub fn format_count(count: usize, singular: &str, plural: &str) -> String {
    let noun = count_noun(count, singular, plural);
    format!("{count} {noun}")
}

fn count_noun<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 {
        singular
    } else {
        plural
    }
}

/// Every long-lived service, wired together once at startup.
#[cfg(feature = "native")]
pub struct Core {
    pub data_dir: PathBuf,
    pub store: Arc<store::Store>,
    pub providers: Arc<providers::Providers>,
    pub images: Arc<images::Images>,
    pub models: Arc<upscaler::manifest::ModelManager>,
    pub jobs: Arc<jobs::Jobs>,
    pub style: Arc<style::StyleMatcher>,
    pub builder: Arc<builder::Builder>,
    pub decksearch: Arc<decksearch::DeckSearch>,
    pub art_policy: art_policy::ArtPolicies,
}

#[cfg(feature = "native")]
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
        let decksearch = Arc::new(decksearch::DeckSearch::new(
            Arc::clone(&store),
            Arc::clone(&providers),
        )?);
        let builder = Arc::new(builder::Builder::with_deck_search(
            Arc::clone(&providers),
            Arc::clone(&decksearch),
        ));
        Ok(Self {
            art_policy: art_policy::ArtPolicies::new(Arc::clone(&store), Arc::clone(&providers)),
            data_dir: data_dir.to_path_buf(),
            store,
            providers,
            images,
            models,
            jobs,
            style,
            builder,
            decksearch,
        })
    }
}
