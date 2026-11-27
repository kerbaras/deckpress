use std::collections::BTreeMap;

use serde_json::Value;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::models::{Card, Deck, DeckEntry, ImportLine, PrintLanguagePreferences, ResolvedCards};

use super::scryfall_card::{
    fold_name, normalize_scryfall, scryfall_full_name_matches, scryfall_oracle_id,
    scryfall_print_number,
};
use super::search::{cards_in, exact_name_query, printing_queries};
use super::Providers;

pub(super) const SCRYFALL_LANGUAGES: &[&str] = &[
    "en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "he", "la", "grc", "ar",
    "sa", "ph", "qya", "tlh", "dw",
];

pub(super) struct ImportResolution<'a> {
    pub(super) line: &'a ImportLine,
    pub(super) original: Option<&'a Card>,
    pub(super) card: Option<Card>,
    pub(super) looked_up: Option<(String, String)>,
}

impl ImportResolution<'_> {
    fn search_clause(&self) -> Option<String> {
        if let Some(card) = self.original {
            uuid::Uuid::parse_str(&card.oracle_id).ok()?;
            return Some(format!("oracleid:{}", card.oracle_id));
        }
        let mut clause = exact_name_query(&self.line.name);
        if !self.line.set.is_empty() {
            if !self
                .line
                .set
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
            {
                return None;
            }
            clause.push_str(&format!(" set:{}", self.line.set));
        }
        Some(clause)
    }

    fn consider(&mut self, raw: &Value, language: &str) {
        let Some((set, collector)) = scryfall_print_number(raw) else {
            return;
        };
        if self.card.is_none()
            && raw["lang"] == language
            && self.original.map_or_else(
                || {
                    (self.line.set.is_empty() || self.line.set == set)
                        && scryfall_full_name_matches(raw, &fold_name(&self.line.name))
                },
                |card| scryfall_oracle_id(raw) == Some(&card.oracle_id),
            )
        {
            self.looked_up
                .get_or_insert_with(|| (set.to_owned(), collector.to_owned()));
            self.card = normalize_scryfall(raw).ok();
        }
    }
}

pub(crate) fn validate_language(language: &str) -> AppResult<()> {
    if SCRYFALL_LANGUAGES.contains(&language) {
        Ok(())
    } else {
        Err(AppError::user("Unsupported print language."))
    }
}

fn valid_languages(languages: &[String]) -> bool {
    !languages.is_empty()
        && languages.iter().enumerate().all(|(index, language)| {
            SCRYFALL_LANGUAGES.contains(&language.as_str())
                && !languages[..index].contains(language)
        })
}

impl Providers {
    pub fn print_language_preferences(&self) -> AppResult<PrintLanguagePreferences> {
        Ok(self
            .store
            .get("settings", "print-language")?
            .unwrap_or_default())
    }

    pub(crate) fn preferences_for_deck(&self, deck: &Deck) -> AppResult<PrintLanguagePreferences> {
        let mut preferences = self.print_language_preferences()?;
        if let Some(language) = &deck.print_language {
            preferences.languages = vec![language.clone()];
        }
        Ok(preferences)
    }

    pub fn save_print_language_preferences(
        &self,
        preferences: PrintLanguagePreferences,
    ) -> AppResult<PrintLanguagePreferences> {
        if !valid_languages(&preferences.languages) {
            return Err(AppError::user(
                "Choose at least one supported print language, without duplicates.",
            ));
        }
        self.store.put("settings", "print-language", &preferences)?;
        Ok(preferences)
    }

    pub async fn resolve_import(&self, lines: Vec<ImportLine>) -> AppResult<ResolvedCards> {
        self.resolve_with_languages(lines, &self.print_language_preferences()?)
            .await
    }

    pub async fn resolve_deck_import(
        &self,
        deck: &Deck,
        lines: Vec<ImportLine>,
    ) -> AppResult<ResolvedCards> {
        self.resolve_with_languages(lines, &self.preferences_for_deck(deck)?)
            .await
    }

    pub async fn related_deck_tokens(
        &self,
        deck: &Deck,
        card_ids: Vec<String>,
    ) -> AppResult<Vec<DeckEntry>> {
        let mut tokens = self.related_tokens(card_ids).await?;
        if let Some(language) = &deck.print_language {
            crate::language_deck::plan(
                self,
                &mut tokens,
                deck.art_policy.as_ref(),
                language,
                self.print_language_preferences()?.policy,
            )
            .await?;
        }
        Ok(tokens)
    }

    pub(super) async fn resolve_import_language(
        &self,
        resolutions: &mut [ImportResolution<'_>],
        language: &str,
        english_only: bool,
    ) -> AppResult<()> {
        let mut clauses = BTreeMap::<_, Vec<_>>::new();
        for (index, resolution) in resolutions.iter_mut().enumerate() {
            if resolution.card.is_some() || (english_only && resolution.original.is_none()) {
                continue;
            }
            if let Some(card) = resolution
                .original
                .filter(|card| card.faces[0].language == language)
            {
                resolution.card = Some(card.clone());
            } else if !resolution.line.set.is_empty()
                && !resolution.line.collector_number.is_empty()
            {
                let line = resolution.line;
                let mut url = Url::parse("https://api.scryfall.com/cards").expect("static URL");
                url.path_segments_mut().expect("static URL").extend([
                    line.set.as_str(),
                    line.collector_number.as_str(),
                    language,
                ]);
                let raw = self.scryfall_json(url.as_str()).await?;
                if scryfall_print_number(&raw)
                    == Some((line.set.as_str(), line.collector_number.as_str()))
                    && raw["lang"] == language
                    && resolution
                        .original
                        .is_none_or(|card| scryfall_oracle_id(&raw) == Some(&card.oracle_id))
                {
                    resolution
                        .looked_up
                        .get_or_insert_with(|| (line.set.clone(), line.collector_number.clone()));
                    resolution.card = normalize_scryfall(&raw).ok();
                }
            } else if let Some(clause) = resolution.search_clause() {
                clauses.entry(clause).or_default().push(index);
            }
        }
        let clauses: Vec<_> = clauses.into_iter().collect();
        let suffix = format!("game:paper lang:{language}");
        for (query, batch) in printing_queries(&clauses, &suffix, false) {
            let indices: Vec<_> = batch
                .iter()
                .flat_map(|(_, indices)| indices.iter().copied())
                .collect();
            self.visit_printing_pages(
                &query,
                |_| {},
                |response| {
                    for raw in cards_in(response) {
                        for &index in &indices {
                            resolutions[index].consider(raw, language);
                        }
                    }
                    indices
                        .iter()
                        .all(|&index| resolutions[index].card.is_some())
                },
            )
            .await?;
        }
        Ok(())
    }
}
