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

    #[error("Read-only connection: {0}")]
    ReadOnly(String),

    #[error("Connection pool exhausted: {0}")]
    PoolExhausted(String),

    #[error("Out of memory: {0}")]
    OutOfMemory(String),

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

/// A query failure in the shape the frontend can act on.
///
/// Commands hand the frontend `Result<_, String>`, which is enough to show a
/// message and nothing else: the history panel could not tell a missing table
/// from a syntax error, and a user debugging a recurring failure had to rerun
/// the query to find out which table was missing (#324).
///
/// The driver already knows more than the message says. MySQL reports an error
/// number (1146 for an unknown table) and a SQLSTATE (42S02); SQLite reports an
/// extended result code. Both are stable identifiers worth keeping, so this
/// carries them alongside the text rather than flattening everything to one
/// string at the boundary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    /// The message the user reads. Always present.
    pub message: String,
    /// Driver error number: MySQL's error code, or SQLite's extended result
    /// code. `None` for failures that never reached a server.
    pub code: Option<u32>,
    /// SQLSTATE, where the driver supplies one. MySQL does; SQLite does not.
    pub sql_state: Option<String>,
}

impl QueryError {
    /// Pull whatever structure the driver attached out of a `CoreError`.
    ///
    /// A failure that never reached a server — a pool timeout, a cancelled
    /// statement — has no code to report, and says so with `None` rather than
    /// a placeholder the frontend would have to know to ignore.
    pub fn from_core(err: &CoreError) -> Self {
        let message = err.to_string();

        match err {
            CoreError::Sqlx(sqlx::Error::Database(db)) => {
                let sql_state = db.code().map(|c| c.to_string());
                // sqlx exposes the vendor number only through the concrete
                // driver error, so this is a downcast rather than a trait call.
                let code = db
                    .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                    .map(|e| u32::from(e.number()));
                Self {
                    message: db.message().to_string(),
                    code,
                    sql_state,
                }
            }
            CoreError::Rusqlite(e) => Self::from_rusqlite(e, &message),
            _ => Self {
                message,
                code: None,
                sql_state: None,
            },
        }
    }

    /// The same for a rusqlite error, so the SQLite backend reports failures
    /// in the shape the shared pane already reads.
    pub fn from_rusqlite(err: &rusqlite::Error, fallback: &str) -> Self {
        match err {
            rusqlite::Error::SqliteFailure(e, detail) => Self {
                message: detail.clone().unwrap_or_else(|| fallback.to_string()),
                // The extended code is the useful one: it separates a UNIQUE
                // violation from a NOT NULL violation, where the primary code
                // calls both "constraint failed".
                code: Some(e.extended_code.unsigned_abs()),
                sql_state: None,
            },
            _ => Self {
                message: fallback.to_string(),
                code: None,
                sql_state: None,
            },
        }
    }
}

impl From<CoreError> for QueryError {
    fn from(err: CoreError) -> Self {
        Self::from_core(&err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sqlite_failure_reports_its_extended_code() {
        let err = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(2067), // SQLITE_CONSTRAINT_UNIQUE
            Some("UNIQUE constraint failed: users.email".to_string()),
        );

        let reported = QueryError::from_rusqlite(&err, "fallback");
        assert_eq!(reported.code, Some(2067));
        assert_eq!(reported.message, "UNIQUE constraint failed: users.email");
        assert_eq!(reported.sql_state, None, "SQLite has no SQLSTATE");
    }

    #[test]
    fn a_failure_that_never_reached_a_server_reports_no_code() {
        let reported = QueryError::from_core(&CoreError::Timeout("took too long".into()));
        assert_eq!(reported.code, None);
        assert_eq!(reported.sql_state, None);
        assert!(reported.message.contains("took too long"));
    }

    #[test]
    fn a_rusqlite_error_without_a_detail_falls_back_to_the_display_form() {
        let err = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(1), None);
        let reported = QueryError::from_rusqlite(&err, "Query error: bad things");
        assert_eq!(reported.message, "Query error: bad things");
        assert_eq!(reported.code, Some(1));
    }
}
