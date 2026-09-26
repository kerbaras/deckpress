//! Super-resolution behind the `Upscaler` trait. `tiling` turns any fixed-tile
//! model into a whole-image upscaler; `ort_backend` runs ONNX models through
//! ONNX Runtime; `manifest` knows which models exist, where they live and how
//! to fetch and verify the ones that are not bundled.

pub mod manifest;
pub mod ort_backend;
pub mod tiling;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::RgbImage;
use serde::Serialize;

use crate::error::AppResult;

/// Cooperative cancellation shared between a print job and the pipeline.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> AppResult<()> {
        if self.is_cancelled() {
            Err(crate::error::AppError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpscalerInfo {
    pub model_id: String,
    pub model_name: String,
    pub scale: u32,
    pub tile: u32,
    pub execution_provider: String,
}

pub trait Upscaler: Send + Sync {
    fn info(&self) -> UpscalerInfo;

    /// Upscales `image` by `info().scale`. `progress(done, total)` is called
    /// once per inference batch.
    fn upscale(
        &self,
        image: &RgbImage,
        cancel: &CancelToken,
        progress: &mut dyn FnMut(usize, usize),
    ) -> AppResult<RgbImage>;
}

/// Runs one fixed-shape batch of tiles. Implemented by inference backends and
/// wrapped by [`tiling::TiledUpscaler`].
pub trait TileModel: Send {
    fn tile(&self) -> u32;
    fn scale(&self) -> u32;
    fn batch(&self) -> usize;
    fn info(&self) -> UpscalerInfo;

    /// `input` is NCHW `f32` in `0..=1` with `N == batch()`. Returns NCHW
    /// output with spatial dimensions multiplied by `scale()`.
    fn run(&mut self, input: &[f32]) -> AppResult<Vec<f32>>;
}
