//! "Match art style": given one reference illustration, rank every other
//! card's available printings by how alike they look. Visual similarity comes
//! from the bundled embedding model (`embed`); printing metadata (`heuristic`)
//! breaks ties and carries the whole ranking when the model cannot run.

pub mod embed;
pub mod heuristic;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult};
use crate::images::Images;
use crate::models::Art;
use crate::store::Store;
use crate::upscaler::manifest::ModelManager;
use embed::Embedder;

const EMBEDDING_KIND: &str = "style-embedding";
const MAX_ENTRIES: usize = 500;
const MAX_OPTIONS: usize = 80;
const CONCURRENT_FETCHES: usize = 4;
/// Cosine range observed across unrelated and identical illustrations, mapped
/// onto the 0..1 "visual match" shown to the user.
const COSINE_FLOOR: f32 = 0.3;
const COSINE_SPAN: f32 = 0.65;
const VISUAL_WEIGHT: f32 = 0.7;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleEntry {
    pub entry_id: String,
    pub options: Vec<Art>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleRequest {
    pub reference: Art,
    pub entries: Vec<StyleEntry>,
    /// `false` forces the metadata-only ranking.
    #[serde(default = "default_true")]
    pub use_model: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StyleMethod {
    Model,
    Heuristic,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyleModelInfo {
    pub id: String,
    pub name: String,
    pub execution_provider: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoredArt {
    pub art: Art,
    /// Blended 0..1 score used for ordering.
    pub score: f32,
    /// Visual match 0..1 from the embedding model, when it ran on both images.
    pub visual: Option<f32>,
    /// Metadata-only score 0..1.
    pub metadata: f32,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyleMatch {
    pub entry_id: String,
    /// Best match first. Empty when the entry had no options.
    pub ranked: Vec<ScoredArt>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyleReport {
    pub method: StyleMethod,
    pub model: Option<StyleModelInfo>,
    pub matches: Vec<StyleMatch>,
    pub warnings: Vec<String>,
    /// Images embedded (or found in the embedding cache) for this run.
    pub embedded: usize,
    /// Images that could not be fetched or decoded and fell back to metadata.
    pub skipped: usize,
}

/// Where the embedding for an art comes from: dedicated illustration crops
/// when the provider has them, otherwise the illustration window of the scan.
fn embed_source(art: &Art) -> (&str, bool) {
    if !art.art_crop_url.is_empty() {
        (&art.art_crop_url, false)
    } else if !art.thumbnail_url.is_empty() {
        (&art.thumbnail_url, true)
    } else {
        (&art.image_url, true)
    }
}

pub fn visual_from_cosine(cosine: f32) -> f32 {
    ((cosine - COSINE_FLOOR) / COSINE_SPAN).clamp(0.0, 1.0)
}

pub struct StyleMatcher {
    store: Arc<Store>,
    images: Arc<Images>,
    models: Arc<ModelManager>,
    embedder: Mutex<Option<Arc<Embedder>>>,
}

impl StyleMatcher {
    pub fn new(store: Arc<Store>, images: Arc<Images>, models: Arc<ModelManager>) -> Self {
        Self {
            store,
            images,
            models,
            embedder: Mutex::new(None),
        }
    }

    /// Loads the embedding model on first use. Blocking: call from a worker.
    pub fn embedder(&self) -> AppResult<Arc<Embedder>> {
        if let Some(existing) = self
            .embedder
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            return Ok(existing.clone());
        }
        let spec = self
            .models
            .style_spec()
            .ok_or_else(|| AppError::user("This build has no art-style model"))?
            .clone();
        let path = self.models.installed_path(&spec)?;
        std::fs::create_dir_all(self.models.cache_dir())?;
        let embedder = Arc::new(Embedder::load(&spec, &path, self.models.cache_dir())?);
        *self.embedder.lock().unwrap_or_else(|e| e.into_inner()) = Some(embedder.clone());
        Ok(embedder)
    }

    fn cache_key(model_id: &str, url: &str) -> String {
        format!("{model_id}:{url}")
    }

    /// Embedding for one art, served from the store when it was computed
    /// before.
    async fn embedding(&self, embedder: &Arc<Embedder>, art: &Art) -> AppResult<Vec<f32>> {
        let (url, full_card) = embed_source(art);
        let key = Self::cache_key(embedder.model_id(), url);
        if let Some(cached) = self.store.get::<Vec<f32>>(EMBEDDING_KIND, &key)? {
            if cached.len() == embedder.dims() {
                return Ok(cached);
            }
        }
        let bytes = self.images.read(url).await?;
        let embedder = embedder.clone();
        let vector = tokio::task::spawn_blocking(move || -> AppResult<Vec<f32>> {
            let image = crate::images::decode(&bytes)?;
            embedder.embed(&embedder.prepare(&image, full_card))
        })
        .await??;
        self.store.put(EMBEDDING_KIND, &key, &vector)?;
        Ok(vector)
    }

    /// Ranks every entry's options against `request.reference`.
    /// `progress(done, total)` counts images as they are embedded.
    pub async fn rank(
        self: &Arc<Self>,
        request: StyleRequest,
        mut progress: impl FnMut(usize, usize),
    ) -> AppResult<StyleReport> {
        if request.entries.len() > MAX_ENTRIES {
            return Err(AppError::user(format!(
                "Style matching is limited to {MAX_ENTRIES} cards at a time"
            )));
        }
        if request
            .entries
            .iter()
            .any(|entry| entry.options.len() > MAX_OPTIONS)
        {
            return Err(AppError::user(format!(
                "Style matching compares at most {MAX_OPTIONS} printings per card"
            )));
        }
        let mut warnings = Vec::new();
        let embedder = if request.use_model {
            let matcher = Arc::clone(self);
            match tokio::task::spawn_blocking(move || matcher.embedder()).await? {
                Ok(embedder) => Some(embedder),
                Err(error) => {
                    log::warn!("Style model unavailable, using metadata only: {error}");
                    warnings.push(format!(
                        "The art-style model could not be loaded ({error}). Ranking by artist, labels and set instead."
                    ));
                    None
                }
            }
        } else {
            None
        };

        let mut vectors: HashMap<String, Vec<f32>> = HashMap::new();
        let mut skipped = 0;
        if let Some(embedder) = &embedder {
            let mut arts: Vec<&Art> = vec![&request.reference];
            arts.extend(request.entries.iter().flat_map(|entry| &entry.options));
            let mut unique: Vec<Art> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for art in arts {
                if seen.insert(art.id.clone()) {
                    unique.push(art.clone());
                }
            }
            let total = unique.len();
            progress(0, total);
            let limit = Arc::new(Semaphore::new(CONCURRENT_FETCHES));
            let mut tasks = JoinSet::new();
            for art in unique {
                let matcher = Arc::clone(self);
                let embedder = embedder.clone();
                let limit = limit.clone();
                tasks.spawn(async move {
                    let _permit = limit.acquire_owned().await;
                    let result = matcher.embedding(&embedder, &art).await;
                    (art, result)
                });
            }
            let mut done = 0;
            while let Some(joined) = tasks.join_next().await {
                let (art, result) = joined?;
                done += 1;
                progress(done, total);
                match result {
                    Ok(vector) => {
                        vectors.insert(art.id, vector);
                    }
                    Err(error) => {
                        log::warn!("Could not embed {} ({}): {error}", art.id, art.name);
                        skipped += 1;
                    }
                }
            }
            if !vectors.contains_key(&request.reference.id) {
                warnings.push(
                    "The reference illustration could not be analysed; ranking by metadata only."
                        .into(),
                );
            }
        }

        let reference_vector = vectors.get(&request.reference.id).cloned();
        let matches = request
            .entries
            .iter()
            .map(|entry| {
                let mut ranked: Vec<ScoredArt> = entry
                    .options
                    .iter()
                    .map(|art| {
                        let metadata = heuristic::score(&request.reference, art);
                        let visual = reference_vector.as_ref().and_then(|reference| {
                            vectors.get(&art.id).map(|vector| {
                                visual_from_cosine(embed::similarity(reference, vector))
                            })
                        });
                        let mut reasons = Vec::new();
                        // Once the reference has a vector every candidate is
                        // scored on the same scale; one whose image could not
                        // be analysed gets a zero visual term rather than a
                        // metadata-only score that would leapfrog scored art.
                        let score = match (visual, &reference_vector) {
                            (Some(visual), _) => {
                                reasons.push(format!("Visual match {}%", (visual * 100.0).round()));
                                VISUAL_WEIGHT * visual + (1.0 - VISUAL_WEIGHT) * metadata.score
                            }
                            (None, Some(_)) => {
                                reasons.push("Illustration could not be analysed".into());
                                (1.0 - VISUAL_WEIGHT) * metadata.score
                            }
                            (None, None) => metadata.score,
                        };
                        reasons.extend(metadata.reasons);
                        ScoredArt {
                            art: art.clone(),
                            score,
                            visual,
                            metadata: metadata.score,
                            reasons,
                        }
                    })
                    .collect();
                ranked.sort_by(|a, b| {
                    b.score
                        .total_cmp(&a.score)
                        .then_with(|| b.art.released_at.cmp(&a.art.released_at))
                });
                StyleMatch {
                    entry_id: entry.entry_id.clone(),
                    ranked,
                }
            })
            .collect();

        let model = embedder
            .as_ref()
            .filter(|_| reference_vector.is_some())
            .map(|embedder| StyleModelInfo {
                id: embedder.model_id().to_string(),
                name: self
                    .models
                    .style_spec()
                    .map(|spec| spec.name.clone())
                    .unwrap_or_default(),
                execution_provider: embedder.execution_provider().to_string(),
            });
        Ok(StyleReport {
            method: if model.is_some() {
                StyleMethod::Model
            } else {
                StyleMethod::Heuristic
            },
            model,
            matches,
            warnings,
            embedded: vectors.len(),
            skipped,
        })
    }
}
