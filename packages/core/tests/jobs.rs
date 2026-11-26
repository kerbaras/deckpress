mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use deckpress_core::images::{Images, UploadInput};
use deckpress_core::jobs::{export_file_name, file_name, Jobs};
use deckpress_core::models::{Backs, Deck, ExportFormat, JobStatus, PrintJob, PrintSettings};
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

#[tokio::test]
async fn png_jobs_do_not_claim_a_calibration_page() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let images = Arc::new(Images::new(dir.path(), store.clone()).unwrap());
    let models = Arc::new(ModelManager::new(dir.path(), dir.path()).unwrap());
    let jobs = Jobs::new(store, images, models, dir.path(), Handle::current()).unwrap();
    let settings = PrintSettings {
        calibration_page: true,
        upscale: false,
        ..PrintSettings::default()
    };
    let job = jobs
        .create(common::deck(1), settings, ExportFormat::Png)
        .unwrap();
    assert!(!job.calibration_page);
}

#[test]
fn long_deck_names_are_cut_by_bytes_on_a_char_boundary() {
    let settings = PrintSettings {
        dpi: 1200,
        ..PrintSettings::default()
    };
    for name in ["𝔞".repeat(200), "ñ".repeat(200), "a".repeat(300)] {
        let deck = Deck {
            name: name.clone(),
            entries: vec![],
            ..common::deck(1)
        };
        for (format, suffix) in [
            (ExportFormat::Pdf, "-1200dpi.pdf"),
            (ExportFormat::Png, "-1200dpi-png.zip"),
        ] {
            let file = file_name(&deck, &settings, format);
            assert!(file.len() <= 200, "{} bytes", file.len());
            let stem = file.strip_suffix(suffix).unwrap();
            assert!(stem.len() > 146 && name.starts_with(stem), "{file}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn png_jobs_name_the_faces_skipped_for_missing_art() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let images = Arc::new(Images::new(dir.path(), Arc::clone(&store)).unwrap());
    let resources =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let models = Arc::new(ModelManager::new(resources, dir.path()).unwrap());
    let art = images
        .upload(
            &common::png(126, 176, [200, 40, 40]),
            UploadInput {
                oracle_id: "o".into(),
                name: "Lightning Bolt".into(),
                artist: String::new(),
                bleed_mm: Some(0.0),
            },
        )
        .unwrap();
    let mut deck = common::deck(2);
    deck.entries[0].card.name = "Lightning Bolt".into();
    deck.entries[0].card.faces = vec![art.clone()];
    deck.entries[0].selected_art = Some(art);
    let jobs = Arc::new(
        Jobs::new(
            store,
            images,
            models,
            dir.path(),
            tokio::runtime::Handle::current(),
        )
        .unwrap(),
    );
    jobs.start();
    let settings = PrintSettings {
        dpi: 150,
        upscale: false,
        backs: Backs::LongEdge,
        calibration_page: false,
        ..PrintSettings::default()
    };
    let id = jobs.create(deck, settings, ExportFormat::Png).unwrap().id;
    let job = loop {
        let job = jobs.get(&id).unwrap();
        if !matches!(job.status, JobStatus::Queued | JobStatus::Running) {
            break job;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(job.status, JobStatus::Completed, "{}", job.message);
    assert_eq!(job.pages, 2);
    assert_eq!(
        job.message,
        "2 PNG files ready · 2 faces without art skipped: \
         Lightning Bolt back (sheet 1, slot 1); Lightning Bolt back (sheet 1, slot 2)"
    );
}

#[test]
fn every_deck_export_shares_the_capped_stem() {
    let long = "𝔞".repeat(200);
    for suffix in [".deckpress.json", "-cut-template.svg", ".xml"] {
        assert_eq!(
            export_file_name("Mono/Red: Burn!", suffix),
            format!("Mono-Red--Burn{suffix}")
        );
        assert_eq!(export_file_name("?!", suffix), format!("deck{suffix}"));
        let name = export_file_name(&long, suffix);
        assert!(name.len() <= 200, "{} bytes", name.len());
        assert_eq!(name.strip_suffix(suffix).unwrap(), "𝔞".repeat(37));
    }
    let deck = Deck {
        name: long.clone(),
        entries: vec![],
        ..common::deck(1)
    };
    assert_eq!(
        file_name(&deck, &PrintSettings::default(), ExportFormat::Pdf),
        export_file_name(&long, "-800dpi.pdf")
    );
}
