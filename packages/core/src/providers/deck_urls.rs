use serde_json::Value;
use url::Url;

use crate::error::{AppError, AppResult};

use super::Providers;

impl Providers {
    /// Turns a public Moxfield or Archidekt deck URL into decklist text that the
    /// TypeScript parser understands.
    pub async fn import_url(&self, input: &str) -> AppResult<String> {
        let url = Url::parse(input)
            .map_err(|_| AppError::user("Use an HTTPS Moxfield or Archidekt deck URL"))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(AppError::user(
                "Use an HTTPS Moxfield or Archidekt deck URL",
            ));
        }
        let host = url.host_str().unwrap_or_default();
        if host == "moxfield.com" || host == "www.moxfield.com" {
            let id = url
                .path()
                .trim_end_matches('/')
                .strip_prefix("/decks/")
                .filter(|id| {
                    !id.is_empty()
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
                .ok_or_else(|| AppError::user("Invalid Moxfield deck URL"))?;
            let data = self
                .json_or_status(
                    &format!("https://api2.moxfield.com/v3/decks/all/{id}"),
                    None,
                    false,
                    |_| {},
                )
                .await?
                .map_err(moxfield_status_error)?;
            let Some(boards) = data.get("boards").and_then(Value::as_object) else {
                return Ok(String::new());
            };
            let mut lines = Vec::new();
            for (zone, board) in boards {
                let header = lines.len();
                for (entry, card, name) in moxfield_cards(board) {
                    let quantity = entry.get("quantity").and_then(Value::as_u64).unwrap_or(1);
                    let set = card.get("set").and_then(Value::as_str).unwrap_or_default();
                    let cn = card.get("cn").and_then(Value::as_str).unwrap_or_default();
                    lines.push(if !set.is_empty() && !cn.is_empty() {
                        format!("{quantity} {name} ({set}) {cn}")
                    } else {
                        format!("{quantity} {name}")
                    });
                }
                if lines.len() > header {
                    let heading = match zone.to_ascii_lowercase().as_str() {
                        "deck" | "main" | "mainboard" | "commander" | "commanders" | "side"
                        | "sideboard" | "maybe" | "maybeboard" | "considering" | "token"
                        | "tokens" => zone.clone(),
                        "companion" | "companions" => "Companion".to_string(),
                        _ => format!("Deck\n// Board: {zone}"),
                    };
                    lines.insert(header, heading);
                }
            }
            return Ok(lines.join("\n"));
        }
        if host == "archidekt.com" || host == "www.archidekt.com" {
            let id = url
                .path()
                .strip_prefix("/decks/")
                .and_then(|rest| rest.split('/').next())
                .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
                .ok_or_else(|| AppError::user("Invalid Archidekt deck URL"))?;
            let data = self
                .json(&format!("https://archidekt.com/api/decks/{id}/"), None)
                .await?;
            let excluded: Vec<String> = data
                .get("categories")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|c| c.get("includedInDeck").and_then(Value::as_bool) == Some(false))
                .filter_map(|c| c.get("name").and_then(Value::as_str).map(str::to_string))
                .collect();
            let mut lines = Vec::new();
            for entry in data
                .get("cards")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let categories: Vec<String> = entry
                    .get("categories")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.as_str().map(str::to_string))
                    .collect();
                let lower: Vec<String> = categories.iter().map(|c| c.to_lowercase()).collect();
                let excluded_board = categories
                    .iter()
                    .any(|c| !c.eq_ignore_ascii_case("companion") && excluded.contains(c));
                let zone = if lower.iter().any(|c| c == "commander") {
                    "Commander"
                } else if !excluded_board && lower.iter().any(|c| c == "companion") {
                    "Companion"
                } else if lower.iter().any(|c| c == "sideboard") {
                    "Sideboard"
                } else if excluded_board {
                    "Maybeboard"
                } else {
                    "Deck"
                };
                let quantity = entry.get("quantity").and_then(Value::as_u64).unwrap_or(1);
                let name = entry
                    .pointer("/card/oracleCard/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let set = entry
                    .pointer("/card/edition/editioncode")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let cn = entry
                    .pointer("/card/collectorNumber")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                lines.push(zone.to_string());
                lines.push(format!("{quantity} {name} ({set}) {cn}"));
            }
            return Ok(lines.join("\n"));
        }
        Err(AppError::user(
            "Only public Moxfield and Archidekt URLs are supported. Other sites can be imported as text or CSV.",
        ))
    }
}

fn moxfield_cards(board: &Value) -> impl Iterator<Item = (&Value, &Value, &str)> {
    board
        .get("cards")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|cards| cards.values())
        .filter_map(|entry| {
            let card = entry.get("card")?;
            let name = card.get("name")?.as_str()?;
            (!name.is_empty()).then_some((entry, card, name))
        })
}

/// Explains a failed Moxfield deck request. Moxfield answers 403 to every
/// client that is not a web browser, so the exported text list is the way in.
pub fn moxfield_status_error(status: u16) -> AppError {
    match status {
        403 => AppError::user(
            "Moxfield refused the request (HTTP 403): it blocks apps that are not a web browser. In Moxfield, open the deck, choose More › Download / Export, click Copy Plain Text and paste the list here.",
        ),
        404 => AppError::user(
            "Moxfield could not find this deck (HTTP 404). Check that the deck is public, or paste its exported text list.",
        ),
        status => AppError::user(format!(
            "Moxfield returned HTTP {status}. Retry later, or paste the deck's exported text list."
        )),
    }
}
