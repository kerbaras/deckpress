use std::collections::HashMap;

use deckpress_core::{
    art_policy::Printing,
    language_deck::{self, Inventory},
    models::{DeckEntry, PrintLanguagePolicy},
    validate::validate_entries,
};
use wasm_bindgen::prelude::*;

use super::{deck, js_error};

// The browser merges these fields into its original entries, retaining web
// upload metadata and any other data the core does not own.
fn update(entry: &DeckEntry) -> serde_json::Value {
    serde_json::json!({
        "id": entry.id,
        "policyArt": entry.policy_art,
        "languageAnchor": entry.language_anchor,
        "languageChoices": entry.language_choices,
        "requestedLanguages": entry.requested_languages,
    })
}

#[wasm_bindgen(js_name = deckLanguageLookups)]
pub fn deck_language_lookups(deck_json: &str, language: &str) -> Result<String, JsError> {
    let deck = deck(deck_json)?;
    serde_json::to_string(&language_deck::lookups(&deck.entries, language)).map_err(js_error)
}

#[wasm_bindgen(js_name = planDeckLanguage)]
pub fn plan_deck_language(
    deck_json: &str,
    language: &str,
    missing: &str,
    inventory_json: &str,
    english_json: Option<String>,
) -> Result<String, JsError> {
    let before = deck(deck_json)?;
    let missing: PrintLanguagePolicy = serde_json::from_str(missing).map_err(js_error)?;
    let inventory: Inventory = serde_json::from_str(inventory_json).map_err(js_error)?;
    let plan = language_deck::propose(
        &before.entries,
        before.art_policy.as_ref(),
        language,
        missing,
        &inventory,
    );
    let english = if let Some(json) = english_json {
        serde_json::from_str(&json).map_err(js_error)?
    } else {
        let ids = plan.english_lookups(&before.entries);
        if !ids.is_empty() {
            return Ok(serde_json::json!({ "englishOracleIds": ids }).to_string());
        }
        HashMap::new()
    };
    let mut entries = before.entries.clone();
    let changes = plan.apply(&mut entries, &english);
    let updates: Vec<_> = entries
        .iter()
        .zip(before.entries.iter())
        .filter(|(next, previous)| next != previous)
        .map(|(entry, _)| update(entry))
        .collect();
    Ok(serde_json::json!({
        "updates": updates,
        "changes": changes,
    })
    .to_string())
}

#[wasm_bindgen(js_name = overrideDeckLanguagePrint)]
pub fn override_deck_language_print(
    original_json: &str,
    proposed_json: &str,
    printing_json: &str,
    language: &str,
) -> Result<String, JsError> {
    let original: DeckEntry = serde_json::from_str(original_json).map_err(js_error)?;
    let proposed: DeckEntry = serde_json::from_str(proposed_json).map_err(js_error)?;
    validate_entries(std::slice::from_ref(&original)).map_err(js_error)?;
    validate_entries(std::slice::from_ref(&proposed)).map_err(js_error)?;
    let printing: Option<Printing> = serde_json::from_str(printing_json).map_err(js_error)?;
    let (entry, change) =
        language_deck::override_print(&original, &proposed, printing.as_ref(), language)
            .map_err(js_error)?;
    Ok(serde_json::json!({ "update": update(&entry), "change": change }).to_string())
}
