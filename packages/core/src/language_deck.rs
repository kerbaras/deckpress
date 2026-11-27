use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::{
    art_policy::{ArtChange, ArtChangeKind, ArtPolicy, Printing},
    language_switch::{choose_printing, LanguageTier},
    models::{Art, DeckEntry, PrintLanguagePolicy, Provider},
    set_family::{family, SetInfo},
    AppError, AppResult,
};

#[cfg(feature = "native")]
use crate::providers::Providers;

pub(crate) fn scryfall_art_id(art_id: &str) -> Option<uuid::Uuid> {
    art_id
        .strip_prefix("scryfall:")
        .and_then(|rest| rest.split(':').next())
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
}

pub(crate) fn protected(entry: &DeckEntry) -> bool {
    entry.is_art_pinned()
        || entry
            .card
            .faces
            .iter()
            .any(|face| face.provider != Provider::Scryfall)
}

fn row(before: &DeckEntry, after: &DeckEntry, tier: LanguageTier) -> ArtChange {
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

fn choice_scans<'a>(print: &'a Printing, entry: &DeckEntry, language: &str) -> Option<&'a [Art]> {
    print.scans.as_deref().filter(|scans| {
        print.paper
            && print.oracle_id == entry.card.oracle_id
            && print.language == language
            && scans.len() == entry.card.faces.len()
    })
}

fn set_faces(entry: &mut DeckEntry, scans: &[Art], fallback: bool) {
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

pub fn override_print(
    original: &DeckEntry,
    proposed: &DeckEntry,
    print: Option<&Printing>,
    language: &str,
) -> AppResult<(DeckEntry, ArtChange)> {
    if protected(original) {
        return Err(AppError::user("Manual art is protected."));
    }
    let (id, scans) = print
        .and_then(|print| {
            Some((
                print.id.parse().ok()?,
                choice_scans(print, original, language)?,
            ))
        })
        .ok_or_else(|| AppError::user("Choose a usable printing in the requested language."))?;
    let mut entry = proposed.clone();
    entry.language_choices.insert(language.to_owned(), id);
    set_faces(&mut entry, scans, false);
    let change = row(original, &entry, LanguageTier::Override);
    Ok((entry, change))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookups<'a> {
    pub anchor_ids: BTreeSet<uuid::Uuid>,
    pub oracle_ids: BTreeSet<&'a str>,
}

pub fn lookups<'a>(entries: &'a [DeckEntry], language: &str) -> Lookups<'a> {
    let eligible = entries.iter().filter(|entry| !protected(entry));
    Lookups {
        anchor_ids: eligible
            .clone()
            .flat_map(|entry| {
                scryfall_art_id(source_id(entry))
                    .into_iter()
                    .chain(entry.language_choices.get(language).copied())
            })
            .collect(),
        oracle_ids: eligible
            .map(|entry| entry.card.oracle_id.as_str())
            .collect(),
    }
}

#[derive(Deserialize)]
pub struct Inventory {
    pub sets: Vec<SetInfo>,
    pub anchors: HashMap<String, Printing>,
    pub candidates: HashMap<String, Vec<Printing>>,
}

pub struct Plan<'a> {
    language: &'a str,
    fallback: bool,
    proposals: HashMap<String, (LanguageTier, &'a [Art])>,
}

pub fn propose<'a>(
    entries: &[DeckEntry],
    policy: Option<&ArtPolicy>,
    language: &'a str,
    missing: PrintLanguagePolicy,
    inventory: &'a Inventory,
) -> Plan<'a> {
    let Inventory {
        sets,
        anchors,
        candidates,
    } = inventory;
    let policy_family = match policy {
        Some(ArtPolicy::MatchSet { set, family: true }) => family(set, sets).into_iter().collect(),
        _ => HashMap::new(),
    };
    let mut families = HashMap::new();
    let proposals = entries
        .iter()
        .filter(|entry| !protected(entry))
        .filter_map(|entry| {
            if let Some(scans) = entry
                .language_choices
                .get(language)
                .and_then(|id| anchors.get(&id.to_string()))
                .and_then(|print| choice_scans(print, entry, language))
            {
                return Some((entry.id.clone(), (LanguageTier::Override, scans)));
            }
            let id = scryfall_art_id(source_id(entry))?;
            let anchor = anchors.get(&id.to_string())?;
            if anchor.oracle_id != entry.card.oracle_id {
                return None;
            }
            let ranks = families
                .entry(anchor.set.clone())
                .or_insert_with(|| family(&anchor.set, sets).into_iter().collect());
            let options = candidates.get(&entry.card.oracle_id)?;
            let (tier, print) =
                choose_printing(anchor, options, language, policy, ranks, &policy_family)?;
            Some((entry.id.clone(), (tier, print.scans.as_deref()?)))
        })
        .collect();
    Plan {
        language,
        fallback: language != "en" && missing == PrintLanguagePolicy::FallbackToEnglish,
        proposals,
    }
}

impl Plan<'_> {
    pub fn english_lookups<'a>(&self, entries: &'a [DeckEntry]) -> BTreeSet<&'a str> {
        entries
            .iter()
            .filter(|entry| {
                self.fallback
                    && !protected(entry)
                    && !self.proposals.contains_key(&entry.id)
                    && entry.front_art().language != "en"
            })
            .map(|entry| entry.card.oracle_id.as_str())
            .collect()
    }

    pub fn apply(
        &self,
        entries: &mut [DeckEntry],
        english: &HashMap<String, Vec<Printing>>,
    ) -> Vec<ArtChange> {
        entries
            .iter_mut()
            .map(|entry| {
                if protected(entry) {
                    return row(entry, entry, LanguageTier::Pinned);
                }
                let before = entry.clone();
                entry.language_anchor = Some(source_id(&before).to_owned());
                entry.requested_languages = vec![self.language.to_owned()];
                let tier = if let Some(&(tier, scans)) = self.proposals.get(&entry.id) {
                    set_faces(entry, scans, false);
                    tier
                } else if let Some(scans) = self
                    .fallback
                    .then(|| same_english_print(&before, english))
                    .flatten()
                {
                    set_faces(entry, scans, true);
                    LanguageTier::KeptEnglish
                } else {
                    let kept_english = self.fallback && before.front_art().language == "en";
                    set_faces(entry, before.effective_faces(), kept_english);
                    if kept_english {
                        LanguageTier::KeptEnglish
                    } else {
                        LanguageTier::KeptCurrent
                    }
                };
                row(&before, entry, tier)
            })
            .collect()
    }
}

#[cfg(feature = "native")]
pub(crate) async fn plan(
    providers: &Providers,
    entries: &mut [DeckEntry],
    policy: Option<&ArtPolicy>,
    language: &str,
    missing: PrintLanguagePolicy,
) -> AppResult<Vec<ArtChange>> {
    let Lookups {
        anchor_ids,
        oracle_ids,
    } = lookups(entries, language);
    if oracle_ids.is_empty() {
        return Ok(entries
            .iter()
            .map(|entry| row(entry, entry, LanguageTier::Pinned))
            .collect());
    }
    let inventory = Inventory {
        sets: providers.sets().await?,
        anchors: providers.language_anchors(anchor_ids).await?,
        candidates: providers.language_printings(oracle_ids, language).await?,
    };
    let plan = propose(entries, policy, language, missing, &inventory);
    let english_ids = plan.english_lookups(entries);
    let english = if english_ids.is_empty() {
        HashMap::new()
    } else {
        providers.language_printings(english_ids, "en").await?
    };
    Ok(plan.apply(entries, &english))
}
