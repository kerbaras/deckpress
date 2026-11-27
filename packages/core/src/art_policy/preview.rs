use serde::Serialize;
use std::collections::BTreeMap;

use super::{
    choose_printing, languages, plan_change, policy_can_change, requested_languages, ArtChange,
    ArtChangeKind, ArtPolicies, ArtPolicy, PolicySelection,
};
use crate::{
    error::{AppError, AppResult},
    providers::PrintingLookupProgress,
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
                        selection.anchor(options(&entry.card.oracle_id), entry.card.faces.len())
                    })
                    .flatten()
            })
            .collect();
        let preferred: Vec<_> = before
            .entries
            .iter()
            .map(|entry| requested_languages(entry, None, &preferences.languages))
            .collect();
        let mut language_orders: Vec<_> = preferred
            .iter()
            .map(|preferred| languages(preferred, preferences.policy))
            .collect();
        let mut selected = vec![None; anchors.len()];
        loop {
            let mut missing = BTreeMap::<_, Vec<_>>::new();
            for (index, anchor) in anchors.iter().enumerate() {
                let Some(anchor) = anchor.filter(|_| selected[index].is_none()) else {
                    continue;
                };
                let Some(language) = language_orders[index].next() else {
                    continue;
                };
                let oracle = anchor.oracle_id.as_str();
                let exact = choose_printing(anchor, options(oracle), language, Some(&selection))
                    .filter(|print| print.set == anchor.set && print.collector == anchor.collector);
                if let Some(print) = exact {
                    selected[index] = Some(print.clone());
                } else {
                    missing.entry(language).or_default().push((index, anchor));
                }
            }
            if missing.is_empty() {
                break;
            }
            for (language, entries) in missing {
                let translations = self
                    .providers
                    .printing_inventory(
                        entries
                            .iter()
                            .map(|(_, anchor)| anchor.oracle_id.as_str())
                            .collect(),
                        Some(language),
                        |update| report(Some(language), update),
                    )
                    .await?;
                for (index, anchor) in entries {
                    let oracle = anchor.oracle_id.as_str();
                    selected[index] = choose_printing(
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
        }
        let mut changes = Vec::with_capacity(before.entries.len());
        for ((entry, selected), preferred) in next.entries.iter_mut().zip(&selected).zip(preferred)
        {
            if !policy_can_change(entry) {
                changes.push(ArtChange::new(
                    entry,
                    ArtChangeKind::Pinned,
                    None,
                    "Manual art is protected.",
                ));
                continue;
            }
            let (change, replacement) = plan_change(entry, selected.as_ref(), preferred, false);
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
            for language in languages(&preferences.languages, preferences.policy) {
                if choose_printing(&anchor, [&anchor], language, None).is_some() {
                    candidate = Some(anchor);
                    break;
                }
                if let Some(exact) = self.providers.policy_exact(&anchor, language).await? {
                    if choose_printing(&anchor, [&exact], language, None).is_some() {
                        candidate = Some(exact);
                        break;
                    }
                }
                let mut inventory = self
                    .providers
                    .language_printings([anchor.oracle_id.as_str()].into(), language)
                    .await?;
                let options = inventory.remove(&anchor.oracle_id).unwrap_or_default();
                if let Some(print) = choose_printing(&anchor, &options, language, None) {
                    candidate = Some(print.clone());
                    break;
                }
            }
        }
        let (change, replacement) =
            plan_change(entry, candidate.as_ref(), &preferences.languages, true);
        let mut next = before.clone();
        if let Some(replacement) = replacement {
            if let Some(entry) = next.entries.iter_mut().find(|item| item.id == entry_id) {
                *entry = replacement;
            }
        }
        self.save_preview(&before, preview_id, next, vec![change])
    }
}
