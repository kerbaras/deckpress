use std::collections::{BTreeMap, HashSet};

use url::Url;

use crate::card_names::split_card_alternative;
use crate::error::{AppError, AppResult};
use crate::models::ImportLine;

use super::collection::{import_candidate, ImportCandidate};
use super::scryfall_card::{fold_name, normalize_scryfall};
use super::search::{cards_in, exact_name_query, printing_query, scryfall_search, search_literal};
use super::Providers;

const SPLIT_SEARCH_CONDITION_LIMIT: usize = 20;
const SPLIT_SEARCH_ENCODED_LIMIT: usize = 1700;
const SPLIT_SEARCH_FILTER: &str = "include:extras";

type SplitSearchClause = (String, Vec<(usize, ImportLine)>);

fn split_search_batches(
    mut clauses: &[SplitSearchClause],
) -> impl Iterator<Item = (Url, &[SplitSearchClause])> {
    std::iter::from_fn(move || {
        while !clauses.is_empty() {
            let mut conditions = 1;
            let mut names = HashSet::new();
            let mut last = None;
            for (index, (_, lookups)) in clauses.iter().enumerate() {
                let line = &lookups[0].1;
                conditions +=
                    1 + usize::from(!line.set.is_empty() || !line.collector_number.is_empty());
                if conditions > SPLIT_SEARCH_CONDITION_LIMIT
                    || !names.insert(fold_name(&lookups[0].1.name))
                {
                    break;
                }
                let query = printing_query(&clauses[..=index], SPLIT_SEARCH_FILTER, false);
                let encoded = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("q", &query)
                    .finish();
                if encoded.len() > SPLIT_SEARCH_ENCODED_LIMIT {
                    break;
                }
                last = Some((index + 1, query));
            }
            if let Some((count, query)) = last {
                let (batch, rest) = clauses.split_at(count);
                clauses = rest;
                return Some((scryfall_search(&query, 1, "cards"), batch));
            }
            clauses = &clauses[1..];
        }
        None
    })
}

impl Providers {
    pub(super) async fn resolve_split_names(
        &self,
        lines: &mut [ImportLine],
        candidates: &mut [Option<ImportCandidate>],
    ) -> AppResult<()> {
        let mut queries: BTreeMap<String, Vec<(usize, ImportLine)>> = BTreeMap::new();
        for (index, (line, candidate)) in lines.iter().zip(candidates.iter()).enumerate() {
            if candidate.is_some()
                || (!line.set.is_empty() && !line.collector_number.is_empty())
                || !line.set.bytes().all(|byte| byte.is_ascii_alphanumeric())
            {
                continue;
            }
            let Some(name) = split_card_alternative(&line.name) else {
                continue;
            };
            let mut clause = exact_name_query(&name);
            if !line.set.is_empty() {
                clause.push_str(&format!(" set:{}", line.set));
            } else if !line.collector_number.is_empty() {
                clause.push_str(&format!(" cn={}", search_literal(&line.collector_number)));
            }
            queries.entry(format!("({clause})")).or_default().push((
                index,
                ImportLine {
                    name,
                    ..line.clone()
                },
            ));
        }
        let clauses: Vec<_> = queries.into_iter().collect();
        for (url, batch) in split_search_batches(&clauses) {
            let response = match self
                .json_or_status(url.as_str(), None, true, |_| {})
                .await?
            {
                Ok(response) => response,
                Err(400..=499) => continue,
                Err(status) => {
                    return Err(AppError::user(format!(
                        "Scryfall returned {status}. Try again."
                    )))
                }
            };
            let cards: Vec<_> = cards_in(&response)
                .map(|raw| (raw, normalize_scryfall(raw).ok()))
                .collect();
            for (index, line) in batch.iter().flat_map(|(_, group)| group) {
                if let Some(candidate) = import_candidate(&cards, line, false) {
                    lines[*index].name.clone_from(&line.name);
                    candidates[*index] = Some(candidate);
                }
            }
        }
        Ok(())
    }
}
