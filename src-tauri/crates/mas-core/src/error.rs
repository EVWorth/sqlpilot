use crate::models::query::QueryResult;
use crate::query::TransactionState;
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

    /// Another error, tagged with which statement of a batch raised it.
    ///
    /// A wrapper rather than a field on every variant: only the multi-statement
    /// executor knows the index, and only the frontend that has to point at a
    /// line cares (#329). Display passes straight through, so nothing that
    /// only reads the message has to know this exists.
    #[error("{source}")]
    AtStatement {
        index: usize,
        source: Box<CoreError>,
        /// What the statements before this one returned, in order, so a
        /// script's earlier results are not lost with its error (#845).
        /// Empty when the first statement failed, and from callers that do
        /// not collect results.
        completed: Vec<QueryResult>,
        /// Whether the editor session the run failed on is still inside a
        /// transaction, asked of the server after the failure (#917). `None`
        /// off a session, and when the server could not say.
        transaction: Option<TransactionState>,
    },

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Rusqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    Serde(#[from] serde_json::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl CoreError {
    /// The error underneath any statement tag, for callers that care what
    /// went wrong rather than where in a batch it did.
    pub fn root(&self) -> &CoreError {
        match self {
            CoreError::AtStatement { source, .. } => source.root(),
            other => other,
        }
    }
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
    /// Which statement of a multi-statement run failed, zero-based.
    ///
    /// A script whose third statement failed used to surface as one opaque
    /// failure, with no way to tell which line to look at (#329).
    #[specta(type = Option<specta_typescript::Number>)]
    pub statement_index: Option<usize>,
    /// The results of the statements that ran before the failing one, when a
    /// run stopped at its second statement or later (#845).
    ///
    /// The error used to be all a failed script returned, so the result of
    /// every statement that succeeded before it was thrown away. `None` when
    /// the first statement failed, and for failures outside a batch, and then
    /// left out of the payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_results: Option<Vec<QueryResult>>,
    /// Whether the editor session the run failed on is still inside a
    /// transaction, read from the server after the failure (#917).
    ///
    /// A failing statement does not end a transaction, so a script that
    /// opened one and then failed leaves it open, and only the server can
    /// say so reliably. `None` off an editor session, when the probe could
    /// not tell, and for failures with no statement index; then left out of
    /// the payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<TransactionState>,
}

impl QueryError {
    /// Pull whatever structure the driver attached out of a `CoreError`.
    ///
    /// A failure that never reached a server — a pool timeout, a cancelled
    /// statement — has no code to report, and says so with `None` rather than
    /// a placeholder the frontend would have to know to ignore.
    pub fn from_core(err: &CoreError) -> Self {
        // Unwrap the statement tag first, then read the error underneath it.
        if let CoreError::AtStatement {
            index,
            source,
            completed,
            transaction,
        } = err
        {
            let mut reported = Self::from_core(source).at_statement(*index);
            if *index > 0 && !completed.is_empty() {
                reported.completed_results = Some(completed.clone());
            }
            reported.transaction = *transaction;
            return reported;
        }

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
                    statement_index: None,
                    completed_results: None,
                    transaction: None,
                }
            }
            CoreError::Rusqlite(e) => Self::from_rusqlite(e, &message),
            _ => Self {
                message,
                code: None,
                sql_state: None,
                statement_index: None,
                completed_results: None,
                transaction: None,
            },
        }
    }

    /// The same for a rusqlite error, so the SQLite backend reports failures
    /// in the shape the shared pane already reads.
    pub fn from_rusqlite(err: &rusqlite::Error, fallback: &str) -> Self {
        match err {
            rusqlite::Error::SqliteFailure(e, detail) => Self {
                statement_index: None,
                message: detail.clone().unwrap_or_else(|| fallback.to_string()),
                // The extended code is the useful one: it separates a UNIQUE
                // violation from a NOT NULL violation, where the primary code
                // calls both "constraint failed".
                code: Some(e.extended_code.unsigned_abs()),
                sql_state: None,
                completed_results: None,
                transaction: None,
            },
            _ => Self {
                message: fallback.to_string(),
                code: None,
                sql_state: None,
                statement_index: None,
                completed_results: None,
                transaction: None,
            },
        }
    }

    /// Say which statement this was, for a multi-statement run.
    #[must_use]
    pub fn at_statement(mut self, index: usize) -> Self {
        self.statement_index = Some(index);
        self
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

    fn count_result(index: usize, sql: &str) -> QueryResult {
        QueryResult {
            query_id: format!("q{index}"),
            statement_index: index,
            sql: sql.to_string(),
            columns: vec![],
            rows: vec![],
            rows_affected: 1,
            execution_time_ms: 0,
            warnings: vec![],
            rows_truncated: false,
            truncation_reason: None,
            total_rows_available: None,
            transaction: None,
        }
    }

    fn failed_at(index: usize, completed: Vec<QueryResult>) -> CoreError {
        CoreError::AtStatement {
            index,
            source: Box::new(CoreError::Query("boom".into())),
            completed,
            transaction: None,
        }
    }

    #[test]
    fn a_failure_after_the_first_statement_carries_the_earlier_results() {
        let completed = vec![count_result(0, "INSERT INTO t VALUES (1)")];
        let reported = QueryError::from_core(&failed_at(1, completed));

        assert_eq!(reported.statement_index, Some(1));
        let carried = reported.completed_results.expect("earlier results kept");
        assert_eq!(carried.len(), 1);
        assert_eq!(carried[0].sql, "INSERT INTO t VALUES (1)");
    }

    #[test]
    fn a_failure_at_the_first_statement_carries_no_results() {
        let reported = QueryError::from_core(&failed_at(0, vec![]));
        assert_eq!(reported.statement_index, Some(0));
        assert!(reported.completed_results.is_none());
    }

    #[test]
    fn a_failure_outside_a_batch_carries_no_results() {
        let reported = QueryError::from_core(&CoreError::Query("boom".into()));
        assert!(reported.completed_results.is_none());
    }

    #[test]
    fn completed_results_serialise_under_the_name_the_frontend_reads() {
        let completed = vec![count_result(0, "SELECT 1")];
        let json = serde_json::to_value(QueryError::from_core(&failed_at(1, completed)))
            .expect("serialises");

        assert_eq!(json["statementIndex"], 1);
        assert_eq!(json["completedResults"][0]["sql"], "SELECT 1");
        assert_eq!(json["completedResults"][0]["statement_index"], 0);

        let json =
            serde_json::to_value(QueryError::from_core(&failed_at(0, vec![]))).expect("serialises");
        assert!(
            json.get("completedResults").is_none(),
            "omitted when none: {json}"
        );
    }

    #[test]
    fn a_failure_on_a_session_carries_its_transaction_state() {
        let err = CoreError::AtStatement {
            index: 1,
            source: Box::new(CoreError::Query("boom".into())),
            completed: vec![count_result(0, "BEGIN")],
            transaction: Some(TransactionState::Open),
        };
        let reported = QueryError::from_core(&err);
        assert_eq!(reported.transaction, Some(TransactionState::Open));

        let json = serde_json::to_value(&reported).expect("serialises");
        assert_eq!(json["transaction"], "open");
        assert_eq!(json["statementIndex"], 1);
    }

    #[test]
    fn transaction_state_is_omitted_when_unknown() {
        let json =
            serde_json::to_value(QueryError::from_core(&failed_at(1, vec![]))).expect("serialises");
        assert!(json.get("transaction").is_none(), "omitted: {json}");
    }

    #[test]
    fn root_sees_through_the_statement_tag() {
        let err = CoreError::AtStatement {
            index: 2,
            source: Box::new(CoreError::Timeout("took too long".into())),
            completed: vec![],
            transaction: None,
        };
        assert!(matches!(err.root(), CoreError::Timeout(_)));
        assert!(matches!(CoreError::Cancelled.root(), CoreError::Cancelled));
    }

    #[test]
    fn a_result_reports_its_transaction_state_only_when_it_has_one() {
        let mut result = count_result(0, "BEGIN");
        let json = serde_json::to_value(&result).expect("serialises");
        assert!(
            json.get("transaction").is_none(),
            "omitted when unknown: {json}"
        );

        result.transaction = Some(crate::query::TransactionState::Open);
        let json = serde_json::to_value(&result).expect("serialises");
        assert_eq!(json["transaction"], "open");

        result.transaction = Some(crate::query::TransactionState::None);
        let json = serde_json::to_value(&result).expect("serialises");
        assert_eq!(json["transaction"], "none");

        let back: QueryResult = serde_json::from_value(json).expect("round-trips");
        assert_eq!(back.transaction, Some(crate::query::TransactionState::None));
    }
}
