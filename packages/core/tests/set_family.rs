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
fn counts_each_entry_once_and_orders_coverage_by_count_then_date() {
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
        .map(|row| (row.set.code.as_str(), row.count, row.total))
        .collect();
    assert_eq!(
        rows,
        [
            ("pecl", 3, 4),
            ("j25", 3, 4),
            ("tfdc", 2, 4),
            ("ecc", 2, 4),
            ("ecl", 2, 4),
            ("tecc", 2, 4),
            ("tecl", 2, 4),
            ("fdc", 2, 4),
            ("fdn", 2, 4),
            ("tfdn", 2, 4),
        ]
    );
    assert!(coverage(&[], &sets).is_empty());
}
