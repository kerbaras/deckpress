const FACE_SEPARATOR: &str = " // ";

pub fn canonical_card_name(name: &str) -> String {
    let compact = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if !compact.contains('/') || compact.starts_with('/') || compact.ends_with('/') {
        return compact;
    }
    compact
        .split('/')
        .map(str::trim)
        .filter(|face| !face.is_empty())
        .collect::<Vec<_>>()
        .join(FACE_SEPARATOR)
}

pub fn card_lookup_name(canonical_name: &str) -> &str {
    canonical_name
        .split_once(FACE_SEPARATOR)
        .map_or(canonical_name, |(front, _)| front)
}

pub fn ampersand_card_alternative(canonical_name: &str) -> Option<String> {
    (canonical_name.contains(" & ") && !canonical_name.contains(FACE_SEPARATOR))
        .then(|| canonical_name.replace(" & ", FACE_SEPARATOR))
}
