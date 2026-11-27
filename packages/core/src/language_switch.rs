//! Ranks a supplied inventory without network or storage dependencies.

use std::{cmp::Ordering, collections::HashMap};

use chrono::NaiveDate;
use serde::Serialize;

use crate::art_policy::{
    selection::{compare_release, compare_scan_quality, same_illustrations, PolicySelection},
    ArtPolicy, Printing,
};

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
    let selection = policy.map(|policy| PolicySelection {
        policy,
        family_ranks: Some(policy_family),
    });
    candidates
        .iter()
        .filter(|print| {
            print.oracle_id == anchor.oracle_id
                && print.language == language
                && selection
                    .as_ref()
                    .map_or(print.paper, |policy| policy.permits(print))
                && print.scans.as_ref().is_some_and(|faces| {
                    !faces.is_empty() && faces.len() == anchor.illustrations.len()
                })
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
            (tier, family_rank, style_distance(anchor, print), print)
        })
        .min_by(
            |(a_tier, a_family, a_style, a), (b_tier, b_family, b_style, b)| {
                a_tier
                    .cmp(b_tier)
                    .then_with(|| a_family.cmp(b_family))
                    .then_with(|| {
                        selection
                            .as_ref()
                            .map_or(Ordering::Equal, |policy| policy.compare_treatment(a, b))
                    })
                    .then_with(|| a_style.cmp(b_style))
                    .then_with(|| policy_family.get(&a.set).cmp(&policy_family.get(&b.set)))
                    .then_with(|| compare_release(a, b, policy))
                    .then_with(|| compare_scan_quality(a, b))
                    .then_with(|| a.id.cmp(&b.id))
            },
        )
        .map(|(tier, _, _, print)| (tier, print))
}
