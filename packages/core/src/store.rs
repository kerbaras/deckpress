//! SQLite document store. Same schema as the original Node API so an existing
//! `deckpress.sqlite` can be copied over unchanged.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::models::{new_id, now_iso, Deck, DeckEntry, NewDeck, PrintSettings};
use crate::validate::validate_entries;

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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Store {
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
        let json = serde_json::to_string(value)?;
        self.with(|conn| {
            conn.execute(
                "INSERT INTO documents (kind, id, json, updated_at) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
                params![kind, id, json, now_ms()],
            )?;
            Ok(())
        })
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

    pub fn create_deck(&self, input: NewDeck) -> AppResult<Deck> {
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
            cover_entry_id: input.cover_entry_id,
            print_settings: input.print_settings,
            revision: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        self.put("deck", &deck.id, &deck)?;
        Ok(deck)
    }

    pub fn update_deck(&self, input: Deck) -> AppResult<Deck> {
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
