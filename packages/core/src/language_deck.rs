use std::collections::HashMap;

use crate::{
    art_policy::{ArtChange, ArtChangeKind, ArtPolicy, Printing},
    language_switch::{choose_printing, LanguageTier},
    models::{Art, DeckEntry, PrintLanguagePolicy, Provider},
    providers::{scryfall_art_id, Providers},
    set_family::family,
    AppResult,
};

pub(crate) fn protected(entry: &DeckEntry) -> bool {
    entry.is_art_pinned()
        || entry
            .card
            .faces
            .iter()
            .any(|face| face.provider != Provider::Scryfall)
}

pub(crate) fn row(before: &DeckEntry, after: &DeckEntry, tier: LanguageTier) -> ArtChange {
    let (kind, reason) = match tier {
        LanguageTier::Pinned => (ArtChangeKind::Pinned, "Manual art is protected."),
        LanguageTier::KeptCurrent => (
            ArtChangeKind::Unmatched,
            "No matching scan in the requested language. Kept the current printing.",
        ),
        LanguageTier::KeptEnglish => (
            ArtChangeKind::Fallback,
            "No matching scan in the requested language. Using English.",
        ),
        _ if before.effective_faces() == after.effective_faces() => (ArtChangeKind::Unchanged, ""),
        _ => (ArtChangeKind::Changed, ""),
    };
    let mut change = ArtChange::new(before, kind, Some(after.front_art().clone()), reason);
    change.tier = Some(tier);
    change.before_back = before.back_art();
    change.after_back = after.back_art();
    change
}

fn source_id(entry: &DeckEntry) -> &str {
    entry
        .language_anchor
        .as_deref()
        .unwrap_or(&entry.front_art().id)
}

pub(crate) fn choice_scans<'a>(
    print: &'a Printing,
    entry: &DeckEntry,
    language: &str,
) -> Option<&'a [Art]> {
    print.scans.as_deref().filter(|scans| {
        print.paper
            && print.oracle_id == entry.card.oracle_id
            && print.language == language
            && scans.len() == entry.card.faces.len()
    })
}

pub(crate) fn set_faces(entry: &mut DeckEntry, scans: &[Art], fallback: bool) {
    entry.policy_art = Some(
        scans
            .iter()
            .cloned()
            .map(|mut art| {
                art.english_fallback = fallback;
                art
            })
            .collect(),
    );
}

fn same_english_print<'a>(
    entry: &DeckEntry,
    options: &'a HashMap<String, Vec<Printing>>,
) -> Option<&'a [crate::models::Art]> {
    let current = entry.front_art();
    options
        .get(&entry.card.oracle_id)?
        .iter()
        .filter(|print| {
            print.paper && print.set == current.set && print.collector == current.collector_number
        })
        .filter_map(|print| print.scans.as_deref())
        .find(|faces| faces.len() == entry.card.faces.len())
}

pub(crate) async fn plan(
    providers: &Providers,
    entries: &mut [DeckEntry],
    policy: Option<&ArtPolicy>,
    language: &str,
    missing: PrintLanguagePolicy,
) -> AppResult<Vec<ArtChange>> {
    let eligible: Vec<_> = entries.iter().filter(|entry| !protected(entry)).collect();
    if eligible.is_empty() {
        return Ok(entries
            .iter()
            .map(|entry| row(entry, entry, LanguageTier::Pinned))
            .collect());
    }
    let sets = providers.sets().await?;
    let policy_family = match policy {
        Some(ArtPolicy::MatchSet { set, family: true }) => family(set, &sets).into_iter().collect(),
        _ => HashMap::new(),
    };
    let printings_by_id = providers
        .language_anchors(
            eligible
                .iter()
                .flat_map(|entry| {
                    scryfall_art_id(source_id(entry))
                        .into_iter()
                        .chain(entry.language_choices.get(language).copied())
                })
                .collect(),
        )
        .await?;
    let candidates = providers
        .language_printings(
            eligible
                .iter()
                .map(|entry| entry.card.oracle_id.as_str())
                .collect(),
            language,
        )
        .await?;
    let mut families = HashMap::new();
    let proposals: HashMap<_, _> = eligible
        .iter()
        .filter_map(|entry| {
            if let Some(scans) = entry
                .language_choices
                .get(language)
                .and_then(|id| printings_by_id.get(&id.to_string()))
                .and_then(|print| choice_scans(print, entry, language))
            {
                return Some((entry.id.clone(), (LanguageTier::Override, scans)));
            }
            let id = scryfall_art_id(source_id(entry))?;
            let anchor = printings_by_id.get(&id.to_string())?;
            if anchor.oracle_id != entry.card.oracle_id {
                return None;
            }
            let ranks = families
                .entry(anchor.set.clone())
                .or_insert_with(|| family(&anchor.set, &sets).into_iter().collect());
            let options = candidates.get(&entry.card.oracle_id)?;
            let (tier, print) =
                choose_printing(anchor, options, language, policy, ranks, &policy_family)?;
            Some((entry.id.clone(), (tier, print.scans.as_deref()?)))
        })
        .collect();
    let fallback = language != "en" && missing == PrintLanguagePolicy::FallbackToEnglish;
    let english = if fallback {
        providers
            .language_printings(
                eligible
                    .iter()
                    .filter(|entry| {
                        !proposals.contains_key(&entry.id) && entry.front_art().language != "en"
                    })
                    .map(|entry| entry.card.oracle_id.as_str())
                    .collect(),
                "en",
            )
            .await?
    } else {
        HashMap::new()
    };
    Ok(entries
        .iter_mut()
        .map(|entry| {
            if protected(entry) {
                return row(entry, entry, LanguageTier::Pinned);
            }
            let before = entry.clone();
            entry.language_anchor = Some(source_id(&before).to_owned());
            entry.requested_languages = vec![language.to_owned()];
            let tier = if let Some(&(tier, scans)) = proposals.get(&entry.id) {
                set_faces(entry, scans, false);
                tier
            } else if let Some(scans) = same_english_print(&before, &english) {
                set_faces(entry, scans, true);
                LanguageTier::KeptEnglish
            } else {
                let kept_english = fallback && before.front_art().language == "en";
                set_faces(entry, before.effective_faces(), kept_english);
                if kept_english {
                    LanguageTier::KeptEnglish
                } else {
                    LanguageTier::KeptCurrent
                }
            };
            row(&before, entry, tier)
        })
        .collect())
}
