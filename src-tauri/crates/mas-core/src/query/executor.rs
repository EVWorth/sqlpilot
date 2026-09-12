use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::models::{ColumnMeta, QueryResult, SqlValue, TruncationReason};
use dashmap::DashMap;
use futures::StreamExt;
use sqlx::{AssertSqlSafe, Column, Either, Row, TypeInfo};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub struct QueryExecutor {
    connection_manager: Arc<ConnectionManager>,
    /// Server thread id -> the connection it belongs to, for every statement
    /// batch currently running. Cancelling or timing out means issuing `KILL
    /// QUERY` against that thread from a *second* pool connection — dropping
    /// the future on this side would leave the server churning (#420).
    ///
    /// Keyed by thread id rather than by connection because several statements
    /// can be in flight on one connection at once: a dozen callers reach the
    /// executor without going through the editor's single-query gate. Keying by
    /// connection let the shorter one's completion deregister the longer one,
    /// and let a timeout kill whichever thread happened to be registered last.
    in_flight: Arc<DashMap<u64, String>>,
    /// How little free RAM stops a fetch, in MB.
    ///
    /// A field rather than a literal inside MemoryGuard because the block that
    /// turns a tripped guard into a partial, memory-truncated result was the
    /// only path through this file no test could reach: provoking the real
    /// floor means starving the machine of RAM (#540).
    memory_floor_mb: u64,
}

/// The free-RAM floor a fetch stops at. Below this, holding more rows risks
/// taking the process down with the answer still unwritten.
pub const DEFAULT_MEMORY_FLOOR_MB: u64 = 512;

/// Deregisters this execution's thread however it ends — normal return, `?` on
/// a decode error, or an early return on timeout.
///
/// Holds the id in a shared cell because it is only known once the server has
/// answered the prelude, which is after the guard has to exist.
struct InFlightGuard {
    in_flight: Arc<DashMap<u64, String>>,
    thread_id: Arc<AtomicU64>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let id = self.thread_id.load(Ordering::Relaxed);
        if id != 0 {
            self.in_flight.remove(&id);
        }
    }
}

impl QueryExecutor {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self::with_memory_floor_mb(connection_manager, DEFAULT_MEMORY_FLOOR_MB)
    }

    /// An executor that stops fetching at a chosen free-RAM floor.
    ///
    /// Exists so the memory-truncation path can be exercised — set the floor
    /// above the machine's free memory and the guard trips on its first check.
    pub fn with_memory_floor_mb(
        connection_manager: Arc<ConnectionManager>,
        memory_floor_mb: u64,
    ) -> Self {
        Self {
            connection_manager,
            in_flight: Arc::new(DashMap::new()),
            memory_floor_mb,
        }
    }

    /// Ask the server to abort what this connection is running.
    ///
    /// `KILL QUERY` terminates the statement but leaves the session alive, so
    /// the pool connection stays usable. A no-op when nothing is in flight.
    ///
    /// Cancels every statement in flight on the connection, because the caller
    /// asks by connection and the executor has no way to tell which of several
    /// concurrent statements the user meant.
    #[tracing::instrument(skip(self))]
    pub async fn cancel(&self, connection_id: &str) -> Result<(), CoreError> {
        let thread_ids: Vec<u64> = self
            .in_flight
            .iter()
            .filter(|entry| entry.value() == connection_id)
            .map(|entry| *entry.key())
            .collect();
        if thread_ids.is_empty() {
            tracing::debug!(connection_id, "Cancel requested with no query in flight");
            return Ok(());
        }
        let pool = self.connection_manager.get_pool(connection_id)?;
        let mut last_err = None;
        for thread_id in thread_ids {
            if let Err(e) = kill_query(&pool, thread_id).await {
                tracing::warn!(error = %e, thread_id, "Failed to cancel query");
                last_err = Some(e);
            }
        }
        match last_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    #[tracing::instrument(skip(self), fields(connection_id = %connection_id, statement_count))]
    pub async fn execute(
        &self,
        connection_id: &str,
        sql: &str,
        database: Option<String>,
        limit: Option<u64>,
        offset: Option<u64>,
    ) -> Result<Vec<QueryResult>, CoreError> {
        self.execute_owned(
            connection_id.to_string(),
            sql.to_string(),
            database,
            limit,
            offset,
        )
        .await
    }

    #[tracing::instrument(skip(self), fields(connection_id = %connection_id, statement_count))]
    pub async fn execute_owned(
        &self,
        connection_id: String,
        sql: String,
        database: Option<String>,
        limit: Option<u64>,
        // Rows to discard from the start of each result set, for paging.
        offset: Option<u64>,
    ) -> Result<Vec<QueryResult>, CoreError> {
        let pool = self.connection_manager.get_pool(&connection_id)?;
        let statements = split_statements(&sql);

        // The user's SQL is sent exactly as written. The row limit is applied
        // while reading the results instead — see the fetch loop below.
        //
        // This used to append `LIMIT n` to anything that looked row-returning,
        // which is what MySQL Workbench does and what every failure mode of
        // this feature came from. Editing a statement to bound it means
        // parsing it correctly, and each gap in that parsing was either a
        // broken query or a cap that silently did not apply (#520):
        //
        //   SHOW / DESCRIBE (every form)      ERROR 1064
        //   SELECT ... FOR UPDATE             ERROR 1064 — LIMIT must precede
        //                                     the locking clause
        //   SELECT ... LOCK IN SHARE MODE     ERROR 1064
        //   SELECT ... INTO @var / OUTFILE    ERROR 1064
        //   SELECT ... -- trailing comment    the appended LIMIT is commented
        //                                     out, so no cap applied at all
        //   SELECT * FROM (SELECT ... LIMIT 5) x
        //                                     read as already-limited, so no
        //                                     cap applied
        //   TABLE / VALUES / WITH ... SELECT  not matched, so no cap applied
        //
        // Capping the read cannot fail any of those ways, and it bounds
        // statements a LIMIT cannot reach at all — SHOW output, and the result
        // sets a procedure returns. It is the approach DBeaver, DataGrip and
        // psql take for SQL the user wrote. Appending stays correct where the
        // app composes the statement itself, which is what the schema tree
        // does when browsing a table.

        // A profile marked read-only must not be able to change anything —
        // not data, not schema, not privileges. The flag was stored and
        // enforced nowhere but EXPLAIN ANALYZE, so "read-only" protected a
        // connection from exactly one button (#429). Refuse before the batch
        // is assembled, so a script is rejected whole rather than half-run.
        if self.connection_manager.is_read_only(&connection_id) {
            if let Some(offending) = statements
                .iter()
                .find(|stmt| crate::query::statement::is_write_statement(stmt))
            {
                let preview: String = offending.chars().take(120).collect();
                tracing::warn!(
                    connection_id = %connection_id,
                    sql_preview = %preview,
                    "Refused a write on a read-only connection"
                );
                return Err(CoreError::ReadOnly(format!(
                    "This connection is marked read-only, so it will not run: {}",
                    preview
                )));
            }
        }

        // Memory guard: detect OOM before the OS kills us
        let mut mem_guard = MemoryGuard::new(self.memory_floor_mb);

        tracing::Span::current().record("statement_count", statements.len());
        tracing::trace!(sql = %sql, "Full SQL input");

        if statements.is_empty() {
            return Ok(vec![]);
        }

        // Combine all statements into one raw_sql call with &pool.
        //
        // Using &pool (not conn.as_mut()) avoids the HRTB lifetime error that
        // Tauri's `respond_async_serialized` imposes. The pool internally acquires
        // ONE connection for the entire multi-statement execution, so USE db
        // session state is preserved for subsequent statements.
        //
        // raw_sql uses the text protocol (COM_QUERY) which supports USE, SHOW CREATE,
        // CALL, etc. — commands that MySQL rejects over the prepared-statement protocol.
        //
        // `SELECT CONNECTION_ID()` leads every batch so a timeout or an explicit
        // cancel has a thread id to KILL. It rides along in the same COM_QUERY —
        // no extra round trip — and the pool holds one connection for the whole
        // batch, so the id it returns is the one running the user's statements.
        let mut prelude: Vec<String> = vec!["SELECT CONNECTION_ID()".to_string()];
        if let Some(db) = &database {
            let escaped_db = db.replace('`', "``");
            tracing::debug!(database = %db, "Switching database context");
            prelude.push(format!("USE `{}`", escaped_db));
        }
        let prelude_count = prelude.len();
        let combined_sql = format!("{}; {}", prelude.join("; "), statements.join("; "));

        // Prelude results are consumed and discarded; user statements start at 0.
        let mut stmt_idx: isize = -(prelude_count as isize);

        // Absolute deadline, so the bound is on total query time rather than on
        // the gap between two rows.
        let query_timeout = self.connection_manager.get_query_timeout(&connection_id);
        let deadline = query_timeout.map(|d| tokio::time::Instant::now() + d);
        let mut timed_out = false;

        // Zero means "not yet known"; a real MySQL thread id is never zero.
        let my_thread_id = Arc::new(AtomicU64::new(0));
        let _guard = InFlightGuard {
            in_flight: Arc::clone(&self.in_flight),
            thread_id: Arc::clone(&my_thread_id),
        };

        let mut stream = sqlx::raw_sql(AssertSqlSafe(combined_sql)).fetch_many(&pool);
        let mut results = Vec::new();
        let mut current_rows: Vec<sqlx::mysql::MySqlRow> = Vec::new();
        // Whether the CALL being processed has already produced a result set,
        // so its closing OK packet is recognised as a marker rather than
        // reported as an extra empty statement.
        let mut call_emitted = false;
        // Whether a row was actually withheld from the statement being read.
        // Tracked rather than inferred from the row count, so a result that
        // happens to be exactly `limit` rows long is not reported as truncated
        // when nothing was left out.
        let mut limit_reached = false;
        // How many rows of the current result set have been discarded to reach
        // the requested offset.
        let mut skipped: u64 = 0;
        // One skipped row, kept only for its column metadata. A page whose
        // rows were all skipped — the last page of a result whose size is an
        // exact multiple of the page size — would otherwise come back with no
        // columns, and the grid would show it as an empty box rather than as
        // the end of the data.
        let mut skipped_shape: Option<sqlx::mysql::MySqlRow> = None;
        let mut start = Instant::now();

        loop {
            let next = match deadline {
                Some(dl) => match tokio::time::timeout_at(dl, stream.next()).await {
                    Ok(next) => next,
                    Err(_) => {
                        timed_out = true;
                        break;
                    }
                },
                None => stream.next().await,
            };
            let Some(item) = next else { break };
            // Read out of the loop variable before the closure borrows it.
            let failing_statement = usize::try_from(stmt_idx).ok();
            let item = item
                .map_err(|e| {
                    // A pool that has run out reports "pool timed out while waiting
                    // for an open connection", which names neither the pool nor
                    // the limit that caused it (#279).
                    self.connection_manager
                        .pool_limits(&connection_id)
                        .and_then(|(name, max, timeout)| {
                            crate::connection::describe_pool_error(&e, &name, max, timeout)
                        })
                        // Kept as the driver's own error rather than flattened to
                        // a string: the error number and SQLSTATE are the only
                        // things that let the caller tell a missing table from a
                        // syntax error, and to_string() drops both (#324).
                        .unwrap_or_else(|| CoreError::Sqlx(e))
                })
                .map_err(|e| match failing_statement {
                    // Which statement broke, so a script's third line can be
                    // pointed at rather than the whole script blamed (#329).
                    Some(index) => CoreError::AtStatement {
                        index,
                        source: Box::new(e),
                    },
                    None => e,
                })?;
            match item {
                Either::Right(row) => {
                    // The first prelude row carries CONNECTION_ID(). Record it so
                    // cancel/timeout can reach this thread.
                    if stmt_idx == -(prelude_count as isize) {
                        if let Ok(thread_id) = row.try_get::<u64, _>(0) {
                            my_thread_id.store(thread_id, Ordering::Relaxed);
                            self.in_flight.insert(thread_id, connection_id.clone());
                            tracing::debug!(connection_id = %connection_id, thread_id, "Query in flight");
                        }
                    }
                    // Result-set row — accumulate until the trailing Left.
                    if stmt_idx >= 0 {
                        // At the cap: stop keeping rows, but keep draining the
                        // stream. Breaking out here would abandon the rest of a
                        // multi-statement batch, so the cost of the rows the
                        // server has already produced is paid either way —
                        // what is bounded is what the app holds and returns.
                        // Paging skips rows here rather than appending
                        // LIMIT/OFFSET to the statement, for the reasons the
                        // comment at the top of this function gives: rewriting
                        // the user's SQL breaks SHOW, locking clauses,
                        // trailing comments and more. Skipping the read works
                        // on all of them, and on the result sets a procedure
                        // returns, which no OFFSET can reach (#391).
                        //
                        // The server still produces the skipped rows. That
                        // cost is paid by OFFSET too — it scans and discards
                        // just the same — and the stream has to be drained
                        // either way.
                        if offset.is_some_and(|skip| skipped < skip) {
                            skipped += 1;
                            if skipped_shape.is_none() {
                                skipped_shape = Some(row);
                            }
                            continue;
                        }
                        if limit.is_some_and(|max| current_rows.len() as u64 >= max) {
                            limit_reached = true;
                            continue;
                        }
                        // Check memory every 1000 rows to prevent OOM
                        if !current_rows.is_empty()
                            && current_rows.len().is_multiple_of(1000)
                            && mem_guard.check().is_err()
                        {
                            tracing::warn!(
                                rows_accumulated = current_rows.len(),
                                "Memory limit reached, stopping query fetch"
                            );
                            break;
                        }
                        current_rows.push(row);
                    }
                }
                Either::Left(qr) => {
                    // A result set, or a statement reporting a count.
                    //
                    // This used to assume one Left per statement, which CALL
                    // breaks: MySQL sends one result set per SELECT inside the
                    // procedure and then a final OK packet, so N+1 arrive for
                    // one statement. `statements[stmt_idx]` then ran off the
                    // end and panicked — on any procedure that returns rows,
                    // which is to say the ordinary case (#544).
                    //
                    // Past the end, the Left belongs to a statement that has
                    // already reported. Attribute it there rather than
                    // indexing out of bounds.
                    let had_rows = !current_rows.is_empty();
                    let mut call_in_progress = false;
                    if stmt_idx >= 0 {
                        let overrun = stmt_idx as usize >= statements.len();
                        let idx = (stmt_idx as usize).min(statements.len().saturating_sub(1));
                        let stmt = &statements[idx];
                        call_in_progress = crate::query::statement::effective_verb(stmt) == "CALL";
                        let query_id = uuid::Uuid::new_v4().to_string();
                        let execution_time = start.elapsed().as_millis() as u64;
                        let preview: String = stmt.chars().take(200).collect();
                        tracing::debug!(
                            query_id = %query_id,
                            statement_index = idx,
                            sql_preview = %preview,
                            "Executing statement"
                        );
                        tracing::trace!(query_id = %query_id, sql = %stmt, "Full statement SQL");

                        // Whether this is a result set cannot come from the
                        // verb alone. CALL is not in the row-returning list and
                        // could not usefully be: whether it returns rows
                        // depends on the procedure body, not the statement
                        // text. Rows that actually arrived settle it, and the
                        // verb still covers a SELECT that matched nothing, so
                        // an empty result set stays a result set rather than
                        // turning into a count.
                        let is_select =
                            !current_rows.is_empty() || (!overrun && returns_rows(stmt));

                        if is_select {
                            let row_count = current_rows.len() as u64;
                            let truncation = truncation_for(limit_reached, mem_guard.triggered());

                            if execution_time > 1000 {
                                tracing::warn!(
                                    query_id = %query_id,
                                    rows = row_count,
                                    time_ms = execution_time,
                                    "Slow query detected"
                                );
                            }
                            tracing::info!(
                                query_id = %query_id,
                                rows = row_count,
                                time_ms = execution_time,
                                "Query executed"
                            );

                            results.push(build_select_result(
                                query_id,
                                idx,
                                stmt.clone(),
                                &current_rows,
                                execution_time,
                                truncation,
                                skipped_shape.as_ref(),
                            ));
                            call_emitted |= call_in_progress;
                        } else if overrun || (call_in_progress && call_emitted) {
                            // A CALL's closing OK packet. The sets it closes
                            // have already been pushed, so reporting it too
                            // would add a phantom "0 rows affected" after
                            // every procedure call. A CALL that produced no
                            // sets at all does not reach here, and still
                            // reports its count.
                            tracing::trace!(
                                query_id = %query_id,
                                statement_index = idx,
                                "Extra completion marker, already reported"
                            );
                        } else {
                            let rows_affected = qr.rows_affected();

                            if execution_time > 1000 {
                                tracing::warn!(
                                    query_id = %query_id,
                                    rows_affected,
                                    time_ms = execution_time,
                                    "Slow statement detected"
                                );
                            }
                            // Writes carry the actor, so an audit trail can
                            // answer who changed what and not only what
                            // changed (#429).
                            tracing::info!(
                                query_id = %query_id,
                                rows_affected,
                                time_ms = execution_time,
                                actor = %self
                                    .connection_manager
                                    .get_actor(&connection_id)
                                    .unwrap_or_else(|| "unknown".to_string()),
                                sql_preview = %preview,
                                "Statement executed"
                            );

                            results.push(QueryResult {
                                query_id,
                                statement_index: idx,
                                sql: stmt.clone(),
                                columns: vec![],
                                rows: vec![],
                                rows_affected,
                                execution_time_ms: execution_time,
                                warnings: vec![],
                                rows_truncated: false,
                                truncation_reason: None,
                                total_rows_available: None,
                            });
                        }

                        current_rows.clear();
                        limit_reached = false;
                        skipped = 0;
                        skipped_shape = None;
                        start = Instant::now();
                    }
                    // A CALL is not finished until a Left arrives carrying no
                    // rows — its result sets come first, then the OK packet
                    // that closes it. Advancing on each of them would
                    // attribute the procedure's second and later result sets
                    // to whatever statement follows the CALL.
                    //
                    // The protocol's "more results" flag would settle this
                    // exactly, but sqlx does not surface it through
                    // fetch_many, so rows-or-not is the available signal. It
                    // is wrong in one case: a procedure whose final SELECT
                    // matches nothing looks finished one Left early. Result
                    // data and ordering are unaffected either way; only
                    // statement_index, which labels the result tabs, drifts.
                    if !(call_in_progress && had_rows) {
                        stmt_idx += 1;
                        call_emitted = false;
                    }
                }
            }
        }

        // Abandoning the stream would leave the statement running on the server,
        // so tell the server to stop before reporting the timeout.
        if timed_out {
            // Kill first, then read the stream to its end.
            //
            // Dropping it here instead — which is what this did — leaves sqlx
            // to drain the connection's remaining packets before it can go
            // back to the pool, and on MariaDB that drain never finishes: the
            // connection stays checked out for good. `pool_max` timeouts then
            // exhaust the pool, after which the *next* timeout waits for a
            // statement to end naturally rather than at its deadline, and
            // `disconnect` hangs on `pool.close()` for ever. MySQL happened to
            // recover, which is why every test in the tree missed it (#658).
            //
            // Reading on gives sqlx the server's "query interrupted" error,
            // which ends the stream properly and returns the connection.
            let thread_id = my_thread_id.load(Ordering::Relaxed);
            if thread_id != 0 {
                if let Err(e) = kill_query(&pool, thread_id).await {
                    tracing::warn!(error = %e, thread_id, "Failed to kill timed-out query");
                }
            }
            drain_after_kill(&mut stream).await;
            drop(stream);
            let secs = query_timeout.map(|d| d.as_secs()).unwrap_or(0);
            tracing::warn!(connection_id = %connection_id, timeout_secs = secs, "Query timed out");
            return Err(CoreError::Timeout(format!(
                "Query exceeded the {}s timeout for this connection and was cancelled",
                secs
            )));
        }

        // If memory guard triggered mid-stream, process accumulated rows for current statement
        if mem_guard.triggered() && stmt_idx >= 0 && !current_rows.is_empty() {
            let idx = stmt_idx as usize;
            let stmt = &statements[idx];
            let execution_time = start.elapsed().as_millis() as u64;

            let is_select = returns_rows(stmt);

            if is_select {
                results.push(build_select_result(
                    uuid::Uuid::new_v4().to_string(),
                    idx,
                    stmt.clone(),
                    &current_rows,
                    execution_time,
                    Some(TruncationReason::MemoryGuard),
                    None,
                ));
            }
        }

        Ok(results)
    }
}

/// How long to keep reading a killed statement's stream before giving up.
///
/// The server answers a `KILL QUERY` almost at once, so this is not a wait so
/// much as a bound: a server that says nothing costs one grace period rather
/// than a connection that never comes back.
const DRAIN_AFTER_KILL: std::time::Duration = std::time::Duration::from_secs(5);

/// Read a killed statement's stream to its end.
///
/// The rows are discarded — the caller is about to report a timeout. What
/// matters is that the stream finishes, because that is what returns the
/// connection to the pool (#658).
async fn drain_after_kill(
    stream: &mut (impl futures::Stream<
        Item = Result<Either<sqlx::mysql::MySqlQueryResult, sqlx::mysql::MySqlRow>, sqlx::Error>,
    > + Unpin),
) {
    let deadline = tokio::time::Instant::now() + DRAIN_AFTER_KILL;
    loop {
        match tokio::time::timeout_at(deadline, stream.next()).await {
            // The end of the stream, or the interrupted error the kill caused.
            Ok(None) | Ok(Some(Err(_))) => return,
            Ok(Some(Ok(_))) => continue,
            Err(_) => {
                tracing::warn!(
                    "A killed statement's stream did not end within {}s; its connection may be lost",
                    DRAIN_AFTER_KILL.as_secs()
                );
                return;
            }
        }
    }
}

/// Abort the statement running on `thread_id` without dropping its session.
///
/// This needs a connection of its own — the one being killed is busy — so a
/// pool with `pool_max = 1` cannot cancel. That surfaces as an acquire timeout
/// rather than a hang.
async fn kill_query(pool: &sqlx::MySqlPool, thread_id: u64) -> Result<(), CoreError> {
    // thread_id is a u64 read back from the server, not user input.
    sqlx::query(AssertSqlSafe(format!("KILL QUERY {}", thread_id)))
        .execute(pool)
        .await
        .map_err(|e| CoreError::Query(format!("Failed to cancel query: {}", e)))?;
    tracing::info!(thread_id, "Sent KILL QUERY");
    Ok(())
}

/// Decode one cell.
///
/// Every arm goes through `decoded`, which distinguishes three outcomes that
/// the previous `.ok().flatten()` collapsed into one:
///
///   * a genuine SQL NULL      -> SqlValue::Null
///   * a successful decode     -> the typed value
///   * a *failed* decode       -> fall back to the raw text and warn
///
/// Conflating the third with the first is what made every DECIMAL and YEAR
/// column render as NULL (#508). A type this function does not understand
/// should degrade to text, never vanish.
fn extract_value(row: &sqlx::mysql::MySqlRow, index: usize, type_name: &str) -> SqlValue {
    let t = type_name.to_uppercase();
    let t = t.trim();

    match t {
        "BOOLEAN" | "TINYINT(1)" | "BOOL" => {
            decode_or_text::<bool, _>(row, index, t, SqlValue::Bool)
        }
        // Up to 32 bits every value fits in a JSON number exactly, so these
        // stay numeric.
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" => {
            decode_or_text::<i64, _>(row, index, t, SqlValue::Int)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIT" => decode_or_text::<u64, _>(row, index, t, SqlValue::UInt),
        // 64-bit values do not. JSON.parse truncates past 2^53, so a BIGINT id
        // would arrive at the grid with a silently wrong final digit — and get
        // pasted into another query from copy-as-INSERT. Carry the exact digits
        // as text; the frontend uses ColumnMeta to know it is still a number.
        // (#502)
        "BIGINT" => decode_or_text::<i64, _>(row, index, t, |v| SqlValue::String(v.to_string())),
        "BIGINT UNSIGNED" => {
            decode_or_text::<u64, _>(row, index, t, |v| SqlValue::String(v.to_string()))
        }
        // YEAR is an integer, not a timestamp. Asking for a DateTime here is
        // what silently nulled it. (#508)
        "YEAR" => decode_or_text::<u64, _>(row, index, t, SqlValue::UInt),
        "FLOAT" | "DOUBLE" | "REAL" => decode_or_text::<f64, _>(row, index, t, SqlValue::Float),
        // DECIMAL deliberately does NOT go through f64. sqlx refuses to decode
        // it as a number at all without the rust_decimal/bigdecimal feature,
        // and f64 would defeat the exactness the column type exists to give.
        // MySQL sends it as text, so keep the text.
        "DECIMAL" | "NUMERIC" => raw_text(row, index).map(SqlValue::String),
        "JSON" => decode_or_text::<serde_json::Value, _>(row, index, t, |v| {
            SqlValue::String(v.to_string())
        }),
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => {
            decode_or_text::<Vec<u8>, _>(row, index, t, blob_value)
        }
        "DATE" | "DATETIME" | "TIMESTAMP" => {
            decode_or_text::<chrono::DateTime<chrono::Utc>, _>(row, index, t, |dt| {
                SqlValue::String(dt.format("%Y-%m-%d %H:%M:%S").to_string())
            })
        }
        _ => decode_or_text::<String, _>(row, index, t, SqlValue::String),
    }
    .unwrap_or(SqlValue::Null)
}

/// What a BLOB-typed column's bytes are, as a value.
///
/// Bytes, unless they are a JSON document — in which case they are text.
///
/// MariaDB has no JSON type of its own: a `JSON` column is `LONGTEXT` with a
/// `json_valid()` check, and its result metadata comes back over the wire as
/// **BLOB**, indistinguishable from a real one. Verified on MariaDB 11.8,
/// where `LONGTEXT` reports as TEXT but `JSON` reports as BLOB. So every JSON
/// column on MariaDB reached the grid as a byte array and rendered as hex —
/// a column of unreadable values where the server has a document.
///
/// The test is deliberately narrow: valid UTF-8, starting with `{` or `[`,
/// and parsing as JSON. A PNG fails the first check, a serialised struct the
/// second, and a BLOB that really does hold a JSON document is a BLOB the
/// user would rather read than see as hex.
fn blob_value(bytes: Vec<u8>) -> SqlValue {
    if let Ok(text) = std::str::from_utf8(&bytes) {
        let trimmed = text.trim_start();
        if (trimmed.starts_with('{') || trimmed.starts_with('['))
            && serde_json::from_str::<serde_json::Value>(text).is_ok()
        {
            return SqlValue::String(text.to_string());
        }
    }
    SqlValue::Bytes(bytes)
}

/// Decode as `T`, or fall back to the raw text if sqlx refuses.
///
/// The three outcomes are kept distinct on purpose:
///   * `Ok(Some(v))` — a value
///   * `Ok(None)`    — a genuine SQL NULL
///   * `Err(_)`      — sqlx cannot decode this column into `T`. Previously
///     discarded, which is how #508 hid whole columns. Now the raw bytes are
///     shown and the gap is logged.
fn decode_or_text<'r, T, F>(
    row: &'r sqlx::mysql::MySqlRow,
    index: usize,
    type_name: &str,
    to_value: F,
) -> Option<SqlValue>
where
    T: sqlx::Decode<'r, sqlx::MySql> + sqlx::Type<sqlx::MySql>,
    F: FnOnce(T) -> SqlValue,
{
    match row.try_get::<Option<T>, _>(index) {
        Ok(Some(v)) => Some(to_value(v)),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(
                column_type = %type_name,
                error = %e,
                "could not decode column into its mapped type; falling back to raw text"
            );
            raw_text(row, index).map(SqlValue::String)
        }
    }
}

/// Read a column as the text MySQL sent, bypassing the type-compatibility
/// check `try_get` performs. Returns `None` for a real NULL, or when the bytes
/// are not valid UTF-8 — which happens for values the binary protocol sends as
/// raw integers rather than text.
fn raw_text(row: &sqlx::mysql::MySqlRow, index: usize) -> Option<String> {
    use sqlx::ValueRef;
    let raw = row.try_get_raw(index).ok()?;
    if raw.is_null() {
        return None;
    }
    <&str as sqlx::Decode<sqlx::MySql>>::decode(raw)
        .ok()
        .map(|s| s.to_string())
}

/// Whether a statement answers with a result set rather than a row count.
///
/// Getting this wrong discards the rows: the executor accumulates them either
/// way, then throws them out and reports `rows_affected` instead. `ANALYZE` was
/// missing, which is why MariaDB's `ANALYZE <stmt>` — its spelling of EXPLAIN
/// ANALYZE — came back completely empty (#422). `TABLE` and `VALUES` were
/// missing for the same reason.
///
/// Reads the verb that decides what the statement does, so a CTE is followed
/// through to what it prefixes: `WITH x AS (...) SELECT` returns rows and
/// `WITH x AS (...) DELETE` reports a count, where matching the bare leading
/// WITH would have called both of them result sets.
fn returns_rows(sql: &str) -> bool {
    const ROW_RETURNING: [&str; 8] = [
        "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "ANALYZE", "TABLE", "VALUES",
    ];
    ROW_RETURNING.contains(&crate::query::statement::effective_verb(sql).as_str())
}

pub(crate) fn split_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut string_char = ' ';
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];
        let next = if i + 1 < len {
            Some(chars[i + 1])
        } else {
            None
        };

        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
            }
            current.push(c);
            i += 1;
            continue;
        }

        if in_block_comment {
            current.push(c);
            if c == '*' && next == Some('/') {
                current.push('/');
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if in_string {
            current.push(c);
            if c == '\\' {
                if let Some(next_ch) = next {
                    current.push(next_ch);
                    i += 2;
                    continue;
                }
            }
            if c == string_char {
                in_string = false;
            }
            i += 1;
            continue;
        }

        // Check for comments
        if c == '-' && next == Some('-') {
            in_line_comment = true;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '/' && next == Some('*') {
            in_block_comment = true;
            current.push(c);
            current.push('*');
            i += 2;
            continue;
        }

        // Check for string start
        if c == '\'' || c == '"' || c == '`' {
            in_string = true;
            string_char = c;
            current.push(c);
            i += 1;
            continue;
        }

        // Statement separator
        if c == ';' {
            if !current.trim().is_empty() {
                statements.push(current.trim().to_string());
            }
            current = String::new();
            i += 1;
            continue;
        }

        current.push(c);
        i += 1;
    }

    if !current.trim().is_empty() {
        statements.push(current.trim().to_string());
    }

    statements
}

/// Why a result set is short, given what bounded it.
///
/// Memory wins when both apply. It is the constraint a user cannot argue
/// with, and telling them to adjust a row limit when RAM was the cap sends
/// them to raise a limit that was never binding (#413).
///
/// Both inputs are observations rather than inferences: a row was withheld,
/// or the guard tripped. Comparing the row count against the limit instead
/// would call a result that happens to be exactly `limit` rows long
/// truncated, when nothing was left out.
fn truncation_for(limit_reached: bool, memory_exhausted: bool) -> Option<TruncationReason> {
    if memory_exhausted {
        Some(TruncationReason::MemoryGuard)
    } else if limit_reached {
        Some(TruncationReason::RowLimit)
    } else {
        None
    }
}

fn build_select_result(
    query_id: String,
    statement_index: usize,
    sql: String,
    rows: &[sqlx::mysql::MySqlRow],
    execution_time_ms: u64,
    truncation: Option<TruncationReason>,
    // A row that was skipped to reach the page offset, used only when every
    // row of the page was skipped and there is no kept row to read the shape
    // from (#391).
    shape: Option<&sqlx::mysql::MySqlRow>,
) -> QueryResult {
    let columns: Vec<ColumnMeta> = rows
        .first()
        .or(shape)
        .map(|r| {
            r.columns()
                .iter()
                .map(|col| ColumnMeta {
                    name: col.name().to_string(),
                    data_type: col.type_info().name().to_string(),
                    // Placeholders, not facts. MySQL does send NOT_NULL and
                    // PRIMARY_KEY flags in the result-set metadata, but sqlx
                    // keeps ColumnFlags pub(crate), so they cannot be read
                    // here. Anything that needs the real answer — the grid,
                    // when working out how to address a row for UPDATE — asks
                    // the schema inspector, which reads information_schema.
                    // Do not start trusting these two (#387).
                    nullable: true,
                    is_primary_key: false,
                })
                .collect()
        })
        .unwrap_or_default();

    let result_rows: Vec<Vec<SqlValue>> = rows
        .iter()
        .map(|row| {
            row.columns()
                .iter()
                .enumerate()
                .map(|(i, col)| extract_value(row, i, col.type_info().name()))
                .collect()
        })
        .collect();

    let row_count = result_rows.len() as u64;

    QueryResult {
        query_id,
        statement_index,
        sql,
        columns,
        rows: result_rows,
        rows_affected: row_count,
        execution_time_ms,
        warnings: vec![],
        // Derived here and nowhere else, so the flag and the reason cannot
        // drift apart.
        rows_truncated: truncation.is_some(),
        truncation_reason: truncation,
        total_rows_available: if truncation.is_some() {
            Some(row_count)
        } else {
            None
        },
    }
}

/// Monitors system-wide available memory to prevent OOM crashes.
/// Checks every 1000 rows during query execution and triggers when
/// available system memory drops below 512 MB.
struct MemoryGuard {
    sys: sysinfo::System,
    triggered: bool,
    floor_mb: u64,
}

impl MemoryGuard {
    /// Create a new guard. Reads initial memory state for diagnostics.
    fn new(floor_mb: u64) -> Self {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();

        let available_mb = sys.available_memory() / 1024 / 1024;
        let total_mb = sys.total_memory() / 1024 / 1024;

        tracing::debug!(
            available_mb,
            total_mb,
            floor_mb,
            "Memory guard initialized, will stop the fetch if available memory drops below the floor"
        );

        Self {
            sys,
            triggered: false,
            floor_mb,
        }
    }

    /// Refresh system memory and return Err if available memory is below the floor.
    /// Sets the triggered flag on the first failure so subsequent calls fast-fail.
    fn check(&mut self) -> Result<(), CoreError> {
        if self.triggered {
            return Err(CoreError::OutOfMemory(
                "Query stopped: available memory critically low".to_string(),
            ));
        }

        self.sys.refresh_memory();
        let available_mb = self.sys.available_memory() / 1024 / 1024;

        if available_mb < self.floor_mb {
            self.triggered = true;
            tracing::warn!(available_mb, "System memory critically low, stopping query");
            return Err(CoreError::OutOfMemory(format!(
                "System memory critically low ({available_mb} MB available). \
                 Add a LIMIT clause to reduce result size."
            )));
        }

        Ok(())
    }

    fn triggered(&self) -> bool {
        self.triggered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_simple_statements() {
        let sql = "SELECT 1; SELECT 2; SELECT 3";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 3);
        assert_eq!(stmts[0], "SELECT 1");
        assert_eq!(stmts[1], "SELECT 2");
        assert_eq!(stmts[2], "SELECT 3");
    }

    #[test]
    fn test_split_with_strings() {
        let sql = "SELECT 'hello;world'; SELECT 1";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert_eq!(stmts[0], "SELECT 'hello;world'");
    }

    #[test]
    fn test_split_with_comments() {
        let sql = "SELECT 1; -- this is a comment;\nSELECT 2";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
    }

    #[test]
    fn returns_rows_recognises_result_returning_statements() {
        for sql in [
            "SELECT 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SHOW TABLES",
            "DESCRIBE users",
            "DESC users",
            "EXPLAIN SELECT 1",
            "EXPLAIN ANALYZE SELECT 1",
            // MariaDB's spelling of EXPLAIN ANALYZE (#422).
            "ANALYZE SELECT 1",
            "ANALYZE TABLE users",
            "TABLE users",
            "VALUES ROW(1)",
            "(SELECT 1)",
            "-- a note\nSELECT 1",
        ] {
            assert!(returns_rows(sql), "should return rows: {sql}");
        }
    }

    #[test]
    fn returns_rows_recognises_statements_that_only_report_a_count() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "CREATE TABLE t (a INT)",
            "DROP TABLE t",
            "SET NAMES utf8mb4",
            "USE test_db",
        ] {
            assert!(!returns_rows(sql), "should not return rows: {sql}");
        }
    }

    #[test]
    fn returns_rows_follows_a_cte_to_what_it_prefixes() {
        // A CTE-prefixed write reports rows_affected, not an empty result set.
        // Matching the leading WITH reported "0 rows" for a DELETE that had
        // just removed data.
        assert!(!returns_rows(
            "WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)"
        ));
        assert!(!returns_rows("WITH x AS (SELECT 1) UPDATE t SET a = 1"));
        assert!(returns_rows("WITH x AS (SELECT 1) SELECT * FROM x"));
    }

    #[test]
    fn returns_rows_matches_whole_words_only() {
        assert!(!returns_rows("INSERT INTO selections VALUES (1)"));
        assert!(!returns_rows("UPDATE tables SET a = 1"));
        assert!(returns_rows("DESCRIBE users"));
    }

    #[test]
    fn test_split_empty() {
        let stmts = split_statements("");
        assert_eq!(stmts.len(), 0);
    }

    #[test]
    fn test_split_single_statement_no_semicolon() {
        let stmts = split_statements("SELECT 1");
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts[0], "SELECT 1");
    }

    #[test]
    fn truncation_for_reports_nothing_when_the_result_fits() {
        assert_eq!(truncation_for(false, false), None);
    }

    #[test]
    fn truncation_for_reports_nothing_when_unbounded() {
        assert_eq!(truncation_for(false, false), None);
    }

    #[test]
    fn truncation_for_reports_the_row_limit_when_it_is_reached() {
        assert_eq!(
            truncation_for(true, false),
            Some(TruncationReason::RowLimit)
        );
    }

    #[test]
    fn truncation_for_reports_memory_even_with_no_limit_set() {
        assert_eq!(
            truncation_for(false, true),
            Some(TruncationReason::MemoryGuard)
        );
    }

    #[test]
    fn truncation_for_prefers_memory_over_the_row_limit() {
        // Someone already at their row limit who is also out of memory must
        // not be told to adjust the limit: raising it asks for more memory,
        // and lowering it does not explain what they are seeing (#413).
        assert_eq!(
            truncation_for(true, true),
            Some(TruncationReason::MemoryGuard)
        );
    }
    mod blob_values {
        use super::*;

        #[test]
        fn a_json_document_in_a_blob_column_is_text() {
            // MariaDB's JSON columns arrive as BLOB — its JSON is LONGTEXT
            // with a check constraint, and the wire metadata says BLOB. Every
            // one of them used to render as hex (#294 sweep).
            let value = blob_value(br#"{"colour": "black", "dpi": 1600}"#.to_vec());
            assert!(
                matches!(&value, SqlValue::String(s) if s.contains("colour")),
                "got {value:?}"
            );
        }

        #[test]
        fn a_json_array_counts_too() {
            assert!(matches!(
                blob_value(b"[1, 2, 3]".to_vec()),
                SqlValue::String(_)
            ));
        }

        #[test]
        fn leading_whitespace_does_not_hide_a_document() {
            assert!(matches!(
                blob_value(b"\n  {\"a\": 1}".to_vec()),
                SqlValue::String(_)
            ));
        }

        #[test]
        fn real_binary_stays_binary() {
            // A PNG header: not valid UTF-8, and nothing like a document.
            let png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            assert!(matches!(blob_value(png.clone()), SqlValue::Bytes(b) if b == png));
        }

        #[test]
        fn text_in_a_blob_that_is_not_a_document_stays_binary() {
            // The narrow test is the point: a BLOB holding a sentence, or a
            // number, or a serialised struct is still a BLOB. Only something
            // that opens as an object or an array and parses is text.
            for raw in [
                &b"just some text"[..],
                &b"123"[..],
                &b"\"a string\""[..],
                &b"{not json at all"[..],
                &b"<xml/>"[..],
            ] {
                assert!(
                    matches!(blob_value(raw.to_vec()), SqlValue::Bytes(_)),
                    "{:?} should have stayed binary",
                    String::from_utf8_lossy(raw)
                );
            }
        }

        #[test]
        fn an_empty_blob_stays_binary() {
            assert!(matches!(blob_value(Vec::new()), SqlValue::Bytes(b) if b.is_empty()));
        }

        #[test]
        fn a_blob_whose_bytes_merely_start_like_json_stays_binary() {
            // `{` followed by rubbish is not a document, and guessing would
            // turn a corrupt blob into a string nobody can round-trip.
            let mut bytes = b"{".to_vec();
            bytes.extend_from_slice(&[0xff, 0xfe]);
            assert!(matches!(blob_value(bytes), SqlValue::Bytes(_)));
        }
    }
}
