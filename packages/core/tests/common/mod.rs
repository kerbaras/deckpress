#![allow(dead_code)]

use deckpress_core::models::{Art, Card, Deck, DeckEntry, NewDeck, PrintSettings, Provider, Zone};

pub fn art(bleed_mm: f64, provider: Provider) -> Art {
    Art {
        id: "a".into(),
        provider,
        name: "a".into(),
        image_url: String::new(),
        thumbnail_url: String::new(),
        art_crop_url: String::new(),
        source_url: String::new(),
        source: String::new(),
        artist: String::new(),
        set: String::new(),
        collector_number: String::new(),
        language: String::new(),
        illustration_id: None,
        scan_quality: None,
        released_at: String::new(),
        dpi: 300.0,
        tags: vec![],
        bleed_mm,
        back_image_url: String::new(),
        back_thumbnail_url: String::new(),
        english_fallback: false,
        filename: None,
        content_hash: None,
    }
}

pub fn scryfall_art() -> Art {
    Art {
        id: "scryfall:x:0".into(),
        name: "Test".into(),
        image_url: "https://cards.scryfall.io/png/front/x.png".into(),
        ..art(0.0, Provider::Scryfall)
    }
}

pub fn entry(face: Art, quantity: u32) -> DeckEntry {
    DeckEntry {
        id: "e".into(),
        card: Card {
            id: "x".into(),
            oracle_id: "o".into(),
            name: "Test".into(),
            type_line: "Creature".into(),
            mana_cost: String::new(),
            mana_value: 0.0,
            colors: vec![],
            faces: vec![face],
        },
        quantity,
        zone: Zone::Main,
        board: None,
        selected_art: None,
        selected_back: None,
        art_pinned: false,
        policy_art: None,
        language_anchor: None,
        language_choices: Default::default(),
        excluded: false,
        requested_languages: Vec::new(),
    }
}

pub fn deck(quantity: u32) -> Deck {
    Deck {
        id: "d".into(),
        name: "Test deck".into(),
        format: String::new(),
        notes: String::new(),
        entries: vec![entry(scryfall_art(), quantity)],
        missing_prints: Vec::new(),
        cover_entry_id: String::new(),
        print_settings: PrintSettings::default(),
        art_policy: None,
        print_language: None,
        revision: 0,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

pub fn new_deck(name: &str) -> NewDeck {
    NewDeck {
        name: name.into(),
        format: "Commander".into(),
        notes: String::new(),
        entries: vec![],
        missing_prints: Vec::new(),
        cover_entry_id: String::new(),
        print_settings: PrintSettings::default(),
        art_policy: None,
        print_language: None,
    }
}

pub fn png(width: u32, height: u32, pixel: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::RgbImage::from_pixel(width, height, image::Rgb(pixel))
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}
