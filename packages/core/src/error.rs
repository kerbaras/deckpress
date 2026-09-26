use serde::{Serialize, Serializer};

/// User-facing error. Serialized as a plain string so the webview can show it
/// directly; `Internal` variants keep the detail in the log only.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    User(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("The art provider is rate limiting requests. Wait 30 seconds and retry.")]
    RateLimited,
    #[error("Export cancelled")]
    Cancelled,
    #[error("Request failed. Check the application log and try again.")]
    Internal(#[source] Box<dyn std::error::Error + Send + Sync>),
}

impl AppError {
    pub fn user(message: impl Into<String>) -> Self {
        Self::User(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn internal(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self::Internal(error.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Self::Internal(inner) = self {
            let mut detail = inner.to_string();
            let mut source = inner.source();
            while let Some(cause) = source {
                detail.push_str(": ");
                detail.push_str(&cause.to_string());
                source = cause.source();
            }
            log::error!("{detail}");
        }
        serializer.serialize_str(&self.to_string())
    }
}

macro_rules! internal_from {
    ($($ty:ty),* $(,)?) => {$(
        impl From<$ty> for AppError {
            fn from(error: $ty) -> Self {
                Self::internal(error)
            }
        }
    )*};
}

internal_from!(
    std::io::Error,
    rusqlite::Error,
    serde_json::Error,
    image::ImageError,
    reqwest::Error,
    tokio::task::JoinError,
    krilla::error::KrillaError,
    fast_image_resize::ResizeError,
    fast_image_resize::ImageBufferError,
);

impl<R> From<ort::Error<R>> for AppError {
    fn from(error: ort::Error<R>) -> Self {
        Self::internal(format!("ONNX Runtime: {error}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
