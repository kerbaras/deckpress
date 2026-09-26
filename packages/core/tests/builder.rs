use std::collections::HashMap;

use deckpress_core::builder::{
    base_query, basic_split, classify_role, commander_profile, format_rules, is_land, land_target,
    pips, plan_fill, pool_card, rank, score, search_url, style_rules, summarize, theme_rules,
    BuilderSpec, Context, PoolCard, StyleRules, ThemeRules,
};
use deckpress_core::models::{new_id, DeckEntry, Zone};
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
        base_query(format_rules("limited").unwrap(), &limited, &[]).unwrap(),
        "game:paper -t:basic set:blb"
    );
    let missing = BuilderSpec {
        set: String::new(),
        ..limited
    };
    assert!(base_query(format_rules("limited").unwrap(), &missing, &[]).is_err());
    assert!(format_rules("brawl").is_err());
}
