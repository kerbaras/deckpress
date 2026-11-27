use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetInfo {
    pub code: String,
    pub name: String,
    #[serde(alias = "set_type")]
    pub set_type: String,
    #[serde(alias = "parent_set_code")]
    pub parent_set_code: Option<String>,
    pub digital: bool,
    #[serde(alias = "released_at")]
    pub released_at: String,
    #[serde(alias = "icon_svg_uri")]
    pub icon_svg_uri: String,
    #[serde(alias = "card_count")]
    pub card_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCoverage {
    pub set: SetInfo,
    pub count: usize,
    pub total: usize,
}

fn is_family_member(set: &SetInfo) -> bool {
    !set.digital
        && matches!(
            set.set_type.as_str(),
            "expansion" | "core" | "commander" | "token"
        )
}

fn roots(sets: &[SetInfo]) -> HashMap<&str, &str> {
    let parents: HashMap<_, _> = sets
        .iter()
        .map(|set| (set.code.as_str(), set.parent_set_code.as_deref()))
        .collect();
    parents
        .keys()
        .map(|&code| {
            let mut root = code;
            for _ in 0..parents.len() {
                let Some(&Some(parent)) = parents.get(root) else {
                    return (code, root);
                };
                root = parent;
            }
            (code, code)
        })
        .collect()
}

pub fn family(chosen: &str, sets: &[SetInfo]) -> Vec<(String, u8)> {
    let roots = roots(sets);
    let mut members = vec![(chosen.to_owned(), 0)];
    if let Some(&root) = roots.get(chosen) {
        for set in sets.iter().filter(|set| {
            set.code != chosen && is_family_member(set) && roots[set.code.as_str()] == root
        }) {
            let rank = if set.code == root || set.set_type == "commander" {
                1
            } else if set.set_type == "token" && set.parent_set_code.as_deref() == Some(chosen) {
                2
            } else {
                3
            };
            members.push((set.code.clone(), rank));
        }
    }
    members.sort_unstable_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    members
}

pub fn coverage(entry_sets: &[Vec<String>], sets: &[SetInfo]) -> Vec<SetCoverage> {
    let roots = roots(sets);
    let member_roots: HashMap<_, _> = sets
        .iter()
        .filter(|set| is_family_member(set))
        .map(|set| (set.code.as_str(), roots[set.code.as_str()]))
        .collect();
    let mut exact_only_counts = HashMap::new();
    let mut family_counts = HashMap::new();
    for codes in entry_sets {
        let covered: HashSet<_> = codes
            .iter()
            .filter_map(|code| member_roots.get(code.as_str()).copied())
            .collect();
        for code in codes.iter().map(String::as_str).collect::<HashSet<_>>() {
            if roots.get(code).is_some_and(|root| !covered.contains(root)) {
                *exact_only_counts.entry(code).or_insert(0) += 1;
            }
        }
        for root in covered {
            *family_counts.entry(root).or_insert(0) += 1;
        }
    }
    let mut rows: Vec<_> = sets
        .iter()
        .filter(|set| !set.digital && !matches!(set.set_type.as_str(), "memorabilia" | "alchemy"))
        .filter_map(|set| {
            let root = roots[set.code.as_str()];
            let count = family_counts.get(root).copied().unwrap_or(0)
                + exact_only_counts
                    .get(set.code.as_str())
                    .copied()
                    .unwrap_or(0);
            (count > 0).then(|| SetCoverage {
                set: set.clone(),
                count,
                total: entry_sets.len(),
            })
        })
        .collect();
    rows.sort_unstable_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| b.set.released_at.cmp(&a.set.released_at))
            .then_with(|| a.set.code.cmp(&b.set.code))
    });
    rows
}
