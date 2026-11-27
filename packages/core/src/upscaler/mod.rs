//! Super-resolution behind the `Upscaler` trait. `tiling` turns any fixed-tile
//! model into a whole-image upscaler. Native builds also include ONNX Runtime
//! and the model manifest.

#[cfg(feature = "native")]
pub mod manifest;
#[cfg(feature = "native")]
pub mod ort_backend;
#[cfg(feature = "native")]
pub mod preview;
pub mod tiling;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(feature = "native")]
use std::sync::{Mutex, Weak};

use image::RgbImage;
use serde::Serialize;
#[cfg(feature = "native")]
use tokio::sync::Notify;

use crate::error::AppResult;

#[cfg(feature = "native")]
type CancelHook = dyn Fn() + Send + Sync;

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    #[cfg(feature = "native")]
    wake: Notify,
    #[cfg(feature = "native")]
    hooks: Mutex<Vec<Weak<CancelHook>>>,
}

/// Cooperative cancellation for print and preview inference.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<Cancellation>);

impl CancelToken {
    pub fn cancel(&self) {
        #[cfg(not(feature = "native"))]
        self.0.cancelled.store(true, Ordering::SeqCst);
        #[cfg(feature = "native")]
        if !self.0.cancelled.swap(true, Ordering::SeqCst) {
            self.0.wake.notify_waiters();
            let mut hooks = self.0.hooks.lock().unwrap_or_else(|err| err.into_inner());
            for hook in hooks.drain(..).filter_map(|hook| hook.upgrade()) {
                hook();
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> AppResult<()> {
        if self.is_cancelled() {
            Err(crate::error::AppError::Cancelled)
        } else {
            Ok(())
        }
    }

    #[cfg(feature = "native")]
    pub async fn cancelled(&self) {
        let notified = self.0.wake.notified();
        if !self.is_cancelled() {
            notified.await;
        }
    }

    #[cfg(feature = "native")]
    fn on_cancel(&self, hook: impl Fn() + Send + Sync + 'static) -> AppResult<Arc<CancelHook>> {
        let mut hooks = self.0.hooks.lock().unwrap_or_else(|err| err.into_inner());
        self.check()?;
        let hook: Arc<CancelHook> = Arc::new(hook);
        hooks.retain(|hook| hook.strong_count() != 0);
        hooks.push(Arc::downgrade(&hook));
        Ok(hook)
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
    fn run(&mut self, input: &[f32], cancel: &CancelToken) -> AppResult<Vec<f32>>;
}
