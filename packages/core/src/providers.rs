//! Scryfall, MPC Autofill, Moxfield and Archidekt clients. Scryfall calls are
//! paced through a single rate limiter and JSON responses are cached in
//! SQLite for 24 hours.

use std::sync::Arc;
use std::time::Instant;

use reqwest::Client;
use tokio::sync::Mutex;
use url::Url;

use crate::store::Store;

mod collection;
mod deck_urls;
mod http;
mod inventory;
mod localization;
mod mpc;
mod printings;
mod scryfall_card;
mod search;
mod split_search;

pub use deck_urls::moxfield_status_error;
pub use http::USER_AGENT;
pub(crate) use inventory::{PrintingInventoryScope, PrintingLookupProgress};
pub(crate) use localization::validate_language;
pub use mpc::MpcArtwork;
pub use scryfall_card::normalize_scryfall;

pub struct Providers {
    store: Arc<Store>,
    client: Client,
    scryfall_next: Mutex<Instant>,
    scryfall_origin: Option<Url>,
}
