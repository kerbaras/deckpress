//! Static tiles with reflect padding, overlap and feathered blending.

use std::sync::Mutex;

use image::RgbImage;

use super::{CancelToken, TileModel, Upscaler, UpscalerInfo};
use crate::error::{AppError, AppResult};

pub const DEFAULT_OVERLAP: u32 = 24;

pub struct TiledUpscaler<M: TileModel> {
    model: Mutex<M>,
    info: UpscalerInfo,
    tile: u32,
    scale: u32,
    batch: usize,
    overlap: u32,
}

impl<M: TileModel> TiledUpscaler<M> {
    pub fn new(model: M, overlap: u32) -> Self {
        let (tile, scale, batch, info) = (
            model.tile(),
            model.scale(),
            model.batch().max(1),
            model.info(),
        );
        Self {
            model: Mutex::new(model),
            info,
            tile,
            scale,
            batch,
            overlap: overlap.min(tile / 2),
        }
    }
}

/// Mirror index without repeating the edge sample (numpy `reflect`).
pub fn reflect(index: i64, len: i64) -> usize {
    if len <= 1 {
        return 0;
    }
    let period = 2 * (len - 1);
    let m = index.rem_euclid(period);
    (if m >= len { period - m } else { m }) as usize
}

/// 1D feather ramp for an output tile: 0..1 over `ramp` samples at both ends.
pub fn feather(size: usize, ramp: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            if ramp == 0 {
                return 1.0;
            }
            let start = (i as f32 + 0.5) / ramp as f32;
            let end = ((size - i) as f32 - 0.5) / ramp as f32;
            start.min(end).clamp(0.0, 1.0)
        })
        .collect()
}

pub fn positions(len: u32, tile: u32, step: u32) -> Vec<u32> {
    if len <= tile {
        return vec![0];
    }
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        out.push(pos);
        if pos + tile >= len {
            break;
        }
        pos = (pos + step).min(len - tile);
    }
    out
}

impl<M: TileModel> Upscaler for TiledUpscaler<M> {
    fn info(&self) -> UpscalerInfo {
        self.info.clone()
    }

    fn upscale(
        &self,
        image: &RgbImage,
        cancel: &CancelToken,
        progress: &mut dyn FnMut(usize, usize),
    ) -> AppResult<RgbImage> {
        let (w, h) = (image.width(), image.height());
        if w == 0 || h == 0 {
            return Err(AppError::user("Cannot upscale an empty image"));
        }
        let (tile, scale) = (self.tile, self.scale);
        let step = tile - self.overlap;
        let xs = positions(w, tile, step);
        let ys = positions(h, tile, step);
        let coords: Vec<(u32, u32)> = ys
            .iter()
            .flat_map(|&y| xs.iter().map(move |&x| (x, y)))
            .collect();
        let total = coords.len();

        let out_tile = (tile * scale) as usize;
        let (ow, oh) = ((w * scale) as usize, (h * scale) as usize);
        let mut accum = vec![0f32; ow * oh * 3];
        let mut weight = vec![0f32; ow * oh];
        let ramp = feather(out_tile, (self.overlap * scale) as usize);
        let src = image.as_raw();
        let tile_len = (tile * tile * 3) as usize;
        let out_len = out_tile * out_tile * 3;

        let mut model = self
            .model
            .lock()
            .map_err(|_| AppError::user("Upscaler is unavailable"))?;
        let mut done = 0;
        progress(0, total);
        for chunk in coords.chunks(self.batch) {
            cancel.check()?;
            let mut input = vec![0f32; tile_len * self.batch];
            for (n, &(x0, y0)) in chunk.iter().enumerate() {
                let base = n * tile_len;
                for ty in 0..tile as usize {
                    let sy = reflect(y0 as i64 + ty as i64, h as i64);
                    for tx in 0..tile as usize {
                        let sx = reflect(x0 as i64 + tx as i64, w as i64);
                        let pixel = (sy * w as usize + sx) * 3;
                        for c in 0..3 {
                            input[base + c * (tile * tile) as usize + ty * tile as usize + tx] =
                                f32::from(src[pixel + c]) / 255.0;
                        }
                    }
                }
            }
            for n in chunk.len()..self.batch {
                let (from, to) = (0, n * tile_len);
                input.copy_within(from..from + tile_len, to);
            }
            let output = model.run(&input)?;
            if output.len() < out_len * chunk.len() {
                return Err(AppError::internal(format!(
                    "Model returned {} values, expected at least {}",
                    output.len(),
                    out_len * chunk.len()
                )));
            }
            for (n, &(x0, y0)) in chunk.iter().enumerate() {
                let base = n * out_len;
                let (ox0, oy0) = ((x0 * scale) as usize, (y0 * scale) as usize);
                for ty in 0..out_tile {
                    let oy = oy0 + ty;
                    if oy >= oh {
                        break;
                    }
                    for tx in 0..out_tile {
                        let ox = ox0 + tx;
                        if ox >= ow {
                            break;
                        }
                        let wgt = ramp[ty] * ramp[tx];
                        let index = oy * ow + ox;
                        weight[index] += wgt;
                        for c in 0..3 {
                            accum[index * 3 + c] +=
                                output[base + c * out_tile * out_tile + ty * out_tile + tx] * wgt;
                        }
                    }
                }
            }
            done += chunk.len();
            progress(done, total);
        }
        drop(model);

        let mut pixels = vec![0u8; ow * oh * 3];
        for (index, wgt) in weight.iter().enumerate() {
            let norm = if *wgt > 1e-6 { 1.0 / wgt } else { 0.0 };
            for c in 0..3 {
                pixels[index * 3 + c] = (accum[index * 3 + c] * norm)
                    .clamp(0.0, 1.0)
                    .mul_add(255.0, 0.5) as u8;
            }
        }
        RgbImage::from_raw(ow as u32, oh as u32, pixels)
            .ok_or_else(|| AppError::internal("Upscaled buffer has the wrong size"))
    }
}
