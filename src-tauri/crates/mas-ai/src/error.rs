use mas_core::CoreError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AiError {
    #[error("Provider unavailable: {0}")]
    ProviderUnavailable(String),

    #[error("Request failed: {0}")]
    RequestFailed(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Streaming error: {0}")]
    StreamError(String),

    #[error("Context error: {0}")]
    ContextError(String),

    #[error("Conversation not found: {0}")]
    ConversationNotFound(String),

    #[error(transparent)]
    Core(#[from] CoreError),
}

impl serde::Serialize for AiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
