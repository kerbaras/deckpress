use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use serde_json::Value;
use url::Url;

use crate::art_policy::Printing;
use crate::error::{AppError, AppResult};

use super::localization::validate_language;
use super::scryfall_card::{normalize_scryfall, scryfall_oracle_id};
use super::search::{cards_in, printing_queries};
use super::Providers;

pub(crate) enum PrintingLookupProgress {
    Cards { done: usize, total: usize },
    RateLimited(Duration),
}

#[derive(Clone, Copy)]
pub(crate) enum PrintingInventoryScope<'a> {
    All,
    Exact(&'a str),
    Family(&'a [String]),
}

fn policy_printing(raw: &Value) -> Option<Printing> {
    let string = |key: &str| raw[key].as_str().unwrap_or_default().to_owned();
    let flag = |key: &str| raw[key].as_bool().unwrap_or(false);
    let illustration = |face: &Value| uuid::Uuid::parse_str(face["illustration_id"].as_str()?).ok();
    let illustrations: Vec<_> = if raw["image_uris"].is_object() || !raw["card_faces"].is_array() {
        vec![illustration(raw)]
    } else {
        raw["card_faces"]
            .as_array()?
            .iter()
            .map(illustration)
            .collect()
    };
    let scans = normalize_scryfall(raw)
        .ok()
        .map(|card| card.faces)
        .filter(|faces| faces.len() == illustrations.len());
    Some(Printing {
        id: raw["id"].as_str()?.into(),
        oracle_id: scryfall_oracle_id(raw)?.into(),
        set: string("set"),
        collector: string("collector_number"),
        date: string("released_at"),
        language: string("lang"),
        frame: string("frame"),
        border: string("border_color"),
        full_art: flag("full_art"),
        showcase: raw["frame_effects"]
            .as_array()
            .is_some_and(|effects| effects.iter().any(|effect| effect == "showcase")),
        treatments: raw["frame_effects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|effect| *effect != "showcase")
            .chain(flag("textless").then_some("textless"))
            .map(str::to_owned)
            .collect(),
        paper: !flag("digital")
            && raw["games"]
                .as_array()
                .is_some_and(|games| games.iter().any(|game| game == "paper")),
        promo: flag("promo"),
        illustrations,
        scans,
    })
}

impl Providers {
    pub(crate) async fn policy_printing(&self, art_id: &str) -> AppResult<Option<Printing>> {
        let Some(id) = crate::language_deck::scryfall_art_id(art_id) else {
            return Ok(None);
        };
        let raw = self
            .scryfall_json(&format!("https://api.scryfall.com/cards/{id}"))
            .await?;
        Ok(policy_printing(&raw).filter(|print| print.id == id.to_string()))
    }

    pub(crate) async fn language_anchors(
        &self,
        ids: BTreeSet<uuid::Uuid>,
    ) -> AppResult<HashMap<String, Printing>> {
        Ok(self
            .collection_by_id(ids)
            .await?
            .iter()
            .filter_map(policy_printing)
            .map(|print| (print.id.clone(), print))
            .collect())
    }

    pub(crate) async fn language_printings(
        &self,
        oracle_ids: BTreeSet<&str>,
        language: &str,
    ) -> AppResult<HashMap<String, Vec<Printing>>> {
        self.printing_inventory(
            oracle_ids,
            Some(language),
            PrintingInventoryScope::All,
            |_| {},
        )
        .await
    }

    pub(crate) async fn printing_inventory(
        &self,
        mut oracle_ids: BTreeSet<&str>,
        language: Option<&str>,
        scope: PrintingInventoryScope<'_>,
        progress: impl Fn(PrintingLookupProgress),
    ) -> AppResult<HashMap<String, Vec<Printing>>> {
        if let Some(language) = language {
            validate_language(language)?;
        }
        let broad_key = |oracle| match language {
            Some(language) => format!("language-printings:{language}:{oracle}"),
            None => format!("policy-printings:{oracle}"),
        };
        let family_filter = match scope {
            PrintingInventoryScope::Family(sets) => {
                let clauses: Vec<_> = sets.iter().map(|set| format!("set:{set}")).collect();
                Some(format!("({})", clauses.join(" or ")))
            }
            _ => None,
        };
        let family_index =
            |set: &str, oracle| format!("family-printing-index:{set}:{}", broad_key(oracle));
        let cache_key = |oracle| match (&family_filter, scope) {
            (Some(filter), _) => format!("family-printings:{filter}:{}", broad_key(oracle)),
            (_, PrintingInventoryScope::Exact(set)) => {
                format!("exact-printings:{set}:{}", broad_key(oracle))
            }
            _ => broad_key(oracle),
        };
        let mut inventory = HashMap::new();
        let mut missing = Vec::new();
        oracle_ids.retain(|oracle| uuid::Uuid::parse_str(oracle).is_ok());
        let total = oracle_ids.len();
        for oracle in oracle_ids {
            let mut cached = match scope {
                PrintingInventoryScope::Exact(_) => self.store.cached(&broad_key(oracle))?,
                _ => self.store.cached(&cache_key(oracle))?,
            };
            if cached.is_none() {
                match scope {
                    PrintingInventoryScope::All => {}
                    PrintingInventoryScope::Family(_) => {
                        cached = self.store.cached(&broad_key(oracle))?
                    }
                    PrintingInventoryScope::Exact(set) => {
                        if let Some(Value::String(key)) =
                            self.store.cached(&family_index(set, oracle))?
                        {
                            cached = self.store.cached(&key)?;
                        }
                        if cached.is_none() {
                            cached = self.store.cached(&cache_key(oracle))?;
                        }
                    }
                }
            }
            match cached {
                Some(Value::Array(cards)) => {
                    inventory.insert(
                        oracle.to_owned(),
                        cards.iter().filter_map(policy_printing).collect(),
                    );
                }
                _ => missing.push((format!("oracleid:{oracle}"), oracle)),
            }
        }
        if total > 0 {
            progress(PrintingLookupProgress::Cards {
                done: inventory.len(),
                total,
            });
        }
        let mut suffix = language.map_or_else(
            || "game:paper".into(),
            |lang| format!("lang:{lang} game:paper"),
        );
        if let Some(filter) = &family_filter {
            suffix.push(' ');
            suffix.push_str(filter);
        }
        if let PrintingInventoryScope::Exact(set) = scope {
            suffix.push_str(" set:");
            suffix.push_str(set);
        }
        for (query, batch) in printing_queries(&missing, &suffix, language.is_some()) {
            let mut found: HashMap<_, Vec<Value>> = batch
                .iter()
                .map(|(_, oracle)| (*oracle, Vec::new()))
                .collect();
            let complete = self
                .visit_printing_pages(
                    &query,
                    |delay| {
                        progress(PrintingLookupProgress::RateLimited(delay));
                    },
                    |response| {
                        for raw in cards_in(response) {
                            if let Some(bucket) = scryfall_oracle_id(raw)
                                .and_then(|oracle| found.get_mut(oracle))
                                .filter(|_| language.is_none_or(|language| raw["lang"] == language))
                                .filter(|_| match scope {
                                    PrintingInventoryScope::Exact(set) => raw["set"] == set,
                                    _ => true,
                                })
                            {
                                bucket.push(raw.clone());
                            }
                        }
                        false
                    },
                )
                .await?;
            if !complete {
                return Err(AppError::user(
                    "Scryfall has too many printings for this deck.",
                ));
            }
            for (oracle, cards) in found {
                let key = cache_key(oracle);
                self.store.put("cache", &key, &cards)?;
                if let PrintingInventoryScope::Family(sets) = scope {
                    for set in sets {
                        self.store.put("cache", &family_index(set, oracle), &key)?;
                    }
                }
                inventory.insert(
                    oracle.to_owned(),
                    cards.iter().filter_map(policy_printing).collect(),
                );
            }
            progress(PrintingLookupProgress::Cards {
                done: inventory.len(),
                total,
            });
        }
        Ok(inventory)
    }

    pub(crate) async fn policy_exact(
        &self,
        anchor: &Printing,
        language: &str,
    ) -> AppResult<Option<Printing>> {
        let mut url = Url::parse("https://api.scryfall.com/cards").expect("static URL");
        url.path_segments_mut().expect("static URL").extend([
            &anchor.set,
            &anchor.collector,
            language,
        ]);
        let raw = self.scryfall_json(url.as_str()).await?;
        Ok(policy_printing(&raw)
            .filter(|print| print.set == anchor.set && print.collector == anchor.collector))
    }
}
