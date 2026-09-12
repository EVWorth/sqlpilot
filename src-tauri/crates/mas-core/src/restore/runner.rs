use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::restore::splitter::StatementSplitter;
use crate::schema::ident::quote_ident;
use serde::{Deserialize, Serialize};
use sqlx::AssertSqlSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

/// How much of the file is read at a time. The splitter holds at most one
/// statement, so this bounds the reader rather than the memory.
const READ_CHUNK_BYTES: usize = 256 * 1024;

/// The shortest gap between two progress reports.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    /// Stop at the first statement that fails.
    pub stop_on_error: bool,
    /// Turn off foreign-key and uniqueness checks for the session.
    ///
    /// A dump written by SQLPilot or mysqldump does this in its own header,
    /// but a hand-written file or one table's worth of INSERTs will not, and
    /// then the order of the file decides whether it restores. Off at the end
    /// whatever happens.
    pub disable_foreign_key_checks: bool,
    /// Wrap the run in a transaction.
    ///
    /// Worth having for a data-only file, where it makes the restore all or
    /// nothing. It cannot make a dump with DDL atomic: `CREATE`, `DROP` and
    /// `ALTER` each commit the open transaction before they run, which is
    /// MySQL's behaviour and not something a client can switch off. Verified
    /// on MySQL 8.0.46: a `ROLLBACK` after `CREATE TABLE` + `INSERT` left both
    /// the table and the row in place.
    pub wrap_in_transaction: bool,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        Self {
            stop_on_error: true,
            disable_foreign_key_checks: true,
            wrap_in_transaction: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgress {
    #[specta(type = specta_typescript::Number)]
    pub statements_run: u64,
    #[specta(type = specta_typescript::Number)]
    pub statements_failed: u64,
    #[specta(type = specta_typescript::Number)]
    pub bytes_read: u64,
    /// The file's size, so the bar has a denominator.
    #[specta(type = specta_typescript::Number)]
    pub total_bytes: u64,
    #[specta(type = specta_typescript::Number)]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    #[specta(type = specta_typescript::Number)]
    pub statements_run: u64,
    #[specta(type = specta_typescript::Number)]
    pub statements_failed: u64,
    #[specta(type = specta_typescript::Number)]
    pub bytes_read: u64,
    #[specta(type = specta_typescript::Number)]
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// Whether the transaction was rolled back.
    pub rolled_back: bool,
    /// True when something had already been committed before the failure —
    /// which any DDL in the file guarantees. The difference between "nothing
    /// happened" and "some of it happened" is the thing a user most needs to
    /// be told, and the old restore never said it.
    pub partially_applied: bool,
    /// One line per failure, in the order they happened. Capped, because a
    /// file whose every statement fails should not produce a million of them.
    pub errors: Vec<String>,
}

/// How many failures are reported before the rest are counted only.
const MAX_REPORTED_ERRORS: usize = 100;

/// Run `path` against `database` on `connection_id`.
#[allow(clippy::too_many_arguments)]
pub async fn run_restore(
    manager: Arc<ConnectionManager>,
    connection_id: &str,
    database: &str,
    path: &std::path::Path,
    options: &RestoreOptions,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(RestoreProgress),
) -> Result<RestoreSummary, CoreError> {
    let started = Instant::now();
    let pool = manager.get_pool(connection_id)?;

    if manager.is_read_only(connection_id) {
        return Err(CoreError::ReadOnly(
            "This connection is marked read-only, so a restore cannot run on it".to_string(),
        ));
    }

    let total_bytes = tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| CoreError::Storage(format!("Could not read {}: {e}", path.display())))?;
    let mut reader = tokio::io::BufReader::new(file);

    // One connection for the whole restore: `USE`, the session settings and
    // the transaction all have to apply to the session running the
    // statements, and a pool does not promise that.
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| CoreError::Connection(format!("Could not start the restore: {e}")))?;

    sqlx::raw_sql(AssertSqlSafe(format!("USE {}", quote_ident(database))))
        .execute(&mut *conn)
        .await
        .map_err(|e| CoreError::Query(format!("Could not open {database}: {e}")))?;

    if options.disable_foreign_key_checks {
        let _ = sqlx::raw_sql(AssertSqlSafe(
            "SET SESSION foreign_key_checks = 0, unique_checks = 0".to_string(),
        ))
        .execute(&mut *conn)
        .await;
    }

    let mut in_transaction = false;
    if options.wrap_in_transaction {
        in_transaction = sqlx::raw_sql(AssertSqlSafe("START TRANSACTION".to_string()))
            .execute(&mut *conn)
            .await
            .is_ok();
    }

    let mut splitter = StatementSplitter::new();
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    // Bytes left over from a chunk that ended mid-character.
    let mut carry: Vec<u8> = Vec::new();

    let mut state = State {
        statements_run: 0,
        statements_failed: 0,
        bytes_read: 0,
        total_bytes,
        started,
        last_emit: Instant::now(),
    };
    let mut errors: Vec<String> = Vec::new();
    let mut committed_something = false;
    let mut stopped = false;

    'outer: loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|e| CoreError::Storage(format!("Reading the file failed: {e}")))?;
        if read == 0 {
            break;
        }
        state.bytes_read += read as u64;

        carry.extend_from_slice(&buffer[..read]);
        // A multi-byte character can straddle a chunk boundary; keep the tail
        // until the rest of it arrives rather than replacing it with U+FFFD.
        let text = match std::str::from_utf8(&carry) {
            Ok(text) => {
                let owned = text.to_string();
                carry.clear();
                owned
            }
            Err(e) => {
                let valid = e.valid_up_to();
                let owned = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                owned
            }
        };

        for statement in splitter.push(&text) {
            if cancel.load(Ordering::Relaxed) {
                break 'outer;
            }
            let outcome = run_one(&mut conn, &statement).await;
            record(
                outcome,
                &statement,
                &mut state,
                &mut errors,
                &mut committed_something,
            );
            if state.statements_failed > 0 && options.stop_on_error {
                stopped = true;
                break 'outer;
            }
            state.emit(&mut on_progress, false);
        }
    }

    // Whatever the splitter is still holding. A truncated file is reported
    // here rather than hanging (#360).
    if !stopped && !cancel.load(Ordering::Relaxed) {
        match splitter.finish() {
            Ok(Some(statement)) => {
                let outcome = run_one(&mut conn, &statement).await;
                record(
                    outcome,
                    &statement,
                    &mut state,
                    &mut errors,
                    &mut committed_something,
                );
            }
            Ok(None) => {}
            Err(e) => {
                // Nothing runs after this point either way — the file is over
                // — so this only has to be counted and reported.
                state.statements_failed += 1;
                errors.push(e.to_string());
            }
        }
    }

    let cancelled = cancel.load(Ordering::Relaxed);
    let failed = state.statements_failed > 0;
    let roll_back = in_transaction && (cancelled || (failed && options.stop_on_error));

    if in_transaction {
        let statement = if roll_back { "ROLLBACK" } else { "COMMIT" };
        let _ = sqlx::raw_sql(AssertSqlSafe(statement.to_string()))
            .execute(&mut *conn)
            .await;
    }

    if options.disable_foreign_key_checks {
        let _ = sqlx::raw_sql(AssertSqlSafe(
            "SET SESSION foreign_key_checks = 1, unique_checks = 1".to_string(),
        ))
        .execute(&mut *conn)
        .await;
    }

    state.emit(&mut on_progress, true);

    Ok(RestoreSummary {
        statements_run: state.statements_run,
        statements_failed: state.statements_failed,
        bytes_read: state.bytes_read,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled,
        rolled_back: roll_back,
        // A rollback undoes only what had not already been committed. Any DDL
        // in the file commits as it runs, so a dump that got as far as a
        // CREATE has changed the database whatever happens next.
        partially_applied: (cancelled || failed) && (!roll_back || committed_something),
        errors,
    })
}

async fn run_one(
    conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    statement: &str,
) -> Result<(), String> {
    sqlx::raw_sql(AssertSqlSafe(statement.to_string()))
        .execute(&mut **conn)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn record(
    outcome: Result<(), String>,
    statement: &str,
    state: &mut State,
    errors: &mut Vec<String>,
    committed_something: &mut bool,
) {
    match outcome {
        Ok(()) => {
            state.statements_run += 1;
            if commits_implicitly(statement) {
                *committed_something = true;
            }
        }
        Err(e) => {
            state.statements_failed += 1;
            if errors.len() < MAX_REPORTED_ERRORS {
                errors.push(format!("Statement {}: {e}", state.statements_run + 1));
            }
        }
    }
}

/// Whether a statement ends the open transaction just by running.
///
/// MySQL commits before every DDL statement; there is no way to ask it not
/// to. Knowing which statements did it is what lets the summary say whether
/// a rollback actually undid anything.
fn commits_implicitly(statement: &str) -> bool {
    let head = statement
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_uppercase();
    matches!(
        head.as_str(),
        "CREATE"
            | "ALTER"
            | "DROP"
            | "RENAME"
            | "TRUNCATE"
            | "GRANT"
            | "REVOKE"
            | "LOCK"
            | "UNLOCK"
            | "FLUSH"
            | "ANALYZE"
            | "OPTIMIZE"
            | "REPAIR"
            | "INSTALL"
            | "UNINSTALL"
    )
}

struct State {
    statements_run: u64,
    statements_failed: u64,
    bytes_read: u64,
    total_bytes: u64,
    started: Instant,
    last_emit: Instant,
}

impl State {
    fn emit(&mut self, on_progress: &mut impl FnMut(RestoreProgress), force: bool) {
        if !force && self.last_emit.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.last_emit = Instant::now();
        on_progress(RestoreProgress {
            statements_run: self.statements_run,
            statements_failed: self.statements_failed,
            bytes_read: self.bytes_read,
            total_bytes: self.total_bytes,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ddl_is_known_to_commit_and_dml_is_not() {
        // What the summary uses to tell "nothing happened" from "some of it
        // happened".
        for ddl in [
            "CREATE TABLE t (a int)",
            "  drop table t",
            "ALTER TABLE t ADD b int",
        ] {
            assert!(commits_implicitly(ddl), "{ddl}");
        }
        for dml in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
        ] {
            assert!(!commits_implicitly(dml), "{dml}");
        }
    }

    #[test]
    fn the_defaults_stop_at_the_first_error() {
        // Carrying on past a failed CREATE means every INSERT after it fails
        // too, and the error list becomes noise.
        let options = RestoreOptions::default();
        assert!(options.stop_on_error);
        assert!(options.wrap_in_transaction);
        assert!(options.disable_foreign_key_checks);
    }
}
