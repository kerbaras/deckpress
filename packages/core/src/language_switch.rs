//! Ranks a supplied inventory without network or storage dependencies.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::Serialize;

use crate::art_policy::{same_illustrations, ArtPolicy, Printing, Treatment};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LanguageTier {
    SamePrinting,
    SameSet,
    SameArt,
    Closest,
    KeptEnglish,
    KeptCurrent,
    Pinned,
    Override,
}

fn allowed(print: &Printing, policy: Option<&ArtPolicy>, sets: &HashMap<String, u8>) -> bool {
    match policy {
        None => true,
        Some(ArtPolicy::MatchSet { set, .. }) => {
            !print.promo && (print.set == *set || sets.contains_key(&print.set))
        }
        Some(ArtPolicy::Style {
            frame,
            border,
            treatment,
        }) => {
            !print.promo
                && frame.is_none_or(|frame| frame.code() == print.frame)
                && border.is_none_or(|border| border.code() == print.border)
                && match treatment {
                    None => true,
                    Some(Treatment::None) => !print.full_art && !print.showcase,
                    Some(Treatment::FullArt) => print.full_art,
                    Some(Treatment::Showcase) => print.showcase,
                }
        }
        _ => !print.promo,
    }
}

fn style_distance(anchor: &Printing, print: &Printing) -> (bool, bool, usize, usize, u64) {
    let missing = |left: &Printing, right: &Printing| {
        left.treatments
            .iter()
            .filter(|effect| !right.treatments.contains(effect))
            .count()
    };
    let date = |print: &Printing| NaiveDate::parse_from_str(&print.date, "%Y-%m-%d").ok();
    (
        !anchor.frame.is_empty() && anchor.frame != print.frame,
        !anchor.border.is_empty() && anchor.border != print.border,
        missing(anchor, print) + missing(print, anchor),
        usize::from(anchor.full_art != print.full_art)
            + usize::from(anchor.showcase != print.showcase),
        date(anchor).zip(date(print)).map_or(u64::MAX, |(a, b)| {
            a.signed_duration_since(b).num_days().unsigned_abs()
        }),
    )
}

/// The family of the source printing determines tier 2. The optional family
/// of a Match Set policy restricts eligibility independently of that tier.
pub fn choose_printing<'a>(
    anchor: &Printing,
    candidates: &'a [Printing],
    language: &str,
    policy: Option<&ArtPolicy>,
    source_family: &HashMap<String, u8>,
    policy_family: &HashMap<String, u8>,
) -> Option<(LanguageTier, &'a Printing)> {
    candidates
        .iter()
        .filter(|print| {
            print.oracle_id == anchor.oracle_id
                && print.language == language
                && print.paper
                && print.scans.as_ref().is_some_and(|faces| {
                    !faces.is_empty() && faces.len() == anchor.illustrations.len()
                })
                && allowed(print, policy, policy_family)
        })
        .map(|print| {
            let (tier, family_rank) = if print.set == anchor.set {
                if print.collector == anchor.collector {
                    (LanguageTier::SamePrinting, 0)
                } else {
                    (LanguageTier::SameSet, 0)
                }
            } else if let Some(&rank) = source_family.get(&print.set) {
                (LanguageTier::SameSet, rank)
            } else if same_illustrations(anchor, print) {
                (LanguageTier::SameArt, 0)
            } else {
                (LanguageTier::Closest, 0)
            };
            ((tier, family_rank, style_distance(anchor, print)), print)
        })
        .min_by(|(a_rank, a), (b_rank, b)| {
            a_rank
                .cmp(b_rank)
                .then_with(|| policy_family.get(&a.set).cmp(&policy_family.get(&b.set)))
                .then_with(|| a.date.is_empty().cmp(&b.date.is_empty()))
                .then_with(|| {
                    if matches!(policy, Some(ArtPolicy::Original)) {
                        a.date.cmp(&b.date)
                    } else {
                        b.date.cmp(&a.date)
                    }
                })
                .then_with(|| {
                    let quality = |print: &Printing| print.scans.as_ref()?.first()?.scan_quality;
                    quality(b).cmp(&quality(a))
                })
                .then_with(|| a.id.cmp(&b.id))
        })
        .map(|((tier, _, _), print)| (tier, print))
}
