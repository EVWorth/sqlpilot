//! Where the rows of a run go.
//!
//! The executor's fetch loop does not know whether a result is returned
//! whole or written to the result store. It hands each row it keeps to a
//! [`RowSink`] and asks the sink for whatever stands for a finished
//! statement: a [`QueryResult`] from [`CollectSink`], a [`ResultHandle`] from
//! [`StoreSink`]. The limit, the offset, the timeout, cancelling and the
//! multi-statement rules all live in the loop, once, and so cannot differ
//! between the two.

use crate::error::{Completed, CoreError};
use crate::models::{ColumnMeta, QueryResult, ResultHandle, SqlValue, TruncationReason};
use crate::query::executor::{build_select_result, columns_of, decode_row};
use crate::query::grid_edits::TransactionState;
use crate::results::{ResultStore, ResultWriter, StoredResult};
use sqlx::mysql::MySqlRow;
use std::future::Future;
use std::sync::Arc;

/// What the loop knows about a statement when it finishes.
pub(crate) struct StatementInfo {
    /// The id the statement is logged under.
    pub query_id: String,
    pub statement_index: usize,
    pub sql: String,
    pub execution_time_ms: u64,
}

/// Takes the rows of one result set at a time.
///
/// The loop calls [`push`](Self::push) for each row it keeps, then exactly
/// one of [`finish_rows`](Self::finish_rows) or
/// [`discard`](Self::discard), after which the sink is ready for the next
/// result set.
pub(crate) trait RowSink: Send {
    /// What a finished statement is reported as.
    type Output: Send;

    /// Whether the rows pushed stay in memory until the run returns, which
    /// is what the free-memory guard exists to bound.
    const HOLDS_ROWS_IN_MEMORY: bool;

    /// Rows of the current result set taken so far. What the row limit is
    /// compared against.
    fn kept(&self) -> u64;

    /// Take one row of the current result set.
    fn push(&mut self, row: MySqlRow) -> impl Future<Output = Result<(), CoreError>> + Send;

    /// Close the current result set.
    ///
    /// `truncation` is what the loop saw (the row limit, the memory guard);
    /// a sink with a limit of its own may report that instead. `shape` is
    /// the columns of a skipped row, for a result set none of whose rows
    /// were kept.
    fn finish_rows(
        &mut self,
        info: StatementInfo,
        truncation: Option<TruncationReason>,
        shape: Option<Vec<ColumnMeta>>,
    ) -> impl Future<Output = Result<Self::Output, CoreError>> + Send;

    /// A statement that reported a count rather than rows.
    fn finish_count(&mut self, info: StatementInfo, rows_affected: u64) -> Self::Output;

    /// Throw away the current result set: its statement failed, timed out
    /// or was cancelled.
    fn discard(&mut self) -> impl Future<Output = ()> + Send;

    /// Record the session's transaction state on a run's last result.
    fn set_transaction(output: &mut Self::Output, state: Option<TransactionState>);

    /// What a failed run carries of the statements that finished before it.
    fn completed(outputs: Vec<Self::Output>) -> Completed;
}

/// Keeps every row and returns each result whole.
///
/// The rows are held as the driver delivered them and decoded when the
/// result set closes, as the executor always has.
pub(crate) struct CollectSink {
    rows: Vec<MySqlRow>,
}

impl CollectSink {
    pub(crate) fn new() -> Self {
        Self { rows: Vec::new() }
    }
}

impl RowSink for CollectSink {
    type Output = QueryResult;

    const HOLDS_ROWS_IN_MEMORY: bool = true;

    fn kept(&self) -> u64 {
        self.rows.len() as u64
    }

    async fn push(&mut self, row: MySqlRow) -> Result<(), CoreError> {
        self.rows.push(row);
        Ok(())
    }

    async fn finish_rows(
        &mut self,
        info: StatementInfo,
        truncation: Option<TruncationReason>,
        shape: Option<Vec<ColumnMeta>>,
    ) -> Result<QueryResult, CoreError> {
        let result = build_select_result(
            info.query_id,
            info.statement_index,
            info.sql,
            &self.rows,
            info.execution_time_ms,
            truncation,
            shape,
        );
        self.rows.clear();
        Ok(result)
    }

    fn finish_count(&mut self, info: StatementInfo, rows_affected: u64) -> QueryResult {
        QueryResult {
            query_id: info.query_id,
            statement_index: info.statement_index,
            sql: info.sql,
            columns: vec![],
            rows: vec![],
            rows_affected,
            execution_time_ms: info.execution_time_ms,
            warnings: vec![],
            rows_truncated: false,
            truncation_reason: None,
            total_rows_available: None,
            transaction: None,
        }
    }

    async fn discard(&mut self) {
        self.rows.clear();
    }

    fn set_transaction(output: &mut QueryResult, state: Option<TransactionState>) {
        output.transaction = state;
    }

    fn completed(outputs: Vec<QueryResult>) -> Completed {
        Completed::Results(outputs)
    }
}

/// Rows handed to the store in one transaction.
pub(crate) const BATCH_ROWS: usize = 1000;

/// Cell data that ends a batch early. A thousand rows is nothing when they
/// are narrow and a gigabyte when each carries a 1 MB BLOB; this keeps what
/// the executor holds to a few megabytes either way (one row can still be
/// as large as the server sends it).
pub(crate) const BATCH_BYTES: usize = 4 * 1024 * 1024;

/// Writes each result set to the result store, a batch at a time.
///
/// A row is decoded as it arrives and the driver's copy dropped, so what is
/// held is the current batch and nothing else. A table is created when the
/// first batch is written: a statement that reports a count, and a result
/// set with no rows, never touch the store.
///
/// The store is synchronous, so every call into it runs on the blocking
/// pool. The writer travels into the closure and back; if the task
/// panics, or this future is dropped while it runs, the writer is dropped
/// there and takes its table with it.
pub(crate) struct StoreSink {
    store: Arc<ResultStore>,
    /// The current result set's writer, once a batch has been written.
    writer: Option<ResultWriter>,
    /// The current result set's columns, read from its first row.
    columns: Vec<ColumnMeta>,
    batch: Vec<Vec<SqlValue>>,
    batch_bytes: usize,
    /// Rows taken for the current result set, whether or not the store
    /// went on to keep them.
    accepted: u64,
    /// The store refused a batch of the current result set. Rows after
    /// that are dropped unread.
    full: bool,
}

impl StoreSink {
    pub(crate) fn new(store: Arc<ResultStore>) -> Self {
        Self {
            store,
            writer: None,
            columns: Vec::new(),
            batch: Vec::new(),
            batch_bytes: 0,
            accepted: 0,
            full: false,
        }
    }

    /// Take one decoded row. `columns` is asked for the result set's
    /// columns on its first row only.
    async fn accept(
        &mut self,
        columns: impl FnOnce() -> Vec<ColumnMeta> + Send,
        values: Vec<SqlValue>,
    ) -> Result<(), CoreError> {
        if self.accepted == 0 {
            self.columns = columns();
        }
        self.accepted += 1;
        self.batch_bytes += cell_bytes(&values);
        self.batch.push(values);
        if self.batch.len() >= BATCH_ROWS || self.batch_bytes >= BATCH_BYTES {
            self.flush().await?;
        }
        Ok(())
    }

    /// Write the current batch. A full store is not an error: the result
    /// keeps the batches before this one and is reported as truncated.
    async fn flush(&mut self) -> Result<(), CoreError> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(&mut self.batch);
        self.batch_bytes = 0;
        let writer = self.writer.take();
        let store = Arc::clone(&self.store);
        let columns = if writer.is_none() {
            self.columns.clone()
        } else {
            Vec::new()
        };

        let (writer, outcome) = tokio::task::spawn_blocking(move || {
            let mut writer = match writer {
                Some(writer) => writer,
                None => match store.begin(&columns) {
                    Ok(writer) => writer,
                    Err(e) => return (None, Err(e)),
                },
            };
            let outcome = writer.append(&batch);
            (Some(writer), outcome)
        })
        .await
        .map_err(store_task_failed)?;
        self.writer = writer;

        match outcome {
            Ok(()) => Ok(()),
            Err(CoreError::ResultStoreFull(reason)) => {
                tracing::warn!(
                    rows_kept = self.writer.as_ref().map_or(0, ResultWriter::row_count),
                    reason = %reason,
                    "The result store is full, so the rest of this result is not kept"
                );
                self.full = true;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// Forget the current result set and hand back its writer, if it has
    /// one, leaving the sink ready for the next.
    fn reset(&mut self) -> Option<ResultWriter> {
        self.batch.clear();
        self.batch_bytes = 0;
        self.accepted = 0;
        self.full = false;
        self.columns.clear();
        self.writer.take()
    }
}

impl RowSink for StoreSink {
    type Output = ResultHandle;

    const HOLDS_ROWS_IN_MEMORY: bool = false;

    fn kept(&self) -> u64 {
        self.accepted
    }

    async fn push(&mut self, row: MySqlRow) -> Result<(), CoreError> {
        if self.full {
            return Ok(());
        }
        let values = decode_row(&row);
        self.accept(move || columns_of(&row), values).await
    }

    async fn finish_rows(
        &mut self,
        info: StatementInfo,
        truncation: Option<TruncationReason>,
        shape: Option<Vec<ColumnMeta>>,
    ) -> Result<ResultHandle, CoreError> {
        if let Err(e) = self.flush().await {
            self.discard().await;
            return Err(e);
        }
        let full = self.full;
        let columns = if self.accepted == 0 {
            shape.unwrap_or_default()
        } else {
            std::mem::take(&mut self.columns)
        };
        let writer = self.reset();

        // A writer with no rows (the store was full from the first batch)
        // is dropped rather than finished, so that the store holds a result
        // exactly when it has rows.
        let stored: Option<StoredResult> = match writer {
            None => None,
            Some(writer) => tokio::task::spawn_blocking(move || {
                if writer.row_count() == 0 {
                    return Ok(None);
                }
                writer.finish().map(Some)
            })
            .await
            .map_err(store_task_failed)??,
        };
        let (result_id, row_count) = match stored {
            Some(stored) => (stored.result_id, stored.row_count),
            None => (info.query_id.clone(), 0),
        };
        tracing::debug!(
            query_id = %info.query_id,
            result_id = %result_id,
            rows = row_count,
            "Result stored"
        );

        Ok(ResultHandle {
            result_id,
            statement_index: info.statement_index,
            sql: info.sql,
            columns,
            row_count,
            rows_affected: row_count,
            execution_time_ms: info.execution_time_ms,
            warnings: vec![],
            // The store's budget wins over the row limit: once the store
            // is full, a different limit would not have kept more.
            truncation_reason: if full {
                Some(TruncationReason::StoreFull)
            } else {
                truncation
            },
            transaction: None,
        })
    }

    fn finish_count(&mut self, info: StatementInfo, rows_affected: u64) -> ResultHandle {
        ResultHandle {
            result_id: info.query_id,
            statement_index: info.statement_index,
            sql: info.sql,
            columns: vec![],
            row_count: 0,
            rows_affected,
            execution_time_ms: info.execution_time_ms,
            warnings: vec![],
            truncation_reason: None,
            transaction: None,
        }
    }

    async fn discard(&mut self) {
        if let Some(writer) = self.reset() {
            // Dropping a writer drops its table, which for a large one is
            // real work.
            if let Err(e) = tokio::task::spawn_blocking(move || drop(writer)).await {
                tracing::warn!(error = %e, "Discarding a partly written result failed");
            }
        }
    }

    fn set_transaction(output: &mut ResultHandle, state: Option<TransactionState>) {
        output.transaction = state;
    }

    fn completed(outputs: Vec<ResultHandle>) -> Completed {
        Completed::Handles(outputs)
    }
}

/// The blocking task writing to the store panicked or was shut down. The
/// writer it held was dropped with it, so nothing is left behind.
fn store_task_failed(err: tokio::task::JoinError) -> CoreError {
    CoreError::Storage(format!("Writing to the result store failed: {err}"))
}

/// Roughly what a row's values take in memory, for ending a batch early.
fn cell_bytes(values: &[SqlValue]) -> usize {
    values
        .iter()
        .map(|value| match value {
            SqlValue::String(text) => text.len(),
            SqlValue::Bytes(bytes) => bytes.len(),
            _ => 8,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::results::WindowRequest;

    const MIB: u64 = 1024 * 1024;

    fn open_store(budget: u64) -> (tempfile::TempDir, Arc<ResultStore>) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = ResultStore::open(dir.path(), budget).expect("store opens");
        (dir, Arc::new(store))
    }

    fn columns() -> Vec<ColumnMeta> {
        ["INT", "VARCHAR"]
            .iter()
            .map(|data_type| ColumnMeta {
                name: data_type.to_lowercase(),
                data_type: (*data_type).to_string(),
                nullable: true,
                is_primary_key: false,
            })
            .collect()
    }

    fn row(n: i64) -> Vec<SqlValue> {
        vec![SqlValue::Int(n), SqlValue::String(format!("row {n}"))]
    }

    fn info(index: usize) -> StatementInfo {
        StatementInfo {
            query_id: format!("q{index}"),
            statement_index: index,
            sql: format!("SELECT {index}"),
            execution_time_ms: 7,
        }
    }

    async fn feed(sink: &mut StoreSink, rows: std::ops::Range<i64>) {
        for n in rows {
            sink.accept(columns, row(n)).await.expect("accept");
            assert!(
                sink.batch.len() < BATCH_ROWS,
                "more than a batch held: {}",
                sink.batch.len()
            );
        }
    }

    fn read(store: &ResultStore, id: &str, offset: u64, count: u32) -> Vec<Vec<SqlValue>> {
        let window = store
            .window(
                id,
                &WindowRequest {
                    offset,
                    count,
                    max_cell_bytes: 1 << 20,
                    ..WindowRequest::default()
                },
            )
            .expect("window");
        window
            .rows
            .into_iter()
            .map(|cells| cells.into_iter().map(|cell| cell.value).collect())
            .collect()
    }

    fn tables(store: &ResultStore) -> u64 {
        store.table_count().expect("table count")
    }

    #[tokio::test]
    async fn rows_come_back_in_order_across_batches() {
        let (_dir, store) = open_store(64 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));
        feed(&mut sink, 0..2500).await;
        assert_eq!(sink.kept(), 2500);
        // Two whole batches are in the store; the rest waits for the third.
        assert_eq!(
            sink.writer.as_ref().map(ResultWriter::row_count),
            Some(2000)
        );
        assert_eq!(sink.batch.len(), 500);

        let handle = sink.finish_rows(info(0), None, None).await.expect("finish");
        assert_eq!(handle.row_count, 2500);
        assert_eq!(handle.rows_affected, 2500);
        assert_eq!(handle.statement_index, 0);
        assert_eq!(handle.sql, "SELECT 0");
        assert_eq!(handle.execution_time_ms, 7);
        assert_eq!(handle.truncation_reason, None);
        assert_eq!(handle.columns.len(), 2);
        assert_eq!(handle.columns[1].data_type, "VARCHAR");

        assert_eq!(read(&store, &handle.result_id, 0, 2), vec![row(0), row(1)]);
        assert_eq!(
            read(&store, &handle.result_id, 999, 3),
            vec![row(999), row(1000), row(1001)],
            "the seam between two batches"
        );
        assert_eq!(read(&store, &handle.result_id, 2499, 5), vec![row(2499)]);
    }

    #[tokio::test]
    async fn large_rows_end_a_batch_before_it_reaches_a_thousand() {
        let (_dir, store) = open_store(256 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));
        let blob = || vec![SqlValue::Int(1), SqlValue::Bytes(vec![7; 1024 * 1024])];
        for _ in 0..10 {
            sink.accept(columns, blob()).await.expect("accept");
            assert!(
                sink.batch_bytes < BATCH_BYTES,
                "{} bytes held",
                sink.batch_bytes
            );
            assert!(sink.batch.len() < 4, "{} rows held", sink.batch.len());
        }
        let handle = sink.finish_rows(info(0), None, None).await.expect("finish");
        assert_eq!(handle.row_count, 10);
    }

    #[tokio::test]
    async fn the_sink_is_reused_for_each_result_of_a_script() {
        let (_dir, store) = open_store(64 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));

        feed(&mut sink, 0..3).await;
        let first = sink.finish_rows(info(0), None, None).await.expect("first");
        assert_eq!(sink.kept(), 0);

        let count = sink.finish_count(info(1), 42);

        feed(&mut sink, 10..15).await;
        let third = sink
            .finish_rows(info(2), Some(TruncationReason::RowLimit), None)
            .await
            .expect("third");

        assert_eq!(first.row_count, 3);
        assert_eq!(third.row_count, 5);
        assert_eq!(third.truncation_reason, Some(TruncationReason::RowLimit));
        assert_eq!(read(&store, &first.result_id, 0, 10).len(), 3);
        assert_eq!(read(&store, &third.result_id, 0, 1), vec![row(10)]);

        // A count is a handle with nothing behind it.
        assert_eq!((count.row_count, count.rows_affected), (0, 42));
        assert!(count.columns.is_empty());
        assert_eq!(count.result_id, "q1");
        assert_eq!(tables(&store), 2, "one table per result with rows");
        assert_ne!(first.result_id, third.result_id);
    }

    #[tokio::test]
    async fn a_result_set_with_no_rows_writes_nothing() {
        let (_dir, store) = open_store(64 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));

        let empty = sink.finish_rows(info(0), None, None).await.expect("empty");
        assert_eq!(empty.row_count, 0);
        assert!(empty.columns.is_empty());

        // A page whose rows were all skipped still reports its columns.
        let paged = sink
            .finish_rows(info(1), None, Some(columns()))
            .await
            .expect("paged");
        assert_eq!(paged.row_count, 0);
        assert_eq!(paged.columns.len(), 2);

        assert_eq!(tables(&store), 0);
        // The store does not know either id, and releasing them is harmless.
        assert!(store
            .window(&empty.result_id, &WindowRequest::default())
            .is_err());
        store.release(&[empty.result_id, paged.result_id]);
    }

    #[tokio::test]
    async fn a_full_store_truncates_the_result_and_keeps_what_was_stored() {
        let (_dir, store) = open_store(MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));
        let wide = |n: i64| vec![SqlValue::Int(n), SqlValue::String("x".repeat(400))];
        for n in 0..10_000 {
            sink.accept(columns, wide(n)).await.expect("never an error");
            if sink.full {
                break;
            }
        }
        assert!(sink.full, "the budget never stopped the write");

        // The row limit was also reached, say. The store's budget is what
        // is reported.
        let handle = sink
            .finish_rows(info(0), Some(TruncationReason::RowLimit), None)
            .await
            .expect("finish");
        assert_eq!(handle.truncation_reason, Some(TruncationReason::StoreFull));
        assert!(handle.row_count > 0, "the batches before the full one stay");
        assert_eq!(handle.row_count % BATCH_ROWS as u64, 0, "whole batches");
        assert_eq!(
            read(&store, &handle.result_id, handle.row_count - 1, 5).len(),
            1
        );
        assert!(!sink.full, "the next result starts clean");

        // The next result finds little or no room: truncated too, and a
        // table only if any of it was kept.
        let before = tables(&store);
        for n in 0..5000 {
            sink.accept(columns, wide(n)).await.expect("never an error");
            if sink.full {
                break;
            }
        }
        let starved = sink.finish_rows(info(1), None, None).await.expect("finish");
        assert_eq!(starved.truncation_reason, Some(TruncationReason::StoreFull));
        assert!(starved.row_count < 5000);
        assert_eq!(starved.columns.len(), 2);
        assert_eq!(
            tables(&store),
            before + u64::from(starved.row_count > 0),
            "no table without rows"
        );
        store.release(&[starved.result_id]);

        // Releasing the first makes room again.
        store.release(&[handle.result_id]);
        feed(&mut sink, 0..10).await;
        let after = sink.finish_rows(info(2), None, None).await.expect("finish");
        assert_eq!(after.truncation_reason, None);
        assert_eq!(after.row_count, 10);
    }

    #[tokio::test]
    async fn discard_leaves_no_table() {
        let (_dir, store) = open_store(64 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));
        feed(&mut sink, 0..3).await;
        let kept = sink.finish_rows(info(0), None, None).await.expect("first");

        feed(&mut sink, 0..2500).await;
        assert_eq!(tables(&store), 2, "the second result is partly written");
        sink.discard().await;
        assert_eq!(tables(&store), 1);
        assert_eq!(sink.kept(), 0);
        assert!(sink.batch.is_empty());

        // The finished one is untouched, and the sink still works.
        assert_eq!(read(&store, &kept.result_id, 0, 10).len(), 3);
        feed(&mut sink, 0..5).await;
        let next = sink.finish_rows(info(2), None, None).await.expect("next");
        assert_eq!(next.row_count, 5);
    }

    #[tokio::test]
    async fn dropping_the_sink_mid_result_leaves_no_table() {
        // What happens when the run's future is dropped: nothing calls
        // `discard`, and the writer's own drop has to do it.
        let (_dir, store) = open_store(64 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));
        feed(&mut sink, 0..2500).await;
        assert_eq!(tables(&store), 1);
        drop(sink);
        assert_eq!(tables(&store), 0);
    }

    #[tokio::test]
    async fn a_panic_while_holding_a_writer_leaves_no_table() {
        let (_dir, store) = open_store(64 * MIB);
        let mut writer = store.begin(&columns()).expect("begin");
        writer.append(&[row(1)]).expect("append");
        assert_eq!(tables(&store), 1);

        let joined = tokio::task::spawn_blocking(move || {
            let _writer = writer;
            panic!("the task writing a batch died");
        })
        .await;
        let err = store_task_failed(joined.expect_err("the task panicked"));
        assert!(matches!(err, CoreError::Storage(_)), "{err:?}");

        assert_eq!(tables(&store), 0, "unwinding dropped the writer");
        // And the store is still usable.
        let mut sink = StoreSink::new(Arc::clone(&store));
        feed(&mut sink, 0..3).await;
        let handle = sink.finish_rows(info(0), None, None).await.expect("finish");
        assert_eq!(handle.row_count, 3);
    }

    #[tokio::test]
    async fn a_store_error_that_is_not_fullness_fails_the_statement() {
        let (_dir, store) = open_store(64 * MIB);
        let mut sink = StoreSink::new(Arc::clone(&store));
        feed(&mut sink, 0..3).await;
        // A row of the wrong width is refused by the store.
        sink.accept(columns, vec![SqlValue::Int(1)])
            .await
            .expect("buffered");
        let err = sink
            .finish_rows(info(0), None, None)
            .await
            .expect_err("the batch is refused");
        assert!(matches!(err, CoreError::Storage(_)), "{err:?}");
        assert_eq!(tables(&store), 0, "the failed result is gone");
        assert_eq!(sink.kept(), 0);
    }

    #[test]
    fn completed_outputs_keep_their_kind() {
        assert!(matches!(
            CollectSink::completed(vec![]),
            Completed::Results(_)
        ));
        let handles = vec![StoreSink::new(open_store(MIB).1).finish_count(info(0), 1)];
        match StoreSink::completed(handles) {
            Completed::Handles(handles) => assert_eq!(handles.len(), 1),
            Completed::Results(_) => panic!("handles became results"),
        }
    }

    #[test]
    fn a_count_from_the_collecting_sink_is_what_it_always_was() {
        let result = CollectSink::new().finish_count(info(3), 9);
        assert_eq!(result.query_id, "q3");
        assert_eq!(result.statement_index, 3);
        assert_eq!(result.rows_affected, 9);
        assert!(result.rows.is_empty() && result.columns.is_empty());
        assert!(!result.rows_truncated);
        assert_eq!(result.truncation_reason, None);
        assert_eq!(result.total_rows_available, None);
    }
}
