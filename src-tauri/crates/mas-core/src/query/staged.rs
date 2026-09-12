//! A write that has run but not been committed.
//!
//! "Are you sure?" is a question nobody can answer well, because the thing
//! being asked about — how much data this changes — is not in the statement.
//! `UPDATE orders SET status = 'x' WHERE customer_id = 42` affects one row or
//! four million, and the difference is in the data.
//!
//! So the statement is run first, inside a transaction, and the user is asked
//! afterwards with the real number in front of them. Answering yes commits;
//! answering no rolls back, and nothing ever happened.
//!
//! Two things follow from holding a transaction open while a person reads a
//! dialog, and both are handled here rather than left to the caller:
//!
//! 1. **It holds locks.** Every staged write has a deadline, and a staged
//!    write nobody answers rolls back rather than blocking other sessions
//!    indefinitely.
//! 2. **It only works for DML.** MySQL commits the open transaction implicitly
//!    before `CREATE`, `ALTER` and `DROP` — verified against 8.0.46, where a
//!    `ROLLBACK` after `CREATE TABLE` leaves the table. DDL is therefore never
//!    staged; it is approved before it runs, and this module refuses it rather
//!    than pretending it can be undone.

use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, MySqlConnection};

use crate::error::CoreError;
use crate::query::statement::{effective_verb, is_write_statement};
use crate::schema::ident::quote_ident;

/// How long a staged write may wait for an answer before it is rolled back.
///
/// Long enough to read a dialog and think, short enough that a user who walked
/// away does not leave rows locked all afternoon.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(120);

/// A statement that has run and is waiting to be committed or thrown away.
pub struct StagedWrite {
    connection: MySqlConnection,
    /// How many rows the statement actually changed.
    pub rows_affected: u64,
    /// What ran, as it was sent.
    pub sql: String,
    /// When this stops waiting and rolls itself back.
    pub deadline: std::time::Instant,
}

/// Why a statement could not be staged.
#[derive(Debug)]
pub enum StageError {
    /// A schema change. MySQL commits before it, so there would be nothing to
    /// roll back — the approval has to come first.
    CannotBeStaged {
        verb: String,
    },
    Failed(CoreError),
}

impl std::fmt::Display for StageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StageError::CannotBeStaged { verb } => write!(
                f,
                "{verb} cannot be tried and undone: MySQL and MariaDB commit the open transaction \
                 before a schema change, so there would be nothing to roll back. Ask before \
                 running it, not after."
            ),
            StageError::Failed(e) => write!(f, "{e}"),
        }
    }
}

impl From<CoreError> for StageError {
    fn from(e: CoreError) -> Self {
        StageError::Failed(e)
    }
}

impl StagedWrite {
    /// Run a write inside a transaction and hold it open.
    ///
    /// The statement has already been classified and permitted by the caller;
    /// what is checked here is only what this module can honour — a schema
    /// change cannot be staged, whatever anybody decided about it.
    pub async fn begin(
        pool: &sqlx::MySqlPool,
        database: Option<&str>,
        sql: &str,
        deadline: Duration,
    ) -> Result<Self, StageError> {
        let verb = effective_verb(sql);
        if is_ddl(&verb) {
            return Err(StageError::CannotBeStaged { verb });
        }
        if !is_write_statement(sql) {
            // A read staged as a write would hold a transaction open for
            // nothing. The caller has classified it; this catches the case
            // where the two disagree.
            return Err(StageError::CannotBeStaged { verb });
        }

        // One connection, not the pool: the transaction and the statement have
        // to be on the same session, and a pool does not promise that.
        let mut connection = pool
            .acquire()
            .await
            .map_err(|e| CoreError::Connection(format!("Could not take a connection: {e}")))?
            .detach();

        if let Some(database) = database {
            sqlx::raw_sql(AssertSqlSafe(format!("USE {}", quote_ident(database))))
                .execute(&mut connection)
                .await
                .map_err(|e| CoreError::Query(format!("Could not open {database}: {e}")))?;
        }

        sqlx::raw_sql(AssertSqlSafe("START TRANSACTION".to_string()))
            .execute(&mut connection)
            .await
            .map_err(|e| CoreError::Query(format!("Could not start a transaction: {e}")))?;

        let result = sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
            .execute(&mut connection)
            .await;

        match result {
            Ok(done) => Ok(Self {
                rows_affected: done.rows_affected(),
                sql: sql.to_string(),
                deadline: std::time::Instant::now() + deadline,
                connection,
            }),
            Err(e) => {
                // The statement failed, so there is nothing to decide about.
                // Rolling back here rather than leaving it to the caller means
                // the connection goes back clean.
                let _ = sqlx::raw_sql(AssertSqlSafe("ROLLBACK".to_string()))
                    .execute(&mut connection)
                    .await;
                let _ = connection.close().await;
                Err(StageError::Failed(CoreError::Query(e.to_string())))
            }
        }
    }

    /// Keep it. Returns the number of rows that were changed.
    pub async fn commit(mut self) -> Result<u64, CoreError> {
        let rows = self.rows_affected;
        sqlx::raw_sql(AssertSqlSafe("COMMIT".to_string()))
            .execute(&mut self.connection)
            .await
            .map_err(|e| CoreError::Query(format!("Could not commit: {e}")))?;
        let _ = self.connection.close().await;
        Ok(rows)
    }

    /// Throw it away. Nothing happened.
    pub async fn rollback(mut self) -> Result<(), CoreError> {
        sqlx::raw_sql(AssertSqlSafe("ROLLBACK".to_string()))
            .execute(&mut self.connection)
            .await
            .map_err(|e| CoreError::Query(format!("Could not roll back: {e}")))?;
        let _ = self.connection.close().await;
        Ok(())
    }

    /// Whether the deadline has passed.
    pub fn expired(&self) -> bool {
        std::time::Instant::now() >= self.deadline
    }
}

/// Statements MySQL commits before, so nothing after them can be undone.
fn is_ddl(verb: &str) -> bool {
    matches!(
        verb,
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_changes_are_named_as_unstageable() {
        for verb in ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"] {
            assert!(is_ddl(verb), "{verb}");
        }
        for verb in ["INSERT", "UPDATE", "DELETE", "REPLACE", "CALL"] {
            assert!(!is_ddl(verb), "{verb}");
        }
    }

    #[test]
    fn the_refusal_explains_why_rather_than_just_saying_no() {
        // A caller who is told "no" tries again. One who is told the server
        // commits first understands that the order has to change.
        let message = StageError::CannotBeStaged {
            verb: "ALTER".to_string(),
        }
        .to_string();
        assert!(message.contains("commit"), "{message}");
        assert!(message.contains("Ask before"), "{message}");
    }
}
