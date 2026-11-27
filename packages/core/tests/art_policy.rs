mod common;

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use deckpress_core::art_policy::{
    ArtChangeKind, ArtPolicies, ArtPolicy, ArtPreviewProgress, Border, Frame, Treatment,
};
use deckpress_core::models::{PrintLanguagePolicy, PrintLanguagePreferences, Provider, Zone};
use deckpress_core::providers::{normalize_scryfall, Providers};
use deckpress_core::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

const ORACLE: &str = "4457ed35-7c10-48c8-9776-456485fdf070";
const SETS_URL: &str = "https://api.scryfall.com/sets";

fn cards() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/scryfall-art-policy.json")).unwrap()
}

fn printing<'a>(cards: &'a [Value], set: &str, language: &str) -> &'a Value {
    cards
        .iter()
        .find(|card| card["set"] == set && card["lang"] == language)
        .unwrap()
}

fn record(store: &Store, url: &str, value: &Value) {
    let key = hex::encode(Sha256::digest(format!("{url}null")));
    store.put("cache", &key, value).unwrap();
}

fn search(store: &Store, language: Option<&str>, page: u32, has_more: bool, data: &[Value]) {
    search_oracle(store, ORACLE, language, page, has_more, data);
}

fn search_oracle(
    store: &Store,
    oracle: &str,
    language: Option<&str>,
    page: u32,
    has_more: bool,
    data: &[Value],
) {
    let query = match language {
        Some(language) => {
            store
                .remove("cache", &format!("language-printings:{language}:{oracle}"))
                .unwrap();
            format!("(oracleid:{oracle}) lang:{language} game:paper")
        }
        None => {
            store
                .remove("cache", &format!("policy-printings:{oracle}"))
                .unwrap();
            format!("oracleid:{oracle} game:paper")
        }
    };
    record_search(store, &query, page, has_more, data);
}

fn record_search(store: &Store, query: &str, page: u32, has_more: bool, data: &[Value]) {
    let mut url = url::Url::parse("https://api.scryfall.com/cards/search").unwrap();
    url.query_pairs_mut().append_pair("q", query);
    record(
        store,
        &format!(
            "{url}&unique=prints&include_multilingual=true&order=released&dir=desc&page={page}"
        ),
        &json!({"data": data, "has_more": has_more}),
    );
}

fn record_sets(store: &Store) {
    record(
        store,
        SETS_URL,
        &serde_json::from_str(include_str!("fixtures/scryfall-set-families.json")).unwrap(),
    );
}

fn in_set(raw: &Value, set: &str, date: &str) -> Value {
    let mut raw = raw.clone();
    raw["id"] = json!(deckpress_core::models::new_id());
    raw["set"] = json!(set);
    raw["released_at"] = json!(date);
    raw
}

fn set_policy(set: &str, family: bool) -> ArtPolicy {
    ArtPolicy::MatchSet {
        set: set.into(),
        family,
    }
}

fn entry(raw: &Value) -> deckpress_core::models::DeckEntry {
    let mut entry = common::entry(common::scryfall_art(), 1);
    entry.id = deckpress_core::models::new_id();
    entry.card = normalize_scryfall(raw).unwrap();
    entry
}

fn preferences(providers: &Providers, language: &str, policy: PrintLanguagePolicy) {
    providers
        .save_print_language_preferences(PrintLanguagePreferences {
            languages: vec![language.into()],
            policy,
        })
        .unwrap();
}

#[tokio::test]
async fn set_preview_batches_and_caches_pages_and_retries_the_throttled_page() {
    let cards = cards();
    let base = printing(&cards, "m11", "en");
    let mut input = common::new_deck("Batched set preview");
    for id in 1..=100 {
        let mut raw = base.clone();
        raw["oracle_id"] = json!(uuid::Uuid::from_u128(id));
        input.entries.push(entry(&raw));
    }
    let mut duplicate = input.entries[0].clone();
    duplicate.id = deckpress_core::models::new_id();
    input.entries.push(duplicate);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let fixture = base.clone();
    let (tx, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let mock = tokio::spawn(async move {
        let mut throttled = false;
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let path = line.split_whitespace().nth(1).unwrap();
            let url = origin_for_path(path);
            let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
            let q = &params["q"];
            let page = params["page"].parse::<u32>().unwrap();
            let language = if q.contains("lang:es") { "es" } else { "en" };
            let ids: Vec<_> = q
                .split("oracleid:")
                .skip(1)
                .map(|term| &term[..36])
                .collect();
            while {
                line.clear();
                stream.read_line(&mut line).await.unwrap() > 0 && line != "\r\n"
            } {}
            let paginated = ids[0] == "00000000-0000-0000-0000-000000000001" && language == "en";
            let rate_limited = paginated && page == 2 && !throttled;
            let (status, header, body) = if rate_limited {
                throttled = true;
                (
                    "429 Too Many Requests",
                    "Retry-After: 1\r\n",
                    "{}".to_owned(),
                )
            } else {
                let page_ids = match (paginated, page) {
                    (true, 1) => &ids[..6],
                    (true, 2) => &ids[6..],
                    (false, 1) => &ids[..],
                    _ => panic!("Unexpected page: {page}"),
                };
                let data: Vec<_> = page_ids
                    .iter()
                    .map(|id| {
                        let mut raw = in_set(&fixture, "fdc", "2024-11-15");
                        raw["oracle_id"] = json!(id);
                        raw["lang"] = json!(language);
                        raw
                    })
                    .collect();
                (
                    "200 OK",
                    "",
                    json!({"data": data, "has_more": paginated && page == 1}).to_string(),
                )
            };
            tx.send((q.to_string(), page, ids.len(), rate_limited, Instant::now()))
                .unwrap();
            stream.get_mut().write_all(format!(
                "HTTP/1.1 {status}\r\n{header}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes()).await.unwrap();
        }
    });

    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::with_scryfall_origin(store.clone(), origin).unwrap());
    preferences(&providers, "es", PrintLanguagePolicy::Strict);
    let service = ArtPolicies::new(store.clone(), providers);
    let deck = store.create_deck(input).unwrap();
    let updates = std::sync::Mutex::new(Vec::new());
    let preview = service
        .preview_policy_with_progress(
            &deck.id,
            deck.revision,
            set_policy("fdc", false),
            |update| {
                updates.lock().unwrap().push(update);
            },
        )
        .await
        .unwrap();
    assert_eq!(preview.changes.len(), 101);
    assert!(preview.changes.iter().all(|change| change
        .after
        .as_ref()
        .is_some_and(|art| { art.set == "fdc" && art.language == "es" })));
    let observed: Vec<_> = std::iter::from_fn(|| requests.try_recv().ok()).collect();
    assert_eq!(observed.len(), 20);
    assert_eq!(observed.iter().map(|entry| entry.2).max(), Some(12));
    let throttled = &observed[1];
    let retry = &observed[2];
    assert!(throttled.3);
    assert!(!retry.3);
    assert_eq!((&throttled.0, throttled.1), (&retry.0, retry.1));
    assert!(retry.4.duration_since(throttled.4) >= Duration::from_secs(1));
    let updates = updates.into_inner().unwrap();
    assert!(updates.iter().any(|update| matches!(
        update,
        ArtPreviewProgress::RateLimited {
            retry_after_seconds: 1
        }
    )));
    assert!(
        matches!(updates.last(), Some(ArtPreviewProgress::Printings { language: Some(language), done: 100, total: 100 }) if language == "es")
    );

    let mut input = common::new_deck("Different deck, shared printing cache");
    input.entries = deck.entries[4..25].to_vec();
    let subset = store.create_deck(input).unwrap();
    let warm = service
        .preview_policy(&subset.id, subset.revision, set_policy("fdc", false))
        .await
        .unwrap();
    assert_eq!(warm.changes.len(), 21);
    assert!(
        requests.try_recv().is_err(),
        "cached cards must not make requests for a new batch composition"
    );
    mock.abort();
}

fn origin_for_path(path: &str) -> url::Url {
    url::Url::parse(&format!("http://localhost{path}")).unwrap()
}

#[tokio::test]
async fn latest_policy_uses_scan_quality_before_the_set_tie_break() {
    let cards = cards();
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    preferences(&providers, "en", PrintLanguagePolicy::Strict);
    let service = ArtPolicies::new(store.clone(), providers);
    let highres = printing(&cards, "m11", "en").clone();
    let mut lowres = printing(&cards, "m10", "en").clone();
    lowres["released_at"] = highres["released_at"].clone();
    lowres["image_status"] = json!("lowres");
    lowres["highres_image"] = json!(false);
    search(&store, None, 1, false, &[lowres, highres]);

    let mut input = common::new_deck("Scan-quality tie");
    input.entries = vec![entry(printing(&cards, "lea", "en"))];
    let deck = store.create_deck(input).unwrap();
    let preview = service
        .preview_policy(&deck.id, deck.revision, ArtPolicy::Latest)
        .await
        .unwrap();
    assert_eq!(preview.changes[0].after.as_ref().unwrap().set, "m11");
}

#[tokio::test]
async fn previews_original_latest_set_and_style_then_applies_and_undoes_without_touching_pins() {
    let cards = cards();
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers);
    search(&store, None, 1, true, &cards[..4]);
    search(&store, None, 2, false, &cards[4..]);

    let mut original = entry(printing(&cards, "m10", "en"));
    original.zone = Zone::Companion;
    let mut pinned = entry(printing(&cards, "m11", "en"));
    pinned.zone = Zone::Companion;
    pinned.selected_art = Some(pinned.front_art().clone());
    let mut upload = entry(printing(&cards, "m11", "en"));
    let custom_art = &mut upload.card.faces[0];
    custom_art.provider = Provider::Upload;
    custom_art.id = format!("upload:{}", upload.id);
    custom_art.image_url = format!("upload://{}", upload.id);
    custom_art.thumbnail_url = custom_art.image_url.clone();
    custom_art.bleed_mm = 2.0;
    let mut input = common::new_deck("Art policy");
    input.entries = vec![original, pinned.clone(), upload.clone()];
    let deck = store.create_deck(input).unwrap();
    let mut last_preview = None;
    for (policy, set) in [
        (ArtPolicy::Latest, "slc"),
        (set_policy("m11", false), "m11"),
        (
            ArtPolicy::Style {
                frame: Some(Frame::Modern),
                border: Some(Border::Black),
                treatment: Some(Treatment::None),
            },
            "m11",
        ),
        (
            ArtPolicy::Style {
                frame: None,
                border: Some(Border::Borderless),
                treatment: Some(Treatment::FullArt),
            },
            "slc",
        ),
        (ArtPolicy::Original, "lea"),
    ] {
        let preview = service
            .preview_policy(&deck.id, deck.revision, policy)
            .await
            .unwrap();
        assert_eq!(preview.changes[0].after.as_ref().unwrap().set, set);
        assert_eq!(preview.changes[1].kind, ArtChangeKind::Pinned);
        assert_eq!(preview.changes[2].kind, ArtChangeKind::Pinned);
        assert_eq!(&preview.changes[2].before, upload.front_art());
        assert_eq!(
            store
                .get::<deckpress_core::models::Deck>("deck", &deck.id)
                .unwrap()
                .unwrap(),
            deck
        );
        if let Some(stale) = last_preview.replace(preview.preview_id) {
            assert!(service.apply(&deck.id, deck.revision, &stale).is_err());
        }
    }

    let applied = service
        .apply(&deck.id, deck.revision, &last_preview.unwrap())
        .unwrap();
    assert_eq!(applied.entries[0].front_art().set, "lea");
    assert_eq!(applied.entries[0].zone, Zone::Companion);
    assert_eq!(applied.entries[0].card.faces[0].set, "m10");
    assert_eq!(applied.entries[1], pinned);
    assert_eq!(applied.entries[2], upload);
    assert_eq!(applied.art_policy, Some(ArtPolicy::Original));
    let restored = service.undo(&deck.id, applied.revision).unwrap();
    assert_eq!(restored.entries, deck.entries);
    assert_eq!(restored.art_policy, deck.art_policy);
    assert!(service.undo(&deck.id, restored.revision).is_err());

    let preview = service
        .preview_policy(&deck.id, restored.revision, ArtPolicy::Latest)
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, restored.revision, &preview.preview_id)
        .unwrap();
    let edited = store
        .update_deck(deckpress_core::models::Deck {
            notes: "Later edits".into(),
            ..applied
        })
        .unwrap();
    assert!(matches!(
        service.undo(&deck.id, edited.revision),
        Err(deckpress_core::AppError::Conflict(_))
    ));
}

#[tokio::test]
async fn family_matches_commander_and_leaves_unmatched_and_protected_art_untouched() {
    let cards = cards();
    let base = printing(&cards, "m11", "en");
    let dfc: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy-dfc.json")).unwrap();
    let old_dfc = &dfc[0];
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    preferences(&providers, "en", PrintLanguagePolicy::Strict);
    let service = ArtPolicies::new(store.clone(), providers.clone());
    record_sets(&store);
    let dfc_oracle = old_dfc["oracle_id"].as_str().unwrap();
    let mut oracles = [ORACLE, dfc_oracle];
    oracles.sort_unstable();
    record_search(
        &store,
        &format!(
            "(oracleid:{} or oracleid:{}) game:paper",
            oracles[0], oracles[1]
        ),
        1,
        false,
        &[
            in_set(base, "ecc", "2026-01-23"),
            in_set(old_dfc, "pecl", "2026-01-23"),
        ],
    );

    let mut pinned = entry(base);
    pinned.art_pinned = true;
    pinned.quantity = 2;
    let mut non_scryfall = entry(base);
    non_scryfall.card.faces[0].provider = Provider::Mpc;
    let mut input = common::new_deck("Lorwyn");
    let mut matched = entry(base);
    matched.quantity = 3;
    input.entries = vec![matched, entry(old_dfc), pinned, non_scryfall];
    let deck = store.create_deck(input).unwrap();
    let legacy: ArtPolicy =
        serde_json::from_value(json!({"kind": "matchSet", "set": "ecl"})).unwrap();
    assert_eq!(legacy, set_policy("ecl", false));
    let exact = service
        .preview_policy(&deck.id, deck.revision, legacy)
        .await
        .unwrap();
    assert_eq!(exact.changes[0].kind, ArtChangeKind::Unmatched);

    let preview = service
        .preview_policy(&deck.id, deck.revision, set_policy("ecl", true))
        .await
        .unwrap();
    assert_eq!(preview.changes[0].after.as_ref().unwrap().set, "ecc");
    assert_eq!(
        preview
            .changes
            .iter()
            .filter(|change| change.kind == ArtChangeKind::Unmatched)
            .count(),
        1
    );
    assert_eq!(preview.changes[1].kind, ArtChangeKind::Unmatched);
    assert!(preview.changes[1].after.is_none());
    assert_eq!(preview.changes[2].kind, ArtChangeKind::Pinned);
    assert_eq!(preview.changes[3].kind, ArtChangeKind::Pinned);
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    assert_eq!(applied.entries[0].front_art().set, "ecc");
    assert_eq!(applied.entries[1..], deck.entries[1..]);

    let rows = providers.set_coverage(&deck.entries).await.unwrap();
    let lorwyn = rows.iter().find(|row| row.set.code == "ecl").unwrap();
    assert_eq!((lorwyn.count, lorwyn.total), (3, 7));
    let commander = rows.iter().find(|row| row.set.code == "ecc").unwrap();
    assert_eq!(commander.exact, 3);
    assert!(providers
        .set_coverage(&deck.entries[2..])
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn family_rank_precedes_release_date_for_foundations() {
    let cards = cards();
    let base = printing(&cards, "m11", "en");
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    preferences(&providers, "en", PrintLanguagePolicy::Strict);
    let service = ArtPolicies::new(store.clone(), providers);
    record_sets(&store);
    let mut input = common::new_deck("Foundations");
    input.entries = vec![entry(base)];
    let deck = store.create_deck(input).unwrap();

    let ranked = ["fdc", "fdn", "tfdc", "tfdn"];
    let prints = [
        in_set(base, "fdc", "2024-11-15"),
        in_set(base, "fdn", "2024-11-16"),
        in_set(base, "tfdc", "2026-10-02"),
        in_set(base, "tfdn", "2026-10-03"),
        in_set(base, "j25", "2026-10-04"),
    ];
    for (index, expected) in ranked.into_iter().enumerate() {
        search(&store, None, 1, false, &prints[index..]);
        let preview = service
            .preview_policy(&deck.id, deck.revision, set_policy("fdc", true))
            .await
            .unwrap();
        assert_eq!(preview.changes[0].after.as_ref().unwrap().set, expected);
    }
}

#[tokio::test]
async fn family_localization_keeps_both_faces_and_filters_out_of_family_scans() {
    let dfc: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy-dfc.json")).unwrap();
    let (en, es) = (&dfc[0], &dfc[1]);
    let oracle = en["oracle_id"].as_str().unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    preferences(&providers, "es", PrintLanguagePolicy::FallbackToEnglish);
    let service = ArtPolicies::new(store.clone(), providers);
    record_sets(&store);
    search_oracle(
        &store,
        oracle,
        None,
        1,
        false,
        &[in_set(en, "ecl", "2026-01-23")],
    );
    let mut spanish = vec![in_set(es, "pecl", "2026-01-24")];
    search_oracle(&store, oracle, Some("es"), 1, false, &spanish);
    let mut input = common::new_deck("Localized family");
    input.entries = vec![entry(en)];
    let deck = store.create_deck(input).unwrap();
    let fallback = service
        .preview_policy(&deck.id, deck.revision, set_policy("ecl", true))
        .await
        .unwrap();
    assert_eq!(fallback.changes[0].kind, ArtChangeKind::Fallback);
    assert_eq!(fallback.changes[0].after.as_ref().unwrap().set, "ecl");

    spanish.push(in_set(es, "ecc", "2026-01-23"));
    search_oracle(&store, oracle, Some("es"), 1, false, &spanish);
    let preview = service
        .preview_policy(&deck.id, deck.revision, set_policy("ecl", true))
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    assert_eq!(applied.entries[0].front_art().set, "ecc");
    let back = applied.entries[0].back_art().unwrap();
    assert_eq!(back.language, "es");
    assert_eq!(
        back.illustration_id,
        deck.entries[0].back_art().unwrap().illustration_id
    );
}

#[tokio::test]
async fn invalid_catalog_is_an_error_for_families_but_not_legacy_exact_policies() {
    let cards = cards();
    let base = printing(&cards, "m11", "en");
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    preferences(&providers, "en", PrintLanguagePolicy::Strict);
    let service = ArtPolicies::new(store.clone(), providers.clone());
    record(&store, SETS_URL, &json!({"data": [{"code": "ecl"}]}));
    search(&store, None, 1, false, &[in_set(base, "ecl", "2026-01-23")]);
    let mut input = common::new_deck("Invalid set catalog");
    input.entries = vec![entry(base)];
    let deck = store.create_deck(input).unwrap();

    assert!(providers.sets().await.is_err());
    assert!(providers.set_coverage(&deck.entries).await.is_err());
    assert!(service
        .preview_policy(&deck.id, deck.revision, set_policy("ecl", true))
        .await
        .is_err());
    let exact = service
        .preview_policy(&deck.id, deck.revision, set_policy("ecl", false))
        .await
        .unwrap();
    assert_eq!(exact.changes[0].after.as_ref().unwrap().set, "ecl");
}

#[tokio::test]
async fn same_illustration_localization_skips_placeholder_and_looks_through_search_pages() {
    let cards = cards();
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    let en = printing(&cards, "m11", "en");
    let placeholder = printing(&cards, "m11", "es");
    let es = printing(&cards, "m10", "es");
    record(
        &store,
        &format!(
            "https://api.scryfall.com/cards/{}",
            en["id"].as_str().unwrap()
        ),
        en,
    );
    record(
        &store,
        "https://api.scryfall.com/cards/m11/149/es",
        placeholder,
    );
    search(
        &store,
        Some("es"),
        1,
        true,
        &[placeholder.clone(), printing(&cards, "4ed", "es").clone()],
    );
    search(&store, Some("es"), 2, false, std::slice::from_ref(es));
    let mut input = common::new_deck("Same art");
    input.entries = vec![entry(en)];
    let deck = store.create_deck(input).unwrap();
    let entry = &deck.entries[0];
    preferences(&providers, "es", PrintLanguagePolicy::Strict);

    let preview = service
        .preview_localization(&deck.id, deck.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    let after = preview.changes[0].after.as_ref().unwrap();
    assert_eq!((&*after.set, &*after.language), ("m10", "es"));
    assert_eq!(after.illustration_id, entry.front_art().illustration_id);
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    assert!(applied.entries[0].is_art_pinned());

    search(&store, Some("es"), 2, false, &[]);
    let strict = service
        .preview_localization(&deck.id, applied.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    assert_eq!(strict.changes[0].kind, ArtChangeKind::Unmatched);
    assert!(!strict.can_apply);
    preferences(&providers, "es", PrintLanguagePolicy::FallbackToEnglish);
    let fallback = service
        .preview_localization(&deck.id, applied.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    let after = fallback.changes[0].after.as_ref().unwrap();
    assert_eq!((&*after.set, &*after.language), ("m11", "en"));
    assert_eq!(fallback.changes[0].kind, ArtChangeKind::Fallback);
    let applied_fallback = service
        .apply(&deck.id, applied.revision, &fallback.preview_id)
        .unwrap();
    assert!(applied_fallback.entries[0].front_art().english_fallback);
    let restored = service.undo(&deck.id, applied_fallback.revision).unwrap();
    assert!(!restored.entries[0].front_art().english_fallback);
}

#[tokio::test]
async fn double_faced_localization_requires_both_illustrations() {
    let data: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/scryfall-art-policy-dfc.json")).unwrap();
    let en = &data[0];
    let es = &data[1];
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    record(
        &store,
        &format!(
            "https://api.scryfall.com/cards/{}",
            en["id"].as_str().unwrap()
        ),
        en,
    );
    record(&store, "https://api.scryfall.com/cards/isd/51/es", es);
    preferences(&providers, "es", PrintLanguagePolicy::Strict);
    let mut input = common::new_deck("Both faces");
    input.entries = vec![entry(en)];
    let deck = store.create_deck(input).unwrap();
    let old = &deck.entries[0];
    let preview = service
        .preview_localization(&deck.id, deck.revision, &old.id, &old.front_art().id)
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    let back = applied.entries[0].back_art().unwrap();
    assert_eq!(back.language, "es");
    assert_eq!(back.illustration_id, old.card.faces[1].illustration_id);

    let mut wrong_back = es.clone();
    wrong_back["card_faces"][1]["illustration_id"] = es["card_faces"][0]["illustration_id"].clone();
    record(
        &store,
        "https://api.scryfall.com/cards/isd/51/es",
        &wrong_back,
    );
    search_oracle(
        &store,
        &old.card.oracle_id,
        Some("es"),
        1,
        false,
        &[wrong_back],
    );
    let mismatch = service
        .preview_localization(&deck.id, applied.revision, &old.id, &old.front_art().id)
        .await
        .unwrap();
    assert_eq!(mismatch.changes[0].kind, ArtChangeKind::Unmatched);
    assert!(!mismatch.can_apply);
}

#[tokio::test]
#[ignore = "calls live Scryfall"]
async fn live_same_illustration_and_deck_policy() {
    let data = cards();
    let mut input = common::new_deck("Live art verification");
    input.entries = vec![entry(printing(&data, "m11", "en"))];
    let store = Arc::new(Store::in_memory().unwrap());
    let providers = Arc::new(Providers::new(store.clone()).unwrap());
    let service = ArtPolicies::new(store.clone(), providers.clone());
    let deck = store.create_deck(input).unwrap();
    let entry = &deck.entries[0];
    preferences(&providers, "es", PrintLanguagePolicy::Strict);
    let localized = service
        .preview_localization(&deck.id, deck.revision, &entry.id, &entry.front_art().id)
        .await
        .unwrap();
    let after = localized.changes[0]
        .after
        .as_ref()
        .expect("usable same-art Spanish Lightning Bolt");
    assert_eq!(after.language, "es");
    assert_eq!(after.illustration_id, entry.front_art().illustration_id);
    preferences(&providers, "en", PrintLanguagePolicy::Strict);
    let preview = service
        .preview_policy(&deck.id, deck.revision, ArtPolicy::Original)
        .await
        .unwrap();
    let applied = service
        .apply(&deck.id, deck.revision, &preview.preview_id)
        .unwrap();
    assert_eq!(applied.entries[0].front_art().set, "lea");
}
