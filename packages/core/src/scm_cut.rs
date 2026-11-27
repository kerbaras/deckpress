use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::sync::LazyLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::error::{AppError, AppResult};
use crate::models::{LayoutMode, PrintSettings};
use crate::scm;

#[derive(Deserialize)]
struct Manifest {
    files: HashMap<String, CutFile>,
    exceptions: HashSet<String>,
}

#[derive(Deserialize)]
struct CutFile {
    path: String,
    sha256: String,
}

static MANIFEST: LazyLock<Manifest> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/scm/cutting-templates.json"))
        .expect("vendored SCM cut-file manifest")
});

pub(crate) fn has_dxf_fallback(template_name: &str) -> bool {
    MANIFEST.exceptions.contains(template_name)
}

pub fn studio3(settings: &PrintSettings) -> AppResult<Vec<u8>> {
    if settings.layout_mode != LayoutMode::Scm {
        return Err(AppError::user(
            "Select an SCM layout to export a .studio3 file",
        ));
    }
    let name = scm::template_name(settings)?;
    let cut_file = MANIFEST
        .files
        .get(&format!("{name}.studio3"))
        .ok_or_else(|| {
            AppError::user(format!(
                "SCM has no .studio3 file for {name}. Export DXF cut lines instead."
            ))
        })?;
    let archive = include_bytes!("../assets/scm/cutting-templates.zip");
    let mut archive = ZipArchive::new(Cursor::new(archive)).map_err(AppError::internal)?;
    let mut entry = archive
        .by_name(&cut_file.path)
        .map_err(AppError::internal)?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    if hex::encode(Sha256::digest(&bytes)) != cut_file.sha256 {
        return Err(AppError::user(format!(
            "The bundled SCM cut file for {name} failed its integrity check"
        )));
    }
    Ok(bytes)
}
