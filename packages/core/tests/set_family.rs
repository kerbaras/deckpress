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
fn counts_each_copy_once_and_excludes_ineligible_sets_from_suggestions() {
    let sets = sets();
    let entries = [
        (20, vec!["ecc", "ecc", "tecc", "pecl", "fdc"]),
        (9, vec!["tecl", "aecl", "tfdc"]),
        (1, vec!["pecl", "pfdn", "j25", "yecl"]),
        (70, vec![]),
    ]
    .map(|(quantity, codes)| (quantity, codes.into_iter().map(String::from).collect()));
    let results = coverage(&entries, &sets);
    let rows: Vec<_> = results
        .iter()
        .map(|row| (row.set.code.as_str(), row.count, row.exact, row.total))
        .collect();
    assert_eq!(
        rows,
        [
            ("ecc", 29, 20, 100),
            ("fdc", 29, 20, 100),
            ("ecl", 29, 0, 100),
            ("fdn", 29, 0, 100),
        ]
    );
    assert!(coverage(&[], &sets).is_empty());
    assert!(coverage(&[(3, vec!["pfdn".into(), "j25".into()])], &sets).is_empty());
}

#[test]
fn foundations_commander_entries_prioritize_commander_then_main_set() {
    let mut sets = sets();
    let main = sets.iter_mut().find(|set| set.code == "fdn").unwrap();
    main.released_at = "2024-11-16".into();
    let entries = [
        (32, vec!["fdc"]),
        (1, vec!["fdc", "fdn"]),
        (1, vec!["tfdc"]),
        (40, vec!["tecl"]),
    ]
    .map(|(quantity, codes)| (quantity, codes.into_iter().map(String::from).collect()));
    let rows = coverage(&entries, &sets);
    let ranked: Vec<_> = rows
        .iter()
        .map(|row| (row.set.code.as_str(), row.count, row.exact))
        .collect();
    assert_eq!(
        ranked,
        [
            ("fdc", 34, 33),
            ("fdn", 34, 1),
            ("ecc", 40, 0),
            ("ecl", 40, 0)
        ]
    );
    assert_eq!(rows[0].set.code, "fdc");
    assert_eq!(rows[1].set.code, "fdn");
}
