use std::collections::HashMap;

use deckpress_core::builder::{
    base_query, basic_split, classify_role, commander_profile, format_rules, is_land, land_target,
    meta_pool_threshold, meta_queries, pips, plan_fill, pool_card, popularity, rank, score,
    search_url, style_rules, summarize, theme_rules, BuilderSpec, Context, PoolCard, StyleRules,
    ThemeRules, META_DECKS,
};
use deckpress_core::decksearch::{DeckSource, MetaSample};
use deckpress_core::models::{new_id, DeckEntry, ImportLine, Zone};
use serde_json::Value;
const FIXTURE: &str = include_str!("fixtures/builder-pool.json");

fn fixture_pool() -> Vec<PoolCard> {
    let values: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    let len = values.len();
    values
        .iter()
        .enumerate()
        .map(|(rank, value)| pool_card(value, rank, len).unwrap())
        .collect()
}

fn find<'a>(pool: &'a [PoolCard], name: &str) -> &'a PoolCard {
    pool.iter().find(|card| card.card.name == name).unwrap()
}

fn atraxa_context<'a>(theme: &'a ThemeRules, style: &'a StyleRules) -> Context<'a> {
    let pool = fixture_pool();
    let atraxa = find(&pool, "Atraxa, Praetors' Voice");
    Context {
        rules: format_rules("commander").unwrap(),
        style,
        theme,
        tribe: String::new(),
        colors: vec!["W".into(), "U".into(), "B".into(), "G".into()],
        commander: Some(commander_profile(
            &atraxa.card.name,
            &atraxa.oracle_text,
            &atraxa.card.type_line,
        )),
        meta: None,
    }
}

fn entry(pool: &PoolCard, quantity: u32, zone: Zone) -> DeckEntry {
    DeckEntry {
        id: new_id(),
        card: pool.card.clone(),
        quantity,
        zone,
        selected_art: None,
        selected_back: None,
        excluded: false,
    }
}

#[test]
fn fixture_normalizes_without_network() {
    let pool = fixture_pool();
    assert_eq!(pool.len(), 12);
    let atraxa = find(&pool, "Atraxa, Praetors' Voice");
    assert_eq!(atraxa.card.colors, vec!["B", "G", "U", "W"]);
    assert!(atraxa.oracle_text.contains("proliferate"));
    assert_eq!(atraxa.edhrec_rank, Some(30));
    assert_eq!(atraxa.card.faces[0].artist, "Victor Adame Minguez");
    let mdfc = find(&pool, "Bala Ged Recovery // Bala Ged Sanctuary");
    assert!(mdfc.oracle_text.contains("//"));
    assert_eq!(mdfc.card.faces.len(), 2);
}

#[test]
fn commander_profile_reads_themes_from_oracle_text() {
    let pool = fixture_pool();
    let atraxa = find(&pool, "Atraxa, Praetors' Voice");
    let profile = commander_profile(
        &atraxa.card.name,
        &atraxa.oracle_text,
        &atraxa.card.type_line,
    );
    let ids: Vec<&str> = profile.themes.iter().map(|theme| theme.id).collect();
    assert!(ids.contains(&"counters"), "{ids:?}");
}

#[test]
fn counters_theme_ranks_proliferate_cards_first() {
    let pool = fixture_pool();
    let ctx = atraxa_context(
        theme_rules("counters").unwrap(),
        style_rules("midrange").unwrap(),
    );
    let ranked = rank(&pool, &ctx);
    let names: Vec<&str> = ranked.iter().map(|item| item.card.name.as_str()).collect();
    let position = |name: &str| names.iter().position(|item| *item == name).unwrap();
    assert!(
        position("Contagion Engine") < position("Sol Ring"),
        "{names:?}"
    );
    assert!(
        position("Evolution Sage") < position("Swords to Plowshares"),
        "{names:?}"
    );
    assert!(
        position("Doubling Season") < position("Rhystic Study"),
        "{names:?}"
    );
    let engine = &ranked[position("Contagion Engine")];
    assert!(
        engine
            .reasons
            .iter()
            .any(|reason| reason.contains("proliferate")),
        "{:?}",
        engine.reasons
    );
    assert!(engine
        .reasons
        .iter()
        .any(|reason| reason.contains("Atraxa, Praetors' Voice also cares")));
    assert!(
        engine.score > 0.4 && engine.score <= 1.0,
        "{}",
        engine.score
    );
    for item in &ranked {
        assert!(
            (0.0..=1.0).contains(&item.score),
            "{} {}",
            item.card.name,
            item.score
        );
        assert!(
            !item.reasons.is_empty(),
            "{} has no reasons",
            item.card.name
        );
    }
}

#[test]
fn typal_theme_matches_type_line_and_oracle_text() {
    let pool = fixture_pool();
    let theme = theme_rules("typal").unwrap();
    let ctx = Context {
        rules: format_rules("modern").unwrap(),
        style: style_rules("aggro").unwrap(),
        theme,
        tribe: "Elf".into(),
        colors: vec!["G".into()],
        commander: None,
        meta: None,
    };
    let sage = score(find(&pool, "Evolution Sage"), &ctx);
    assert_eq!(sage.role, "threat");
    assert!(
        sage.reasons.iter().any(|reason| reason == "Is an Elf"),
        "{:?}",
        sage.reasons
    );
    let bolt = score(find(&pool, "Lightning Bolt"), &ctx);
    assert_eq!(bolt.reasons, vec!["Outside your colour identity"]);
    assert_eq!(bolt.score, 0.0);
}

#[test]
fn roles_are_classified_from_text() {
    assert_eq!(
        classify_role("Artifact", "{T}: Add {C}{C}.", 1.0, false),
        "ramp"
    );
    assert_eq!(
        classify_role("Instant", "Exile target creature.", 1.0, false),
        "removal"
    );
    assert_eq!(
        classify_role("Instant", "Counter target spell.", 2.0, false),
        "interaction"
    );
    assert_eq!(
        classify_role(
            "Enchantment",
            "Whenever an opponent casts a spell, you may draw a card.",
            3.0,
            false
        ),
        "draw"
    );
    assert_eq!(
        classify_role("Legendary Creature — Angel", "Flying", 6.0, false),
        "wincon"
    );
    assert_eq!(
        classify_role("Creature — Elf Druid", "Landfall", 2.0, false),
        "threat"
    );
    assert_eq!(
        classify_role(
            "Enchantment",
            "If an effect would create tokens, it creates twice that many.",
            5.0,
            true
        ),
        "synergy"
    );
    assert_eq!(classify_role("Land", "", 0.0, false), "land");
    assert_eq!(
        classify_role(
            "Sorcery",
            "Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.",
            2.0,
            false
        ),
        "ramp"
    );
    assert_eq!(
        classify_role(
            "Instant",
            "Return target nonland permanent you don't control to its owner's hand.",
            2.0,
            false
        ),
        "removal"
    );
}

fn main_line(name: &str, quantity: u32) -> ImportLine {
    ImportLine {
        quantity,
        name: name.into(),
        zone: Zone::Main,
        set: String::new(),
        collector_number: String::new(),
    }
}

/// A 20-card main deck of `names` plus filler unique to `tag`.
fn sample_deck(tag: &str, names: &[&str]) -> Vec<ImportLine> {
    let mut lines: Vec<ImportLine> = names.iter().map(|name| main_line(name, 1)).collect();
    for index in lines.len()..20 {
        lines.push(main_line(&format!("{tag} filler {index}"), 1));
    }
    lines
}

#[test]
fn meta_sample_counts_decks_not_copies() {
    let mut meta = MetaSample::new(DeckSource::Archidekt, "Commander Atraxa decks");
    assert!(meta.add_deck(&sample_deck("a", &["Sol Ring", "Doubling Season"])));
    let mut second = sample_deck("b", &["Doubling Season"]);
    second.push(main_line("Sol Ring", 3));
    second.push(ImportLine {
        zone: Zone::Side,
        ..main_line("Rhystic Study", 1)
    });
    second.push(main_line("Ignored", 0));
    assert!(meta.add_deck(&second));
    // Too small to be a real deck.
    assert!(!meta.add_deck(&[main_line("Sol Ring", 1)]));
    assert_eq!(meta.decks, 2);
    assert_eq!(meta.frequency("Sol Ring"), 2);
    assert_eq!(meta.frequency("sol ring"), 2);
    assert_eq!(meta.frequency("Doubling Season"), 2);
    assert_eq!(meta.frequency("Rhystic Study"), 0);
    assert_eq!(meta.frequency("Ignored"), 0);
    assert_eq!(
        meta.common(2),
        vec![("Doubling Season", 2), ("Sol Ring", 2)]
    );
    assert_eq!(meta.common(3), Vec::<(&str, u32)>::new());
}

#[test]
fn meta_sample_matches_double_faced_cards_by_front_face() {
    let mut meta = MetaSample::new(DeckSource::Archidekt, "decks");
    assert!(meta.add_deck(&sample_deck("a", &["Bala Ged Recovery"])));
    assert_eq!(meta.frequency("Bala Ged Recovery // Bala Ged Sanctuary"), 1);
    assert_eq!(meta.frequency("Bala Ged Sanctuary"), 0);
    let json = serde_json::to_value(&meta).unwrap();
    assert_eq!(json["source"], "archidekt");
    assert_eq!(json["decks"], 1);
    assert!(json.get("counts").is_none());
}

#[test]
fn play_rate_lifts_staples_with_an_attributed_reason() {
    let pool = fixture_pool();
    let theme = theme_rules("counters").unwrap();
    let style = style_rules("midrange").unwrap();
    let without = atraxa_context(theme, style);
    let sol_ring = find(&pool, "Sol Ring");
    let baseline = score(sol_ring, &without);
    let mut meta = MetaSample::new(DeckSource::Archidekt, "Commander Atraxa decks");
    for index in 0..META_DECKS {
        assert!(meta.add_deck(&sample_deck(&index.to_string(), &["Sol Ring"])));
    }
    let with = Context {
        meta: Some(meta),
        ..atraxa_context(theme, style)
    };
    let boosted = score(sol_ring, &with);
    assert_eq!(boosted.meta_decks, 10);
    assert_eq!(baseline.meta_decks, 0);
    assert!(
        boosted.score > baseline.score,
        "{} vs {}",
        boosted.score,
        baseline.score
    );
    assert!(
        boosted
            .reasons
            .iter()
            .any(|reason| reason == "In 10 of the 10 most-viewed Archidekt Commander Atraxa decks"),
        "{:?}",
        boosted.reasons
    );
    let unseen = score(find(&pool, "Rhystic Study"), &with);
    assert_eq!(unseen.meta_decks, 0);
    assert!(!unseen
        .reasons
        .iter()
        .any(|reason| reason.contains("Archidekt")));
    // Normalising against the extra weight keeps unseen cards below their
    // no-sample score; nothing exceeds 1.0.
    assert!(unseen.score <= score(find(&pool, "Rhystic Study"), &without).score);
    assert!((0.0..=1.0).contains(&boosted.score));
}

#[test]
fn popularity_uses_edhrec_rank_on_a_log_scale() {
    let pool = fixture_pool();
    let sol_ring = find(&pool, "Sol Ring");
    assert_eq!(sol_ring.edhrec_rank, Some(1));
    assert!((popularity(sol_ring) - 1.0).abs() < 1e-9);
    let atraxa = find(&pool, "Atraxa, Praetors' Voice");
    let atraxa_pop = popularity(atraxa);
    assert!(atraxa_pop > 0.6 && atraxa_pop < 0.7, "{atraxa_pop}");
    assert!(popularity(sol_ring) > atraxa_pop);
}

#[test]
fn meta_pool_queries_batch_exact_names_within_the_base_query() {
    assert_eq!(meta_pool_threshold(10), 3);
    assert_eq!(meta_pool_threshold(1), 1);
    assert_eq!(meta_pool_threshold(0), 1);
    let names: Vec<String> = (0..13).map(|index| format!("Card {index}")).collect();
    let mut refs: Vec<&str> = names.iter().map(String::as_str).collect();
    refs[0] = "Ajani, \"Sleeper\" Agent";
    let queries = meta_queries("format:commander id<=WUBG", &refs);
    assert_eq!(queries.len(), 2);
    assert!(queries[0]
        .starts_with("format:commander id<=WUBG (!\"Ajani, Sleeper Agent\" or !\"Card 1\""));
    assert_eq!(queries[1], "format:commander id<=WUBG (!\"Card 12\")");
    assert!(meta_queries("base", &[]).is_empty());
}

#[test]
fn aggro_curve_prefers_cheap_cards_and_fewer_lands() {
    let pool = fixture_pool();
    let rules = format_rules("standard").unwrap();
    let aggro = style_rules("aggro").unwrap();
    let control = style_rules("control").unwrap();
    assert_eq!(land_target(rules, aggro), 21);
    assert_eq!(land_target(rules, control), 26);
    let ctx = Context {
        rules,
        style: aggro,
        theme: theme_rules("none").unwrap(),
        tribe: String::new(),
        colors: vec!["R".into()],
        commander: None,
        meta: None,
    };
    let bolt = score(find(&pool, "Lightning Bolt"), &ctx);
    assert!(
        bolt.reasons
            .iter()
            .any(|reason| reason.contains("suits the aggro curve")),
        "{:?}",
        bolt.reasons
    );
    let summary = summarize(rules, aggro, &["R".into()], &[]);
    let targets: Vec<u32> = summary.curve.iter().map(|bucket| bucket.target).collect();
    assert!(
        (38..=40).contains(&targets.iter().sum::<u32>()),
        "{targets:?}"
    );
    assert!(targets[2] > targets[4]);
}

#[test]
fn summary_enforces_singleton_and_tracks_totals() {
    let pool = fixture_pool();
    let rules = format_rules("commander").unwrap();
    let style = style_rules("midrange").unwrap();
    let colors = vec!["W".into(), "U".into(), "B".into(), "G".into()];
    let entries = vec![
        entry(find(&pool, "Atraxa, Praetors' Voice"), 1, Zone::Commander),
        entry(find(&pool, "Sol Ring"), 2, Zone::Main),
        entry(find(&pool, "Forest"), 30, Zone::Main),
        entry(find(&pool, "Swords to Plowshares"), 1, Zone::Main),
    ];
    let summary = summarize(rules, style, &colors, &entries);
    assert_eq!(summary.count, 34);
    assert_eq!(summary.target, 100);
    assert_eq!(summary.lands, 30);
    assert_eq!(summary.land_target, 37);
    assert!(summary.singleton);
    assert_eq!(
        summary.issues,
        vec!["Sol Ring appears 2 times; Commander decks are singleton."]
    );
    assert!(!summary.complete);
    let white = summary
        .colors
        .iter()
        .find(|share| share.color == "W")
        .unwrap();
    assert_eq!(white.pips, 2);
    assert_eq!(summary.curve[1].count, 3);
    assert_eq!(summary.curve[4].count, 1);
}

#[test]
fn summary_flags_missing_commander_and_copy_limits() {
    let pool = fixture_pool();
    let commander = summarize(
        format_rules("commander").unwrap(),
        style_rules("midrange").unwrap(),
        &[],
        &[],
    );
    assert!(commander.issues[0].contains("Choose a commander"));
    let standard = summarize(
        format_rules("standard").unwrap(),
        style_rules("aggro").unwrap(),
        &["R".into()],
        &[
            entry(find(&pool, "Lightning Bolt"), 5, Zone::Main),
            entry(find(&pool, "Mountain"), 20, Zone::Main),
        ],
    );
    assert_eq!(
        standard.issues,
        vec!["Lightning Bolt has 5 copies; the limit is 4."]
    );
    assert_eq!(standard.max_copies, 4);
}

#[test]
fn pips_count_hybrid_symbols_per_colour() {
    let counts = pips("{2}{G}{G/U}{W/P}");
    assert_eq!(counts.get("G"), Some(&2));
    assert_eq!(counts.get("U"), Some(&1));
    assert_eq!(counts.get("W"), Some(&1));
    assert_eq!(counts.get("B"), None);
}

#[test]
fn basics_follow_pip_proportions() {
    let mut pip_counts = HashMap::new();
    pip_counts.insert("R".to_string(), 30);
    pip_counts.insert("G".to_string(), 10);
    let split = basic_split(&["R".into(), "G".into()], &pip_counts, 20);
    assert_eq!(split, vec![("Mountain", 15), ("Forest", 5)]);
    let even = basic_split(&["W".into(), "U".into()], &HashMap::new(), 17);
    assert_eq!(even.iter().map(|(_, count)| count).sum::<u32>(), 17);
    let mut lopsided = HashMap::new();
    lopsided.insert("G".to_string(), 20);
    let floored = basic_split(&["W".into(), "G".into()], &lopsided, 17);
    assert_eq!(floored, vec![("Plains", 1), ("Forest", 16)]);
    assert_eq!(
        basic_split(&["W".into(), "G".into()], &lopsided, 1),
        vec![("Forest", 1)]
    );
    assert_eq!(basic_split(&[], &HashMap::new(), 3), vec![("Wastes", 3)]);
    assert!(basic_split(&["W".into()], &HashMap::new(), 0).is_empty());
}

#[test]
fn fill_plan_reaches_the_target_with_singleton_copies() {
    let pool = fixture_pool();
    let rules = format_rules("commander").unwrap();
    let style = style_rules("midrange").unwrap();
    let colors = vec!["W".into(), "U".into(), "B".into(), "G".into()];
    let ctx = atraxa_context(theme_rules("counters").unwrap(), style);
    let ranked = rank(&pool, &ctx);
    let entries = vec![
        entry(find(&pool, "Atraxa, Praetors' Voice"), 1, Zone::Commander),
        entry(find(&pool, "Sol Ring"), 1, Zone::Main),
    ];
    let plan = plan_fill(rules, style, &colors, &entries, &ranked);
    assert!(plan.entries.iter().all(|added| added.quantity == 1));
    assert!(plan
        .entries
        .iter()
        .all(|added| added.card.name != "Sol Ring" && !is_land(&added.card.type_line)));
    let nonland: u32 = plan.entries.iter().map(|added| added.quantity).sum();
    let basics: u32 = plan.basics.iter().map(|(_, count)| count).sum();
    assert_eq!(2 + nonland + basics, 100);
    assert_eq!(basics, 37 + (61 - nonland));
}

#[test]
fn fill_plan_uses_four_copies_in_sixty_card_formats() {
    let pool = fixture_pool();
    let rules = format_rules("standard").unwrap();
    let style = style_rules("aggro").unwrap();
    let ctx = Context {
        rules,
        style,
        theme: theme_rules("none").unwrap(),
        tribe: String::new(),
        colors: vec!["R".into()],
        commander: None,
        meta: None,
    };
    let ranked = rank(&pool, &ctx);
    let plan = plan_fill(rules, style, &["R".into()], &[], &ranked);
    let bolt = plan
        .entries
        .iter()
        .find(|added| added.card.name == "Lightning Bolt")
        .unwrap();
    assert_eq!(bolt.quantity, 4);
    let nonland: u32 = plan.entries.iter().map(|added| added.quantity).sum();
    let basics: u32 = plan.basics.iter().map(|(_, count)| count).sum();
    assert_eq!(nonland + basics, 60);
    assert_eq!(plan.basics, vec![("Mountain", basics)]);
}

#[test]
fn queries_follow_the_spec() {
    let spec = BuilderSpec {
        format: "commander".into(),
        set: String::new(),
        colors: vec!["g".into(), "w".into(), "x".into()],
        commander: None,
        style: "midrange".into(),
        theme: "counters".into(),
        tribe: String::new(),
    };
    let rules = format_rules("commander").unwrap();
    let query = base_query(rules, &spec, &["W".into(), "G".into()]).unwrap();
    assert_eq!(query, "game:paper -t:basic format:commander id<=WG");
    assert!(search_url(&query, "edhrec", 2).contains("order=edhrec&page=2"));
    let limited = BuilderSpec {
        format: "limited".into(),
        set: " BLB ".into(),
        ..spec.clone()
    };
    assert_eq!(
        base_query(format_rules("limited").unwrap(), &limited, &["R".into()]).unwrap(),
        "game:paper -t:basic set:blb id<=R"
    );
    assert!(base_query(format_rules("limited").unwrap(), &limited, &[]).is_err());
    let missing = BuilderSpec {
        set: String::new(),
        ..limited
    };
    assert!(base_query(format_rules("limited").unwrap(), &missing, &[]).is_err());
    assert!(format_rules("brawl").is_err());
}
