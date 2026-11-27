//! SQLite document store. Same schema as the original Node API so an existing
//! `deckpress.sqlite` can be copied over unchanged.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::images::upload_id;
use crate::models::{
    new_id, now_iso, Deck, DeckEntry, NewDeck, PrintSettings, PrinterProfile, PrinterProfileInput,
    Provider, Upload,
};
use crate::validate::{validate_duplex_adjustment, validate_entries};

fn check_deck(
    name: &str,
    format: &str,
    notes: &str,
    entries: &[DeckEntry],
    settings: &PrintSettings,
) -> AppResult<()> {
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::user("Deck name must be 1-100 characters"));
    }
    if format.chars().count() > 40 || notes.chars().count() > 5000 {
        return Err(AppError::user("Deck format or notes are too long"));
    }
    validate_entries(entries)?;
    settings.validate()
}

pub struct Store {
    conn: Mutex<Connection>,
}

const CACHE_TTL_MS: i64 = 86_400_000;
const PRINTER_PROFILE: &str = "printer_profile";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    System,
    Light,
    Dark,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn put_document<T: Serialize>(conn: &Connection, kind: &str, id: &str, value: &T) -> AppResult<()> {
    conn.execute(
        "INSERT INTO documents (kind, id, json, updated_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![kind, id, serde_json::to_string(value)?, now_ms()],
    )?;
    Ok(())
}

impl Store {
    pub fn appearance(&self) -> AppResult<Option<Appearance>> {
        self.get("settings", "appearance")
    }

    pub fn set_appearance(&self, appearance: Appearance) -> AppResult<()> {
        self.put("settings", "appearance", &appearance)
    }

    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::from_connection(Connection::open(path)?)
    }

    pub fn in_memory() -> AppResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> AppResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; \
             CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id)) STRICT;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::user("Storage is unavailable"))?;
        f(&conn)
    }

    pub fn get<T: DeserializeOwned>(&self, kind: &str, id: &str) -> AppResult<Option<T>> {
        self.with(|conn| {
            let json: Option<String> = conn
                .query_row(
                    "SELECT json FROM documents WHERE kind = ?1 AND id = ?2",
                    params![kind, id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(match json {
                Some(json) => Some(serde_json::from_str(&json)?),
                None => None,
            })
        })
    }

    pub fn list<T: DeserializeOwned>(&self, kind: &str) -> AppResult<Vec<T>> {
        self.with(|conn| {
            let mut statement = conn
                .prepare("SELECT json FROM documents WHERE kind = ?1 ORDER BY updated_at DESC")?;
            let rows = statement.query_map(params![kind], |row| row.get::<_, String>(0))?;
            let mut items = Vec::new();
            for json in rows {
                match serde_json::from_str(&json?) {
                    Ok(value) => items.push(value),
                    Err(error) => log::warn!("Skipping unreadable {kind} document: {error}"),
                }
            }
            Ok(items)
        })
    }

    pub fn put<T: Serialize>(&self, kind: &str, id: &str, value: &T) -> AppResult<()> {
        self.with(|conn| put_document(conn, kind, id, value))
    }

    /// Rewrites a document's `updated_at`, which decides cache expiry and
    /// list order.
    pub fn touch(&self, kind: &str, id: &str, updated_at_ms: i64) -> AppResult<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE documents SET updated_at = ?1 WHERE kind = ?2 AND id = ?3",
                params![updated_at_ms, kind, id],
            )?;
            Ok(())
        })
    }

    pub fn remove(&self, kind: &str, id: &str) -> AppResult<()> {
        self.with(|conn| {
            conn.execute(
                "DELETE FROM documents WHERE kind = ?1 AND id = ?2",
                params![kind, id],
            )?;
            Ok(())
        })
    }

    pub fn cached(&self, key: &str) -> AppResult<Option<serde_json::Value>> {
        self.with(|conn| {
            let json: Option<String> = conn
                .query_row(
                    "SELECT json FROM documents WHERE kind = 'cache' AND id = ?1 AND updated_at > ?2",
                    params![key, now_ms() - CACHE_TTL_MS],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(match json {
                Some(json) => Some(serde_json::from_str(&json)?),
                None => None,
            })
        })
    }

    pub fn printer_profiles(&self) -> AppResult<Vec<PrinterProfile>> {
        self.list(PRINTER_PROFILE)
    }

    pub fn save_printer_profile(
        &self,
        id: Option<String>,
        mut input: PrinterProfileInput,
    ) -> AppResult<PrinterProfile> {
        input.name = input.name.trim().to_owned();
        if input.name.is_empty() || input.name.chars().count() > 100 {
            return Err(AppError::user(
                "Printer profile name must be 1-100 characters",
            ));
        }
        validate_duplex_adjustment(
            input.back_offset_xmm,
            input.back_offset_ymm,
            input.back_rotation_deg,
        )?;
        let update = id.is_some();
        let profile = PrinterProfile {
            id: id.unwrap_or_else(new_id),
            input,
        };
        if update {
            let json = serde_json::to_string(&profile)?;
            self.with(|conn| {
                let changed = conn.execute(
                    "UPDATE documents SET json = ?1, updated_at = ?2 WHERE kind = ?3 AND id = ?4",
                    params![json, now_ms(), PRINTER_PROFILE, profile.id],
                )?;
                if changed == 0 {
                    return Err(AppError::not_found("Printer profile not found"));
                }
                Ok(())
            })?;
        } else {
            self.put(PRINTER_PROFILE, &profile.id, &profile)?;
        }
        Ok(profile)
    }

    pub fn delete_printer_profile(&self, id: &str) -> AppResult<()> {
        self.remove(PRINTER_PROFILE, id)
    }

    fn refresh_uploads(&self, entries: &mut [DeckEntry]) -> AppResult<()> {
        self.refresh_with_uploads(entries, &HashMap::new())
    }

    fn refresh_with_uploads(
        &self,
        entries: &mut [DeckEntry],
        uploads: &HashMap<String, Upload>,
    ) -> AppResult<()> {
        for entry in entries {
            for art in entry
                .card
                .faces
                .iter_mut()
                .chain(entry.selected_art.iter_mut())
                .chain(entry.selected_back.iter_mut())
            {
                if art.provider == Provider::Upload {
                    if let Some(Ok(id)) = upload_id(&art.image_url) {
                        let stored;
                        let upload = if let Some(upload) = uploads.get(&id) {
                            Some(upload)
                        } else {
                            stored = self.get::<Upload>("upload", &id)?;
                            stored.as_ref()
                        };
                        if let Some(upload) = upload {
                            art.bleed_mm = upload.art.bleed_mm;
                            art.dpi = upload.art.dpi;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn deck(&self, id: &str) -> AppResult<Deck> {
        let mut deck: Deck = self
            .get("deck", id)?
            .ok_or_else(|| AppError::not_found("Deck not found"))?;
        self.refresh_uploads(&mut deck.entries)?;
        Ok(deck)
    }

    pub fn decks(&self) -> AppResult<Vec<Deck>> {
        let mut decks: Vec<Deck> = self.list("deck")?;
        for deck in &mut decks {
            self.refresh_uploads(&mut deck.entries)?;
        }
        decks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(decks)
    }

    pub fn create_deck(&self, input: NewDeck) -> AppResult<Deck> {
        self.create_deck_with_uploads(input, HashMap::new())
    }

    pub(crate) fn create_deck_with_uploads(
        &self,
        mut input: NewDeck,
        uploads: HashMap<String, Upload>,
    ) -> AppResult<Deck> {
        self.refresh_with_uploads(&mut input.entries, &uploads)?;
        let name = input.name.trim();
        check_deck(
            name,
            &input.format,
            &input.notes,
            &input.entries,
            &input.print_settings,
        )?;
        let now = now_iso();
        let deck = Deck {
            id: new_id(),
            name: name.to_string(),
            format: input.format,
            notes: input.notes,
            entries: input.entries,
            missing_prints: input.missing_prints,
            cover_entry_id: input.cover_entry_id,
            print_settings: input.print_settings,
            art_policy: input.art_policy,
            print_language: input.print_language,
            revision: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        self.with(|conn| {
            let transaction = conn.unchecked_transaction()?;
            for (id, upload) in &uploads {
                put_document(&transaction, "upload", id, upload)?;
            }
            put_document(&transaction, "deck", &deck.id, &deck)?;
            Ok(transaction.commit()?)
        })?;
        Ok(deck)
    }

    pub fn update_deck(&self, mut input: Deck) -> AppResult<Deck> {
        self.refresh_uploads(&mut input.entries)?;
        let name = input.name.trim().to_string();
        check_deck(
            &name,
            &input.format,
            &input.notes,
            &input.entries,
            &input.print_settings,
        )?;
        let old: Deck = self
            .get("deck", &input.id)?
            .ok_or_else(|| AppError::not_found("Deck not found"))?;
        let deck = Deck {
            name,
            created_at: old.created_at,
            updated_at: now_iso(),
            revision: input.revision + 1,
            ..input
        };
        let json = serde_json::to_string(&deck)?;
        let changed = self.with(|conn| {
            Ok(conn.execute(
                "UPDATE documents SET json = ?1, updated_at = ?2 WHERE kind = 'deck' AND id = ?3 AND json_extract(json, '$.revision') = ?4",
                params![json, now_ms(), deck.id, (deck.revision - 1) as i64],
            )?)
        })?;
        if changed == 0 {
            return Err(AppError::Conflict(
                "This deck changed elsewhere. Reload it before saving.".into(),
            ));
        }
        Ok(deck)
    }
}
