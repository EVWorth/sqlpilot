use crate::query::SqliteQueryResult;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SqliteError {
    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Query error: {0}")]
    Query(String),

    #[error("Schema error: {0}")]
    Schema(String),

    #[error("Not found: {0}")]
    NotFound(String),

    /// Another error, tagged with which statement of a script raised it,
    /// mirroring `mas_core::CoreError::AtStatement` (#928). Display passes
    /// straight through.
    #[error("{source}")]
    AtStatement {
        index: usize,
        source: Box<SqliteError>,
        /// What the statements before this one returned, in order. Empty
        /// when the first statement failed.
        completed: Vec<SqliteQueryResult>,
    },

    #[error(transparent)]
    Rusqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    Serde(#[from] serde_json::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl serde::Serialize for SqliteError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
