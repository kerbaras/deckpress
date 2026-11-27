#[cfg(feature = "native")]
use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};

use crate::models::Art;

#[cfg(feature = "native")]
use crate::{
    error::{AppError, AppResult},
    language_deck,
    language_switch::LanguageTier,
    models::{new_id, Deck, DeckEntry, PrintLanguagePolicy, PrintLanguagePreferences},
    providers::{validate_language, PrintingLookupProgress, Providers},
    set_family::family,
    store::Store,
};

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

#[derive(Debug, Clone)]
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

#[cfg(feature = "native")]
impl ArtPolicy {
    fn validate(&self) -> AppResult<()> {
        match self {
            Self::MatchSet { set, .. }
                if set.is_empty()
                    || set.len() > 20
                    || !set
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) =>
            {
                Err(AppError::user("Enter a valid set code."))
            }
            Self::Style {
                frame: None,
                border: None,
                treatment: None,
            } => Err(AppError::user("Choose a frame, border, or treatment.")),
            _ => Ok(()),
        }
    }
}

#[cfg(feature = "native")]
struct PolicySelection<'a> {
    policy: &'a ArtPolicy,
    family_ranks: Option<HashMap<String, u8>>,
}

#[cfg(feature = "native")]
impl PolicySelection<'_> {
    fn permits(&self, printing: &Printing) -> bool {
        printing.paper
            && !printing.promo
            && match self.policy {
                ArtPolicy::MatchSet { set, .. } => self.family_ranks.as_ref().map_or_else(
                    || printing.set == *set,
                    |ranks| ranks.contains_key(&printing.set),
                ),
                ArtPolicy::Style { frame, border, .. } => {
                    frame.is_none_or(|frame| frame.code() == printing.frame)
                        && border.is_none_or(|border| border.code() == printing.border)
                }
                _ => true,
            }
    }

    fn treatment_matches(&self, printing: &Printing) -> bool {
        match self.policy {
            ArtPolicy::Style {
                treatment: Some(Treatment::None),
                ..
            } => !printing.full_art && !printing.showcase,
            ArtPolicy::Style {
                treatment: Some(Treatment::FullArt),
                ..
            } => printing.full_art,
            ArtPolicy::Style {
                treatment: Some(Treatment::Showcase),
                ..
            } => printing.showcase,
            _ => true,
        }
    }

    fn compare(&self, a: &Printing, b: &Printing, deck_policy: bool) -> Ordering {
        let release = if matches!(self.policy, ArtPolicy::Original) {
            a.date.cmp(&b.date)
        } else {
            b.date.cmp(&a.date)
        };
        self.family_ranks
            .as_ref()
            .map_or(Ordering::Equal, |ranks| ranks[&a.set].cmp(&ranks[&b.set]))
            .then_with(|| self.treatment_matches(b).cmp(&self.treatment_matches(a)))
            .then_with(|| a.date.is_empty().cmp(&b.date.is_empty()))
            .then(release)
            .then_with(|| {
                if deck_policy {
                    compare_scan_quality(
                        a.scans.as_ref().and_then(|faces| faces.first()),
                        b.scans.as_ref().and_then(|faces| faces.first()),
                    )
                } else {
                    Ordering::Equal
                }
            })
            .then_with(|| a.set.cmp(&b.set))
            .then_with(|| a.collector.cmp(&b.collector))
            .then_with(|| (a.language != "en").cmp(&(b.language != "en")))
            .then_with(|| a.id.cmp(&b.id))
    }
}

#[cfg(feature = "native")]
fn compare_scan_quality(a: Option<&Art>, b: Option<&Art>) -> Ordering {
    b.and_then(|art| art.scan_quality)
        .cmp(&a.and_then(|art| art.scan_quality))
}

pub(crate) fn same_illustrations(anchor: &Printing, candidate: &Printing) -> bool {
    anchor.oracle_id == candidate.oracle_id
        && (anchor.id == candidate.id
            || (!anchor.illustrations.is_empty()
                && anchor.illustrations.iter().all(Option::is_some)
                && anchor.illustrations == candidate.illustrations))
}

#[cfg(feature = "native")]
fn localized<'a>(
    anchor: &Printing,
    candidates: impl IntoIterator<Item = &'a Printing>,
    language: &str,
    selection: Option<&PolicySelection<'_>>,
) -> Option<&'a Printing> {
    candidates
        .into_iter()
        .filter(|print| {
            print.paper
                && print.language == language
                && print.scans.is_some()
                && same_illustrations(anchor, print)
                && selection.is_none_or(|selection| {
                    selection.permits(print)
                        && (!selection.treatment_matches(anchor)
                            || selection.treatment_matches(print))
                })
        })
        .min_by(|a, b| {
            let exact =
                |print: &Printing| print.set == anchor.set && print.collector == anchor.collector;
            exact(b).cmp(&exact(a)).then_with(|| {
                selection
                    .unwrap_or(&PolicySelection {
                        policy: &ArtPolicy::Latest,
                        family_ranks: None,
                    })
                    .compare(a, b, selection.is_some())
            })
        })
}

#[cfg(feature = "native")]
pub(crate) fn policy_can_change(entry: &DeckEntry) -> bool {
    !entry.is_art_pinned()
        && entry
            .card
            .faces
            .iter()
            .all(|art| art.provider == crate::models::Provider::Scryfall)
}

#[cfg(feature = "native")]
fn languages(preferences: &PrintLanguagePreferences) -> impl Iterator<Item = &str> {
    preferences.languages.iter().map(String::as_str).chain(
        (preferences.policy == PrintLanguagePolicy::FallbackToEnglish
            && !preferences.languages.iter().any(|lang| lang == "en"))
        .then_some("en"),
    )
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtChangeKind {
    Changed,
    Unchanged,
    Pinned,
    Unmatched,
    Fallback,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArtPreviewProgress {
    Printings {
        language: Option<String>,
        done: usize,
        total: usize,
    },
    RateLimited {
        #[serde(rename = "retryAfterSeconds")]
        retry_after_seconds: u64,
    },
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtChange {
    pub entry_id: String,
    pub name: String,
    pub quantity: u32,
    pub before: Art,
    pub after: Option<Art>,
    pub kind: ArtChangeKind,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<LanguageTier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_back: Option<Art>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_back: Option<Art>,
}

#[cfg(feature = "native")]
impl ArtChange {
    pub(crate) fn new(
        entry: &DeckEntry,
        kind: ArtChangeKind,
        after: Option<Art>,
        reason: &str,
    ) -> Self {
        Self {
            entry_id: entry.id.clone(),
            name: entry.card.name.clone(),
            quantity: entry.quantity,
            before: entry.front_art().clone(),
            after,
            kind,
            reason: reason.into(),
            tier: None,
            before_back: None,
            after_back: None,
        }
    }
}

#[cfg(feature = "native")]
fn plan_change(
    entry: &DeckEntry,
    candidate: Option<&Printing>,
    preferences: &PrintLanguagePreferences,
    manual: bool,
) -> (ArtChange, Option<DeckEntry>) {
    let Some((print, scans)) = candidate.and_then(|print| Some((print, print.scans.as_ref()?)))
    else {
        return (
            ArtChange::new(
                entry,
                ArtChangeKind::Unmatched,
                None,
                "No usable same-illustration scan matches the requested language and policy.",
            ),
            None,
        );
    };
    let fallback = print.language == "en" && !preferences.languages.iter().any(|lang| lang == "en");
    let mut next = entry.clone();
    if manual {
        next.art_pinned = true;
        let mark_fallback = |scan: &Art| Art {
            english_fallback: fallback,
            ..scan.clone()
        };
        next.selected_art = scans.first().map(mark_fallback);
        next.selected_back = scans.get(1).map(mark_fallback);
    } else {
        next.policy_art = Some(scans.clone());
        next.language_anchor = None;
    }
    next.requested_languages = preferences.languages.clone();
    let (kind, reason) = if fallback {
        (
            ArtChangeKind::Fallback,
            if manual {
                "Same illustration; using the English scan."
            } else {
                "No preferred-language scan for the policy illustration; using English."
            },
        )
    } else if next.front_art() == entry.front_art() && next.back_art() == entry.back_art() {
        (
            ArtChangeKind::Unchanged,
            "The displayed printing already matches.",
        )
    } else {
        (ArtChangeKind::Changed, "A matching printing is available.")
    };
    (
        ArtChange::new(entry, kind, scans.first().cloned(), reason),
        (next != *entry).then_some(next),
    )
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtPreview {
    pub preview_id: String,
    pub changes: Vec<ArtChange>,
    pub can_apply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
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

    pub async fn preview_policy(
        &self,
        deck_id: &str,
        revision: u64,
        policy: ArtPolicy,
    ) -> AppResult<ArtPreview> {
        self.preview_policy_with_progress(deck_id, revision, policy, |_| {})
            .await
    }

    pub async fn preview_policy_with_progress(
        &self,
        deck_id: &str,
        revision: u64,
        policy: ArtPolicy,
        progress: impl Fn(ArtPreviewProgress),
    ) -> AppResult<ArtPreview> {
        policy.validate()?;
        let (before, preview_id) = self.begin_preview(deck_id, revision)?;
        let preferences = self.providers.preferences_for_deck(&before)?;
        let family_ranks = match &policy {
            ArtPolicy::MatchSet { set, family: true }
                if before.entries.iter().any(policy_can_change) =>
            {
                Some(
                    family(set, &self.providers.sets().await?)
                        .into_iter()
                        .collect(),
                )
            }
            _ => None,
        };
        let mut next = before.clone();
        next.art_policy = Some(policy.clone());
        let selection = PolicySelection {
            policy: &policy,
            family_ranks,
        };
        let report = |language: Option<&str>, update| {
            progress(match update {
                PrintingLookupProgress::Cards { done, total } => ArtPreviewProgress::Printings {
                    language: language.map(str::to_owned),
                    done,
                    total,
                },
                PrintingLookupProgress::RateLimited(delay) => ArtPreviewProgress::RateLimited {
                    retry_after_seconds: delay
                        .as_secs()
                        .saturating_add(u64::from(delay.subsec_nanos() > 0)),
                },
            });
        };
        let inventory = self
            .providers
            .printing_inventory(
                before
                    .entries
                    .iter()
                    .filter(|entry| policy_can_change(entry))
                    .map(|entry| entry.card.oracle_id.as_str())
                    .collect(),
                None,
                |update| report(None, update),
            )
            .await?;
        let options = |oracle: &str| inventory.get(oracle).map_or(&[][..], Vec::as_slice);
        let anchors: Vec<_> = before
            .entries
            .iter()
            .map(|entry| {
                policy_can_change(entry)
                    .then(|| {
                        options(&entry.card.oracle_id)
                            .iter()
                            .filter(|print| {
                                selection.permits(print)
                                    && print.illustrations.len() == entry.card.faces.len()
                            })
                            .min_by(|a, b| selection.compare(a, b, true))
                    })
                    .flatten()
            })
            .collect();
        let mut selected = vec![None; anchors.len()];
        for language in languages(&preferences) {
            let mut missing = Vec::new();
            for (index, anchor) in anchors.iter().enumerate() {
                let Some(anchor) = anchor.filter(|_| selected[index].is_none()) else {
                    continue;
                };
                let oracle = anchor.oracle_id.as_str();
                let exact = localized(anchor, options(oracle), language, Some(&selection))
                    .filter(|print| print.set == anchor.set && print.collector == anchor.collector);
                if let Some(print) = exact {
                    selected[index] = Some(print.clone());
                } else {
                    missing.push((index, anchor));
                }
            }
            if missing.is_empty() {
                continue;
            }
            let translations = self
                .providers
                .printing_inventory(
                    missing
                        .iter()
                        .map(|(_, anchor)| anchor.oracle_id.as_str())
                        .collect(),
                    Some(language),
                    |update| report(Some(language), update),
                )
                .await?;
            for (index, anchor) in missing {
                let oracle = anchor.oracle_id.as_str();
                selected[index] = localized(
                    anchor,
                    options(oracle)
                        .iter()
                        .chain(translations.get(oracle).into_iter().flatten()),
                    language,
                    Some(&selection),
                )
                .cloned();
            }
        }
        let mut changes = Vec::with_capacity(before.entries.len());
        for (entry, selected) in next.entries.iter_mut().zip(&selected) {
            if !policy_can_change(entry) {
                changes.push(ArtChange::new(
                    entry,
                    ArtChangeKind::Pinned,
                    None,
                    "Manual art is protected.",
                ));
                continue;
            }
            let (change, replacement) = plan_change(entry, selected.as_ref(), &preferences, false);
            changes.push(change);
            if let Some(replacement) = replacement {
                *entry = replacement;
            }
        }
        self.save_preview(&before, preview_id, next, changes)
    }

    pub async fn preview_localization(
        &self,
        deck_id: &str,
        revision: u64,
        entry_id: &str,
        art_id: &str,
    ) -> AppResult<ArtPreview> {
        let (before, preview_id) = self.begin_preview(deck_id, revision)?;
        let entry = before
            .entries
            .iter()
            .find(|item| item.id == entry_id)
            .ok_or_else(|| AppError::not_found("Card not found"))?;
        let preferences = self.providers.preferences_for_deck(&before)?;
        let anchor = self.providers.policy_printing(art_id).await?;
        let mut candidate = None;
        if let Some(anchor) = anchor.filter(|anchor| {
            anchor.oracle_id == entry.card.oracle_id
                && anchor.illustrations.len() == entry.card.faces.len()
        }) {
            for language in languages(&preferences) {
                if localized(&anchor, [&anchor], language, None).is_some() {
                    candidate = Some(anchor);
                    break;
                }
                if let Some(exact) = self.providers.policy_exact(&anchor, language).await? {
                    if localized(&anchor, [&exact], language, None).is_some() {
                        candidate = Some(exact);
                        break;
                    }
                }
                let mut inventory = self
                    .providers
                    .language_printings([anchor.oracle_id.as_str()].into(), language)
                    .await?;
                let options = inventory.remove(&anchor.oracle_id).unwrap_or_default();
                if let Some(print) = localized(&anchor, &options, language, None) {
                    candidate = Some(print.clone());
                    break;
                }
            }
        }
        let (change, replacement) = plan_change(entry, candidate.as_ref(), &preferences, true);
        let mut next = before.clone();
        if let Some(replacement) = replacement {
            if let Some(entry) = next.entries.iter_mut().find(|item| item.id == entry_id) {
                *entry = replacement;
            }
        }
        self.save_preview(&before, preview_id, next, vec![change])
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
        let original = before
            .entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| AppError::not_found("Card not found"))?;
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
        let (print_id, scans) = printing
            .as_ref()
            .and_then(|print| {
                let scans = language_deck::choice_scans(print, original, language)?;
                Some((print.id.parse().ok()?, scans))
            })
            .ok_or_else(|| AppError::user("Choose a usable printing in the requested language."))?;
        let next = next.get_or_insert_with(|| before.clone());
        let entry = next
            .entries
            .iter_mut()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| AppError::not_found("Card not found"))?;
        entry.language_choices.insert(language.to_owned(), print_id);
        language_deck::set_faces(entry, scans, false);
        Ok(language_deck::row(original, entry, LanguageTier::Override))
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
