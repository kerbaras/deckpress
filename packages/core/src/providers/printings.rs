use serde::Deserialize;
use serde_json::Value;

use crate::art_policy::policy_can_change;
use crate::art_quality::{prefer_high_res, ScanQuality};
use crate::error::{AppError, AppResult};
use crate::models::{Art, ArtPage, DeckEntry, Provider};
use crate::set_family::{coverage, SetCoverage, SetInfo};

use super::inventory::PrintingInventoryScope;
use super::localization::SCRYFALL_LANGUAGES;
use super::scryfall_card::normalize_scryfall;
use super::search::{cards_in, has_more, print_search};
use super::Providers;

impl Providers {
    pub async fn sets(&self) -> AppResult<Vec<SetInfo>> {
        #[derive(Deserialize)]
        struct SetList {
            data: Vec<SetInfo>,
        }

        let raw = self.scryfall_json("https://api.scryfall.com/sets").await?;
        Ok(serde_json::from_value::<SetList>(raw)?.data)
    }

    pub async fn set_coverage(&self, entries: &[DeckEntry]) -> AppResult<Vec<SetCoverage>> {
        if !entries.iter().any(policy_can_change) {
            return Ok(Vec::new());
        }
        let sets = self.sets().await?;
        let inventory = self
            .printing_inventory(
                entries
                    .iter()
                    .filter(|entry| policy_can_change(entry))
                    .map(|entry| entry.card.oracle_id.as_str())
                    .collect(),
                None,
                PrintingInventoryScope::All,
                |_| {},
            )
            .await?;
        let mut entry_sets = Vec::new();
        for entry in entries {
            if !policy_can_change(entry) {
                entry_sets.push((entry.quantity, Vec::new()));
                continue;
            }
            let codes = inventory
                .get(&entry.card.oracle_id)
                .into_iter()
                .flatten()
                .filter(|print| {
                    print.paper
                        && !print.promo
                        && print.illustrations.len() == entry.card.faces.len()
                })
                .map(|print| print.set.clone())
                .collect();
            entry_sets.push((entry.quantity, codes));
        }
        Ok(coverage(&entry_sets, &sets))
    }

    pub async fn prints(
        &self,
        oracle_id: &str,
        page: u32,
        face: usize,
        language: Option<&str>,
    ) -> AppResult<ArtPage> {
        if language.is_some_and(|lang| !SCRYFALL_LANGUAGES.contains(&lang)) {
            return Err(AppError::user("Unsupported print language."));
        }
        if uuid::Uuid::parse_str(oracle_id).is_err() {
            return Ok(ArtPage {
                items: Vec::new(),
                page,
                has_more: false,
                total: 0,
            });
        }
        let mut query = format!("oracleid:{oracle_id} game:paper");
        if let Some(language) = language {
            query.push_str(&format!(" lang:{language}"));
        }
        let url = print_search(&query, page);
        let response = self.scryfall_json(url.as_str()).await?;
        let items = cards_in(&response)
            .filter_map(|raw| normalize_scryfall(raw).ok())
            .filter(|card| card.oracle_id == oracle_id)
            .filter_map(|card| card.faces.get(face).cloned())
            .filter(|art| language.is_none_or(|language| language == art.language))
            .collect();
        Ok(ArtPage {
            items,
            page,
            has_more: has_more(&response),
            total: response
                .get("total_cards")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }

    pub async fn better_scan(
        &self,
        selected: Art,
        oracle_id: uuid::Uuid,
        face: usize,
    ) -> AppResult<Art> {
        if selected.provider != Provider::Scryfall
            || selected.scan_quality == Some(ScanQuality::HighresScan)
        {
            return Ok(selected);
        }
        let Some(print_id) = selected
            .id
            .split(':')
            .nth(1)
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
        else {
            return Ok(selected);
        };
        let mut base = selected;
        if base.illustration_id.is_none() {
            let raw = self
                .json(&format!("https://api.scryfall.com/cards/{print_id}"), None)
                .await?;
            let card = normalize_scryfall(&raw)?;
            let Some(art) = card.faces.into_iter().nth(face) else {
                return Ok(base);
            };
            if art.language != base.language || art.image_url != base.image_url {
                return Ok(base);
            }
            base = art;
        }
        let Some(illustration) = base.illustration_id else {
            return Ok(base);
        };
        if base.scan_quality == Some(ScanQuality::HighresScan)
            || !SCRYFALL_LANGUAGES.contains(&base.language.as_str())
        {
            return Ok(base);
        }
        let query = format!(
            "oracleid:{oracle_id} illustration_id:{illustration} game:paper lang:{}",
            base.language
        );
        for page in 1u32.. {
            let url = print_search(&query, page);
            let response = self.scryfall_json(url.as_str()).await?;
            let candidates: Vec<_> = cards_in(&response)
                .filter_map(|raw| normalize_scryfall(raw).ok())
                .filter_map(|card| card.faces.into_iter().nth(face))
                .collect();
            base = prefer_high_res(&base, &candidates).clone();
            if base.scan_quality == Some(ScanQuality::HighresScan) || !has_more(&response) {
                break;
            }
        }
        Ok(base)
    }
}
