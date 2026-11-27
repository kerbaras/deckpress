use std::collections::BTreeSet;

use serde_json::Value;

use crate::card_names::card_lookup_name;
use crate::error::{AppError, AppResult};
use crate::models::{
    new_id, Card, DeckEntry, ImportIssue, ImportIssueKind, ImportLine, ImportPrintLookup,
    MissingPrint, PrintLanguagePolicy, PrintLanguagePreferences, ResolvedCards, Zone,
};

use super::localization::ImportResolution;
use super::scryfall_card::{
    fold_name, normalize_scryfall, scryfall_full_name_matches, scryfall_name_matches,
    scryfall_print_number,
};
use super::search::cards_in;
use super::Providers;

const COLLECTION_BATCH: usize = 75;

fn import_label(line: &ImportLine) -> String {
    if line.set.is_empty() {
        format!("{} {}", line.quantity, line.name)
    } else {
        format!(
            "{} {} ({}) {}",
            line.quantity, line.name, line.set, line.collector_number
        )
        .trim_end()
        .to_string()
    }
}

fn import_identifier(line: &ImportLine) -> Value {
    if !line.set.is_empty() && !line.collector_number.is_empty() {
        serde_json::json!({ "set": line.set, "collector_number": line.collector_number })
    } else if !line.set.is_empty() {
        serde_json::json!({ "name": card_lookup_name(&line.name), "set": line.set })
    } else {
        serde_json::json!({ "name": card_lookup_name(&line.name) })
    }
}

pub(super) struct ImportCandidate {
    pub(super) card: Option<Card>,
    pub(super) number: (String, String),
}

pub(super) fn import_candidate(
    cards: &[(&Value, Option<Card>)],
    line: &ImportLine,
    allow_faces: bool,
) -> Option<ImportCandidate> {
    let wanted = fold_name(&line.name);
    let mut best = None;
    let mut best_rank = 0;
    for (raw, card) in cards {
        let Some((set, collector)) = scryfall_print_number(raw) else {
            continue;
        };
        if (!line.set.is_empty() && set != line.set)
            || (!line.collector_number.is_empty() && collector != line.collector_number)
        {
            continue;
        }
        let full = (!line.set.is_empty() && !line.collector_number.is_empty())
            || scryfall_full_name_matches(raw, &wanted);
        if !full
            && (!allow_faces
                || card_lookup_name(&line.name) != line.name
                || !raw
                    .get("card_faces")
                    .and_then(Value::as_array)
                    .is_some_and(|faces| {
                        faces
                            .iter()
                            .any(|face| scryfall_name_matches(face, &wanted))
                    }))
        {
            continue;
        }
        let rank = 1 + 2 * u8::from(full) + u8::from(card.is_some());
        if rank > best_rank {
            best = Some((card, set, collector));
            best_rank = rank;
        }
    }
    best.map(|(card, set, collector)| ImportCandidate {
        card: card.clone(),
        number: (set.into(), collector.into()),
    })
}

impl Providers {
    pub async fn resolve(&self, lines: Vec<ImportLine>) -> AppResult<ResolvedCards> {
        self.resolve_with_languages(lines, &PrintLanguagePreferences::default())
            .await
    }

    pub(super) async fn resolve_with_languages(
        &self,
        mut lines: Vec<ImportLine>,
        preferences: &PrintLanguagePreferences,
    ) -> AppResult<ResolvedCards> {
        let mut entries = Vec::new();
        let mut issues = Vec::new();
        let mut missing_prints = Vec::new();
        let languages = &preferences.languages;
        let english_only = languages.as_slice() == ["en"];
        let fallback_english = preferences.policy == PrintLanguagePolicy::FallbackToEnglish
            && !languages.iter().any(|lang| lang == "en");
        let mut candidates = Vec::with_capacity(lines.len());
        for batch in lines.chunks(COLLECTION_BATCH) {
            let identifiers: Vec<_> = batch.iter().map(import_identifier).collect();
            let response = self
                .json(
                    "https://api.scryfall.com/cards/collection",
                    Some(serde_json::json!({ "identifiers": identifiers })),
                )
                .await?;
            let cards: Vec<_> = cards_in(&response)
                .map(|raw| (raw, normalize_scryfall(raw).ok()))
                .collect();
            candidates.extend(
                batch
                    .iter()
                    .map(|line| import_candidate(&cards, line, true)),
            );
        }
        self.resolve_split_names(&mut lines, &mut candidates)
            .await?;
        let mut resolutions: Vec<_> = lines
            .iter()
            .zip(&candidates)
            .map(|(line, candidate)| ImportResolution {
                line,
                original: candidate
                    .as_ref()
                    .and_then(|candidate| candidate.card.as_ref()),
                card: None,
                looked_up: candidate.as_ref().map(|candidate| candidate.number.clone()),
            })
            .collect();
        let mut attempted = languages.clone();
        if fallback_english {
            attempted.push("en".into());
        }
        for batch in resolutions.chunks_mut(COLLECTION_BATCH) {
            for language in &attempted {
                self.resolve_import_language(batch, language, english_only)
                    .await?;
            }
        }
        for (index, resolution) in resolutions.into_iter().enumerate() {
            let position = index + 1;
            let ImportResolution {
                line,
                card,
                looked_up,
                ..
            } = resolution;
            match card {
                Some(card) => entries.push(DeckEntry {
                    id: new_id(),
                    card,
                    quantity: line.quantity,
                    zone: line.zone,
                    board: line.board.clone(),
                    selected_art: None,
                    selected_back: None,
                    art_pinned: false,
                    policy_art: None,
                    language_anchor: None,
                    language_choices: Default::default(),
                    excluded: false,
                    requested_languages: if english_only { Vec::new() } else { languages.clone() },
                }),
                None if looked_up.is_some() => {
                    let input = import_label(line);
                    issues.push(ImportIssue {
                        line: position as u32,
                        input: input.clone(),
                        message: format!("No usable scan found in {}.", attempted.join(", ")),
                        kind: ImportIssueKind::NoUsableScan,
                        print_lookup: looked_up.map(|(set, collector_number)| ImportPrintLookup {
                            set,
                            collector_number,
                            languages: attempted.clone(),
                        }),
                    });
                    missing_prints.push(MissingPrint { input, languages: languages.clone() });
                }
                None => issues.push(ImportIssue {
                    line: position as u32,
                    input: import_label(line),
                    message: "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.".into(),
                    kind: ImportIssueKind::NotFound,
                    print_lookup: None,
                }),
            }
        }
        Ok(ResolvedCards {
            entries,
            issues,
            missing_prints,
        })
    }

    pub(super) async fn collection_by_id(
        &self,
        ids: BTreeSet<uuid::Uuid>,
    ) -> AppResult<Vec<Value>> {
        let ids: Vec<_> = ids.into_iter().collect();
        let mut result = Vec::new();
        for batch in ids.chunks(COLLECTION_BATCH) {
            let identifiers: Vec<_> = batch
                .iter()
                .map(|id| serde_json::json!({ "id": id.to_string() }))
                .collect();
            let mut response = self
                .json(
                    "https://api.scryfall.com/cards/collection",
                    Some(serde_json::json!({ "identifiers": identifiers })),
                )
                .await?;
            let cards = response
                .get_mut("data")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| AppError::user("Unexpected Scryfall collection data"))?;
            result.append(cards);
        }
        Ok(result)
    }

    pub async fn related_tokens(&self, card_ids: Vec<String>) -> AppResult<Vec<DeckEntry>> {
        if card_ids.len() > 1000 {
            return Err(AppError::user("Decklists are limited to 1000 lines"));
        }
        let producers = card_ids
            .iter()
            .map(|id| uuid::Uuid::parse_str(id).map_err(|_| AppError::user("Invalid card ID")))
            .collect::<AppResult<_>>()?;
        let ids = self
            .collection_by_id(producers)
            .await?
            .iter()
            .filter_map(|card| card["all_parts"].as_array())
            .flatten()
            .filter(|part| {
                part["component"] == "token"
                    || (part["component"] == "combo_piece"
                        && part["type_line"]
                            .as_str()
                            .is_some_and(|line| line.starts_with("Emblem")))
            })
            .filter_map(|part| uuid::Uuid::parse_str(part["id"].as_str()?).ok())
            .collect();
        let mut seen = BTreeSet::new();
        let mut entries: Vec<_> = self
            .collection_by_id(ids)
            .await?
            .iter()
            .filter_map(|raw| normalize_scryfall(raw).ok())
            .filter(|card| seen.insert(card.oracle_id.clone()))
            .map(|card| DeckEntry {
                id: new_id(),
                card,
                quantity: 1,
                zone: Zone::Tokens,
                board: None,
                selected_art: None,
                selected_back: None,
                art_pinned: false,
                policy_art: None,
                language_anchor: None,
                language_choices: Default::default(),
                excluded: false,
                requested_languages: Vec::new(),
            })
            .collect();
        entries.sort_by(|a, b| a.card.name.cmp(&b.card.name));
        Ok(entries)
    }
}
