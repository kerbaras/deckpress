use serde::Serialize;

use super::selection::{localized, PolicySelection};
use super::{
    languages, policy_can_change, ArtChange, ArtChangeKind, ArtPolicies, ArtPolicy, Printing,
};
use crate::{
    error::{AppError, AppResult},
    models::{Art, DeckEntry, PrintLanguagePreferences},
    providers::{PrintingInventoryScope, PrintingLookupProgress},
    set_family::family,
};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtPreview {
    pub preview_id: String,
    pub changes: Vec<ArtChange>,
    pub can_apply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

impl ArtPolicies {
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
        let family_members = match &policy {
            ArtPolicy::MatchSet { set, family: true }
                if before.entries.iter().any(policy_can_change) =>
            {
                Some(family(set, &self.providers.sets().await?))
            }
            _ => None,
        };
        let family_sets = family_members.as_ref().map(|members| {
            let mut sets: Vec<_> = members.iter().map(|(set, _)| set.clone()).collect();
            sets.sort_unstable();
            sets
        });
        let scope = match (&policy, &family_sets) {
            (_, Some(sets)) => PrintingInventoryScope::Family(sets),
            (ArtPolicy::MatchSet { set, family: false }, _) => PrintingInventoryScope::Exact(set),
            _ => PrintingInventoryScope::All,
        };
        let family_ranks = family_members.map(|members| members.into_iter().collect());
        let mut next = before.clone();
        next.art_policy = Some(policy.clone());
        let selection = PolicySelection {
            policy: &policy,
            family_ranks: family_ranks.as_ref(),
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
                scope,
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
                    scope,
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
}
