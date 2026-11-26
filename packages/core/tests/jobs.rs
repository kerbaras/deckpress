mod common;

use std::sync::Arc;
use std::time::Duration;

use deckpress_core::images::{Images, UploadInput};
use deckpress_core::jobs::{file_name, Jobs};
use deckpress_core::models::{Deck, ExportFormat, JobStatus, PrintJob, PrintSettings};
use deckpress_core::store::Store;
use deckpress_core::upscaler::manifest::ModelManager;
use tokio::runtime::Handle;

#[tokio::test]
async fn a_single_page_is_singular_when_queued_and_ready() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let images = Arc::new(Images::new(dir.path(), store.clone()).unwrap());
    let models = Arc::new(ModelManager::new(dir.path(), dir.path()).unwrap());
    let mut deck = common::deck(1);
    deck.entries[0].selected_art = Some(
        images
            .upload(
                &common::png(372, 520, [30, 90, 200]),
                UploadInput {
                    oracle_id: deck.entries[0].card.oracle_id.clone(),
                    name: "Test".into(),
                    artist: String::new(),
                    bleed_mm: Some(0.0),
                },
            )
            .unwrap(),
    );
    let jobs = Arc::new(Jobs::new(store, images, models, dir.path(), Handle::current()).unwrap());
    jobs.start();

    let queued = jobs
        .create(
            deck,
            PrintSettings {
                calibration_page: false,
                dpi: 150,
                ..PrintSettings::default()
            },
            ExportFormat::Pdf,
        )
        .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let job = jobs.get(&queued.id).unwrap();
            if !matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                break job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("print job did not finish");
    assert_eq!(ready.status, JobStatus::Completed, "{}", ready.message);
    assert_eq!(
        (queued.message.as_str(), ready.message.as_str()),
        ("Queued · 1 page", "1 page ready")
    );
}

#[test]
fn file_names_are_safe_and_carry_the_dpi() {
    let deck = Deck {
        name: "Mono/Red: Burn!".into(),
        entries: vec![],
        ..common::deck(1)
    };
    assert_eq!(
        file_name(&deck, &PrintSettings::default(), ExportFormat::Pdf),
        "Mono-Red--Burn-800dpi.pdf"
    );
    assert_eq!(
        file_name(&deck, &PrintSettings::default(), ExportFormat::Png),
        "Mono-Red--Burn-800dpi-png.zip"
    );
}

#[tokio::test]
async fn jobs_persist_the_export_calibration_setting_and_read_legacy_records() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let images = Arc::new(Images::new(dir.path(), store.clone()).unwrap());
    let models = Arc::new(ModelManager::new(dir.path(), dir.path()).unwrap());
    let jobs = Jobs::new(store.clone(), images, models, dir.path(), Handle::current()).unwrap();

    for calibration_page in [false, true] {
        let settings = PrintSettings {
            calibration_page,
            upscale: false,
            ..PrintSettings::default()
        };
        let job = jobs
            .create(common::deck(1), settings, ExportFormat::Pdf)
            .unwrap();
        let saved = store.get::<PrintJob>("job", &job.id).unwrap().unwrap();
        assert_eq!(job.calibration_page, calibration_page);
        assert_eq!(saved.calibration_page, calibration_page);
        let mut legacy = serde_json::to_value(saved).unwrap();
        assert_eq!(
            legacy.as_object_mut().unwrap().remove("calibrationPage"),
            Some(calibration_page.into())
        );
        let legacy: PrintJob = serde_json::from_value(legacy).unwrap();
        assert!(!legacy.calibration_page);
    }
}
