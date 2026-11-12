//! Backend-owned query results (#967, `docs/design/RESULT_STORE.md`).
//!
//! A result is written to a scratch SQLite file as it arrives, and the grid
//! reads it back a window at a time. The backend then never holds more than
//! a batch of rows, and the webview only the rows on screen.
//!
//! Everything here is synchronous; async callers go through
//! `tokio::task::spawn_blocking`. One connection sits behind one mutex, which
//! is taken for a single batch or a single read and never for a whole
//! ingest, so reading one result is not blocked for the length of a long
//! write to another.
//!
//! ## How a value comes back as the value that went in
//!
//! SQLite has five storage classes and `SqlValue` has seven variants, so the
//! class alone does not say whether an INTEGER was a `Bool`, an `Int` or a
//! `UInt`, or whether a TEXT was a `String` or a `UInt` too big for an
//! INTEGER. The executor picks the variant from the column's type, so within
//! a column the answer is almost always the same. The store records, per
//! column, which variant its INTEGER cells are and which variant its TEXT
//! cells are, taken from the first cell of each class. A cell that disagrees
//! with its column (the executor falls back to text when it cannot decode a
//! value) is listed in a side table by row and column with its own variant.
//! That table is not created until the first such cell, so an ordinary
//! result pays nothing for it.

mod filter;
mod order;
#[cfg(test)]
mod tests;

pub use filter::{
    is_active_filter, matches_filter, ColumnFilter, CompiledFilter, FilterCell, FilterOperator,
};

use crate::error::CoreError;
use crate::models::query::{ColumnMeta, SqlValue};
use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// SQLite function the `WHERE` clause calls for every filter but the NULL
/// tests: `mas_match(cell, operator, value, value2, cell_is_bool)`.
const MATCH_FUNCTION: &str = "mas_match";

/// Page cache of the scratch database, in KiB (SQLite reads a negative
/// `cache_size` as a size rather than a page count). This is the store's
/// memory ceiling; everything past it lives in the file.
const CACHE_KIB: i64 = 64 * 1024;

/// The fewest bytes of a long text value a window asks SQLite for. The few
/// values stored as text that are not strings (an unsigned integer above
/// `i64::MAX`) are far shorter than this, so they always arrive whole even
/// when the caller's cell limit is tiny.
const MIN_FETCH_BYTES: u32 = 64;

/// One key of a sort: a column and a direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SortKey {
    /// Zero-based position of the column in the result.
    #[specta(type = specta_typescript::Number)]
    pub column: usize,
    pub descending: bool,
}

/// One cell of a window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Cell {
    pub value: SqlValue,
    /// Set when `value` is only the start of a longer text or binary value:
    /// the real length in bytes. The whole value comes from
    /// [`ResultStore::cell`].
    #[specta(type = Option<specta_typescript::Number>)]
    pub full_len: Option<u64>,
}

/// Which rows of a result to read, and in what order.
#[derive(Debug, Clone, Default)]
pub struct WindowRequest {
    /// Rows to skip, counted after filtering and sorting.
    pub offset: u64,
    /// Rows to return at most.
    pub count: u32,
    /// Sort keys in order of precedence. Arrival order breaks ties, and is
    /// the whole order when this is empty.
    pub sort: Vec<SortKey>,
    /// All must pass. Filters with nothing typed into them are ignored.
    pub filters: Vec<ColumnFilter>,
    /// The most bytes of one text or binary cell to return.
    pub max_cell_bytes: u32,
}

/// A window of a result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ResultWindow {
    /// The identity of each returned row: its 1-based position in the result
    /// as the server returned it. Sorting and filtering do not change it.
    #[specta(type = Vec<specta_typescript::Number>)]
    pub row_ids: Vec<u64>,
    pub rows: Vec<Vec<Cell>>,
    /// Rows that pass the filters, before `offset` and `count` are applied.
    #[specta(type = specta_typescript::Number)]
    pub matching_rows: u64,
}

/// A result that has been written completely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct StoredResult {
    pub result_id: String,
    #[specta(type = specta_typescript::Number)]
    pub row_count: u64,
}

/// The `SqlValue` variant of a stored cell, where the storage class alone
/// does not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Variant {
    Bool,
    Int,
    UInt,
    Float,
    String,
}

impl Variant {
    /// The number a variant is written as in the side table.
    fn code(self) -> i64 {
        match self {
            Variant::Bool => 1,
            Variant::Int => 2,
            Variant::UInt => 3,
            Variant::Float => 4,
            Variant::String => 5,
        }
    }

    fn from_code(code: i64) -> Option<Self> {
        match code {
            1 => Some(Variant::Bool),
            2 => Some(Variant::Int),
            3 => Some(Variant::UInt),
            4 => Some(Variant::Float),
            5 => Some(Variant::String),
            _ => None,
        }
    }
}

const CLASS_INTEGER: u8 = 1;
const CLASS_REAL: u8 = 2;
const CLASS_TEXT: u8 = 4;
const CLASS_BLOB: u8 = 8;

/// What the store knows about one column of one result.
#[derive(Debug, Clone)]
struct ColumnState {
    /// Whether the server's type is a number, which decides how it sorts.
    numeric: bool,
    /// Storage classes seen in this column. Only used to pick the cheapest
    /// correct sort expression, so over-reporting is harmless.
    classes: u8,
    /// What an INTEGER cell of this column is, unless the side table says
    /// otherwise.
    integer_variant: Option<Variant>,
    /// What a TEXT cell of this column is, unless the side table says
    /// otherwise.
    text_variant: Option<Variant>,
    /// Longest string or byte value seen, so a window only pays for
    /// truncation in columns that can need it.
    max_len: u64,
}

impl ColumnState {
    fn new(meta: &ColumnMeta) -> Self {
        Self {
            numeric: order::is_numeric_type(&meta.data_type),
            classes: 0,
            integer_variant: None,
            text_variant: None,
            max_len: 0,
        }
    }

    /// Note an INTEGER cell of `variant`. Returns the variant when it is not
    /// what this column's INTEGER cells are, so the caller records it.
    fn see_integer(&mut self, variant: Variant) -> Option<Variant> {
        self.classes |= CLASS_INTEGER;
        Self::see(&mut self.integer_variant, variant)
    }

    /// The same for a TEXT cell.
    fn see_text(&mut self, variant: Variant) -> Option<Variant> {
        self.classes |= CLASS_TEXT;
        Self::see(&mut self.text_variant, variant)
    }

    fn see(recorded: &mut Option<Variant>, variant: Variant) -> Option<Variant> {
        match recorded {
            None => {
                *recorded = Some(variant);
                None
            }
            Some(known) if *known == variant => None,
            Some(_) => Some(variant),
        }
    }

    fn see_len(&mut self, len: usize) {
        self.max_len = self.max_len.max(u64::try_from(len).unwrap_or(u64::MAX));
    }
}

/// A finished result, as the catalog remembers it.
#[derive(Debug)]
struct ResultMeta {
    table: u64,
    columns: Vec<ColumnState>,
    row_count: u64,
    /// Whether the side table of mismatched cells exists.
    has_exceptions: bool,
}

fn table_name(table: u64) -> String {
    format!("r{table}")
}

fn exceptions_name(table: u64) -> String {
    format!("r{table}x")
}

struct State {
    /// `None` only while the store is being dropped.
    conn: Option<Connection>,
    /// Finished results by id. Kept in memory: the file does not outlive the
    /// process, so neither does anything that describes it.
    catalog: HashMap<String, Arc<ResultMeta>>,
    next_table: u64,
}

impl State {
    fn conn(&mut self) -> Result<&mut Connection, CoreError> {
        self.conn
            .as_mut()
            .ok_or_else(|| CoreError::Storage("The result store is closed".to_string()))
    }

    fn drop_tables(&mut self, table: u64) -> Result<(), CoreError> {
        // Names are generated from a counter, never taken from input.
        self.conn()?.execute_batch(&format!(
            "DROP TABLE IF EXISTS {}; DROP TABLE IF EXISTS {};",
            table_name(table),
            exceptions_name(table)
        ))?;
        Ok(())
    }
}

struct Inner {
    state: Mutex<State>,
    path: PathBuf,
    budget_bytes: u64,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic while the lock was held cannot leave the database half
        // written (each call is one transaction), so the state behind a
        // poisoned lock is still good to use.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn full(&self) -> CoreError {
        CoreError::ResultStoreFull(format!(
            "stored results would take more than {} bytes",
            self.budget_bytes
        ))
    }

    /// Tell a write that hit the size budget apart from any other failure.
    /// SQLite reports the page limit set in `open` as "database or disk is
    /// full", which is also what a really full disk looks like; both mean
    /// the same to the caller: stop reading rows.
    fn write_error(&self, err: rusqlite::Error) -> CoreError {
        match &err {
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::DiskFull =>
            {
                self.full()
            }
            _ => CoreError::Rusqlite(err),
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(PoisonError::into_inner);
        // Close before deleting: Windows will not delete an open file.
        if let Some(conn) = state.conn.take() {
            if let Err((_, e)) = conn.close() {
                tracing::warn!(error = %e, "Failed to close the result store");
            }
        }
        if let Err(e) = std::fs::remove_file(&self.path) {
            tracing::warn!(error = %e, "Failed to delete the result store file");
        }
    }
}

/// The scratch database holding this run's query results.
///
/// Dropping it closes the database and deletes its file. A [`ResultWriter`]
/// still alive at that point keeps the file until it is dropped too.
pub struct ResultStore {
    inner: Arc<Inner>,
}

impl ResultStore {
    /// Create this run's store in `dir`, which is created if missing.
    ///
    /// Any store file already in `dir` was left by a run that crashed, and is
    /// deleted first: results are private data and must not pile up on disk.
    /// `budget_bytes` caps the size of the file; a write that would pass it
    /// fails with [`CoreError::ResultStoreFull`].
    #[tracing::instrument(skip(dir))]
    pub fn open(dir: &Path, budget_bytes: u64) -> Result<Self, CoreError> {
        std::fs::create_dir_all(dir)
            .map_err(|e| CoreError::Storage(format!("Cannot create the result store: {e}")))?;
        sweep_stale_files(dir);

        let path = dir.join(format!("results-{}.db", uuid::Uuid::new_v4()));
        create_private_file(&path)
            .map_err(|e| CoreError::Storage(format!("Cannot create the result store: {e}")))?;

        let opened = Self::open_database(&path, budget_bytes);
        if opened.is_err() {
            // Nothing owns the file yet, so nothing else would delete it.
            let _ = std::fs::remove_file(&path);
        }
        let conn = opened?;

        Ok(Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    conn: Some(conn),
                    catalog: HashMap::new(),
                    next_table: 1,
                }),
                path,
                budget_bytes,
            }),
        })
    }

    fn open_database(path: &Path, budget_bytes: u64) -> Result<Connection, CoreError> {
        let conn = Connection::open(path)?;

        // A scratch file: if the process dies the file is deleted at the
        // next start, so nothing has to survive a crash. That buys speed:
        // no fsync, and the rollback journal in memory instead of in a
        // second file. The journal is kept rather than turned off because a
        // batch that hits the size budget is rolled back, and without a
        // journal that rollback would corrupt the file for the rows already
        // in it. Exclusive locking saves a file lock per transaction; no
        // other process has a reason to open this file.
        conn.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
        conn.pragma_update(None, "journal_mode", "MEMORY")?;
        conn.pragma_update(None, "synchronous", "OFF")?;
        conn.pragma_update(None, "cache_size", -CACHE_KIB)?;

        // The budget, enforced by SQLite itself: the file may not grow past
        // this many pages. Pages freed by released results are reused, so
        // the limit is on what the store holds, not on what it ever held.
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let page_size = u64::try_from(page_size).unwrap_or(4096).max(512);
        let max_pages = i64::try_from((budget_bytes / page_size).max(1)).unwrap_or(i64::MAX);
        conn.pragma_update(None, "max_page_count", max_pages)?;

        conn.create_collation(order::TEXT_COLLATION, order::text_cmp)?;
        conn.create_collation(order::DECIMAL_COLLATION, order::decimal_cmp)?;
        register_functions(&conn)?;
        Ok(conn)
    }

    /// Start writing a result with these columns.
    ///
    /// Columns are stored by position (`c0`, `c1`, ...), so duplicate and
    /// empty names need no escaping and no name from a server ever reaches
    /// the SQL this module builds.
    #[tracing::instrument(skip_all, fields(columns = columns.len()))]
    pub fn begin(&self, columns: &[ColumnMeta]) -> Result<ResultWriter, CoreError> {
        let mut state = self.inner.lock();
        let table = state.next_table;
        state.next_table += 1;

        // No declared types: a typed column would make SQLite convert values
        // on the way in ("12" into an INTEGER column becomes 12), and every
        // value must come back as it went in. A result with no columns still
        // needs one for the table to exist.
        let names = if columns.is_empty() {
            "z".to_string()
        } else {
            column_list(columns.len())
        };
        state
            .conn()?
            .execute_batch(&format!("CREATE TABLE {} ({names})", table_name(table)))
            .map_err(|e| self.inner.write_error(e))?;

        let mut insert_sql = format!("INSERT INTO {} (rowid", table_name(table));
        for index in 0..columns.len() {
            let _ = write!(insert_sql, ", c{index}");
        }
        insert_sql.push_str(") VALUES (?");
        insert_sql.push_str(&", ?".repeat(columns.len()));
        insert_sql.push(')');

        Ok(ResultWriter {
            inner: Arc::clone(&self.inner),
            table,
            columns: columns.iter().map(ColumnState::new).collect(),
            row_count: 0,
            has_exceptions: false,
            insert_sql,
            finished: false,
        })
    }

    /// Read a window of a result: filtered, sorted, then cut to
    /// `offset`/`count`.
    ///
    /// Sorting and filtering happen inside SQLite; no row outside the window
    /// is loaded to decide the order.
    #[tracing::instrument(skip_all, fields(
        result_id = %result_id,
        offset = request.offset,
        count = request.count,
        sort_keys = request.sort.len(),
        filters = request.filters.len(),
    ))]
    pub fn window(
        &self,
        result_id: &str,
        request: &WindowRequest,
    ) -> Result<ResultWindow, CoreError> {
        let mut state = self.inner.lock();
        let meta = lookup(&state, result_id)?;
        let conn = state.conn()?;
        let table = table_name(meta.table);

        let (where_sql, params) = where_clause(&meta, &request.filters)?;
        let filtered = !where_sql.is_empty();
        let order_sql = order_clause(&meta, &request.sort)?;

        let matching_rows = if filtered {
            let count: i64 = conn.query_row(
                &format!("SELECT count(*) FROM {table} WHERE {where_sql}"),
                rusqlite::params_from_iter(params.iter()),
                |row| row.get(0),
            )?;
            u64::try_from(count).unwrap_or_default()
        } else {
            meta.row_count
        };

        let mut window = ResultWindow {
            row_ids: Vec::new(),
            rows: Vec::new(),
            matching_rows,
        };
        if request.count == 0 || request.offset >= matching_rows {
            return Ok(window);
        }

        // Select list: the row id, each column (cut short where the column
        // can hold more than the cell limit), then the row's entries in the
        // side table of mismatched cells, if there is one.
        let limit = request.max_cell_bytes;
        let fetch = limit.max(MIN_FETCH_BYTES);
        let mut sql = String::from("SELECT t.rowid");
        let mut truncating = Vec::with_capacity(meta.columns.len());
        for (index, column) in meta.columns.iter().enumerate() {
            let cuts = column.max_len > u64::from(limit);
            truncating.push(cuts);
            if cuts {
                // Text is cut as bytes and relabelled as text; the cut may
                // land inside a character, which `decode_cell` trims off.
                let _ = write!(
                    sql,
                    ", CASE WHEN typeof(c{index}) = 'text' AND octet_length(c{index}) > {fetch} \
                     THEN CAST(substr(CAST(c{index} AS BLOB), 1, {fetch}) AS TEXT) \
                     WHEN typeof(c{index}) = 'blob' AND octet_length(c{index}) > {fetch} \
                     THEN substr(c{index}, 1, {fetch}) ELSE c{index} END, \
                     CASE WHEN typeof(c{index}) IN ('text', 'blob') \
                     AND octet_length(c{index}) > {limit} THEN octet_length(c{index}) END"
                );
            } else {
                let _ = write!(sql, ", c{index}");
            }
        }
        if meta.has_exceptions {
            let _ = write!(
                sql,
                ", (SELECT group_concat(col_no || ':' || variant) FROM {} WHERE row_id = t.rowid)",
                exceptions_name(meta.table)
            );
        }
        let _ = write!(sql, " FROM {table} AS t");

        let count = request.count;
        if !filtered && request.sort.is_empty() {
            // Row ids are the positions 1..=n with no gaps, so an unsorted,
            // unfiltered window is a range of them: a seek, however deep the
            // offset, rather than a walk past every row before it.
            let _ = write!(
                sql,
                " WHERE t.rowid > {} ORDER BY t.rowid LIMIT {count}",
                request.offset
            );
        } else {
            if filtered {
                let _ = write!(sql, " WHERE {where_sql}");
            }
            let offset = request.offset.min(i64::MAX.unsigned_abs());
            let _ = write!(sql, " ORDER BY {order_sql} LIMIT {count} OFFSET {offset}");
        }

        // Where the side-table entries sit: after the row id and one or two
        // values per column.
        let exceptions_position = 1 + truncating
            .iter()
            .map(|cuts| if *cuts { 2 } else { 1 })
            .sum::<usize>();

        let mut statement = conn.prepare(&sql)?;
        let mut rows = statement.query(rusqlite::params_from_iter(params.iter()))?;
        while let Some(row) = rows.next()? {
            let row_id: i64 = row.get(0)?;
            let exceptions = if meta.has_exceptions {
                parse_exceptions(row.get_ref(exceptions_position)?)?
            } else {
                Vec::new()
            };

            let mut cells = Vec::with_capacity(meta.columns.len());
            let mut position = 1;
            for (index, column) in meta.columns.iter().enumerate() {
                let value = row.get_ref(position)?;
                position += 1;
                let full_len = if truncating[index] {
                    let len: Option<i64> = row.get(position)?;
                    position += 1;
                    len.and_then(|len| u64::try_from(len).ok())
                } else {
                    None
                };
                let exception = exceptions
                    .iter()
                    .find(|(col, _)| *col == index)
                    .map(|(_, variant)| *variant);
                cells.push(decode_cell(value, column, exception, full_len, limit)?);
            }
            window
                .row_ids
                .push(u64::try_from(row_id).unwrap_or_default());
            window.rows.push(cells);
        }
        Ok(window)
    }

    /// Read one whole cell, however long. `row_id` is the row's identity as
    /// [`ResultWindow::row_ids`] reports it.
    #[tracing::instrument(skip(self))]
    pub fn cell(&self, result_id: &str, row_id: u64, column: usize) -> Result<SqlValue, CoreError> {
        let mut state = self.inner.lock();
        let meta = lookup(&state, result_id)?;
        let conn = state.conn()?;
        let column_state = meta
            .columns
            .get(column)
            .ok_or_else(|| CoreError::NotFound(format!("Column {column} of result {result_id}")))?;
        let missing_row = || CoreError::NotFound(format!("Row {row_id} of result {result_id}"));
        let row = i64::try_from(row_id).map_err(|_| missing_row())?;

        let exception = if meta.has_exceptions {
            let code: Option<i64> = conn
                .query_row(
                    &format!(
                        "SELECT variant FROM {} WHERE row_id = ?1 AND col_no = ?2",
                        exceptions_name(meta.table)
                    ),
                    rusqlite::params![row, i64::try_from(column).unwrap_or(i64::MAX)],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })?;
            code.and_then(Variant::from_code)
        } else {
            None
        };

        let mut statement = conn.prepare_cached(&format!(
            "SELECT c{column} FROM {} WHERE rowid = ?1",
            table_name(meta.table)
        ))?;
        let mut rows = statement.query([row])?;
        let found = rows.next()?.ok_or_else(missing_row)?;
        decode_value(found.get_ref(0)?, column_state, exception)
    }

    /// Forget these results and free their space for later ones. Ids the
    /// store does not know (already released, or never finished) are
    /// ignored.
    #[tracing::instrument(skip(self))]
    pub fn release(&self, result_ids: &[String]) {
        let mut state = self.inner.lock();
        for result_id in result_ids {
            let Some(meta) = state.catalog.remove(result_id) else {
                continue;
            };
            if let Err(e) = state.drop_tables(meta.table) {
                tracing::warn!(result_id, error = %e, "Failed to drop a released result");
            }
        }
    }
}

/// Writes one result into the store, a batch at a time.
///
/// Dropping a writer without calling [`ResultWriter::finish`] discards what
/// it wrote.
pub struct ResultWriter {
    inner: Arc<Inner>,
    table: u64,
    columns: Vec<ColumnState>,
    row_count: u64,
    has_exceptions: bool,
    insert_sql: String,
    finished: bool,
}

impl ResultWriter {
    /// Append rows, in order, as one transaction.
    ///
    /// The store's lock is held for this call only. If the batch would take
    /// the store past its budget, none of it is kept, the error is
    /// [`CoreError::ResultStoreFull`], and the rows of earlier calls stay:
    /// the writer can still be finished and what it holds read.
    #[tracing::instrument(skip_all, fields(rows = rows.len()))]
    pub fn append(&mut self, rows: &[Vec<SqlValue>]) -> Result<(), CoreError> {
        if rows.is_empty() {
            return Ok(());
        }
        // What this batch learns about the columns is kept apart until the
        // batch commits. If it were applied directly and the batch then
        // rolled back, the writer would believe in a side table that the
        // rollback removed.
        let mut columns = self.columns.clone();
        let mut has_exceptions = self.has_exceptions;
        let mut row_id = self.row_count;

        let inner = Arc::clone(&self.inner);
        let mut state = inner.lock();
        let tx = state.conn()?.transaction()?;
        {
            let mut insert = tx
                .prepare_cached(&self.insert_sql)
                .map_err(|e| inner.write_error(e))?;
            for row in rows {
                if row.len() != columns.len() {
                    return Err(CoreError::Storage(format!(
                        "A row has {} values for {} columns",
                        row.len(),
                        columns.len()
                    )));
                }
                row_id += 1;
                let row_key = i64::try_from(row_id)
                    .map_err(|_| CoreError::Storage("Too many rows".to_string()))?;
                insert.raw_bind_parameter(1, row_key)?;
                for (index, (value, column)) in row.iter().zip(columns.iter_mut()).enumerate() {
                    let Some(variant) = bind_value(&mut insert, index + 2, value, column)? else {
                        continue;
                    };
                    // This cell is not what its column's cells are. Note its
                    // own variant so it still comes back exactly.
                    if !has_exceptions {
                        tx.execute_batch(&format!(
                            "CREATE TABLE IF NOT EXISTS {} (row_id INTEGER NOT NULL, \
                             col_no INTEGER NOT NULL, variant INTEGER NOT NULL, \
                             PRIMARY KEY (row_id, col_no)) WITHOUT ROWID",
                            exceptions_name(self.table)
                        ))
                        .map_err(|e| inner.write_error(e))?;
                        has_exceptions = true;
                    }
                    tx.prepare_cached(&format!(
                        "INSERT INTO {} (row_id, col_no, variant) VALUES (?1, ?2, ?3)",
                        exceptions_name(self.table)
                    ))
                    .and_then(|mut statement| {
                        statement.execute(rusqlite::params![
                            row_key,
                            i64::try_from(index).unwrap_or(i64::MAX),
                            variant.code()
                        ])
                    })
                    .map_err(|e| inner.write_error(e))?;
                }
                insert.raw_execute().map_err(|e| inner.write_error(e))?;
            }
        }
        tx.commit().map_err(|e| inner.write_error(e))?;
        drop(state);

        self.columns = columns;
        self.has_exceptions = has_exceptions;
        self.row_count = row_id;
        Ok(())
    }

    /// Rows written so far.
    pub fn row_count(&self) -> u64 {
        self.row_count
    }

    /// Make the result readable and return its id.
    #[tracing::instrument(skip_all, fields(rows = self.row_count))]
    pub fn finish(mut self) -> Result<StoredResult, CoreError> {
        let result_id = uuid::Uuid::new_v4().to_string();
        let meta = ResultMeta {
            table: self.table,
            columns: std::mem::take(&mut self.columns),
            row_count: self.row_count,
            has_exceptions: self.has_exceptions,
        };
        self.inner
            .lock()
            .catalog
            .insert(result_id.clone(), Arc::new(meta));
        // From here the catalog owns the table; `Drop` must leave it alone.
        self.finished = true;
        Ok(StoredResult {
            result_id,
            row_count: self.row_count,
        })
    }
}

impl Drop for ResultWriter {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // An abandoned result (the query failed or was cancelled) has no id
        // anyone could release it by, so its rows go now.
        if let Err(e) = self.inner.lock().drop_tables(self.table) {
            tracing::warn!(error = %e, "Failed to drop an unfinished result");
        }
    }
}

/// Delete store files left in `dir` by a run that did not exit cleanly.
///
/// Best effort. A second copy of the app that is still running keeps its
/// store working on Unix (an open file survives its name being removed) and
/// on Windows refuses the delete, which is ignored.
fn sweep_stale_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // The database and anything SQLite put beside it (`-journal`).
        if name.starts_with("results-") && name.contains(".db") {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                tracing::warn!(error = %e, "Failed to delete a stale result store file");
            }
        }
    }
}

/// Create the store's file so that only the owner can read it, before SQLite
/// puts anything in it. Results are the user's data, on disk.
fn create_private_file(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map(|_| ())
}

fn column_list(count: usize) -> String {
    (0..count)
        .map(|index| format!("c{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn lookup(state: &State, result_id: &str) -> Result<Arc<ResultMeta>, CoreError> {
    state
        .catalog
        .get(result_id)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("Result {result_id}")))
}

fn check_column(meta: &ResultMeta, column: usize) -> Result<&ColumnState, CoreError> {
    meta.columns
        .get(column)
        .ok_or_else(|| CoreError::Query(format!("The result has no column {column}")))
}

/// The filters as SQL, with the text each one binds. Empty when no filter is
/// active. Only generated names and numbers are written into the SQL; every
/// operand is a bound parameter.
fn where_clause(
    meta: &ResultMeta,
    filters: &[ColumnFilter],
) -> Result<(String, Vec<String>), CoreError> {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for filter in filters.iter().filter(|f| is_active_filter(f)) {
        let column = check_column(meta, filter.column)?;
        let index = filter.column;
        clauses.push(match filter.operator {
            FilterOperator::IsNull => format!("c{index} IS NULL"),
            FilterOperator::IsNotNull => format!("c{index} IS NOT NULL"),
            operator => {
                params.push(filter.value.clone());
                params.push(filter.value2.clone().unwrap_or_default());
                // The function sees an INTEGER and cannot tell 1 from true;
                // the column can. A boolean is searched as "true"/"false".
                let is_bool = i32::from(column.integer_variant == Some(Variant::Bool));
                format!(
                    "{MATCH_FUNCTION}(c{index}, {}, ?{}, ?{}, {is_bool})",
                    operator.code(),
                    params.len() - 1,
                    params.len()
                )
            }
        });
    }
    Ok((clauses.join(" AND "), params))
}

/// The sort keys as an `ORDER BY` list, ending in the row id so the order is
/// stable and total.
///
/// SQLite already puts NULL first ascending and last descending, which is
/// MySQL's rule.
fn order_clause(meta: &ResultMeta, sort: &[SortKey]) -> Result<String, CoreError> {
    let mut keys = Vec::with_capacity(sort.len() + 1);
    for key in sort {
        let column = check_column(meta, key.column)?;
        let index = key.column;
        let has_text = column.classes & (CLASS_TEXT | CLASS_BLOB) != 0;
        let has_numbers = column.classes & (CLASS_INTEGER | CLASS_REAL) != 0;
        let expression = if !column.numeric {
            // Only text is compared by the collation; numbers in the same
            // column keep SQLite's own order and come before text.
            format!("c{index} COLLATE {}", order::TEXT_COLLATION)
        } else if !has_text {
            // INTEGER and REAL: SQLite compares them as numbers already.
            format!("c{index}")
        } else if !has_numbers {
            // DECIMAL, BIGINT: exact digits kept as text.
            format!("c{index} COLLATE {}", order::DECIMAL_COLLATION)
        } else {
            // Both in one column (a BIT(64) with values either side of
            // i64::MAX). SQLite would put every INTEGER before every TEXT,
            // so all of them are compared as decimal text.
            format!(
                "{}(c{index}) COLLATE {}",
                order::NUMBER_TEXT_FUNCTION,
                order::DECIMAL_COLLATION
            )
        };
        let direction = if key.descending { " DESC" } else { "" };
        keys.push(format!("{expression}{direction}"));
    }
    keys.push("t.rowid".to_string());
    Ok(keys.join(", "))
}

/// Register the scalar functions `where_clause` and `order_clause` call.
fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;

    conn.create_scalar_function(MATCH_FUNCTION, 5, flags, |ctx| {
        // The operator and operands are the same for every row of a scan, so
        // the compiled filter (lowercased needle, compiled pattern) is built
        // for the first row and kept with the statement.
        let compiled = match ctx.get_aux::<CompiledFilter>(1)? {
            Some(compiled) => compiled,
            None => {
                let operator = FilterOperator::from_code(ctx.get::<i64>(1)?).ok_or_else(|| {
                    rusqlite::Error::UserFunctionError("unknown filter operator".into())
                })?;
                let value: String = ctx.get(2)?;
                let value2: String = ctx.get(3)?;
                ctx.set_aux(1, CompiledFilter::new(operator, &value, Some(&value2)))?
            }
        };
        let is_bool = ctx.get::<i64>(4)? != 0;
        let cell = match ctx.get_raw(0) {
            ValueRef::Null => FilterCell::Null,
            ValueRef::Integer(value) if is_bool => FilterCell::Bool(value != 0),
            ValueRef::Integer(value) => FilterCell::Int(value),
            ValueRef::Real(value) => FilterCell::Float(value),
            ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
                Ok(text) => FilterCell::Text(text),
                Err(_) => FilterCell::Bytes,
            },
            ValueRef::Blob(_) => FilterCell::Bytes,
        };
        Ok(compiled.matches(&cell))
    })?;

    conn.create_scalar_function(order::NUMBER_TEXT_FUNCTION, 1, flags, |ctx| {
        Ok(match ctx.get_raw(0) {
            ValueRef::Integer(value) => Value::Text(value.to_string()),
            ValueRef::Real(value) => Value::Text(order::float_text(value)),
            other => Value::from(other),
        })
    })
}

/// Bind one value to an insert, and note what the column now holds.
///
/// Returns the cell's variant when it is not the one recorded for its
/// column, which the caller writes to the side table.
fn bind_value(
    statement: &mut rusqlite::CachedStatement<'_>,
    position: usize,
    value: &SqlValue,
    column: &mut ColumnState,
) -> Result<Option<Variant>, CoreError> {
    let exception = match value {
        SqlValue::Null => {
            statement.raw_bind_parameter(position, rusqlite::types::Null)?;
            None
        }
        SqlValue::Bool(value) => {
            statement.raw_bind_parameter(position, i64::from(*value))?;
            column.see_integer(Variant::Bool)
        }
        SqlValue::Int(value) => {
            statement.raw_bind_parameter(position, *value)?;
            column.see_integer(Variant::Int)
        }
        SqlValue::UInt(value) => match i64::try_from(*value) {
            Ok(small) => {
                statement.raw_bind_parameter(position, small)?;
                column.see_integer(Variant::UInt)
            }
            // Past what an INTEGER holds: the digits as text. The decimal
            // collation still sorts them as numbers.
            Err(_) => {
                statement.raw_bind_parameter(position, value.to_string())?;
                column.see_text(Variant::UInt)
            }
        },
        // SQLite has no NaN; binding one stores NULL, which would then pass
        // an `isNull` filter. Keep it apart from NULL as the text "NaN".
        SqlValue::Float(value) if value.is_nan() => {
            statement.raw_bind_parameter(position, "NaN")?;
            column.see_text(Variant::Float)
        }
        SqlValue::Float(value) => {
            statement.raw_bind_parameter(position, *value)?;
            column.classes |= CLASS_REAL;
            None
        }
        SqlValue::String(value) => {
            statement.raw_bind_parameter(position, value.as_str())?;
            column.see_len(value.len());
            column.see_text(Variant::String)
        }
        SqlValue::Bytes(value) => {
            statement.raw_bind_parameter(position, value.as_slice())?;
            column.see_len(value.len());
            column.classes |= CLASS_BLOB;
            None
        }
    };
    Ok(exception)
}

/// The store read back something it could not have written.
fn corrupt(what: &str) -> CoreError {
    CoreError::Storage(format!("The result store holds {what}"))
}

/// Turn a stored value back into the `SqlValue` that was written.
fn decode_value(
    value: ValueRef<'_>,
    column: &ColumnState,
    exception: Option<Variant>,
) -> Result<SqlValue, CoreError> {
    Ok(match value {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(stored) => match exception.or(column.integer_variant) {
            Some(Variant::Bool) => SqlValue::Bool(stored != 0),
            Some(Variant::UInt) => SqlValue::UInt(
                u64::try_from(stored).map_err(|_| corrupt("a negative unsigned integer"))?,
            ),
            _ => SqlValue::Int(stored),
        },
        ValueRef::Real(stored) => SqlValue::Float(stored),
        ValueRef::Text(bytes) => {
            let text = std::str::from_utf8(bytes).map_err(|_| corrupt("text that is not UTF-8"))?;
            match exception.or(column.text_variant) {
                Some(Variant::UInt) => SqlValue::UInt(
                    text.parse()
                        .map_err(|_| corrupt("an unreadable unsigned integer"))?,
                ),
                Some(Variant::Float) => SqlValue::Float(f64::NAN),
                _ => SqlValue::String(text.to_string()),
            }
        }
        ValueRef::Blob(bytes) => SqlValue::Bytes(bytes.to_vec()),
    })
}

/// Decode a cell of a window, cutting a long string or byte value to
/// `limit` bytes.
///
/// `full_len` is the value's real length when SQLite found it longer than
/// `limit`; the value may already have been cut by the query, possibly in
/// the middle of a character.
fn decode_cell(
    value: ValueRef<'_>,
    column: &ColumnState,
    exception: Option<Variant>,
    full_len: Option<u64>,
    limit: u32,
) -> Result<Cell, CoreError> {
    let Some(full_len) = full_len else {
        return Ok(Cell {
            value: decode_value(value, column, exception)?,
            full_len: None,
        });
    };
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    match value {
        ValueRef::Blob(bytes) => Ok(Cell {
            value: SqlValue::Bytes(bytes[..limit.min(bytes.len())].to_vec()),
            full_len: Some(full_len),
        }),
        ValueRef::Text(bytes)
            if matches!(
                exception.or(column.text_variant),
                None | Some(Variant::String)
            ) =>
        {
            let cut = &bytes[..limit.min(bytes.len())];
            // Back off to the last whole character: a string must not end
            // in half of one.
            let text = match std::str::from_utf8(cut) {
                Ok(text) => text,
                Err(e) => std::str::from_utf8(&cut[..e.valid_up_to()])
                    .map_err(|_| corrupt("text that is not UTF-8"))?,
            };
            Ok(Cell {
                value: SqlValue::String(text.to_string()),
                full_len: Some(full_len),
            })
        }
        // A number kept as text is never cut, whatever the limit: half of
        // one is a different number. The query fetches at least
        // `MIN_FETCH_BYTES`, so it is whole here.
        other => Ok(Cell {
            value: decode_value(other, column, exception)?,
            full_len: None,
        }),
    }
}

/// Read a row's side-table entries, written by the window query as
/// `column:variant` pairs separated by commas.
fn parse_exceptions(value: ValueRef<'_>) -> Result<Vec<(usize, Variant)>, CoreError> {
    let ValueRef::Text(bytes) = value else {
        return Ok(Vec::new());
    };
    let text = std::str::from_utf8(bytes).map_err(|_| corrupt("an unreadable cell note"))?;
    text.split(',')
        .map(|pair| {
            let (column, code) = pair.split_once(':')?;
            Some((
                column.parse().ok()?,
                Variant::from_code(code.parse().ok()?)?,
            ))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| corrupt("an unreadable cell note"))
}
