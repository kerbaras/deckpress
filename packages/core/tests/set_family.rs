use deckpress_core::set_family::{coverage, family, SetInfo};
use serde_json::Value;

fn sets() -> Vec<SetInfo> {
    let raw: Value =
        serde_json::from_str(include_str!("fixtures/scryfall-set-families.json")).unwrap();
    serde_json::from_value(raw["data"].clone()).unwrap()
}

#[test]
fn follows_parents_and_ranks_paper_family_members() {
    let mut sets = sets();
    sets.push(SetInfo {
        code: "digital".into(),
        digital: true,
        ..sets[1].clone()
    });
    for (chosen, expected) in [
        ("ecl", [("ecl", 0), ("ecc", 1), ("tecl", 2), ("tecc", 3)]),
        ("fdc", [("fdc", 0), ("fdn", 1), ("tfdc", 2), ("tfdn", 3)]),
        ("tecc", [("tecc", 0), ("ecc", 1), ("ecl", 1), ("tecl", 3)]),
    ] {
        assert_eq!(
            family(chosen, &sets),
            expected.map(|(code, rank)| (code.into(), rank))
        );
    }
    assert_eq!(family("missing", &[]), [("missing".into(), 0)]);
    assert_eq!(family("pecl", &sets)[0], ("pecl".into(), 0));
}

#[test]
fn counts_each_entry_once_and_orders_coverage_by_count_exact_then_date() {
    let sets = sets();
    let entries = [
        vec!["ecc", "ecc", "tecc", "pecl", "fdc"],
        vec!["tecl", "aecl", "tfdc"],
        vec!["pecl", "j25", "yecl"],
        vec![],
    ]
    .map(|codes| codes.into_iter().map(String::from).collect());
    let results = coverage(&entries, &sets);
    let rows: Vec<_> = results
        .iter()
        .map(|row| (row.set.code.as_str(), row.count, row.exact, row.total))
        .collect();
    assert_eq!(
        rows,
        [
            ("pecl", 3, 2, 4),
            ("j25", 3, 1, 4),
            ("ecc", 2, 1, 4),
            ("fdc", 2, 1, 4),
            ("ecl", 2, 0, 4),
            ("fdn", 2, 0, 4),
        ]
    );
    assert!(coverage(&[], &sets).is_empty());
}

#[test]
fn foundations_commander_entries_prioritize_commander_then_main_set() {
    let mut sets = sets();
    let main = sets.iter_mut().find(|set| set.code == "fdn").unwrap();
    main.released_at = "2024-11-16".into();
    let entries = [vec!["fdc"], vec!["fdc", "fdn"], vec!["tfdc"]]
        .map(|codes| codes.into_iter().map(String::from).collect());
    let rows = coverage(&entries, &sets);
    let ranked: Vec<_> = rows
        .iter()
        .filter(|row| row.set.code != "j25")
        .map(|row| (row.set.code.as_str(), row.count, row.exact))
        .collect();
    assert_eq!(ranked, [("fdc", 3, 2), ("fdn", 3, 1)]);
    assert_eq!(rows[0].set.code, "fdc");
    assert_eq!(rows[1].set.code, "fdn");
}
