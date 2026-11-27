use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::{Art, ArtPage, Provider};

use super::Providers;

const MPC_PAGE: usize = 48;
const MPC_PROJECT_LIMIT: usize = 612;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MpcCard {
    name: String,
    download_link: String,
    medium_thumbnail_url: String,
    source: String,
    dpi: f64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    language: String,
    #[serde(default)]
    searchq: String,
    #[serde(default)]
    extension: String,
    #[serde(default)]
    card_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpcArtwork {
    pub art: Art,
    pub filename: String,
    pub query: String,
}

impl MpcCard {
    fn artwork(self, id: &str) -> MpcArtwork {
        let lower = self.name.to_lowercase();
        let mut tags = self.tags;
        if lower.contains("full art") {
            tags.push("full art".into());
        }
        if lower.contains("borderless") {
            tags.push("borderless".into());
        }
        let prefix = match self.card_type.as_str() {
            "TOKEN" => "t:",
            "CARDBACK" => "b:",
            _ => "",
        };
        let filename = if self.extension.is_empty() {
            self.name.clone()
        } else {
            format!("{}.{}", self.name, self.extension)
        };
        MpcArtwork {
            filename: filename.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"),
            query: format!(
                "{prefix}{}",
                if self.searchq.is_empty() {
                    &self.name
                } else {
                    &self.searchq
                }
            ),
            art: Art {
                id: format!("mpc:{id}"),
                provider: Provider::Mpc,
                name: self.name,
                image_url: self.download_link.clone(),
                thumbnail_url: self.medium_thumbnail_url,
                art_crop_url: String::new(),
                source_url: self.download_link,
                source: self.source,
                artist: "Uncredited".into(),
                set: String::new(),
                collector_number: String::new(),
                language: self.language.to_lowercase(),
                illustration_id: None,
                scan_quality: None,
                released_at: String::new(),
                tags,
                dpi: if self.dpi > 0.0 { self.dpi } else { 300.0 },
                bleed_mm: 3.048,
                back_image_url: String::new(),
                back_thumbnail_url: String::new(),
                english_fallback: false,
                filename: None,
                content_hash: None,
            },
        }
    }
}

impl Providers {
    async fn mpc_cards_batch(&self, ids: &[String]) -> AppResult<Vec<MpcArtwork>> {
        let response = self
            .json(
                "https://mpcfill.com/2/cards/",
                Some(serde_json::json!({ "cardIdentifiers": ids })),
            )
            .await?;
        Ok(ids
            .iter()
            .filter_map(|id| {
                let raw = response.get("results")?.get(id)?;
                let card: MpcCard = serde_json::from_value(raw.clone()).ok()?;
                Some(card.artwork(id))
            })
            .collect())
    }

    pub async fn mpc_artwork(&self, ids: Vec<String>) -> AppResult<Vec<MpcArtwork>> {
        if ids.len() > MPC_PROJECT_LIMIT * 2
            || ids.iter().any(|id| {
                id.is_empty()
                    || id.len() > 120
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        {
            return Err(AppError::user("Invalid MPC Autofill artwork IDs"));
        }
        let ids: Vec<_> = ids
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut artwork = Vec::new();
        for batch in ids.chunks(MPC_PAGE) {
            artwork.extend(self.mpc_cards_batch(batch).await?);
        }
        for item in &artwork {
            crate::images::validate_image_url(&item.art.image_url)?;
            crate::images::validate_image_url(&item.art.thumbnail_url)?;
        }
        Ok(artwork)
    }

    pub async fn community(&self, name: &str, page: u32) -> AppResult<ArtPage> {
        #[derive(Deserialize)]
        struct Source {
            pk: u64,
        }
        let sources = self.json("https://mpcfill.com/2/sources/", None).await?;
        let pks: Vec<Value> = sources
            .get("results")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|map| map.values())
            .filter_map(|value| serde_json::from_value::<Source>(value.clone()).ok())
            .map(|source| serde_json::json!([source.pk, true]))
            .collect();
        let query = name.to_lowercase().trim().to_string();
        let search = self
            .json(
                "https://mpcfill.com/2/editorSearch/",
                Some(serde_json::json!({
                    "searchSettings": {
                        "searchTypeSettings": { "fuzzySearch": false, "filterCardbacks": false },
                        "sourceSettings": { "sources": pks },
                        "filterSettings": {
                            "minimumDPI": 0, "maximumDPI": 1500, "maximumSize": 30,
                            "languages": [], "includesTags": [], "excludesTags": ["NSFW"]
                        }
                    },
                    "queries": [{ "query": query, "cardType": "CARD" }]
                })),
            )
            .await?;
        let ids: Vec<String> = search
            .pointer(&format!(
                "/results/{}/CARD",
                query.replace('~', "~0").replace('/', "~1")
            ))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let page = page.max(1);
        let start = ((page as usize) - 1) * MPC_PAGE;
        let batch: Vec<String> = ids.iter().skip(start).take(MPC_PAGE).cloned().collect();
        let total = ids.len() as u64;
        if batch.is_empty() {
            return Ok(ArtPage {
                items: vec![],
                page,
                has_more: false,
                total,
            });
        }
        let items = self
            .mpc_cards_batch(&batch)
            .await?
            .into_iter()
            .map(|item| item.art)
            .collect();
        Ok(ArtPage {
            items,
            page,
            has_more: (page as usize) * MPC_PAGE < ids.len(),
            total,
        })
    }
}
