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
fn reflect(index: i64, len: i64) -> usize {
    if len <= 1 {
        return 0;
    }
    let period = 2 * (len - 1);
    let m = index.rem_euclid(period);
    (if m >= len { period - m } else { m }) as usize
}

/// 1D feather ramp for an output tile: 0..1 over `ramp` samples at both ends.
fn feather(size: usize, ramp: usize) -> Vec<f32> {
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

fn positions(len: u32, tile: u32, step: u32) -> Vec<u32> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Nearest-neighbour 2x "model" with a batch of 2, used to validate tiling.
    struct Nearest;

    impl TileModel for Nearest {
        fn tile(&self) -> u32 {
            16
        }
        fn scale(&self) -> u32 {
            2
        }
        fn batch(&self) -> usize {
            2
        }
        fn info(&self) -> UpscalerInfo {
            UpscalerInfo {
                model_id: "nearest".into(),
                model_name: "Nearest".into(),
                scale: 2,
                tile: 16,
                execution_provider: "test".into(),
            }
        }
        fn run(&mut self, input: &[f32]) -> AppResult<Vec<f32>> {
            let (t, s) = (16usize, 2usize);
            let mut out = vec![0f32; input.len() * s * s];
            for n in 0..self.batch() {
                for c in 0..3 {
                    for y in 0..t * s {
                        for x in 0..t * s {
                            out[n * 3 * t * t * s * s + c * t * t * s * s + y * t * s + x] =
                                input[n * 3 * t * t + c * t * t + (y / s) * t + x / s];
                        }
                    }
                }
            }
            Ok(out)
        }
    }

    #[test]
    fn reflect_padding_mirrors_without_edge_repeat() {
        assert_eq!(reflect(5, 5), 3);
        assert_eq!(reflect(4, 5), 4);
        assert_eq!(reflect(8, 5), 0);
        assert_eq!(reflect(3, 1), 0);
    }

    #[test]
    fn feather_is_symmetric_and_full_in_the_middle() {
        let ramp = feather(8, 2);
        assert!((ramp[0] - 0.25).abs() < 1e-6);
        assert!((ramp[1] - 0.75).abs() < 1e-6);
        assert_eq!(ramp[3], 1.0);
        assert_eq!(ramp[0], ramp[7]);
    }

    #[test]
    fn positions_cover_the_whole_axis() {
        assert_eq!(positions(10, 16, 12), vec![0]);
        assert_eq!(positions(40, 16, 12), vec![0, 12, 24]);
        assert_eq!(positions(41, 16, 12), vec![0, 12, 24, 25]);
    }

    #[test]
    fn tiled_nearest_reproduces_exact_upscale_on_odd_sizes() {
        let mut image = RgbImage::new(37, 29);
        for (x, y, p) in image.enumerate_pixels_mut() {
            *p = image::Rgb([
                (x * 7 % 256) as u8,
                (y * 5 % 256) as u8,
                ((x + y) % 256) as u8,
            ]);
        }
        let upscaler = TiledUpscaler::new(Nearest, 4);
        let mut calls = Vec::new();
        let out = upscaler
            .upscale(&image, &CancelToken::default(), &mut |d, t| {
                calls.push((d, t))
            })
            .unwrap();
        assert_eq!((out.width(), out.height()), (74, 58));
        for (x, y, p) in out.enumerate_pixels() {
            assert_eq!(p, image.get_pixel(x / 2, y / 2), "pixel {x},{y}");
        }
        assert_eq!(calls.first().unwrap().0, 0);
        assert_eq!(calls.last().unwrap().0, calls.last().unwrap().1);
    }

    #[test]
    fn cancellation_stops_before_inference() {
        let token = CancelToken::default();
        token.cancel();
        let upscaler = TiledUpscaler::new(Nearest, 4);
        let result = upscaler.upscale(&RgbImage::new(8, 8), &token, &mut |_, _| {});
        assert!(matches!(result, Err(AppError::Cancelled)));
    }
}
