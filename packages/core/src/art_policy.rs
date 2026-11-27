use serde::{Deserialize, Serialize};

use crate::models::{Art, DeckEntry, PrintLanguagePolicy};

#[cfg(feature = "native")]
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[cfg(feature = "native")]
use crate::{
    error::{AppError, AppResult},
    language_deck,
    models::{new_id, Deck},
    providers::{validate_language, Providers},
    store::Store,
};

mod change;
#[cfg(feature = "native")]
mod preview;
pub(crate) mod selection;
pub use change::{plan_change, ArtChange, ArtChangeKind};
#[cfg(feature = "native")]
pub use preview::{ArtPreview, ArtPreviewProgress};
pub use selection::{choose_printing, PolicySelection};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ArtPolicy {
    Original,
    Latest,
    MatchSet {
        set: String,
        #[serde(default)]
        family: bool,
    },
    Style {
        frame: Option<Frame>,
        border: Option<Border>,
        treatment: Option<Treatment>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Frame {
    #[serde(rename = "1993")]
    Original,
    #[serde(rename = "1997")]
    Classic,
    #[serde(rename = "2003")]
    Modern,
    #[serde(rename = "2015")]
    Current,
    #[serde(rename = "future")]
    Future,
}

impl Frame {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Original => "1993",
            Self::Classic => "1997",
            Self::Modern => "2003",
            Self::Current => "2015",
            Self::Future => "future",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Border {
    Black,
    White,
    Borderless,
}

impl Border {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Black => "black",
            Self::White => "white",
            Self::Borderless => "borderless",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Treatment {
    None,
    FullArt,
    Showcase,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Printing {
    pub id: String,
    pub oracle_id: String,
    pub set: String,
    pub collector: String,
    pub date: String,
    pub language: String,
    pub frame: String,
    pub border: String,
    pub full_art: bool,
    pub showcase: bool,
    pub treatments: Vec<String>,
    pub paper: bool,
    pub promo: bool,
    pub illustrations: Vec<Option<uuid::Uuid>>,
    pub scans: Option<Vec<Art>>,
}

pub fn policy_can_change(entry: &DeckEntry) -> bool {
    !entry.is_art_pinned()
        && entry
            .card
            .faces
            .iter()
            .all(|art| art.provider == crate::models::Provider::Scryfall)
}

pub fn requested_languages<'a>(
    entry: &'a DeckEntry,
    deck_language: Option<&'a String>,
    defaults: &'a [String],
) -> &'a [String] {
    if !entry.requested_languages.is_empty() {
        &entry.requested_languages
    } else {
        deck_language.map_or(defaults, std::slice::from_ref)
    }
}

pub fn languages(preferred: &[String], policy: PrintLanguagePolicy) -> impl Iterator<Item = &str> {
    preferred.iter().map(String::as_str).chain(
        (policy == PrintLanguagePolicy::FallbackToEnglish
            && !preferred.iter().any(|lang| lang == "en"))
        .then_some("en"),
    )
}

#[cfg(feature = "native")]
struct Pending {
    id: String,
    next: Option<Deck>,
    language: Option<String>,
}

#[cfg(feature = "native")]
struct Undo {
    applied_revision: u64,
    before: Deck,
}

#[cfg(feature = "native")]
#[derive(Default)]
struct History {
    pending: HashMap<String, Pending>,
    undo: HashMap<String, Undo>,
}

#[cfg(feature = "native")]
pub struct ArtPolicies {
    store: Arc<Store>,
    providers: Arc<Providers>,
    history: Mutex<History>,
}

#[cfg(feature = "native")]
impl ArtPolicies {
    pub fn new(store: Arc<Store>, providers: Arc<Providers>) -> Self {
        Self {
            store,
            providers,
            history: Mutex::default(),
        }
    }

    fn at_revision(&self, deck_id: &str, revision: u64) -> AppResult<Deck> {
        let deck = self
            .store
            .get::<Deck>("deck", deck_id)?
            .ok_or_else(|| AppError::not_found("Deck not found"))?;
        if deck.revision != revision {
            return Err(AppError::Conflict(
                "The deck changed. Reload it before previewing or applying art.".into(),
            ));
        }
        Ok(deck)
    }

    fn begin_preview(&self, deck_id: &str, revision: u64) -> AppResult<(Deck, String)> {
        let mut history = self
            .history
            .lock()
            .map_err(|_| AppError::user("Art previews are unavailable."))?;
        let before = self.at_revision(deck_id, revision)?;
        let id = new_id();
        history.pending.insert(
            deck_id.to_owned(),
            Pending {
                id: id.clone(),
                next: None,
                language: None,
            },
        );
        Ok((before, id))
    }

    fn save_preview(
        &self,
        before: &Deck,
        preview_id: String,
        next: Deck,
        changes: Vec<ArtChange>,
    ) -> AppResult<ArtPreview> {
        self.save_preview_for_language(before, preview_id, next, changes, None)
    }

    fn save_preview_for_language(
        &self,
        before: &Deck,
        preview_id: String,
        next: Deck,
        changes: Vec<ArtChange>,
        language: Option<String>,
    ) -> AppResult<ArtPreview> {
        let mut history = self
            .history
            .lock()
            .map_err(|_| AppError::user("Art previews are unavailable."))?;
        self.at_revision(&before.id, before.revision)?;
        let pending = history
            .pending
            .get_mut(&before.id)
            .filter(|pending| pending.id == preview_id)
            .ok_or_else(|| AppError::user("This art preview was superseded."))?;
        let can_apply = *before != next;
        pending.next = can_apply.then_some(next);
        pending.language.clone_from(&language);
        Ok(ArtPreview {
            preview_id,
            changes,
            can_apply,
            language,
        })
    }

    pub async fn preview_language(
        &self,
        deck_id: &str,
        revision: u64,
        language: String,
    ) -> AppResult<ArtPreview> {
        validate_language(&language)?;
        let (before, preview_id) = self.begin_preview(deck_id, revision)?;
        let missing = self.providers.print_language_preferences()?.policy;
        let mut next = before.clone();
        next.print_language = Some(language.clone());
        let changes = language_deck::plan(
            &self.providers,
            &mut next.entries,
            next.art_policy.as_ref(),
            &language,
            missing,
        )
        .await?;
        self.save_preview_for_language(&before, preview_id, next, changes, Some(language))
    }

    pub async fn override_language_print(
        &self,
        deck_id: &str,
        revision: u64,
        preview_id: &str,
        entry_id: &str,
        art_id: &str,
    ) -> AppResult<ArtChange> {
        let before = self.at_revision(deck_id, revision)?;
        let index = before
            .entries
            .iter()
            .position(|entry| entry.id == entry_id)
            .ok_or_else(|| AppError::not_found("Card not found"))?;
        let original = &before.entries[index];
        if language_deck::protected(original) {
            return Err(AppError::user("Manual art is protected."));
        }
        let printing = self.providers.policy_printing(art_id).await?;
        let mut history = self
            .history
            .lock()
            .map_err(|_| AppError::user("Art previews are unavailable."))?;
        self.at_revision(deck_id, revision)?;
        let (next, language) = history
            .pending
            .get_mut(deck_id)
            .filter(|pending| pending.id == preview_id)
            .and_then(|pending| Some((&mut pending.next, pending.language.as_deref()?)))
            .ok_or_else(|| {
                AppError::user("This language preview expired. Preview the changes again.")
            })?;
        let proposed = &next.as_ref().unwrap_or(&before).entries[index];
        let (entry, change) =
            language_deck::override_print(original, proposed, printing.as_ref(), language)?;
        next.get_or_insert(before).entries[index] = entry;
        Ok(change)
    }

    pub fn apply(&self, deck_id: &str, revision: u64, preview_id: &str) -> AppResult<Deck> {
        let mut history = self
            .history
            .lock()
            .map_err(|_| AppError::user("Art previews are unavailable."))?;
        let before = self.at_revision(deck_id, revision)?;
        let next = history
            .pending
            .get(deck_id)
            .filter(|pending| pending.id == preview_id)
            .and_then(|pending| pending.next.as_ref())
            .filter(|next| next.revision == revision)
            .ok_or_else(|| {
                AppError::user("This art preview expired. Preview the changes again.")
            })?;
        let applied = self.store.update_deck(next.clone())?;
        history.pending.remove(deck_id);
        history.undo.insert(
            deck_id.to_owned(),
            Undo {
                applied_revision: applied.revision,
                before,
            },
        );
        Ok(applied)
    }

    pub fn undo(&self, deck_id: &str, revision: u64) -> AppResult<Deck> {
        let mut history = self
            .history
            .lock()
            .map_err(|_| AppError::user("Art previews are unavailable."))?;
        self.at_revision(deck_id, revision)?;
        let undo = history
            .undo
            .get(deck_id)
            .ok_or_else(|| AppError::user("There is no art change to undo."))?;
        if revision != undo.applied_revision {
            return Err(AppError::Conflict(
                "The deck changed since applying art. Undo would overwrite those changes.".into(),
            ));
        }
        let restored = self.store.update_deck(Deck {
            revision,
            ..undo.before.clone()
        })?;
        history.undo.remove(deck_id);
        history.pending.remove(deck_id);
        Ok(restored)
    }
}
