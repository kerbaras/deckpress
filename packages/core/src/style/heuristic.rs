//! Metadata-only similarity between two printings: artist, frame labels, set,
//! era and provider. Used on its own when the embedding model is unavailable
//! and blended with the visual score otherwise.

use std::collections::BTreeSet;

use crate::models::Art;

pub const ARTIST_WEIGHT: f32 = 0.45;
pub const ARTIST_PARTIAL_WEIGHT: f32 = 0.2;
pub const LABELS_WEIGHT: f32 = 0.25;
pub const PLAIN_FRAME_WEIGHT: f32 = 0.15;
pub const SET_WEIGHT: f32 = 0.15;
pub const SOURCE_WEIGHT: f32 = 0.08;
pub const ERA_WEIGHT: f32 = 0.1;
pub const PROVIDER_WEIGHT: f32 = 0.05;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Heuristic {
    /// 0..=1, larger is more alike.
    pub score: f32,
    pub reasons: Vec<String>,
}

fn words(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() > 2)
        .map(|word| word.to_lowercase())
        .filter(|word| {
            !matches!(
                word.as_str(),
                "the" | "and" | "art" | "artist" | "unknown" | "set" | "edition"
            )
        })
        .collect()
}

fn labels(art: &Art) -> BTreeSet<String> {
    art.tags
        .iter()
        .map(|tag| tag.trim().to_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn year(art: &Art) -> Option<i32> {
    art.released_at.get(..4)?.parse().ok()
}

fn known_artist(art: &Art) -> bool {
    let artist = art.artist.trim();
    !artist.is_empty() && !artist.eq_ignore_ascii_case("unknown")
}

pub fn score(reference: &Art, candidate: &Art) -> Heuristic {
    let mut total = 0.0;
    let mut reasons = Vec::new();

    if known_artist(reference) && known_artist(candidate) {
        if reference
            .artist
            .trim()
            .eq_ignore_ascii_case(candidate.artist.trim())
        {
            total += ARTIST_WEIGHT;
            reasons.push(format!("Same artist ({})", candidate.artist.trim()));
        } else {
            let shared: Vec<_> = words(&reference.artist)
                .intersection(&words(&candidate.artist))
                .cloned()
                .collect();
            if !shared.is_empty() {
                total += ARTIST_PARTIAL_WEIGHT;
                reasons.push("Artist credit overlaps".into());
            }
        }
    }

    let (a, b) = (labels(reference), labels(candidate));
    if a.is_empty() && b.is_empty() {
        total += PLAIN_FRAME_WEIGHT;
        reasons.push("Both regular frames".into());
    } else {
        let shared: Vec<_> = a.intersection(&b).cloned().collect();
        let union = a.union(&b).count();
        if !shared.is_empty() && union > 0 {
            total += LABELS_WEIGHT * shared.len() as f32 / union as f32;
            reasons.push(format!("Shares labels: {}", shared.join(", ")));
        }
    }

    if !reference.set.is_empty() && reference.set.eq_ignore_ascii_case(&candidate.set) {
        total += SET_WEIGHT;
        reasons.push(format!("Same set ({})", candidate.set.to_uppercase()));
    } else {
        let shared: Vec<_> = words(&reference.source)
            .intersection(&words(&candidate.source))
            .cloned()
            .collect();
        if !shared.is_empty() {
            total += SOURCE_WEIGHT;
            reasons.push(format!("Related source ({})", candidate.source.trim()));
        }
    }

    if let (Some(a), Some(b)) = (year(reference), year(candidate)) {
        let gap = (a - b).abs();
        let era = match gap {
            0 => ERA_WEIGHT,
            1..=3 => ERA_WEIGHT * 0.7,
            4..=8 => ERA_WEIGHT * 0.4,
            _ => 0.0,
        };
        if era > 0.0 {
            total += era;
            reasons.push(if gap == 0 {
                "Same year".into()
            } else {
                format!("Released within {gap} years")
            });
        }
    }

    if reference.provider == candidate.provider {
        total += PROVIDER_WEIGHT;
    }

    Heuristic {
        score: total.clamp(0.0, 1.0),
        reasons,
    }
}
