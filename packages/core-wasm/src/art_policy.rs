use std::collections::HashMap;

use deckpress_core::{
    art_policy::{choose_printing, plan_change, requested_languages, PolicySelection, Printing},
    models::{DeckEntry, PrintLanguagePreferences},
    validate::validate_entries,
};
use wasm_bindgen::prelude::*;

use super::{deck, js_error};

#[wasm_bindgen(js_name = planDeckArtPolicy)]
pub fn plan_deck_art_policy(
    deck_json: &str,
    policy_json: &str,
    preferences_json: &str,
    family_ranks_json: &str,
    inventory_json: &str,
) -> Result<String, JsError> {
    let deck = deck(deck_json)?;
    let policy = serde_json::from_str(policy_json).map_err(js_error)?;
    let preferences: PrintLanguagePreferences =
        serde_json::from_str(preferences_json).map_err(js_error)?;
    let family_ranks: Option<HashMap<String, u8>> =
        serde_json::from_str(family_ranks_json).map_err(js_error)?;
    let inventory: HashMap<String, Vec<Printing>> =
        serde_json::from_str(inventory_json).map_err(js_error)?;
    let selection = PolicySelection {
        policy: &policy,
        family_ranks: family_ranks.as_ref(),
    };
    let mut changes = Vec::with_capacity(deck.entries.len());
    let mut updates = Vec::new();
    for entry in &deck.entries {
        let preferred =
            requested_languages(entry, deck.print_language.as_ref(), &preferences.languages);
        let options = inventory
            .get(&entry.card.oracle_id)
            .map_or(&[][..], Vec::as_slice);
        let (change, next) = selection.plan_entry(entry, options, preferred, preferences.policy);
        changes.push(change);
        if let Some(entry) = next {
            updates.push(serde_json::json!({
                "id": entry.id,
                "policyArt": entry.policy_art,
                "languageAnchor": entry.language_anchor,
                "requestedLanguages": entry.requested_languages,
            }));
        }
    }
    Ok(serde_json::json!({ "changes": changes, "updates": updates }).to_string())
}

#[wasm_bindgen(js_name = planPrintLocalization)]
pub fn plan_print_localization(
    entry_json: &str,
    anchor_json: &str,
    candidates_json: &str,
    preferred_json: &str,
    language: Option<String>,
) -> Result<String, JsError> {
    let entry: DeckEntry = serde_json::from_str(entry_json).map_err(js_error)?;
    validate_entries(std::slice::from_ref(&entry)).map_err(js_error)?;
    let anchor: Option<Printing> = serde_json::from_str(anchor_json).map_err(js_error)?;
    let candidates: Vec<Printing> = serde_json::from_str(candidates_json).map_err(js_error)?;
    let preferred: Vec<String> = serde_json::from_str(preferred_json).map_err(js_error)?;
    let print = anchor
        .as_ref()
        .zip(language.as_deref())
        .filter(|(anchor, _)| {
            anchor.oracle_id == entry.card.oracle_id
                && anchor.illustrations.len() == entry.card.faces.len()
        })
        .and_then(|(anchor, language)| choose_printing(anchor, &candidates, language, None));
    let (change, next) = plan_change(&entry, print, &preferred, true);
    let update = next.map(|entry| {
        serde_json::json!({
            "selectedArt": entry.selected_art,
            "selectedBack": entry.selected_back,
            "artPinned": entry.art_pinned,
            "requestedLanguages": entry.requested_languages,
        })
    });
    Ok(serde_json::json!({ "change": change, "update": update }).to_string())
}
