use mas_core::models::query::{ColumnMeta, SqlValue};
use mas_core::models::ResultHandle;
use mas_core::results::{ResultStore, ResultWriter, StoredResult};
use std::sync::Arc;
use tauri::State;

use super::AppState;

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_open(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    state
        .sqlite_manager
        .open(&id, &path)
        .map_err(|e| e.to_string())?;
    tracing::info!(path = %path, id = %id, "SQLite connection opened");
    Ok(id)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_close(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    state
        .sqlite_manager
        .close(&connection_id)
        .map_err(|e| e.to_string())?;
    tracing::info!(id = %connection_id, "SQLite connection closed");
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.sqlite_manager.list())
}

#[tauri::command]
// The SQL text is not recorded whole: it can carry data the log should not
// keep. A redacted preview is enough to tell runs apart (#875).
#[tracing::instrument(
    skip(state, sql),
    fields(sql_preview = %mas_core::query::redacted_preview(&sql, mas_core::query::LOG_PREVIEW_CHARS))
)]
#[specta::specta]
pub async fn sqlite_execute(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    // The row limit and page offset, as `execute_query` takes them (#933).
    // u32 because specta forbids exporting u64; widened for the executor.
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<mas_sqlite::query::SqliteQueryResult>, mas_core::QueryError> {
    let window = mas_sqlite::query::FetchWindow {
        limit: limit.map(u64::from),
        offset: offset.map(u64::from),
    };
    // Same shape as the MySQL path: the shared pane reads one error type
    // whichever backend answered (#324).
    state
        .sqlite_executor
        .execute_window(&connection_id, &sql, window)
        .await
        .map_err(|e| sqlite_query_error(&e))
}

/// [`sqlite_execute`], with the rows kept in the backend.
///
/// Same arguments, same semantics: the script is split the same way, the
/// limit and offset apply to each result set, and every result says whether
/// the connection is in a transaction. What differs is what comes back, as
/// with `run_query` on MySQL: each statement yields a handle, its rows go
/// to the result store, and the grid reads them with the `result_*`
/// commands. The caller owns the results and frees them with
/// `result_release`; on a failure that includes the ones in the error's
/// `completedHandles`.
#[tauri::command]
// `sql` is skipped for the reason `sqlite_execute` gives (#875).
#[tracing::instrument(
    skip(state, sql),
    fields(sql_preview = %mas_core::query::redacted_preview(&sql, mas_core::query::LOG_PREVIEW_CHARS))
)]
#[specta::specta]
pub async fn sqlite_run_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<ResultHandle>, mas_core::QueryError> {
    let window = mas_sqlite::query::FetchWindow {
        limit: limit.map(u64::from),
        offset: offset.map(u64::from),
    };
    run_into_store(
        &state.sqlite_executor,
        &state.result_store,
        &connection_id,
        &sql,
        window,
    )
    .await
}

/// Run a script on a SQLite connection with its rows written to `store`.
async fn run_into_store(
    executor: &mas_sqlite::query::SqliteQueryExecutor,
    store: &Arc<ResultStore>,
    connection_id: &str,
    sql: &str,
    window: mas_sqlite::query::FetchWindow,
) -> Result<Vec<ResultHandle>, mas_core::QueryError> {
    let consumer = StoreConsumer {
        store: Arc::clone(store),
        writer: None,
    };
    match executor
        .run_window(connection_id, sql, window, consumer)
        .await
    {
        Ok(results) => {
            let handles: Vec<ResultHandle> = results.into_iter().map(handle).collect();
            tracing::info!(
                statement_count = handles.len(),
                total_rows = handles.iter().map(|h| h.row_count).sum::<u64>(),
                "SQLite query executed into the result store"
            );
            Ok(handles)
        }
        Err(failure) => {
            let mut reported = sqlite_query_error(&failure.error);
            reported.statement_index = failure.statement_index;
            // Whenever anything completed, as `run_query` reports it: a
            // handle left out would be rows nobody could release.
            if !failure.completed.is_empty() {
                reported.completed_handles =
                    Some(failure.completed.into_iter().map(handle).collect());
            }
            reported.transaction = failure.in_transaction.map(transaction_state);
            Err(reported)
        }
    }
}

/// Writes the rows of a SQLite run to the result store, a batch at a time:
/// the bridge between `mas-sqlite`, which does not know the store, and
/// `mas-core`, which owns it.
///
/// A table is created when the first batch arrives, so a result set with
/// no rows never touches the store. A writer that is dropped without being
/// finished (the statement failed, or the task running it died) takes its
/// table with it.
struct StoreConsumer {
    store: Arc<ResultStore>,
    /// The current result set's writer, once a batch has arrived.
    writer: Option<ResultWriter>,
}

impl mas_sqlite::query::RowConsumer for StoreConsumer {
    /// The stored result, or `None` when the store holds nothing for this
    /// result set (it had no rows, or the store was full from the start).
    type Output = Option<StoredResult>;

    fn rows(
        &mut self,
        columns: &[mas_sqlite::query::SqliteColumnMeta],
        rows: Vec<Vec<mas_sqlite::query::SqliteValue>>,
    ) -> Result<mas_sqlite::query::Flow, mas_sqlite::error::SqliteError> {
        use mas_sqlite::query::Flow;
        let batch: Vec<Vec<SqlValue>> = rows
            .into_iter()
            .map(|row| row.into_iter().map(stored_value).collect())
            .collect();
        let writer = match &mut self.writer {
            Some(writer) => writer,
            empty => {
                let columns: Vec<ColumnMeta> = columns.iter().cloned().map(core_column).collect();
                empty.insert(self.store.begin(&columns).map_err(store_error)?)
            }
        };
        match writer.append(&batch) {
            Ok(()) => Ok(Flow::Continue),
            // Not an error: the result keeps the batches before this one
            // and is reported as cut short.
            Err(mas_core::error::CoreError::ResultStoreFull(reason)) => {
                tracing::warn!(
                    rows_kept = writer.row_count(),
                    reason = %reason,
                    "The result store is full, so the rest of this result is not kept"
                );
                Ok(Flow::Stop)
            }
            Err(e) => Err(store_error(e)),
        }
    }

    fn finish(
        &mut self,
        _columns: &[mas_sqlite::query::SqliteColumnMeta],
    ) -> Result<Self::Output, mas_sqlite::error::SqliteError> {
        match self.writer.take() {
            // A writer with no rows is dropped rather than finished, so
            // that the store holds a result exactly when it has rows.
            Some(writer) if writer.row_count() > 0 => {
                writer.finish().map(Some).map_err(store_error)
            }
            _ => Ok(None),
        }
    }

    fn discard(&mut self) {
        self.writer = None;
    }
}

fn store_error(err: mas_core::error::CoreError) -> mas_sqlite::error::SqliteError {
    mas_sqlite::error::SqliteError::Query(err.to_string())
}

/// A SQLite value as the store keeps it: what [`core_value`] makes of the
/// same value on its way through `sqlite_execute`, so a result reads the
/// same whichever command ran it. That includes a BLOB, which both show as
/// its size and not its bytes.
fn stored_value(value: mas_sqlite::query::SqliteValue) -> SqlValue {
    use mas_sqlite::query::SqliteValue;
    match value {
        SqliteValue::Null => SqlValue::Null,
        SqliteValue::Integer(i) => SqlValue::Int(i),
        // JSON has no NaN or infinity, so `sqlite_execute` shows them as
        // NULL. (SQLite itself stores NaN as NULL; an infinity it keeps.)
        SqliteValue::Real(f) if !f.is_finite() => SqlValue::Null,
        SqliteValue::Real(f) => SqlValue::Float(f),
        SqliteValue::Text(s) => SqlValue::String(s),
        SqliteValue::Blob(b) => SqlValue::String(format!("<blob {} bytes>", b.len())),
    }
}

fn core_column(c: mas_sqlite::query::SqliteColumnMeta) -> ColumnMeta {
    ColumnMeta {
        name: c.name,
        data_type: c.data_type,
        nullable: c.nullable,
        is_primary_key: c.is_primary_key,
    }
}

/// One statement of a streamed run as the handle the grid reads.
fn handle(r: mas_sqlite::query::StreamedResult<Option<StoredResult>>) -> ResultHandle {
    use mas_core::models::query::TruncationReason;
    use mas_sqlite::query::StreamTruncation;
    // As `run_query` does: a result with no rows in the store carries an
    // id the store does not know.
    let (result_id, row_count) = match r.output.flatten() {
        Some(stored) => (stored.result_id, stored.row_count),
        None => (r.query_id, 0),
    };
    ResultHandle {
        result_id,
        statement_index: r.statement_index,
        sql: r.sql,
        // Known from the prepared statement, so present even when the
        // result set has no rows.
        columns: r.columns.into_iter().map(core_column).collect(),
        row_count,
        // What SQLite counted as changed, as `sqlite_execute` reports it:
        // zero for a SELECT.
        rows_affected: r.rows_affected,
        execution_time_ms: r.execution_time_ms,
        warnings: r.warnings,
        truncation_reason: r.truncation.map(|reason| match reason {
            StreamTruncation::RowLimit => TruncationReason::RowLimit,
            StreamTruncation::ConsumerFull => TruncationReason::StoreFull,
        }),
        // SQLite answers for the whole connection after every statement,
        // so every handle carries it, not only the last.
        transaction: Some(transaction_state(r.in_transaction)),
    }
}

/// A SQLite failure in the shape the shared pane reads.
///
/// A statement-tagged failure (#928) carries its index and, from the second
/// statement on, what the statements before it returned, as the MySQL path
/// reports them. It also says whether the connection is still inside a
/// transaction, as #917 does for a MySQL session (#935).
fn sqlite_query_error(err: &mas_sqlite::error::SqliteError) -> mas_core::QueryError {
    use mas_sqlite::error::SqliteError;
    match err {
        SqliteError::AtStatement {
            index,
            source,
            completed,
            in_transaction,
        } => {
            let mut reported = sqlite_query_error(source).at_statement(*index);
            if *index > 0 && !completed.is_empty() {
                reported.completed_results =
                    Some(completed.iter().cloned().map(core_result).collect());
            }
            reported.transaction = Some(transaction_state(*in_transaction));
            reported
        }
        SqliteError::Rusqlite(inner) => {
            mas_core::QueryError::from_rusqlite(inner, &err.to_string())
        }
        _ => mas_core::QueryError {
            message: err.to_string(),
            code: None,
            sql_state: None,
            statement_index: None,
            completed_results: None,
            completed_handles: None,
            transaction: None,
        },
    }
}

/// A SQLite result as the shared result type, for `completed_results`, which
/// the frontend reads as MySQL-shaped results whichever backend failed.
fn core_result(r: mas_sqlite::query::SqliteQueryResult) -> mas_core::models::query::QueryResult {
    use mas_core::models::query::{QueryResult, TruncationReason};
    use mas_sqlite::query::SqliteTruncationReason;
    QueryResult {
        query_id: r.query_id,
        statement_index: r.statement_index,
        sql: r.sql,
        columns: r.columns.into_iter().map(core_column).collect(),
        rows: r
            .rows
            .into_iter()
            .map(|row| row.into_iter().map(core_value).collect())
            .collect(),
        rows_affected: r.rows_affected,
        execution_time_ms: r.execution_time_ms,
        warnings: r.warnings,
        rows_truncated: r.rows_truncated,
        truncation_reason: r.truncation_reason.map(|reason| match reason {
            SqliteTruncationReason::RowLimit => TruncationReason::RowLimit,
            SqliteTruncationReason::MemoryGuard => TruncationReason::MemoryGuard,
        }),
        total_rows_available: None,
        transaction: Some(transaction_state(r.in_transaction)),
    }
}

/// `is_autocommit()`'s answer in the shared transaction type.
fn transaction_state(in_transaction: bool) -> mas_core::query::TransactionState {
    use mas_core::query::TransactionState;
    if in_transaction {
        TransactionState::Open
    } else {
        TransactionState::None
    }
}

/// The SQLite executor only produces null, integers, reals and text.
fn core_value(v: serde_json::Value) -> SqlValue {
    match v {
        serde_json::Value::Null => SqlValue::Null,
        serde_json::Value::Bool(b) => SqlValue::Bool(b),
        serde_json::Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => SqlValue::Int(i),
            (None, Some(u)) => SqlValue::UInt(u),
            _ => n.as_f64().map_or(SqlValue::Null, SqlValue::Float),
        },
        serde_json::Value::String(s) => SqlValue::String(s),
        other => SqlValue::String(other.to_string()),
    }
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_get_tables(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_sqlite::schema::SqliteTableInfo>, String> {
    state
        .sqlite_inspector
        .get_tables(&connection_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<mas_sqlite::schema::SqliteColumnInfo>, String> {
    state
        .sqlite_inspector
        .get_columns(&connection_id, &table)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<mas_sqlite::schema::SqliteIndexInfo>, String> {
    state
        .sqlite_inspector
        .get_indexes(&connection_id, &table)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<String, String> {
    state
        .sqlite_inspector
        .get_table_ddl(&connection_id, &table)
        .await
        .map_err(|e| e.to_string())
}

/// A SQLite table's foreign keys, in the shape `get_foreign_keys` returns for
/// MySQL, so the structure and designer views read both the same way. SQLite
/// keeps no constraint names; see `SqliteForeignKeyInfo` for the made-up ones.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_get_foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<mas_core::schema::inspector::ForeignKeyInfo>, String> {
    let keys = state
        .sqlite_inspector
        .get_foreign_keys(&connection_id, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get SQLite foreign keys");
            e.to_string()
        })?;
    tracing::info!(count = keys.len(), "Listed SQLite foreign keys");
    Ok(keys
        .into_iter()
        .map(|k| mas_core::schema::inspector::ForeignKeyInfo {
            name: k.name,
            columns: k.columns,
            referenced_table: k.referenced_table,
            referenced_columns: k.referenced_columns,
            on_update: k.on_update,
            on_delete: k.on_delete,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mas_sqlite::connection::SqliteConnectionManager;
    use mas_sqlite::error::SqliteError;
    use mas_sqlite::query::SqliteQueryExecutor;

    async fn run(sql: &str) -> mas_core::QueryError {
        let manager = Arc::new(SqliteConnectionManager::new());
        manager.open("c", ":memory:").expect("opens");
        let err = SqliteQueryExecutor::new(manager)
            .execute("c", sql)
            .await
            .expect_err("the script fails");
        sqlite_query_error(&err)
    }

    #[tokio::test]
    async fn a_second_statement_failure_reports_index_and_earlier_results() {
        let reported = run("SELECT 1, 1.5, 'a', NULL; SELECT * FROM missing; SELECT 3").await;
        assert_eq!(reported.message, "no such table: missing");
        assert_eq!(reported.code, Some(1));
        assert_eq!(reported.statement_index, Some(1));
        let completed = reported
            .completed_results
            .clone()
            .expect("earlier results kept");
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].sql, "SELECT 1, 1.5, 'a', NULL");
        assert_eq!(
            completed[0].rows[0],
            vec![
                SqlValue::Int(1),
                SqlValue::Float(1.5),
                SqlValue::String("a".into()),
                SqlValue::Null,
            ]
        );
        let json = serde_json::to_value(&reported).expect("serialises");
        assert_eq!(json["statementIndex"], 1);
        assert_eq!(json["completedResults"][0]["statement_index"], 0);
    }

    #[tokio::test]
    async fn a_first_statement_failure_has_index_zero_and_no_results() {
        let reported = run("SELECT * FROM missing; SELECT 1").await;
        assert_eq!(reported.statement_index, Some(0));
        assert!(reported.completed_results.is_none());
    }

    #[tokio::test]
    async fn an_earlier_result_keeps_its_truncation_and_transaction() {
        let manager = Arc::new(SqliteConnectionManager::new());
        manager.open("c", ":memory:").expect("opens");
        let window = mas_sqlite::query::FetchWindow {
            limit: Some(1),
            offset: None,
        };
        let err = SqliteQueryExecutor::new(manager)
            .execute_window(
                "c",
                "SELECT 1 UNION ALL SELECT 2; SELECT * FROM missing",
                window,
            )
            .await
            .expect_err("the script fails");
        let completed = sqlite_query_error(&err)
            .completed_results
            .expect("earlier results kept");
        assert_eq!(completed[0].rows.len(), 1);
        assert!(completed[0].rows_truncated);
        assert_eq!(
            completed[0].truncation_reason,
            Some(mas_core::models::query::TruncationReason::RowLimit)
        );
        assert_eq!(
            completed[0].transaction,
            Some(mas_core::query::TransactionState::None)
        );
    }

    #[tokio::test]
    async fn a_failure_reports_whether_the_connection_is_in_a_transaction() {
        use mas_core::query::TransactionState;
        let manager = Arc::new(SqliteConnectionManager::new());
        manager.open("c", ":memory:").expect("opens");
        let executor = SqliteQueryExecutor::new(manager);
        let err = executor
            .execute("c", "BEGIN; SELECT * FROM missing")
            .await
            .expect_err("fails");
        let reported = sqlite_query_error(&err);
        assert_eq!(reported.transaction, Some(TransactionState::Open));
        let json = serde_json::to_value(&reported).expect("serialises");
        assert_eq!(json["transaction"], "open");
        executor.execute("c", "ROLLBACK").await.expect("rolls back");
        let err = executor
            .execute("c", "SELECT * FROM missing")
            .await
            .expect_err("fails");
        let reported = sqlite_query_error(&err);
        assert_eq!(reported.transaction, Some(TransactionState::None));
    }

    const MIB: u64 = 1024 * 1024;

    fn store_and_executor(budget: u64) -> (Arc<ResultStore>, SqliteQueryExecutor) {
        let manager = Arc::new(SqliteConnectionManager::new());
        manager.open("c", ":memory:").expect("opens");
        let store = Arc::new(ResultStore::in_memory(budget).expect("store"));
        (store, SqliteQueryExecutor::new(manager))
    }

    fn all() -> mas_sqlite::query::FetchWindow {
        mas_sqlite::query::FetchWindow::default()
    }

    /// Every row of a stored result, whole.
    fn stored_rows(store: &ResultStore, handle: &ResultHandle) -> Vec<Vec<SqlValue>> {
        let ids: Vec<u64> = (1..=handle.row_count).collect();
        ids.chunks(mas_core::results::ROWS_MAX_COUNT)
            .flat_map(|chunk| store.rows(&handle.result_id, chunk).expect("rows"))
            .collect()
    }

    const MULTI_TYPE: &str = "CREATE TABLE m(i INTEGER, r REAL, t TEXT, b BLOB, n, big INTEGER); \
         INSERT INTO m VALUES \
           (1, 1.5, 'one', x'010203', NULL, 9223372036854775807), \
           (-2, -0.0, '', x'', NULL, -9223372036854775808), \
           (3, 1e300, 'trois é 日本', zeroblob(70000), 'text in an untyped column', 0), \
           (NULL, 9e999, NULL, NULL, 4.25, 9007199254740993), \
           ('text in an integer column', 2, 7, 'text in a blob column', x'ff', 1)";

    #[tokio::test]
    async fn a_stored_run_reads_back_as_what_sqlite_execute_returns() {
        let (store, executor) = store_and_executor(64 * MIB);
        executor.execute("c", MULTI_TYPE).await.expect("fills m");
        let script = "SELECT * FROM m ORDER BY rowid; SELECT count(*) AS n, 'x' AS label FROM m; \
                      SELECT i FROM m WHERE i = 12345; UPDATE m SET r = r WHERE i = 1";

        let whole = executor.execute("c", script).await.expect("executes");
        let handles = run_into_store(&executor, &store, "c", script, all())
            .await
            .expect("runs");
        assert_eq!(handles.len(), whole.len());

        for (handle, result) in handles.iter().zip(whole) {
            let result = core_result(result);
            assert_eq!(handle.statement_index, result.statement_index);
            assert_eq!(handle.sql, result.sql);
            assert_eq!(handle.rows_affected, result.rows_affected);
            assert_eq!(handle.truncation_reason, result.truncation_reason);
            assert_eq!(handle.transaction, result.transaction);
            assert_eq!(handle.row_count, result.rows.len() as u64);
            let names = |columns: &[ColumnMeta]| {
                columns
                    .iter()
                    .map(|c| (c.name.clone(), c.data_type.clone()))
                    .collect::<Vec<_>>()
            };
            assert_eq!(names(&handle.columns), names(&result.columns));
            if handle.row_count == 0 {
                // No table: the id is one the store does not know.
                let err = store.rows(&handle.result_id, &[]).expect_err("no table");
                assert!(matches!(err, mas_core::error::CoreError::NotFound(_)));
                continue;
            }
            // Value for value, variant for variant.
            let stored = stored_rows(&store, handle);
            assert_eq!(stored.len(), result.rows.len());
            for (stored, returned) in stored.iter().zip(&result.rows) {
                for (a, b) in stored.iter().zip(returned) {
                    assert_eq!(std::mem::discriminant(a), std::mem::discriminant(b));
                    assert_eq!(a, b);
                }
            }
            // And the same on the wire, which is where the grid meets it.
            let wire = |rows: &[Vec<SqlValue>]| {
                let wire: Vec<Vec<mas_core::results::WireValue>> = rows
                    .iter()
                    .map(|row| row.iter().cloned().map(Into::into).collect())
                    .collect();
                serde_json::to_value(wire).expect("serialises")
            };
            assert_eq!(wire(&stored), wire(&result.rows));
        }

        // Four statements, two with rows.
        assert_eq!(handles[0].row_count, 5);
        assert_eq!(handles[0].columns.len(), 6);
        assert_eq!(handles[2].row_count, 0);
        assert_eq!(handles[2].columns.len(), 1, "columns even with no rows");
        assert_eq!(handles[3].rows_affected, 1);
        assert!(handles[3].columns.is_empty());
        assert_eq!(store.table_count().expect("count"), 2);

        // The store sorts and filters it like any other result.
        let window = store
            .window(
                &handles[0].result_id,
                &mas_core::results::WindowRequest {
                    offset: 0,
                    count: 10,
                    sort: vec![mas_core::results::SortKey {
                        column: 5,
                        descending: true,
                    }],
                    filters: vec![mas_core::results::ResultFilter {
                        column: 2,
                        operator: mas_core::results::FilterOperator::IsNotNull,
                        value: String::new(),
                        value2: None,
                    }],
                    max_cell_bytes: 1024,
                },
            )
            .expect("window");
        assert_eq!(window.matching_rows, 4);
        assert_eq!(window.row_ids, vec![1, 5, 3, 2]);

        let ids: Vec<String> = handles.into_iter().map(|h| h.result_id).collect();
        store.release(&ids);
        assert_eq!(store.table_count().expect("count"), 0);
    }

    #[tokio::test]
    async fn a_stored_run_pages_and_reports_the_row_limit_as_sqlite_execute_does() {
        let (store, executor) = store_and_executor(64 * MIB);
        executor
            .execute(
                "c",
                "CREATE TABLE t(x INTEGER); \
                 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2500) \
                 INSERT INTO t SELECT x FROM c",
            )
            .await
            .expect("fills t");
        let page = |limit, offset| mas_sqlite::query::FetchWindow {
            limit: Some(limit),
            offset: Some(offset),
        };
        let first = |store: &ResultStore, handle: &ResultHandle, row| {
            store.cell(&handle.result_id, row, 0).expect("cell")
        };

        let handles = run_into_store(&executor, &store, "c", "SELECT x FROM t", page(2000, 0))
            .await
            .expect("runs");
        assert_eq!(handles[0].row_count, 2000);
        assert_eq!(
            handles[0].truncation_reason,
            Some(mas_core::models::query::TruncationReason::RowLimit)
        );
        assert_eq!(first(&store, &handles[0], 2000), SqlValue::Int(2000));

        // The last page is short and not cut.
        let handles = run_into_store(&executor, &store, "c", "SELECT x FROM t", page(2000, 2000))
            .await
            .expect("runs");
        assert_eq!(handles[0].row_count, 500);
        assert_eq!(handles[0].truncation_reason, None);
        assert_eq!(first(&store, &handles[0], 1), SqlValue::Int(2001));

        // Without a limit, all of it, across several batches.
        let handles = run_into_store(&executor, &store, "c", "SELECT x FROM t", all())
            .await
            .expect("runs");
        assert_eq!(handles[0].row_count, 2500);
        assert_eq!(first(&store, &handles[0], 2500), SqlValue::Int(2500));
    }

    #[tokio::test]
    async fn a_failing_stored_run_hands_back_what_completed_and_leaves_nothing_else() {
        let (store, executor) = store_and_executor(64 * MIB);
        executor
            .execute(
                "c",
                "CREATE TABLE t(x INTEGER); \
                 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1500) \
                 INSERT INTO t SELECT x FROM c; \
                 INSERT INTO t VALUES (-9223372036854775808)",
            )
            .await
            .expect("fills t");

        // The third statement fails after its first batch is in the store.
        let reported = run_into_store(
            &executor,
            &store,
            "c",
            "SELECT x FROM t LIMIT 3; BEGIN; SELECT abs(x) FROM t ORDER BY rowid; SELECT 2",
            all(),
        )
        .await
        .expect_err("the script fails");
        assert_eq!(reported.message, "integer overflow");
        assert_eq!(reported.statement_index, Some(2));
        assert_eq!(
            reported.transaction,
            Some(mas_core::query::TransactionState::Open)
        );
        assert!(reported.completed_results.is_none());
        let completed = reported.completed_handles.clone().expect("handles kept");
        assert_eq!(completed.len(), 2);
        assert_eq!(completed[0].row_count, 3);
        assert_eq!(
            stored_rows(&store, &completed[0]),
            vec![
                vec![SqlValue::Int(1)],
                vec![SqlValue::Int(2)],
                vec![SqlValue::Int(3)]
            ]
        );
        assert_eq!(completed[1].sql, "BEGIN");
        assert_eq!(completed[1].row_count, 0);
        // Only the completed result is in the store: the half-written one
        // went with the failure.
        assert_eq!(store.table_count().expect("count"), 1);
        let json = serde_json::to_value(&reported).expect("serialises");
        assert_eq!(json["statementIndex"], 2);
        assert_eq!(json["completedHandles"][0]["row_count"], 3);
        assert_eq!(json["transaction"], "open");
        assert!(json.get("completedResults").is_none());

        // Releasing what the error carried leaves the store empty.
        let ids: Vec<String> = completed.into_iter().map(|h| h.result_id).collect();
        store.release(&ids);
        assert_eq!(store.table_count().expect("count"), 0);
        executor.execute("c", "ROLLBACK").await.expect("rolls back");

        // A failure at the first statement: an index, no handles.
        let reported = run_into_store(&executor, &store, "c", "SELECT * FROM missing", all())
            .await
            .expect_err("fails");
        assert_eq!(reported.message, "no such table: missing");
        assert_eq!(reported.code, Some(1));
        assert_eq!(reported.statement_index, Some(0));
        assert!(reported.completed_handles.is_none());
        assert_eq!(
            reported.transaction,
            Some(mas_core::query::TransactionState::None)
        );

        // A connection that is not open: no index, no transaction to report.
        let reported = run_into_store(&executor, &store, "gone", "SELECT 1", all())
            .await
            .expect_err("fails");
        assert_eq!(reported.statement_index, None);
        assert_eq!(reported.transaction, None);
        assert!(
            reported.message.contains("not found"),
            "{}",
            reported.message
        );
        assert_eq!(store.table_count().expect("count"), 0);
    }

    #[tokio::test]
    async fn a_full_store_cuts_a_sqlite_result_short_and_the_script_carries_on() {
        let (store, executor) = store_and_executor(MIB);
        // 5,000 rows of about 1 KB: five times the store's megabyte.
        let big = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) \
                   SELECT x, printf('%01000d', x) FROM c";
        let script = format!("{big}; SELECT 1; {big}");
        let handles = run_into_store(&executor, &store, "c", &script, all())
            .await
            .expect("a full store is not a failure");
        assert_eq!(handles.len(), 3);

        let store_full = Some(mas_core::models::query::TruncationReason::StoreFull);
        assert_eq!(handles[0].truncation_reason, store_full);
        // Whole batches, fewer than there were, and readable.
        assert!(handles[0].row_count > 0 && handles[0].row_count < 5000);
        assert_eq!(handles[0].row_count % 1000, 0, "{}", handles[0].row_count);
        let last = handles[0].row_count;
        assert_eq!(
            store.cell(&handles[0].result_id, last, 0).expect("cell"),
            SqlValue::Int(i64::try_from(last).expect("fits"))
        );

        // The script carried on. There was no room left for even one more
        // batch of the third result, so it has no table and no rows.
        assert_eq!(handles[2].truncation_reason, store_full);
        assert_eq!(handles[2].row_count, 0);
        assert!(store.rows(&handles[2].result_id, &[]).is_err());
        assert_eq!(handles[2].columns.len(), 2);
        let tables = store.table_count().expect("count");
        assert!(tables <= 2, "{tables}");

        // With the limit also reached, the store's is the one reported.
        store.release(&[handles[0].result_id.clone(), handles[1].result_id.clone()]);
        let limited = mas_sqlite::query::FetchWindow {
            limit: Some(4000),
            offset: None,
        };
        let handles = run_into_store(&executor, &store, "c", big, limited)
            .await
            .expect("runs");
        assert_eq!(handles[0].truncation_reason, store_full);

        let ids: Vec<String> = handles.into_iter().map(|h| h.result_id).collect();
        store.release(&ids);
        assert_eq!(store.table_count().expect("count"), 0);
    }

    #[test]
    fn an_untagged_failure_has_no_index() {
        let reported = sqlite_query_error(&SqliteError::NotFound("gone".into()));
        assert_eq!(reported.message, "Not found: gone");
        assert_eq!(reported.statement_index, None);
        assert_eq!(reported.transaction, None);
    }
}
