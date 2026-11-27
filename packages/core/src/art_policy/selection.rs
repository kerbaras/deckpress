use std::{cmp::Ordering, collections::HashMap};

use super::{
    languages, plan_change, policy_can_change, ArtChange, ArtChangeKind, ArtPolicy, Printing,
    Treatment,
};
#[cfg(feature = "native")]
use crate::error::{AppError, AppResult};
use crate::models::{DeckEntry, PrintLanguagePolicy};

#[cfg(feature = "native")]
impl ArtPolicy {
    pub(super) fn validate(&self) -> AppResult<()> {
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

pub struct PolicySelection<'a> {
    pub policy: &'a ArtPolicy,
    pub family_ranks: Option<&'a HashMap<String, u8>>,
}

impl PolicySelection<'_> {
    pub fn plan_entry(
        &self,
        entry: &DeckEntry,
        candidates: &[Printing],
        preferred: &[String],
        missing: PrintLanguagePolicy,
    ) -> (ArtChange, Option<DeckEntry>) {
        if !policy_can_change(entry) {
            return (
                ArtChange::new(
                    entry,
                    ArtChangeKind::Pinned,
                    None,
                    "Manual art is protected.",
                ),
                None,
            );
        }
        let print = self
            .anchor(candidates, entry.card.faces.len())
            .and_then(|anchor| {
                languages(preferred, missing)
                    .find_map(|language| choose_printing(anchor, candidates, language, Some(self)))
            });
        plan_change(entry, print, preferred, false)
    }

    pub fn anchor<'a>(&self, candidates: &'a [Printing], faces: usize) -> Option<&'a Printing> {
        candidates
            .iter()
            .filter(|print| self.permits(print) && print.illustrations.len() == faces)
            .min_by(|a, b| self.compare(a, b, true))
    }

    pub(crate) fn permits(&self, printing: &Printing) -> bool {
        printing.paper
            && !printing.promo
            && match self.policy {
                ArtPolicy::MatchSet { set, .. } => {
                    printing.set == *set
                        || self
                            .family_ranks
                            .is_some_and(|ranks| ranks.contains_key(&printing.set))
                }
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

    pub(crate) fn compare_treatment(&self, a: &Printing, b: &Printing) -> Ordering {
        self.treatment_matches(b).cmp(&self.treatment_matches(a))
    }

    fn compare(&self, a: &Printing, b: &Printing, deck_policy: bool) -> Ordering {
        self.family_ranks
            .as_ref()
            .map_or(Ordering::Equal, |ranks| {
                ranks.get(&a.set).cmp(&ranks.get(&b.set))
            })
            .then_with(|| self.compare_treatment(a, b))
            .then_with(|| compare_release(a, b, Some(self.policy)))
            .then_with(|| {
                if deck_policy {
                    compare_scan_quality(a, b)
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

pub(crate) fn compare_scan_quality(a: &Printing, b: &Printing) -> Ordering {
    let quality = |print: &Printing| print.scans.as_ref()?.first()?.scan_quality;
    quality(b).cmp(&quality(a))
}

pub(crate) fn compare_release(a: &Printing, b: &Printing, policy: Option<&ArtPolicy>) -> Ordering {
    a.date.is_empty().cmp(&b.date.is_empty()).then_with(|| {
        if matches!(policy, Some(ArtPolicy::Original)) {
            a.date.cmp(&b.date)
        } else {
            b.date.cmp(&a.date)
        }
    })
}

pub(crate) fn same_illustrations(anchor: &Printing, candidate: &Printing) -> bool {
    anchor.oracle_id == candidate.oracle_id
        && (anchor.id == candidate.id
            || (!anchor.illustrations.is_empty()
                && anchor.illustrations.iter().all(Option::is_some)
                && anchor.illustrations == candidate.illustrations))
}

/// Select a scan for the policy's chosen illustration, or for a manual art pick.
pub fn choose_printing<'a>(
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
