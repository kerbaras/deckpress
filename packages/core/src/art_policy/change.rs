use serde::Serialize;

use super::Printing;
use crate::{
    language_switch::LanguageTier,
    models::{Art, DeckEntry},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtChangeKind {
    Changed,
    Unchanged,
    Pinned,
    Unmatched,
    Fallback,
}

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

pub fn plan_change(
    entry: &DeckEntry,
    candidate: Option<&Printing>,
    preferred: &[String],
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
    let fallback = print.language == "en" && !preferred.iter().any(|lang| lang == "en");
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
    next.requested_languages = preferred.to_vec();
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
