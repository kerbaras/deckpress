//! Compares what the deck builder fills in against the most-viewed public
//! Archidekt decks for the same commander / format. The builder itself samples
//! the top [`META_DECKS`] decks for its play-rate signal, so the comparison is
//! reported twice: against those decks (in-sample) and against the next
//! [`TOP_K`] most-viewed decks it never saw (hold-out). Needs the network, so
//! it is ignored by default:
//!
//! ```sh
//! cargo test -p deckpress-core --test builder_meta -- --ignored --nocapture
//! ```

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use deckpress_core::builder::{Builder, BuilderSpec, META_DECKS};
use deckpress_core::decksearch::{DeckQuery, DeckSearch, DeckSource, SearchField};
use deckpress_core::models::{Card, DeckEntry, Zone};
use deckpress_core::providers::Providers;
use deckpress_core::store::Store;

const TOP_K: usize = 10;

struct Harness {
    builder: Builder,
    search: Arc<DeckSearch>,
}

fn harness() -> (tempfile::TempDir, Harness) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("deckpress.sqlite")).unwrap());
    let providers = Arc::new(Providers::new(Arc::clone(&store)).unwrap());
    let search = Arc::new(DeckSearch::new(store, Arc::clone(&providers)).unwrap());
    let builder = Builder::with_deck_search(providers, Arc::clone(&search));
    (dir, Harness { builder, search })
}

fn is_land(card: &Card) -> bool {
    card.type_line.contains("Land")
}

fn spells(entries: &[DeckEntry]) -> HashSet<String> {
    entries
        .iter()
        .filter(|entry| !entry.excluded && entry.zone != Zone::Commander && !is_land(&entry.card))
        .map(|entry| entry.card.name.clone())
        .collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    let union = a.union(b).count();
    if union == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f64 / union as f64
}

async fn meta_decks(
    harness: &Harness,
    text: &str,
    field: SearchField,
    format: &str,
    colors: &[&str],
) -> Vec<(String, HashSet<String>)> {
    let wanted = META_DECKS + TOP_K;
    let mut decks = Vec::new();
    let mut page = 1;
    while decks.len() < wanted && page <= 5 {
        let result = harness
            .search
            .search(
                DeckQuery {
                    text: text.into(),
                    field,
                    format: format.into(),
                    source: Some(DeckSource::Archidekt),
                },
                page,
            )
            .await
            .unwrap();
        for item in &result.items {
            if decks.len() >= wanted {
                break;
            }
            let fits = colors.is_empty()
                || item
                    .color_identity
                    .iter()
                    .all(|color| colors.contains(&color.as_str()));
            if !fits || item.card_count < 40 {
                continue;
            }
            let resolved = harness
                .search
                .import(DeckSource::Archidekt, &item.id)
                .await
                .unwrap();
            let names = spells(&resolved.entries);
            if names.len() >= 15 {
                decks.push((format!("{} ({} views)", item.name, item.views), names));
            }
        }
        if !result.has_more {
            break;
        }
        page += 1;
    }
    decks
}

async fn report(
    harness: &Harness,
    label: &str,
    spec: BuilderSpec,
    seed: Vec<DeckEntry>,
    mut meta: Vec<(String, HashSet<String>)>,
) {
    assert!(
        meta.len() > META_DECKS + 2,
        "{label}: only {} reference decks",
        meta.len()
    );
    let mut built = seed.clone();
    built.extend(harness.builder.fill(&spec, &seed).await.unwrap());
    let ours = spells(&built);
    println!("\n== {label} ==");
    println!(
        "builder deck: {} cards, {} non-land spells",
        built.iter().map(|entry| entry.quantity).sum::<u32>(),
        ours.len()
    );
    let holdout = meta.split_off(META_DECKS);
    compare("in-sample (the decks the builder sampled)", &ours, &meta);
    compare("hold-out (next most-viewed decks)", &ours, &holdout);
}

fn compare(label: &str, ours: &HashSet<String>, meta: &[(String, HashSet<String>)]) {
    let mut frequency: BTreeMap<&str, usize> = BTreeMap::new();
    for (_, names) in meta {
        for name in names {
            *frequency.entry(name.as_str()).or_default() += 1;
        }
    }
    let consensus: Vec<&str> = frequency
        .iter()
        .filter(|(_, count)| **count * 2 >= meta.len())
        .map(|(name, _)| *name)
        .collect();
    let in_any = ours
        .iter()
        .filter(|name| frequency.contains_key(name.as_str()))
        .count();
    let in_three = ours
        .iter()
        .filter(|name| frequency.get(name.as_str()).copied().unwrap_or(0) >= 3)
        .count();
    let consensus_hit = consensus
        .iter()
        .filter(|name| ours.contains(**name))
        .count();
    let ours_vs_meta: f64 = meta
        .iter()
        .map(|(_, names)| jaccard(ours, names))
        .sum::<f64>()
        / meta.len() as f64;
    let mut pairs: f64 = 0.0;
    let mut pair_sum = 0.0;
    for (i, (_, a)) in meta.iter().enumerate() {
        for (_, b) in meta.iter().skip(i + 1) {
            pair_sum += jaccard(a, b);
            pairs += 1.0;
        }
    }
    let meta_vs_meta = pair_sum / pairs.max(1.0);

    println!("-- {label}: {} reference decks", meta.len());
    for (name, _) in meta {
        println!("  - {name}");
    }
    println!(
        "builder spells seen in >=1 reference deck: {in_any}/{} ({:.0}%)",
        ours.len(),
        100.0 * in_any as f64 / ours.len().max(1) as f64
    );
    println!(
        "builder spells seen in >=3 reference decks: {in_three}/{} ({:.0}%)",
        ours.len(),
        100.0 * in_three as f64 / ours.len().max(1) as f64
    );
    println!(
        "consensus cards (in >=50% of reference decks) found by builder: {consensus_hit}/{} ({:.0}%)",
        consensus.len(),
        100.0 * consensus_hit as f64 / consensus.len().max(1) as f64
    );
    println!(
        "mean Jaccard builder vs reference: {ours_vs_meta:.3}; reference vs reference: {meta_vs_meta:.3}"
    );
    let missed: Vec<&str> = consensus
        .iter()
        .filter(|name| !ours.contains(**name))
        .copied()
        .collect();
    println!("consensus cards missed: {}", missed.join(", "));
    let mut unseen: Vec<&String> = ours
        .iter()
        .filter(|name| !frequency.contains_key(name.as_str()))
        .collect();
    unseen.sort();
    println!(
        "builder spells in no reference deck: {}",
        unseen
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
}

#[tokio::test]
#[ignore = "talks to Scryfall and Archidekt"]
async fn atraxa_counters_midrange_resembles_popular_atraxa_lists() {
    let (_dir, harness) = harness();
    let commander = harness
        .builder
        .commanders("Atraxa, Praetors' Voice", &[])
        .await
        .unwrap()
        .into_iter()
        .find(|suggestion| suggestion.card.name == "Atraxa, Praetors' Voice")
        .expect("Atraxa on Scryfall")
        .card;
    let spec = BuilderSpec {
        format: "commander".into(),
        set: String::new(),
        colors: Vec::new(),
        commander: Some(commander.clone()),
        style: "midrange".into(),
        theme: "counters".into(),
        tribe: String::new(),
    };
    let seed = vec![DeckEntry {
        id: "cmd".into(),
        card: commander,
        quantity: 1,
        zone: Zone::Commander,
        selected_art: None,
        selected_back: None,
        excluded: false,
    }];
    let meta = meta_decks(
        &harness,
        "Atraxa, Praetors' Voice",
        SearchField::Commander,
        "Commander",
        &[],
    )
    .await;
    report(
        &harness,
        "Commander · Atraxa · counters · midrange",
        spec,
        seed,
        meta,
    )
    .await;
}

#[tokio::test]
#[ignore = "talks to Scryfall and Archidekt"]
async fn mono_red_standard_aggro_resembles_popular_lists() {
    let (_dir, harness) = harness();
    let spec = BuilderSpec {
        format: "standard".into(),
        set: String::new(),
        colors: vec!["R".into()],
        commander: None,
        style: "aggro".into(),
        theme: "none".into(),
        tribe: String::new(),
    };
    let meta = meta_decks(&harness, "Aggro", SearchField::Name, "Standard", &["R"]).await;
    report(
        &harness,
        "Standard · mono red · aggro",
        spec,
        Vec::new(),
        meta,
    )
    .await;
}
