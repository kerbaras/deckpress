use std::collections::{HashMap, HashSet};
use std::io::Cursor;

use deckpress_core::layout::create_layout;
use deckpress_core::models::{LayoutMode, PrintSettings, ScmTemplate, ScmVariant};
use deckpress_core::scm_cut::studio3;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

#[test]
fn every_scm_layout_has_the_pinned_studio_file_or_an_explicit_exception() {
    let layouts: Value = serde_json::from_str(include_str!("../assets/scm/layouts.json")).unwrap();
    let manifest: Value =
        serde_json::from_str(include_str!("../assets/scm/cutting-templates.json")).unwrap();
    assert_eq!(
        manifest["commit"],
        "0da09b729814aa5aafde024b5a6059624fa87951"
    );
    let inventory: HashSet<_> = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap())
        .collect();
    let mut files: HashMap<_, _> = manifest["exports"].as_object().unwrap().iter().collect();
    let exceptions = manifest["exceptions"].as_array().unwrap();
    let mut exceptions: HashSet<_> = exceptions
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert_eq!(files.len(), 190);
    assert_eq!(manifest["exceptions"].as_array().unwrap().len(), 38);
    assert_eq!(exceptions.len(), 38);
    let archive = ZipArchive::new(Cursor::new(include_bytes!(
        "../assets/scm/cutting-templates.zip"
    )))
    .unwrap();
    assert_eq!(archive.len(), files.len());

    for (paper, cards) in layouts["layouts"].as_object().unwrap() {
        for (card, variants) in cards.as_object().unwrap() {
            for (variant, layout) in variants.as_object().unwrap() {
                let borderless = variant == "borderless";
                let version = layout["version"].as_u64().unwrap();
                let suffix = if borderless { "-borderless" } else { "" };
                let name = format!("{paper}-{card}{suffix}-v{version}");
                let settings = |marks| PrintSettings {
                    layout_mode: LayoutMode::Scm,
                    scm_template: ScmTemplate {
                        paper: paper.clone(),
                        card: card.clone(),
                        variant: if borderless {
                            ScmVariant::Borderless
                        } else {
                            ScmVariant::Default
                        },
                        marks,
                    },
                    ..PrintSettings::default()
                };
                let filename = format!("{name}.studio3");
                let entry = files.remove(&filename);
                let exception = exceptions.remove(name.as_str());
                assert_ne!(entry.is_some(), exception, "{name}");
                assert_eq!(
                    exception,
                    borderless && matches!(paper.as_str(), "a3" | "arch_b")
                );
                for marks in [3, 4] {
                    let settings = settings(marks);
                    let sheet = create_layout(&settings).unwrap().scm.unwrap();
                    assert_eq!(sheet.name, name);
                    let exported = studio3(&settings);
                    if let Some(entry) = entry {
                        let expected_path = if borderless {
                            format!("borderless/{filename}")
                        } else {
                            filename.clone()
                        };
                        assert_eq!(entry["path"], expected_path);
                        assert!(inventory.contains(expected_path.as_str()));
                        let bytes = exported.unwrap();
                        assert_eq!(hex::encode(Sha256::digest(bytes)), entry["sha256"]);
                    } else {
                        assert!(exported.unwrap_err().to_string().contains("Export DXF"));
                    }
                }
            }
        }
    }
    assert!(files.is_empty() && exceptions.is_empty());
    assert!(studio3(&PrintSettings::default()).is_err());
}
