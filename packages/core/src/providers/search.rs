use std::time::Duration;

use serde_json::Value;
use url::Url;

use crate::error::AppResult;

use super::Providers;

const PRINT_SEARCH_BATCH: usize = 12;

pub(super) fn print_search(query: &str, page: u32) -> Url {
    scryfall_search(query, page, "prints")
}

pub(super) fn scryfall_search(query: &str, page: u32, unique: &str) -> Url {
    let mut url = Url::parse("https://api.scryfall.com/cards/search").expect("static URL");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("unique", unique)
        .append_pair("include_multilingual", "true")
        .append_pair("order", "released")
        .append_pair("dir", "desc")
        .append_pair("page", &page.to_string());
    url
}

pub(super) fn printing_queries<'a, T>(
    clauses: &'a [(String, T)],
    suffix: &'a str,
    parenthesize_single: bool,
) -> impl Iterator<Item = (String, &'a [(String, T)])> {
    clauses
        .chunks(PRINT_SEARCH_BATCH)
        .map(move |batch| (printing_query(batch, suffix, parenthesize_single), batch))
}

pub(super) fn printing_query<T>(
    clauses: &[(String, T)],
    suffix: &str,
    parenthesize_single: bool,
) -> String {
    let terms = clauses
        .iter()
        .map(|(term, _)| term.as_str())
        .collect::<Vec<_>>()
        .join(" or ");
    if clauses.len() > 1 || parenthesize_single {
        format!("({terms}) {suffix}")
    } else {
        format!("{terms} {suffix}")
    }
}

pub(super) fn cards_in(response: &Value) -> impl Iterator<Item = &Value> {
    response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

pub(super) fn has_more(response: &Value) -> bool {
    response
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn search_literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

pub(super) fn exact_name_query(name: &str) -> String {
    format!("!{}", search_literal(name))
}

impl Providers {
    pub(super) async fn visit_printing_pages(
        &self,
        query: &str,
        on_retry: impl Fn(Duration),
        mut visit: impl FnMut(&Value) -> bool,
    ) -> AppResult<bool> {
        for page in 1..=100 {
            let url = print_search(query, page);
            let response = self
                .scryfall_json_with_retry(url.as_str(), &on_retry)
                .await?;
            if visit(&response) || !has_more(&response) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
