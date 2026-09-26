//! Runs the style-embedding ONNX model: a fixed-size RGB square in, a unit
//! vector out. The dot product of two embeddings is the similarity.

use std::path::Path;
use std::sync::Mutex;

use image::imageops::FilterType;
use image::{DynamicImage, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

use crate::error::{AppError, AppResult};
use crate::upscaler::manifest::ModelSpec;
use crate::upscaler::ort_backend::{io_shapes, load_session};

/// Fraction of a full card scan occupied by the illustration window on a
/// regular frame: used when a source has no dedicated art crop.
const ART_WINDOW: (f32, f32, f32, f32) = (0.07, 0.11, 0.93, 0.56);

pub struct Embedder {
    session: Mutex<Session>,
    spec: ModelSpec,
    size: u32,
    dims: usize,
    provider: &'static str,
}

impl Embedder {
    pub fn load(spec: &ModelSpec, path: &Path, cache_dir: &Path) -> AppResult<Self> {
        let (session, provider) = load_session(&spec.id, path, cache_dir)?;
        let (input, output) = io_shapes(&session)?;
        if input.len() != 4 || output.len() != 2 {
            return Err(AppError::internal(
                "Style model must take NCHW images and return one vector per image",
            ));
        }
        let size = u32::try_from(input[3])
            .ok()
            .filter(|v| *v > 0 && input[2] == input[3])
            .unwrap_or(spec.tile);
        let dims = usize::try_from(output[1])
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| AppError::internal("Style model has a dynamic output size"))?;
        Ok(Self {
            session: Mutex::new(session),
            spec: spec.clone(),
            size,
            dims,
            provider,
        })
    }

    pub fn model_id(&self) -> &str {
        &self.spec.id
    }

    pub fn execution_provider(&self) -> &'static str {
        self.provider
    }

    pub fn dims(&self) -> usize {
        self.dims
    }

    /// Squares and shrinks `image` to the model's input size. `full_card`
    /// selects the illustration window first.
    pub fn prepare(&self, image: &DynamicImage, full_card: bool) -> RgbImage {
        prepare(image, full_card, self.size)
    }

    /// Embeds an image already shaped by [`Embedder::prepare`].
    pub fn embed(&self, image: &RgbImage) -> AppResult<Vec<f32>> {
        if image.width() != self.size || image.height() != self.size {
            return Err(AppError::internal(
                "Image was not prepared for the style model",
            ));
        }
        let side = self.size as usize;
        let mut input = vec![0f32; 3 * side * side];
        for (x, y, pixel) in image.enumerate_pixels() {
            let offset = y as usize * side + x as usize;
            for channel in 0..3 {
                input[channel * side * side + offset] = f32::from(pixel[channel]) / 255.0;
            }
        }
        let tensor = Tensor::from_array(([1, 3, side, side], input))?;
        let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let outputs = session.run(ort::inputs![tensor])?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>()?;
        let mut vector = data.to_vec();
        vector.truncate(self.dims);
        Ok(normalize(vector))
    }
}

pub fn prepare(image: &DynamicImage, full_card: bool, size: u32) -> RgbImage {
    let mut rgb = image.to_rgb8();
    if full_card {
        let (w, h) = (rgb.width() as f32, rgb.height() as f32);
        let (x0, y0, x1, y1) = ART_WINDOW;
        let (x, y) = ((w * x0) as u32, (h * y0) as u32);
        let (cw, ch) = (
            ((w * (x1 - x0)) as u32).max(1),
            ((h * (y1 - y0)) as u32).max(1),
        );
        rgb = image::imageops::crop_imm(&rgb, x, y, cw, ch).to_image();
    }
    let side = rgb.width().min(rgb.height()).max(1);
    let x = (rgb.width() - side) / 2;
    let y = (rgb.height() - side) / 2;
    let square = image::imageops::crop_imm(&rgb, x, y, side, side).to_image();
    image::imageops::resize(&square, size, size, FilterType::CatmullRom)
}

pub fn normalize(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 1e-6 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

/// Cosine similarity of two unit vectors, clamped to `-1..=1`.
pub fn similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| x * y)
        .sum::<f32>()
        .clamp(-1.0, 1.0)
}
