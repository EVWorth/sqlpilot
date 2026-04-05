use thiserror::Error;

#[derive(Debug, Error)]
pub enum AiError {
    #[error("Copilot SDK error: {0}")]
    SdkError(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Not connected to database")]
    NotConnected,
    #[error("Tool execution failed: {0}")]
    ToolError(String),
    #[error("Permission denied")]
    PermissionDenied,
    #[error("Context error: {0}")]
    ContextError(String),
    #[error("Cancelled")]
    Cancelled,
}

impl serde::Serialize for AiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
