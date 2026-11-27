use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{redirect, Client, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::store::Store;

use super::Providers;

pub const USER_AGENT: &str = "Deckpress/0.1 (local playtest tool)";
const SCRYFALL_INTERVAL: Duration = Duration::from_millis(550);
const SCRYFALL_BACKOFF: Duration = Duration::from_secs(15);
const SCRYFALL_MAX_BACKOFF: Duration = Duration::from_secs(30);
const SCRYFALL_RETRIES: u32 = 3;

fn cache_key(url: &str, body: Option<&Value>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hasher.update(
        serde_json::to_string(&body.cloned().unwrap_or(Value::Null))
            .unwrap_or_default()
            .as_bytes(),
    );
    hex::encode(hasher.finalize())
}

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let value = response.headers().get("Retry-After")?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse() {
        return Some(Duration::from_secs(seconds));
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        date.signed_duration_since(chrono::Utc::now())
            .to_std()
            .unwrap_or_default(),
    )
}

impl Providers {
    pub fn new(store: Arc<Store>) -> AppResult<Self> {
        Self::with_origin(store, None)
    }

    /// Uses an alternate origin for Scryfall, leaving other providers unchanged.
    pub fn with_scryfall_origin(store: Arc<Store>, origin: Url) -> AppResult<Self> {
        Self::with_origin(store, Some(origin))
    }

    fn with_origin(store: Arc<Store>, scryfall_origin: Option<Url>) -> AppResult<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .build()?;
        Ok(Self {
            store,
            client,
            scryfall_next: Mutex::new(Instant::now()),
            scryfall_origin,
        })
    }

    pub async fn json(&self, url: &str, body: Option<Value>) -> AppResult<Value> {
        self.json_or_status(url, body, false, |_| {})
            .await?
            .map_err(|status| {
                AppError::user(format!(
                    "Provider returned {status}. Try again or import an exported decklist instead."
                ))
            })
    }

    /// Like [`Self::json`], but hands a non-success HTTP status back to the
    /// caller so it can explain that provider's refusal.
    pub(super) async fn json_or_status(
        &self,
        url: &str,
        body: Option<Value>,
        allow_missing: bool,
        on_retry: impl Fn(Duration),
    ) -> AppResult<Result<Value, u16>> {
        let key = cache_key(url, body.as_ref());
        if let Some(cached) = self.store.cached(&key)? {
            return Ok(Ok(cached));
        }
        let parsed = Url::parse(url).map_err(|_| AppError::user("Invalid provider URL"))?;
        let scryfall = parsed.host_str() == Some("api.scryfall.com");
        let endpoint = if let Some(origin) = self.scryfall_origin.as_ref().filter(|_| scryfall) {
            let mut endpoint = origin.clone();
            endpoint.set_path(parsed.path());
            endpoint.set_query(parsed.query());
            endpoint
        } else {
            parsed.clone()
        };
        let mut attempt = 0;
        let response = loop {
            let mut next = if scryfall {
                let next = self.scryfall_next.lock().await;
                if let Some(cached) = self.store.cached(&key)? {
                    return Ok(Ok(cached));
                }
                Some(next)
            } else {
                None
            };
            if let Some(next) = &mut next {
                tokio::time::sleep((**next).saturating_duration_since(Instant::now())).await;
                **next = Instant::now() + SCRYFALL_INTERVAL;
            }
            let request = match &body {
                Some(body) => self.client.post(endpoint.clone()).json(body),
                None => self.client.get(endpoint.clone()),
            }
            .header("Accept", "application/json");
            let response = request.send().await.map_err(|error| {
                AppError::user(format!(
                    "Could not reach {}: {}",
                    parsed.host_str().unwrap_or("provider"),
                    if error.is_timeout() {
                        "timed out"
                    } else {
                        "network error"
                    }
                ))
            })?;
            if response.status() != StatusCode::TOO_MANY_REQUESTS {
                break response;
            }
            let Some(mut next) = next else {
                return Err(AppError::RateLimited);
            };
            let now = Instant::now();
            let fallback = (SCRYFALL_BACKOFF * (1 << attempt)).min(SCRYFALL_MAX_BACKOFF);
            let delay = retry_after(&response)
                .filter(|delay| now.checked_add(*delay).is_some())
                .unwrap_or(fallback);
            *next = (*next).max(now + delay);
            if attempt == SCRYFALL_RETRIES {
                return Err(AppError::user(
                    "Scryfall is still rate limiting requests. Try again later.",
                ));
            }
            on_retry(next.saturating_duration_since(now));
            attempt += 1;
        };
        if allow_missing && response.status() == StatusCode::NOT_FOUND {
            self.store.put("cache", &key, &Value::Null)?;
            return Ok(Ok(Value::Null));
        }
        if !response.status().is_success() {
            return Ok(Err(response.status().as_u16()));
        }
        let json: Value = response
            .json()
            .await
            .map_err(|_| AppError::user("Provider returned invalid JSON"))?;
        self.store.put("cache", &key, &json)?;
        Ok(Ok(json))
    }

    pub(super) async fn scryfall_json(&self, url: &str) -> AppResult<Value> {
        self.scryfall_json_with_retry(url, |_| {}).await
    }

    pub(super) async fn scryfall_json_with_retry(
        &self,
        url: &str,
        on_retry: impl Fn(Duration),
    ) -> AppResult<Value> {
        self.json_or_status(url, None, true, on_retry)
            .await?
            .map_err(|status| AppError::user(format!("Scryfall returned {status}. Try again.")))
    }
}
