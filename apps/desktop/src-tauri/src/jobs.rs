//! Serialized print queue. One job renders at a time because inference already
//! saturates the machine; the queue persists so the UI can list past exports.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::images::Images;
use crate::models::{new_id, now_iso, Deck, JobStatus, PrintJob, PrintSettings};
use crate::pdf::{build_pdf, print_plan, PdfServices};
use crate::store::Store;
use crate::upscaler::manifest::{default_model_id, ModelManager};
use crate::upscaler::CancelToken;

const KIND: &str = "job";
const KEEP: usize = 50;

struct Queued {
    job: PrintJob,
    deck: Deck,
    settings: PrintSettings,
    cancel: CancelToken,
}

pub struct Jobs {
    store: Arc<Store>,
    images: Arc<Images>,
    models: Arc<ModelManager>,
    pdf_dir: PathBuf,
    raster_dir: PathBuf,
    live: Mutex<HashMap<String, PrintJob>>,
    cancels: Mutex<HashMap<String, CancelToken>>,
    sender: mpsc::UnboundedSender<Queued>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<Queued>>>,
}

fn file_name(deck: &Deck, settings: &PrintSettings) -> String {
    let stem: String = deck
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(60)
        .collect();
    let stem = if stem.is_empty() {
        "deck".to_string()
    } else {
        stem
    };
    format!("{stem}-{}dpi.pdf", settings.dpi)
}

impl Jobs {
    pub fn new(
        store: Arc<Store>,
        images: Arc<Images>,
        models: Arc<ModelManager>,
        data_dir: &Path,
    ) -> AppResult<Self> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let jobs = Self {
            store,
            images,
            models,
            pdf_dir: data_dir.join("pdfs"),
            raster_dir: data_dir.join("raster"),
            live: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            sender,
            receiver: Mutex::new(Some(receiver)),
        };
        std::fs::create_dir_all(&jobs.pdf_dir)?;
        std::fs::create_dir_all(&jobs.raster_dir)?;
        for mut job in jobs.store.list::<PrintJob>(KIND)? {
            if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                job.status = JobStatus::Failed;
                job.message = "Interrupted when Deckpress closed".into();
                jobs.store.put(KIND, &job.id, &job)?;
            }
        }
        Ok(jobs)
    }

    /// Starts the worker. Call once from the Tauri setup hook on the runtime.
    pub fn start(self: &Arc<Self>) {
        let Some(mut receiver) = self
            .receiver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        else {
            return;
        };
        let jobs = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            while let Some(queued) = receiver.recv().await {
                jobs.run(queued).await;
            }
        });
    }

    pub fn list(&self) -> AppResult<Vec<PrintJob>> {
        let live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        let mut jobs: Vec<PrintJob> = self
            .store
            .list::<PrintJob>(KIND)?
            .into_iter()
            .map(|job| live.get(&job.id).cloned().unwrap_or(job))
            .collect();
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        jobs.truncate(KEEP);
        Ok(jobs)
    }

    pub fn get(&self, id: &str) -> AppResult<PrintJob> {
        if let Some(job) = self.live.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            return Ok(job.clone());
        }
        self.store
            .get::<PrintJob>(KIND, id)?
            .ok_or_else(|| AppError::not_found("Print job not found"))
    }

    pub fn pdf_path(&self, id: &str) -> AppResult<PathBuf> {
        let job = self.get(id)?;
        if job.status != JobStatus::Completed {
            return Err(AppError::user("This export has not finished"));
        }
        let path = self.pdf_dir.join(format!("{}.pdf", job.id));
        if !path.is_file() {
            return Err(AppError::not_found("PDF file is missing. Export again."));
        }
        Ok(path)
    }

    pub fn create(&self, deck: Deck, settings: PrintSettings) -> AppResult<PrintJob> {
        let plan = print_plan(&deck, &settings)?;
        if settings.upscale {
            let id = if settings.upscale_model.is_empty() {
                default_model_id()
            } else {
                settings.upscale_model.clone()
            };
            let spec = self.models.spec(&id)?;
            if self.models.path(spec).is_none() {
                return Err(AppError::user(format!(
                    "{} is not downloaded yet. Download it in Print setup or pick another model.",
                    spec.name
                )));
            }
        }
        let job = PrintJob {
            id: new_id(),
            deck_id: deck.id.clone(),
            deck_name: deck.name.clone(),
            status: JobStatus::Queued,
            completed: 0,
            total: plan
                .sides
                .iter()
                .map(|side| side.entries.len() as u32)
                .sum(),
            message: format!("Queued · {} pages", plan.sides.len()),
            created_at: now_iso(),
            file_name: file_name(&deck, &settings),
            bytes: 0,
            pages: 0,
        };
        self.store.put(KIND, &job.id, &job)?;
        self.prune()?;
        let cancel = CancelToken::default();
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job.id.clone(), cancel.clone());
        self.live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job.id.clone(), job.clone());
        self.sender
            .send(Queued {
                job: job.clone(),
                deck,
                settings,
                cancel,
            })
            .map_err(|_| AppError::internal("Print queue is closed"))?;
        Ok(job)
    }

    pub fn cancel(&self, id: &str) -> AppResult<PrintJob> {
        let job = self.get(id)?;
        if !matches!(job.status, JobStatus::Queued | JobStatus::Running) {
            return Ok(job);
        }
        if let Some(cancel) = self
            .cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
        {
            cancel.cancel();
        }
        Ok(job)
    }

    fn prune(&self) -> AppResult<()> {
        let mut jobs = self.store.list::<PrintJob>(KIND)?;
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        for job in jobs.into_iter().skip(KEEP) {
            if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                continue;
            }
            self.store.remove(KIND, &job.id)?;
            let _ = std::fs::remove_file(self.pdf_dir.join(format!("{}.pdf", job.id)));
        }
        Ok(())
    }

    fn publish(&self, job: &PrintJob, persist: bool) {
        self.live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job.id.clone(), job.clone());
        if persist {
            if let Err(error) = self.store.put(KIND, &job.id, job) {
                log::warn!("Could not persist print job {}: {error}", job.id);
            }
        }
    }

    fn finish(&self, mut job: PrintJob, status: JobStatus, message: String) {
        job.status = status;
        job.message = message;
        self.publish(&job, true);
        self.live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&job.id);
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&job.id);
    }

    async fn run(self: &Arc<Self>, queued: Queued) {
        let Queued {
            mut job,
            deck,
            settings,
            cancel,
        } = queued;
        if cancel.is_cancelled() {
            self.finish(
                job,
                JobStatus::Cancelled,
                "Cancelled before it started".into(),
            );
            return;
        }
        job.status = JobStatus::Running;
        job.message = "Fetching card scans".into();
        self.publish(&job, true);

        match self.render(&job, &deck, &settings, &cancel).await {
            Ok((bytes, pages)) => {
                job.completed = job.total;
                job.bytes = bytes;
                job.pages = pages as u32;
                self.finish(job, JobStatus::Completed, format!("{pages} pages ready"));
            }
            Err(AppError::Cancelled) => {
                self.finish(job, JobStatus::Cancelled, "Cancelled".into());
            }
            Err(error) => {
                log::error!("Print job {} failed: {error:?}", job.id);
                self.finish(job, JobStatus::Failed, error.to_string());
            }
        }
    }

    async fn render(
        self: &Arc<Self>,
        job: &PrintJob,
        deck: &Deck,
        settings: &PrintSettings,
        cancel: &CancelToken,
    ) -> AppResult<(u64, usize)> {
        let plan = print_plan(deck, settings)?;
        let mut urls: Vec<String> = Vec::new();
        for side in &plan.sides {
            for entry in &side.entries {
                let art = if side.back {
                    entry.back_art()
                } else {
                    Some(entry.front_art().clone())
                };
                if let Some(art) = art {
                    if !urls.contains(&art.image_url) {
                        urls.push(art.image_url);
                    }
                }
            }
        }
        let fetch_total = urls.len();
        for (index, url) in urls.iter().enumerate() {
            cancel.check()?;
            let mut progress = job.clone();
            progress.message = format!("Fetching card scans · {}/{fetch_total}", index + 1);
            self.publish(&progress, false);
            self.images.read(url).await?;
        }

        let upscaler = if settings.upscale {
            let id = if settings.upscale_model.is_empty() {
                default_model_id()
            } else {
                settings.upscale_model.clone()
            };
            let models = Arc::clone(&self.models);
            Some(tauri::async_runtime::spawn_blocking(move || models.upscaler(&id)).await??)
        } else {
            None
        };

        let jobs = Arc::clone(self);
        let job = job.clone();
        let deck = deck.clone();
        let settings = settings.clone();
        let cancel = cancel.clone();
        let (bytes, pages) =
            tauri::async_runtime::spawn_blocking(move || -> AppResult<(u64, usize)> {
                let mut last_persist = Instant::now();
                let mut current = job.clone();
                let mut progress = |completed: usize, total: usize, message: String| {
                    current.completed = completed as u32;
                    current.total = total as u32;
                    current.message = message;
                    let persist = last_persist.elapsed() > Duration::from_secs(2);
                    if persist {
                        last_persist = Instant::now();
                    }
                    jobs.publish(&current, persist);
                };
                let images = Arc::clone(&jobs.images);
                let mut read_source = |url: &str| -> AppResult<Vec<u8>> {
                    Ok(std::fs::read(images.local_path(url)?)?)
                };
                let output = build_pdf(
                    &deck,
                    &settings,
                    &PdfServices {
                        upscaler: upscaler.as_deref(),
                        raster_dir: &jobs.raster_dir,
                    },
                    &cancel,
                    &mut progress,
                    &mut read_source,
                )?;
                let path = jobs.pdf_dir.join(format!("{}.pdf", job.id));
                let tmp = path.with_extension("part");
                std::fs::write(&tmp, &output.bytes)?;
                std::fs::rename(&tmp, &path)?;
                Ok((output.bytes.len() as u64, output.pages))
            })
            .await??;
        Ok((bytes, pages))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_safe_and_carry_the_dpi() {
        let deck = Deck {
            id: "d".into(),
            name: "Mono/Red: Burn!".into(),
            format: String::new(),
            notes: String::new(),
            entries: vec![],
            cover_entry_id: String::new(),
            print_settings: PrintSettings::default(),
            revision: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert_eq!(
            file_name(&deck, &PrintSettings::default()),
            "Mono-Red--Burn-800dpi.pdf"
        );
    }
}
