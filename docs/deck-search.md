# Deck search (Discover)

`#/discover` lets a user search public decks on an external deck database,
preview the list and import it as a new Deckpress deck. All provider logic
lives in `packages/core/src/decksearch.rs`; the Tauri commands
`search_decks`, `deck_detail` and `import_external_deck` only forward IPC, and
`apps/web/src/deck-search.tsx` renders the route.

## Provider selection

| Candidate | Verdict | Why |
| --- | --- | --- |
| Archidekt | **Used** | Public JSON endpoints answer without credentials from a plain `reqwest` client using Deckpress's own user agent. Same host `providers.rs` already imports decks from by URL. |
| Moxfield | Not used | `https://api2.moxfield.com/v2/decks/search` and `/v3/decks/all/<id>` both returned Cloudflare HTTP 403 for a non-browser client during research. The API is unofficial and Moxfield has stated it is not for third-party use; add it only with a documented, verified endpoint. |
| MTGGoldfish, MTGTop8 | Not used | HTML only; scraping would break on every redesign. |
| Scryfall | Used for card names and card resolution only | Has no deck search. `cards/autocomplete` turns a partial commander or card name into an exact name, and the existing `Providers::resolve` matches imported lines. |

Adding a source means a new `DeckSource` variant, a URL builder, a
`parse_*_search` / `parse_*_deck` pair with fixture tests, and an entry in
`sourceNames` on the web side.

## Archidekt endpoints

Discovered from the site's client bundle; there is no published API
documentation, so shapes are de facto and may change.

- Search: `GET https://archidekt.com/api/decks/v3/?name=<text>&deckFormat=<id>&orderBy=-viewCount&page=<n>`
  - `commanderName=<exact card name>` and `cardName=<exact card name>` replace
    `name` for commander and card searches. Both need an exact card name, so
    the typed text is resolved through Scryfall autocomplete first
    (`matchedCard` / `cardMatches` in the response let the user pick another).
  - `count: -1` means the card filter matched nothing.
  - Page size is server-controlled; `next` (nullable) signals more pages.
  - Format ids (`deckFormat`): Standard 1, Modern 2, Commander 3, Legacy 4,
    Vintage 5, Pauper 6, Pioneer 15. Formats Deckpress cannot name (Brawl,
    Oathbreaker, Historic, …) are shown with Archidekt's label and imported as
    `Casual`, or `Commander` for Commander variants.
- Detail: `GET https://archidekt.com/api/decks/<id>/`
  - `cards[].card.oracleCard.name`, `card.edition.editioncode`,
    `card.collectorNumber`, `quantity`, `categories[]`.
  - Cards in any category with `includedInDeck: false` become the maybeboard
    (even if also tagged `Commander`); otherwise a category named `Commander`
    becomes the commander zone, `Sideboard` the sideboard and everything else
    the main deck.
- Private and unlisted decks are dropped from results even when returned, and
  `detail`/`import` refuse them by id; a page that ends up empty still exposes
  `hasMore` so the next public page stays reachable.
- Imports are bounded like every other deck (`validate.rs`: 1000 lines, 250
  copies per line, 1500 cards) before any Scryfall lookup.
- Cover art comes from `https://storage.googleapis.com/archidekt-card-images/…`
  (older decks) or `https://card-images.archidekt.com/…` (`.webp`);
  `images::validate_image_url` allows that bucket path and that host.
- Descriptions are Quill deltas (`{"ops":[{"insert":…}]}`); `plain_description`
  joins the string inserts and truncates to 1200 characters.

Recorded responses live in `packages/core/fixtures/archidekt_*.json` and
drive the normalisation tests in `packages/core/tests/decksearch.rs`; no test
touches the network.

## Terms of use and attribution

Archidekt's terms (`https://archidekt.com/terms`, checked September 2026) grant
access for personal, non-commercial use and prohibit automated searches,
requests or queries. Deckpress is a single-user desktop app that only issues
requests in direct response to a user typing a search or clicking a deck, and
never crawls, but the wording is broad enough that this feature should be
confirmed with Archidekt (or replaced with an official API) before a public
release. No attribution requirement is stated; Deckpress still:

- labels every result and preview with its source and links to the deck page;
- writes `Imported from Archidekt by <author>: <url>` into the new deck's
  notes so the original author stays credited.

Scryfall's terms ask for identification via `User-Agent` and `Accept` headers
and ≥ 50–100 ms between requests; the existing 550 ms limiter covers this.

## Rate limits and caching

Archidekt publishes no rate limit. `DeckSearch` spaces requests to
`archidekt.com` at least 1 s apart (one limiter per host, same shape as the
Scryfall limiter in `providers.rs`) and backs off 30 s after an HTTP 429,
surfacing "Archidekt is rate limiting requests. Wait 30 seconds and retry." to
the user. Search text is debounced for 450 ms in the UI before a request is
made.

Every Archidekt and Scryfall JSON response is cached in the SQLite `cache` kind
through the store's 24-hour TTL, keyed by URL, so paging back, reopening a
preview or importing after a preview costs no extra request.

## Known limitations

- Archidekt only. Moxfield stays out until an endpoint that answers without a
  browser session is verified.
- Commander and card searches use the first Scryfall autocomplete match that
  looks right (exact match, else a "Name, Title" candidate for commanders);
  other candidates are offered as chips.
- Archidekt returns pages of a fixed size (60 decks) sorted by view count;
  there is no server-side sort or colour filter exposed in the UI yet.
- Cards Scryfall cannot resolve are listed before import and left out of the
  created deck; the user adds them from the deck editor.
- Archidekt's terms question above is unresolved.
