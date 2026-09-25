//! ONNX Runtime backend. Picks the platform execution provider (Core ML on
//! Apple silicon, DirectML on Windows, CUDA when compiled in and present,
//! otherwise CPU) and reads the static tile shape from the model itself.

use std::path::Path;
use std::sync::Once;

use ort::ep::ExecutionProviderDispatch;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use super::manifest::ModelSpec;
use super::{TileModel, UpscalerInfo};
use crate::error::{AppError, AppResult};

static INIT: Once = Once::new();

fn init_runtime() {
    INIT.call_once(|| {
        ort::init().with_name("deckpress").commit();
    });
}

struct Candidate {
    name: &'static str,
    dispatch: ExecutionProviderDispatch,
}

fn candidates(cache_dir: &Path) -> Vec<Candidate> {
    let mut list = Vec::new();
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        use ort::ep::coreml::{ComputeUnits, ModelFormat, SpecializationStrategy};
        list.push(Candidate {
            name: "CoreML",
            dispatch: ort::ep::CoreML::default()
                .with_model_format(ModelFormat::MLProgram)
                .with_static_input_shapes(true)
                .with_compute_units(ComputeUnits::All)
                .with_specialization_strategy(SpecializationStrategy::FastPrediction)
                .with_model_cache_dir(cache_dir.join("coreml").display())
                .build()
                .error_on_failure(),
        });
    }
    #[cfg(target_os = "windows")]
    list.push(Candidate {
        name: "DirectML",
        dispatch: ort::ep::DirectML::default().build().error_on_failure(),
    });
    #[cfg(feature = "cuda")]
    list.push(Candidate {
        name: "CUDA",
        dispatch: ort::ep::CUDA::default().build().error_on_failure(),
    });
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    let _ = cache_dir;
    list.push(Candidate {
        name: "CPU",
        dispatch: ort::ep::CPU::default().build(),
    });
    list
}

pub struct OrtModel {
    session: Session,
    spec: ModelSpec,
    tile: u32,
    scale: u32,
    batch: usize,
    provider: &'static str,
}

impl OrtModel {
    pub fn load(spec: &ModelSpec, path: &Path, cache_dir: &Path) -> AppResult<Self> {
        init_runtime();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let mut last_error = None;
        for candidate in candidates(cache_dir) {
            let built = (|| -> AppResult<Session> {
                Ok(Session::builder()?
                    .with_optimization_level(GraphOptimizationLevel::Level3)?
                    .with_intra_threads(threads)?
                    .with_execution_providers([candidate.dispatch])?
                    .commit_from_file(path)?)
            })();
            match built {
                Ok(session) => {
                    log::info!(
                        "Loaded {} with the {} execution provider",
                        spec.id,
                        candidate.name
                    );
                    return Self::from_session(session, spec, candidate.name);
                }
                Err(error) => {
                    log::warn!(
                        "{} execution provider unavailable for {}: {error}",
                        candidate.name,
                        spec.id
                    );
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| AppError::internal("No execution provider available")))
    }

    fn from_session(session: Session, spec: &ModelSpec, provider: &'static str) -> AppResult<Self> {
        let input = session
            .inputs()
            .first()
            .and_then(|input| input.dtype().tensor_shape().cloned())
            .ok_or_else(|| AppError::internal("Model has no tensor input"))?;
        let output = session
            .outputs()
            .first()
            .and_then(|output| output.dtype().tensor_shape().cloned())
            .ok_or_else(|| AppError::internal("Model has no tensor output"))?;
        if input.len() != 4 || output.len() != 4 {
            return Err(AppError::internal("Model input/output must be NCHW"));
        }
        let dim = |value: i64, fallback: u32| {
            u32::try_from(value)
                .ok()
                .filter(|v| *v > 0)
                .unwrap_or(fallback)
        };
        let batch = dim(input[0], 1) as usize;
        let tile = dim(input[3], spec.tile);
        if dim(input[2], spec.tile) != tile {
            return Err(AppError::internal("Model tiles must be square"));
        }
        let scale = dim(output[3], spec.tile * spec.scale) / tile;
        if scale == 0 {
            return Err(AppError::internal("Model output is smaller than its input"));
        }
        Ok(Self {
            session,
            spec: spec.clone(),
            tile,
            scale,
            batch,
            provider,
        })
    }
}

impl TileModel for OrtModel {
    fn tile(&self) -> u32 {
        self.tile
    }

    fn scale(&self) -> u32 {
        self.scale
    }

    fn batch(&self) -> usize {
        self.batch
    }

    fn info(&self) -> UpscalerInfo {
        UpscalerInfo {
            model_id: self.spec.id.clone(),
            model_name: self.spec.name.clone(),
            scale: self.scale,
            tile: self.tile,
            execution_provider: self.provider.to_string(),
        }
    }

    fn run(&mut self, input: &[f32]) -> AppResult<Vec<f32>> {
        let shape = [self.batch, 3, self.tile as usize, self.tile as usize];
        let tensor = Tensor::from_array((shape, input.to_vec()))?;
        let outputs = self.session.run(ort::inputs![tensor])?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>()?;
        Ok(data.to_vec())
    }
}
