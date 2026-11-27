const FACE_SEPARATOR: &str = " // ";

pub fn card_lookup_name(name: &str) -> &str {
    name.split_once(FACE_SEPARATOR)
        .map_or(name, |(front, _)| front.trim_end())
}

pub fn split_card_alternative(name: &str) -> Option<String> {
    let compact = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let split = if compact.contains('/') {
        compact
    } else {
        compact.replace(" & ", "/")
    };
    if !split.contains('/') || split.starts_with('/') || split.ends_with('/') {
        return None;
    }
    Some(
        split
            .split('/')
            .map(str::trim)
            .filter(|face| !face.is_empty())
            .collect::<Vec<_>>()
            .join(FACE_SEPARATOR),
    )
}
