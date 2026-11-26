mod common;

use std::sync::Arc;

use deckpress_core::images::Images;
use deckpress_core::jobs::{file_name, Jobs};
use deckpress_core::models::{Deck, PrintJob, PrintSettings};
use deckpress_core::store::Store;
use deckpress_core::upscaler::manifest::ModelManager;
use tokio::runtime::Handle;

#[test]
fn file_names_are_safe_and_carry_the_dpi() {
    let deck = Deck {
        name: "Mono/Red: Burn!".into(),
        entries: vec![],
        ..common::deck(1)
    };
    assert_eq!(
        file_name(&deck, &PrintSettings::default()),
        "Mono-Red--Burn-800dpi.pdf"
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
        let job = jobs.create(common::deck(1), settings).unwrap();
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
