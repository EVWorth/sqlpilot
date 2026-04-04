use thiserror::Error;

#[derive(Error, Debug)]
pub enum CoreError {
    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Query error: {0}")]
    Query(String),

    #[error("Schema error: {0}")]
    Schema(String),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("SSH tunnel error: {0}")]
    SSH(String),

    #[error("SSL/TLS error: {0}")]
    SSL(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("Cancelled")]
    Cancelled,

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Rusqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    Serde(#[from] serde_json::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl serde::Serialize for CoreError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
