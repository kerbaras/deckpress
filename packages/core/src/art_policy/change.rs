use serde::Serialize;

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
