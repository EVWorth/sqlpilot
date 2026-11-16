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
//! write to another. Putting a result in a sorted or filtered order is done
//! once per order and in steps of that size too (see `view`).
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
mod view;
mod wire;

pub use filter::{
    is_active_filter, matches_filter, CompiledFilter, FilterCell, FilterOperator, ResultFilter,
};

pub use wire::WireValue;

use crate::error::CoreError;
use crate::models::query::{ColumnMeta, SqlValue};
use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use view::{Phase, ViewKey, ViewSlot};

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

/// The most row ids one [`ResultStore::row_ids`] call returns, whatever it
/// asks for. An id is a small number, so this is far above a window's cap.
pub const ROW_IDS_MAX_COUNT: u32 = 100_000;

/// The most row ids one [`ResultStore::order`] call takes.
pub const ORDER_MAX_IDS: usize = 1_000_000;

/// The most rows one [`ResultStore::rows`] call returns.
pub const ROWS_MAX_COUNT: usize = 1_000;

/// The most cell data one [`ResultStore::rows`] call returns, in bytes. A
/// call that would pass it fails and says so, and the caller asks for fewer
/// rows. One row is always returned, however large: there is no smaller
/// thing to ask for.
pub const ROWS_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// How many orders of one result are kept ready at a time: the one on
/// screen and the two before it, so going back to a sort or a filter just
/// left costs nothing. The least recently read goes first.
pub const VIEWS_PER_RESULT: usize = 3;

/// Rows [`ResultStore::rows`] reads per turn at the store's lock.
const ROWS_PER_TURN: usize = 200;

/// Cell data that ends a turn at the lock early, in bytes: what a batch of
/// a write is held to.
const TURN_BYTES: u64 = 4 * 1024 * 1024;

/// Row ids [`ResultStore::order`] looks up per turn at the lock.
const ORDER_SEEKS_PER_TURN: usize = 4_000;

/// View rows [`ResultStore::order`] walks per turn at the lock, when most
/// of the view was asked for and walking it is cheaper than looking up.
const ORDER_SCAN_PER_TURN: u32 = 20_000;

/// How often a read tries to get a view before it reads without one. More
/// than one try is only needed when a view was dropped between being built
/// and being read, by a burst of other views of the same result.
const VIEW_ATTEMPTS: usize = 3;

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
    /// On the wire a [`WireValue`]: binary travels as base64, not as an
    /// array of numbers.
    #[serde(with = "wire")]
    #[specta(type = WireValue)]
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
    pub filters: Vec<ResultFilter>,
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

/// A finished result and the orders of it that are kept ready.
struct Entry {
    meta: Arc<ResultMeta>,
    /// Most recently read first, at most [`VIEWS_PER_RESULT`].
    views: Vec<Arc<ViewSlot>>,
}

struct State {
    /// `None` only while the store is being dropped.
    conn: Option<Connection>,
    /// Finished results by id. Kept in memory: the file does not outlive the
    /// process, so neither does anything that describes it.
    catalog: HashMap<String, Entry>,
    next_table: u64,
    next_view: u64,
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

    fn drop_view(&mut self, table: u64) -> Result<(), CoreError> {
        self.conn()?
            .execute_batch(&format!("DROP TABLE IF EXISTS {}", view::table_name(table)))?;
        Ok(())
    }

    /// Stop keeping a view: free its table if it has one, and tell whoever
    /// is still building it to stop. The caller has already taken it out of
    /// its result's list.
    fn discard_view(&mut self, slot: &ViewSlot) {
        slot.cancel();
        if let Phase::Ready { table, .. } = slot.phase() {
            slot.set(Phase::Unavailable);
            if let Err(e) = self.drop_view(table) {
                tracing::warn!(error = %e, "Failed to drop a view of a result");
            }
        }
    }
}

struct Inner {
    state: Mutex<State>,
    /// The store's file, or `None` for a store that lives in memory.
    path: Option<PathBuf>,
    budget_bytes: u64,
    /// The most columns a result may have: what this build's SQLite allows
    /// in a table, asked of SQLite itself rather than assumed.
    max_columns: usize,
    /// Views built to completion since the store opened.
    views_built: AtomicU64,
    /// Called between the steps of a view build, with no lock held, so a
    /// test can stop a build half way.
    #[cfg(test)]
    build_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic while the lock was held cannot leave the database half
        // written (each call is one transaction), so the state behind a
        // poisoned lock is still good to use.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Between two steps of a view build, with no lock held.
    fn after_build_step(&self) {
        #[cfg(test)]
        {
            // Cloned out, so one build waiting in the hook does not hold
            // up another build's call to it.
            let hook = self
                .build_hook
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if let Some(hook) = hook {
                hook();
            }
        }
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
        if let Some(path) = &self.path {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!(error = %e, "Failed to delete the result store file");
            }
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

        let opened = Connection::open(&path)
            .map_err(CoreError::from)
            .and_then(|conn| Self::configure(conn, budget_bytes));
        if opened.is_err() {
            // Nothing owns the file yet, so nothing else would delete it.
            let _ = std::fs::remove_file(&path);
        }
        Ok(Self::with_connection(opened?, Some(path), budget_bytes))
    }

    /// A store that keeps its results in memory rather than in a file.
    ///
    /// For when no directory can be written to: the app still runs queries,
    /// with `budget_bytes` of RAM as the ceiling on what it can hold.
    #[tracing::instrument]
    pub fn in_memory(budget_bytes: u64) -> Result<Self, CoreError> {
        let conn = Self::configure(Connection::open_in_memory()?, budget_bytes)?;
        Ok(Self::with_connection(conn, None, budget_bytes))
    }

    fn with_connection(conn: Connection, path: Option<PathBuf>, budget_bytes: u64) -> Self {
        let max_columns = column_limit(&conn);
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    conn: Some(conn),
                    catalog: HashMap::new(),
                    next_table: 1,
                    next_view: 1,
                }),
                path,
                budget_bytes,
                max_columns,
                views_built: AtomicU64::new(0),
                #[cfg(test)]
                build_hook: Mutex::new(None),
            }),
        }
    }

    /// The most columns a result may have in this build.
    ///
    /// SQLite's stock limit is 2,000 columns in a table; the bundled SQLite
    /// is built with a higher one (`src-tauri/.cargo/config.toml`) because a
    /// MySQL table alone can have 4,096. This is what the SQLite in this
    /// binary really allows.
    pub fn max_columns(&self) -> usize {
        self.inner.max_columns
    }

    /// How many views this store has built since it opened. A view that was
    /// read again without being rebuilt does not count. For diagnostics and
    /// for tests of reuse.
    pub fn views_built(&self) -> u64 {
        self.inner.views_built.load(Ordering::Relaxed)
    }

    fn configure(conn: Connection, budget_bytes: u64) -> Result<Connection, CoreError> {
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
        if columns.len() > self.inner.max_columns {
            return Err(CoreError::Storage(format!(
                "A result of {} columns cannot be stored: the limit is {}",
                columns.len(),
                self.inner.max_columns
            )));
        }
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

    /// Run `read` against one order of a result: `sort` over the rows that
    /// pass `filters`.
    ///
    /// `read` is told where that order is to be found: nowhere, for the
    /// result as it arrived; in a view table, built here the first time the
    /// order is asked for and kept for the next read; or, when a view could
    /// not be built, in the sort-and-filter query itself. It runs with the
    /// store's lock held, so the view it reads cannot be dropped under it.
    ///
    /// Two callers that want the same new view build it once: the second
    /// waits for the first. Neither holds the lock while it waits or builds.
    fn read_view<T>(
        &self,
        result_id: &str,
        sort: &[SortKey],
        filters: &[ResultFilter],
        mut read: impl FnMut(&mut Connection, &ResultMeta, &Plan, Source) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let key = ViewKey::new(sort, filters);
        for _ in 0..VIEW_ATTEMPTS {
            let mut state = self.inner.lock();
            let entry = state
                .catalog
                .get_mut(result_id)
                .ok_or_else(|| unknown_result(result_id))?;
            let meta = Arc::clone(&entry.meta);
            let plan = Plan::new(&meta, &key)?;
            if key.is_identity() {
                return read(state.conn()?, &meta, &plan, Source::Arrival);
            }

            let Some(index) = entry.views.iter().position(|slot| slot.key == key) else {
                // A new order. Claim it before letting go of the lock, so
                // the next caller that wants it waits instead of building.
                let slot = Arc::new(ViewSlot::new(key.clone()));
                entry.views.insert(0, Arc::clone(&slot));
                let keep = entry.views.len().min(VIEWS_PER_RESULT);
                let dropped = entry.views.split_off(keep);
                for old in &dropped {
                    state.discard_view(old);
                }
                drop(state);
                view::build(&self.inner, result_id, &meta, &plan, &slot);
                continue;
            };
            let slot = entry.views.remove(index);
            entry.views.insert(0, Arc::clone(&slot));
            match slot.phase() {
                Phase::Ready { table, len } => {
                    return read(state.conn()?, &meta, &plan, Source::View { table, len });
                }
                Phase::Unavailable => return read(state.conn()?, &meta, &plan, Source::Query),
                Phase::Building => {
                    drop(state);
                    slot.wait();
                }
            }
        }

        let mut state = self.inner.lock();
        let meta = lookup(&state, result_id)?;
        let plan = Plan::new(&meta, &key)?;
        read(state.conn()?, &meta, &plan, Source::Query)
    }

    /// Read a window of a result: filtered, sorted, then cut to
    /// `offset`/`count`.
    ///
    /// The first window of a sort or a filter puts the whole result in that
    /// order once (a view); every window after it, at any offset, is a seek.
    /// No row outside the window is loaded either way.
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
        self.read_view(
            result_id,
            &request.sort,
            &request.filters,
            |conn, meta, plan, source| read_window(conn, meta, plan, source, request),
        )
    }

    /// The ids of the rows at positions `[offset, offset + count)` of a
    /// view, fewer where the view ends first. `count` is cut to
    /// [`ROW_IDS_MAX_COUNT`]; a caller that wants more asks again from where
    /// the answer stopped.
    #[tracing::instrument(skip_all, fields(
        result_id = %result_id,
        offset,
        count,
        sort_keys = sort.len(),
        filters = filters.len(),
    ))]
    pub fn row_ids(
        &self,
        result_id: &str,
        offset: u64,
        count: u32,
        sort: &[SortKey],
        filters: &[ResultFilter],
    ) -> Result<Vec<u64>, CoreError> {
        let count = count.min(ROW_IDS_MAX_COUNT);
        self.read_view(result_id, sort, filters, |conn, meta, plan, source| {
            if count == 0 {
                return Ok(Vec::new());
            }
            let offset = offset.min(i64::MAX.unsigned_abs());
            match source {
                Source::Arrival => {
                    let end = offset.saturating_add(u64::from(count)).min(meta.row_count);
                    Ok((offset.saturating_add(1)..=end).collect())
                }
                Source::View { table, .. } => collect_ids(
                    conn,
                    &format!(
                        "SELECT rid FROM {} WHERE pos > {offset} ORDER BY pos LIMIT {count}",
                        view::table_name(table)
                    ),
                    &[],
                ),
                Source::Query => collect_ids(
                    conn,
                    &format!(
                        "{} LIMIT {count} OFFSET {offset}",
                        plan.ordered_ids(meta.table)
                    ),
                    &plan.params,
                ),
            }
        })
    }

    /// Where a row is in a view, counted from 0, or `None` when the filters
    /// leave it out (or the result has no such row).
    #[tracing::instrument(skip_all, fields(
        result_id = %result_id,
        row_id,
        sort_keys = sort.len(),
        filters = filters.len(),
    ))]
    pub fn row_position(
        &self,
        result_id: &str,
        row_id: u64,
        sort: &[SortKey],
        filters: &[ResultFilter],
    ) -> Result<Option<u64>, CoreError> {
        self.read_view(result_id, sort, filters, |conn, meta, plan, source| {
            if row_id == 0 || row_id > meta.row_count {
                return Ok(None);
            }
            match source {
                Source::Arrival => Ok(Some(row_id - 1)),
                Source::View { table, .. } => {
                    let mut statement = conn.prepare_cached(&format!(
                        "SELECT pos FROM {} WHERE rid = ?1",
                        view::table_name(table)
                    ))?;
                    let mut rows = statement.query([i64::try_from(row_id).unwrap_or(i64::MAX)])?;
                    Ok(match rows.next()? {
                        Some(row) => u64::try_from(row.get::<_, i64>(0)? - 1).ok(),
                        None => None,
                    })
                }
                Source::Query => {
                    // No view to look in: walk the order until the row
                    // turns up.
                    let mut statement = conn.prepare(&plan.ordered_ids(meta.table))?;
                    let mut rows = statement.query(rusqlite::params_from_iter(&plan.params))?;
                    let mut position = 0_u64;
                    while let Some(row) = rows.next()? {
                        if u64::try_from(row.get::<_, i64>(0)?).ok() == Some(row_id) {
                            return Ok(Some(position));
                        }
                        position += 1;
                    }
                    Ok(None)
                }
            }
        })
    }

    /// Those of `row_ids` that are in a view, in the view's order. An id
    /// given twice comes back once; an id the result or the filters do not
    /// have is left out. At most [`ORDER_MAX_IDS`] ids per call.
    ///
    /// A long list is worked through a few thousand ids at a time, giving
    /// up the store's lock in between.
    #[tracing::instrument(skip_all, fields(
        result_id = %result_id,
        ids = row_ids.len(),
        sort_keys = sort.len(),
        filters = filters.len(),
    ))]
    pub fn order(
        &self,
        result_id: &str,
        row_ids: &[u64],
        sort: &[SortKey],
        filters: &[ResultFilter],
    ) -> Result<Vec<u64>, CoreError> {
        if row_ids.len() > ORDER_MAX_IDS {
            return Err(CoreError::Query(format!(
                "Too many rows to put in order at once: {} (the limit is {ORDER_MAX_IDS})",
                row_ids.len()
            )));
        }
        let wanted: HashSet<u64> = row_ids.iter().copied().collect();
        let ids: Vec<u64> = wanted.iter().copied().collect();

        // What has been done so far, kept across turns at the lock. A view
        // rebuilt between two turns is the same order again, so what one
        // turn found still holds in the next.
        let mut found: Vec<(i64, u64)> = Vec::new();
        let mut looked_up = 0_usize;
        let mut walked = 0_u64;
        let mut in_order: Vec<u64> = Vec::new();

        loop {
            let done = self.read_view(result_id, sort, filters, |conn, meta, plan, source| {
                match source {
                    Source::Arrival => {
                        let mut all: Vec<u64> = ids
                            .iter()
                            .copied()
                            .filter(|id| *id >= 1 && *id <= meta.row_count)
                            .collect();
                        all.sort_unstable();
                        Ok(Some(all))
                    }
                    Source::Query => {
                        let mut all =
                            collect_ids(conn, &plan.ordered_ids(meta.table), &plan.params)?;
                        all.retain(|id| wanted.contains(id));
                        Ok(Some(all))
                    }
                    // Most of the view was asked for: walk it once rather
                    // than look every id up.
                    Source::View { table, len } if (ids.len() as u64).saturating_mul(4) >= len => {
                        let page = collect_ids(
                            conn,
                            &format!(
                                "SELECT rid FROM {} WHERE pos > {walked} ORDER BY pos \
                                 LIMIT {ORDER_SCAN_PER_TURN}",
                                view::table_name(table)
                            ),
                            &[],
                        )?;
                        walked += page.len() as u64;
                        let finished = page.is_empty() || walked >= len;
                        in_order.extend(page.into_iter().filter(|id| wanted.contains(id)));
                        Ok(finished.then(|| std::mem::take(&mut in_order)))
                    }
                    Source::View { table, .. } => {
                        let mut statement = conn.prepare_cached(&format!(
                            "SELECT pos FROM {} WHERE rid = ?1",
                            view::table_name(table)
                        ))?;
                        let end = (looked_up + ORDER_SEEKS_PER_TURN).min(ids.len());
                        for id in &ids[looked_up..end] {
                            let Ok(key) = i64::try_from(*id) else {
                                continue;
                            };
                            let mut rows = statement.query([key])?;
                            if let Some(row) = rows.next()? {
                                found.push((row.get(0)?, *id));
                            }
                        }
                        looked_up = end;
                        if looked_up < ids.len() {
                            return Ok(None);
                        }
                        found.sort_unstable();
                        Ok(Some(found.iter().map(|(_, id)| *id).collect()))
                    }
                }
            })?;
            if let Some(ordered) = done {
                return Ok(ordered);
            }
        }
    }

    /// Whole rows, every value complete, in the order asked. `row_ids` are
    /// identities as [`ResultWindow::row_ids`] reports them; one the result
    /// does not have is an error.
    ///
    /// At most [`ROWS_MAX_COUNT`] rows and [`ROWS_MAX_BYTES`] of cell data
    /// per call. Passing either is an error rather than a shorter answer,
    /// since the caller could not tell which rows were left out; the error
    /// for the bytes says so, and the caller asks for fewer rows. A single
    /// row is returned whatever its size.
    #[tracing::instrument(skip_all, fields(result_id = %result_id, rows = row_ids.len()))]
    pub fn rows(&self, result_id: &str, row_ids: &[u64]) -> Result<Vec<Vec<SqlValue>>, CoreError> {
        if row_ids.len() > ROWS_MAX_COUNT {
            return Err(CoreError::Query(format!(
                "Too many rows asked for at once: {} (the limit is {ROWS_MAX_COUNT})",
                row_ids.len()
            )));
        }
        let mut out = Vec::with_capacity(row_ids.len());
        let mut bytes = 0_u64;
        let mut next = 0;
        // Always at least one turn, so an unknown result is reported even
        // when no row was asked for.
        loop {
            let mut state = self.inner.lock();
            let meta = lookup(&state, result_id)?;
            let conn = state.conn()?;
            let (columns, shape) = select_list(&meta, u32::MAX);
            let mut statement = conn.prepare_cached(&format!(
                "SELECT {columns} FROM {} AS t WHERE t.rowid = ?1",
                table_name(meta.table)
            ))?;

            let mut turn_bytes = 0_u64;
            let end = (next + ROWS_PER_TURN).min(row_ids.len());
            while next < end && turn_bytes < TURN_BYTES {
                let row_id = row_ids[next];
                let missing = || CoreError::NotFound(format!("Row {row_id} of result {result_id}"));
                let key = i64::try_from(row_id).map_err(|_| missing())?;
                let mut found = statement.query([key])?;
                let row = found.next()?.ok_or_else(missing)?;
                let (_, cells) = decode_row(row, &meta, &shape, u32::MAX)?;
                let values: Vec<SqlValue> = cells.into_iter().map(|cell| cell.value).collect();
                let size = value_bytes(&values);
                if !out.is_empty() && bytes.saturating_add(size) > ROWS_MAX_BYTES {
                    return Err(CoreError::Query(format!(
                        "{ROWS_TOO_LARGE}: the first {} of the {} rows asked for already hold \
                         {bytes} bytes and the limit is {ROWS_MAX_BYTES}. Ask for fewer rows at \
                         a time.",
                        out.len(),
                        row_ids.len()
                    )));
                }
                bytes = bytes.saturating_add(size);
                turn_bytes = turn_bytes.saturating_add(size);
                out.push(values);
                next += 1;
            }
            if next >= row_ids.len() {
                return Ok(out);
            }
        }
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

    /// How many tables the file holds. A result with rows, finished or
    /// still being written, is one table, plus one more in the rare case
    /// that it has a side table of mismatched cells, plus one for each view
    /// of it that is kept. For diagnostics and for tests that nothing is
    /// left behind.
    pub fn table_count(&self) -> Result<u64, CoreError> {
        let mut state = self.inner.lock();
        let count: i64 = state.conn()?.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
            [],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(count).unwrap_or_default())
    }

    /// Forget these results and free their space for later ones. Ids the
    /// store does not know (already released, or never finished) are
    /// ignored.
    #[tracing::instrument(skip(self))]
    pub fn release(&self, result_ids: &[String]) {
        let mut state = self.inner.lock();
        let mut freed = false;
        for result_id in result_ids {
            let Some(entry) = state.catalog.remove(result_id) else {
                continue;
            };
            freed = true;
            for slot in &entry.views {
                state.discard_view(slot);
            }
            if let Err(e) = state.drop_tables(entry.meta.table) {
                tracing::warn!(result_id, error = %e, "Failed to drop a released result");
            }
        }
        if freed {
            // A view that could not be built for lack of room may fit now:
            // forget the failure, so the next read tries again.
            for entry in state.catalog.values_mut() {
                entry
                    .views
                    .retain(|slot| !matches!(slot.phase(), Phase::Unavailable));
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
        self.inner.lock().catalog.insert(
            result_id.clone(),
            Entry {
                meta: Arc::new(meta),
                views: Vec::new(),
            },
        );
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

fn unknown_result(result_id: &str) -> CoreError {
    CoreError::NotFound(format!("Result {result_id}"))
}

fn lookup(state: &State, result_id: &str) -> Result<Arc<ResultMeta>, CoreError> {
    state
        .catalog
        .get(result_id)
        .map(|entry| Arc::clone(&entry.meta))
        .ok_or_else(|| unknown_result(result_id))
}

/// The most columns a table of this connection may have. The insert binds
/// one value per column and the row id, so SQLite's limit on bound values
/// counts too.
fn column_limit(conn: &Connection) -> usize {
    use rusqlite::limits::Limit;
    let read = |limit| {
        conn.limit(limit)
            .ok()
            .and_then(|value| usize::try_from(value).ok())
    };
    let columns = read(Limit::SQLITE_LIMIT_COLUMN).unwrap_or(2000);
    let variables = read(Limit::SQLITE_LIMIT_VARIABLE_NUMBER).unwrap_or(999);
    columns.min(variables.saturating_sub(1))
}

fn check_column(meta: &ResultMeta, column: usize) -> Result<&ColumnState, CoreError> {
    meta.columns
        .get(column)
        .ok_or_else(|| CoreError::Query(format!("The result has no column {column}")))
}

/// How [`ResultStore::rows`] starts its error when the rows asked for hold
/// more than [`ROWS_MAX_BYTES`], so a caller can tell it from other errors
/// and ask for fewer.
pub const ROWS_TOO_LARGE: &str = "The rows are too large to return at once";

/// One order of a result as SQL: what a view is built from, and what is run
/// directly when there is no view.
struct Plan {
    sort: Vec<SortKey>,
    /// Empty when no filter is active.
    where_sql: String,
    /// The text `where_sql` binds, as `?1`, `?2`, ...
    params: Vec<String>,
    order_sql: String,
}

impl Plan {
    fn new(meta: &ResultMeta, key: &ViewKey) -> Result<Self, CoreError> {
        let (where_sql, params) = where_clause(meta, &key.filters)?;
        Ok(Self {
            sort: key.sort.clone(),
            where_sql,
            params,
            order_sql: order_clause(meta, &key.sort)?,
        })
    }

    /// The query for every row id of the order, first to last.
    fn ordered_ids(&self, table: u64) -> String {
        let mut sql = format!("SELECT t.rowid FROM {} AS t", table_name(table));
        if !self.where_sql.is_empty() {
            let _ = write!(sql, " WHERE {}", self.where_sql);
        }
        let _ = write!(sql, " ORDER BY {}", self.order_sql);
        sql
    }
}

/// Where a read finds the order it was asked for.
#[derive(Debug, Clone, Copy)]
enum Source {
    /// No sort and no filter: position is row id minus one, and nothing
    /// needs looking up.
    Arrival,
    /// A view table of `len` rows: position to row id, both ways.
    View { table: u64, len: u64 },
    /// No view could be built (the store is full): the sort-and-filter
    /// query itself, as slow as it is.
    Query,
}

/// How the values of one selected row are laid out.
struct RowShape {
    /// Per column, whether the query cuts long values and so returns a
    /// second value, the real length.
    truncating: Vec<bool>,
    /// Where the row's side-table entries are, when the result has any.
    exceptions_position: usize,
}

/// The select list for rows of a result as table `t`: the row id, each
/// column (cut short where the column can hold more than `limit` bytes),
/// then the row's entries in the side table of mismatched cells, if there
/// is one.
fn select_list(meta: &ResultMeta, limit: u32) -> (String, RowShape) {
    let fetch = limit.max(MIN_FETCH_BYTES);
    let mut sql = String::from("t.rowid");
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
    // After the row id and one or two values per column.
    let exceptions_position = 1 + truncating
        .iter()
        .map(|cuts| if *cuts { 2 } else { 1 })
        .sum::<usize>();
    (
        sql,
        RowShape {
            truncating,
            exceptions_position,
        },
    )
}

/// Read one row selected with [`select_list`]: its id and its cells.
fn decode_row(
    row: &rusqlite::Row<'_>,
    meta: &ResultMeta,
    shape: &RowShape,
    limit: u32,
) -> Result<(u64, Vec<Cell>), CoreError> {
    let row_id: i64 = row.get(0)?;
    let exceptions = if meta.has_exceptions {
        parse_exceptions(row.get_ref(shape.exceptions_position)?)?
    } else {
        Vec::new()
    };

    let mut cells = Vec::with_capacity(meta.columns.len());
    let mut position = 1;
    for (index, column) in meta.columns.iter().enumerate() {
        let value = row.get_ref(position)?;
        position += 1;
        let full_len = if shape.truncating[index] {
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
    Ok((u64::try_from(row_id).unwrap_or_default(), cells))
}

/// Read one window from wherever its order is to be found.
fn read_window(
    conn: &mut Connection,
    meta: &ResultMeta,
    plan: &Plan,
    source: Source,
    request: &WindowRequest,
) -> Result<ResultWindow, CoreError> {
    let table = table_name(meta.table);
    let matching_rows = match source {
        Source::Arrival => meta.row_count,
        Source::View { len, .. } => len,
        Source::Query if plan.where_sql.is_empty() => meta.row_count,
        Source::Query => {
            let count: i64 = conn.query_row(
                &format!("SELECT count(*) FROM {table} WHERE {}", plan.where_sql),
                rusqlite::params_from_iter(plan.params.iter()),
                |row| row.get(0),
            )?;
            u64::try_from(count).unwrap_or_default()
        }
    };

    let mut window = ResultWindow {
        row_ids: Vec::new(),
        rows: Vec::new(),
        matching_rows,
    };
    if request.count == 0 || request.offset >= matching_rows {
        return Ok(window);
    }

    let limit = request.max_cell_bytes;
    let (columns, shape) = select_list(meta, limit);
    let count = request.count;
    let offset = request.offset.min(i64::MAX.unsigned_abs());
    let no_params: &[String] = &[];
    let (sql, params) = match source {
        // Row ids are the positions 1..=n with no gaps, so a window of the
        // result as it arrived is a range of them: a seek, however deep
        // the offset, rather than a walk past every row before it.
        Source::Arrival => (
            format!(
                "SELECT {columns} FROM {table} AS t WHERE t.rowid > {offset} \
                 ORDER BY t.rowid LIMIT {count}"
            ),
            no_params,
        ),
        // The same through a view: a range of its positions, each one a
        // seek to its row. CROSS JOIN keeps SQLite from turning the join
        // round and walking the result instead.
        Source::View { table: view, .. } => (
            format!(
                "SELECT {columns} FROM {} AS v CROSS JOIN {table} AS t ON t.rowid = v.rid \
                 WHERE v.pos > {offset} ORDER BY v.pos LIMIT {count}",
                view::table_name(view)
            ),
            no_params,
        ),
        Source::Query => {
            let mut sql = format!("SELECT {columns} FROM {table} AS t");
            if !plan.where_sql.is_empty() {
                let _ = write!(sql, " WHERE {}", plan.where_sql);
            }
            let _ = write!(
                sql,
                " ORDER BY {} LIMIT {count} OFFSET {offset}",
                plan.order_sql
            );
            (sql, plan.params.as_slice())
        }
    };

    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        let (row_id, cells) = decode_row(row, meta, &shape, limit)?;
        window.row_ids.push(row_id);
        window.rows.push(cells);
    }
    Ok(window)
}

/// Run a query of one integer column and collect it as row ids.
fn collect_ids(conn: &Connection, sql: &str, params: &[String]) -> Result<Vec<u64>, CoreError> {
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(params.iter()))?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        ids.push(u64::try_from(row.get::<_, i64>(0)?).unwrap_or_default());
    }
    Ok(ids)
}

/// Roughly what a row's values take, for the cap on [`ResultStore::rows`].
fn value_bytes(values: &[SqlValue]) -> u64 {
    values
        .iter()
        .map(|value| match value {
            SqlValue::String(text) => text.len() as u64,
            SqlValue::Bytes(bytes) => bytes.len() as u64,
            _ => 8,
        })
        .sum()
}

/// The filters as SQL, with the text each one binds. Empty when no filter is
/// active. Only generated names and numbers are written into the SQL; every
/// operand is a bound parameter.
fn where_clause(
    meta: &ResultMeta,
    filters: &[ResultFilter],
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

/// Register the collations and scalar functions `where_clause` and
/// `order_clause` use. Every connection that sorts or filters a result's
/// values needs them: the store's own, and the one a view is sorted on.
fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_collation(order::TEXT_COLLATION, order::text_cmp)?;
    conn.create_collation(order::DECIMAL_COLLATION, order::decimal_cmp)?;

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
            other => other.try_into()?,
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
