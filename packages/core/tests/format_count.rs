use deckpress_core::format_count;

#[test]
fn only_one_uses_the_singular() {
    for (count, pages, faces) in [
        (0, "0 pages", "0 card faces"),
        (1, "1 page", "1 card face"),
        (2, "2 pages", "2 card faces"),
    ] {
        assert_eq!(format_count(count, "page", "pages"), pages);
        assert_eq!(format_count(count, "card face", "card faces"), faces);
    }
}
