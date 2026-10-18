//! Saving grid edits on the editor tab's own session (#735).
//!
//! A grid edit belongs to the tab its result came from. On the shared pool it
//! landed on some other connection, so an edit to rows the tab had locked in an
//! open transaction waited on the tab itself, and an edit made inside that
//! transaction committed independently of it.
//!
//! The obvious fix — send the same `START TRANSACTION; …; COMMIT` batch to the
//! tab's session — is the dangerous one: `START TRANSACTION` implicitly commits
//! a transaction that is already open, so a grid save would silently commit the
//! user's in-progress work. So the save first asks whether a transaction is
//! open, and wraps the edits accordingly:
//!
//! - **No transaction open:** `START TRANSACTION … COMMIT`, so a statement
//!   that fails halfway leaves nothing applied. The failure path rolls back
//!   explicitly; on a session that lives as long as the tab, a transaction left
//!   open by a failed save would quietly swallow the user's next statements.
//! - **A transaction open:** a savepoint inside it. The edits become part of
//!   the user's transaction and stay uncommitted, and a failure rolls back to
//!   the savepoint, undoing only this save and leaving the user's own work and
//!   transaction as they were.
//!
//! Everything runs on one acquired connection, so nothing else the tab runs can
//! land between the question and the edits it decided.

use sqlx::pool::PoolConnection;
use sqlx::{AssertSqlSafe, MySql};

use crate::connection::{ConnectionManager, Route};
use crate::error::CoreError;
use crate::query::statement::is_write_statement;

/// The savepoint a save inside the user's transaction runs under.
///
/// Prefixed so it cannot collide with one the user named, which a `SAVEPOINT`
/// of the same name would silently replace.
const SAVEPOINT: &str = "sqlpilot_grid_save";

/// MySQL and MariaDB both raise this when transaction characteristics are set
/// while a transaction is in progress.
const ER_CANT_CHANGE_TX_CHARACTERISTICS: u16 = 1568;

/// Whether the session was inside a transaction when the save began.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    /// No transaction: the edits were applied and committed.
    None,
    /// The user's transaction: the edits were applied inside it and are not
    /// committed until the user commits.
    Open,
}

/// What a save did.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct GridEditOutcome {
    /// Rows each statement changed, in the order given. A statement whose
    /// WHERE no longer matches changes zero rows without failing (#419).
    #[specta(type = Vec<specta_typescript::Number>)]
    pub rows_affected: Vec<u64>,
    pub transaction: TransactionState,
}

/// Ask whether the session on `conn` is inside a transaction.
///
/// MariaDB has `@@in_transaction`; MySQL has nothing equivalent, and the
/// protocol's `SERVER_STATUS_IN_TRANS` flag is not exposed by sqlx. What both
/// servers share is that transaction characteristics cannot change while a
/// transaction is in progress (ER 1568). Assigning the next transaction's
/// isolation level its current session value is refused inside a transaction
/// and changes nothing outside one: it keeps the isolation level and the
/// session's READ ONLY setting, both of which `SET TRANSACTION READ WRITE`, the
/// more obvious probe, would override for the save that follows.
///
/// Verified on MySQL 8.0 and MariaDB 11 against `START TRANSACTION` alone,
/// `BEGIN` then a read, `autocommit = 0` then a write, and the states after
/// `COMMIT` and after DDL's implicit commit. `autocommit = 0` with nothing run
/// yet reads as no transaction, which is right: there is nothing in it to lose.
///
/// `Ok(None)` when the probe fails for any other reason: the server cannot
/// say, and the caller must not guess.
async fn transaction_state(
    conn: &mut PoolConnection<MySql>,
) -> Result<Option<TransactionState>, CoreError> {
    let probe = "SET @@transaction_isolation = @@session.transaction_isolation";
    match sqlx::raw_sql(AssertSqlSafe(probe))
        .execute(&mut **conn)
        .await
    {
        Ok(_) => Ok(Some(TransactionState::None)),
        Err(sqlx::Error::Database(db)) => {
            let number = db
                .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                .map(|e| e.number());
            if number == Some(ER_CANT_CHANGE_TX_CHARACTERISTICS) {
                Ok(Some(TransactionState::Open))
            } else {
                tracing::warn!(error = %db, "Could not tell whether the session is in a transaction");
                Ok(None)
            }
        }
        Err(e) => Err(CoreError::Sqlx(e)),
    }
}

/// Run each statement, collecting the rows it changed.
///
/// One statement per round trip rather than a combined batch, so the failing
/// statement is known exactly and nothing after it is sent.
async fn run_each(
    conn: &mut PoolConnection<MySql>,
    statements: &[String],
) -> Result<Vec<u64>, CoreError> {
    let mut affected = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
        let done = sqlx::raw_sql(AssertSqlSafe(statement.as_str()))
            .execute(&mut **conn)
            .await
            .map_err(|e| CoreError::AtStatement {
                index,
                source: Box::new(CoreError::Sqlx(e)),
            })?;
        affected.push(done.rows_affected());
    }
    Ok(affected)
}

async fn exec(conn: &mut PoolConnection<MySql>, sql: &str) -> Result<(), CoreError> {
    sqlx::raw_sql(AssertSqlSafe(sql))
        .execute(&mut **conn)
        .await?;
    Ok(())
}

/// Undo a failed save, then report the failure that caused it.
///
/// A rollback that itself fails is logged, not returned: the user needs to see
/// why the save failed, and the session will have been dropped by the server
/// if it is that broken.
async fn undo(conn: &mut PoolConnection<MySql>, rollback: &str, cause: CoreError) -> CoreError {
    if let Err(e) = exec(conn, rollback).await {
        tracing::error!(error = %e, rollback, "Could not undo a failed grid save");
    }
    cause
}

/// Apply grid edits on an editor tab's session, without ever committing a
/// transaction the user opened. See the module documentation.
///
/// `Ok(None)` when the session cannot say whether it is in a transaction, so
/// the caller can fall back to the shared pool rather than risk the user's
/// work. Nothing has been applied in that case.
pub async fn apply_in_session(
    manager: &ConnectionManager,
    connection_id: &str,
    session: &str,
    database: Option<&str>,
    statements: &[String],
) -> Result<Option<GridEditOutcome>, CoreError> {
    if manager.is_read_only(connection_id) {
        if let Some(write) = statements.iter().find(|s| is_write_statement(s)) {
            let preview: String = write.chars().take(120).collect();
            return Err(CoreError::ReadOnly(format!(
                "This connection is marked read-only, so it will not run: {preview}"
            )));
        }
    }

    let pool = manager.session_pool(connection_id, session)?;
    let mut conn = pool.acquire().await.map_err(|e| {
        let route = Route::Session(session.to_string());
        manager
            .pool_limits(connection_id, &route)
            .and_then(|limits| crate::connection::describe_pool_error(&e, &limits, &route, 0))
            .unwrap_or(CoreError::Sqlx(e))
    })?;

    if let Some(db) = database {
        exec(&mut conn, &format!("USE `{}`", db.replace('`', "``"))).await?;
    }

    let Some(state) = transaction_state(&mut conn).await? else {
        return Ok(None);
    };

    let (begin, commit, rollback) = match state {
        TransactionState::None => (
            "START TRANSACTION".to_string(),
            "COMMIT".to_string(),
            "ROLLBACK".to_string(),
        ),
        TransactionState::Open => (
            format!("SAVEPOINT {SAVEPOINT}"),
            format!("RELEASE SAVEPOINT {SAVEPOINT}"),
            format!("ROLLBACK TO SAVEPOINT {SAVEPOINT}"),
        ),
    };

    exec(&mut conn, &begin).await?;
    let rows_affected = match run_each(&mut conn, statements).await {
        Ok(affected) => affected,
        Err(e) => return Err(undo(&mut conn, &rollback, e).await),
    };
    if let Err(e) = exec(&mut conn, &commit).await {
        return Err(undo(&mut conn, &rollback, e).await);
    }

    tracing::debug!(
        connection_id,
        session,
        ?state,
        statements = statements.len(),
        "Applied grid edits on the tab's session"
    );
    Ok(Some(GridEditOutcome {
        rows_affected,
        transaction: state,
    }))
}
