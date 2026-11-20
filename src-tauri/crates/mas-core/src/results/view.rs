//! Views: one order of a stored result, worked out once.
//!
//! A view is the list of a result's row ids for one combination of sort
//! keys and active filters, kept as a table of position to row id beside
//! the result (with an index for the way back). Sorting 100,000 rows takes
//! a couple of hundred milliseconds; with the order kept, every window,
//! position and range after the first is a seek.
//!
//! ## Building without holding the store up
//!
//! The store has one connection behind one lock, and a sort is one SQLite
//! statement that cannot be paused. Run on the store's connection it would
//! stop every read of every other result until it finished. So the sort
//! runs somewhere else:
//!
//! 1. The sort keys of the rows that pass the filters are copied, a few
//!    thousand rows per turn at the lock, into a scratch database of the
//!    build's own.
//! 2. That database sorts them, with the same collations and the same
//!    `ORDER BY` the store would have used, holding no lock at all.
//! 3. The row ids come out in order and are written to the view table, a
//!    few thousand per turn at the lock.
//!
//! A view with filters and no sort needs no sorting: it is filled straight
//! from the result, a range of rows per turn.
//!
//! The scratch database is a file beside the store's (same directory, same
//! owner-only permissions, swept at start if a crash left it) or in memory
//! when the store is. It is deleted when the build ends.

use super::{
    create_private_file, is_active_filter, register_functions, table_name as result_table, Inner,
    Plan, ResultFilter, ResultMeta, SortKey, CACHE_KIB,
};
use crate::error::CoreError;
use rusqlite::types::Value;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};

/// Rows of the result one turn at the lock reads while a view is built. The
/// reads are a column or two wide, so this is about as long as the write of
/// one batch of an ordinary result.
const SCAN_ROWS: u64 = 4_000;

/// Cell data that ends such a turn early, in bytes, for results whose rows
/// are large.
const SCAN_BYTES: u64 = 4 * 1024 * 1024;

/// View rows one turn at the lock writes.
const WRITE_ROWS: usize = 4_000;

/// Page cache of the scratch database a sort runs in, in KiB.
const SCRATCH_CACHE_KIB: i64 = CACHE_KIB / 4;

pub(super) fn table_name(table: u64) -> String {
    format!("v{table}")
}

/// What makes a view: the sort keys, and the filters that narrow anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ViewKey {
    pub(super) sort: Vec<SortKey>,
    pub(super) filters: Vec<ResultFilter>,
}

impl ViewKey {
    pub(super) fn new(sort: &[SortKey], filters: &[ResultFilter]) -> Self {
        Self {
            sort: sort.to_vec(),
            filters: filters
                .iter()
                .filter(|filter| is_active_filter(filter))
                .cloned()
                .collect(),
        }
    }

    /// The result as it arrived, which needs no view: a row's position is
    /// its id minus one.
    pub(super) fn is_identity(&self) -> bool {
        self.sort.is_empty() && self.filters.is_empty()
    }
}

/// How far along a view is.
#[derive(Debug, Clone, Copy)]
pub(super) enum Phase {
    /// Someone is building it; wait for them.
    Building,
    /// Table `v<table>` holds its `len` rows.
    Ready { table: u64, len: u64 },
    /// It could not be built, or it was dropped. Reads go without it.
    Unavailable,
}

/// One view of one result, from the moment it is first asked for.
pub(super) struct ViewSlot {
    pub(super) key: ViewKey,
    phase: Mutex<Phase>,
    changed: Condvar,
    /// Set when the view is no longer wanted (its result was released, or
    /// newer views pushed it out), so a build still running stops.
    cancelled: AtomicBool,
}

impl ViewSlot {
    pub(super) fn new(key: ViewKey) -> Self {
        Self {
            key,
            phase: Mutex::new(Phase::Building),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
        }
    }

    pub(super) fn phase(&self) -> Phase {
        *self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn set(&self, phase: Phase) {
        *self.phase.lock().unwrap_or_else(PoisonError::into_inner) = phase;
        self.changed.notify_all();
    }

    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Block until the view is no longer being built.
    pub(super) fn wait(&self) {
        let mut phase = self.phase.lock().unwrap_or_else(PoisonError::into_inner);
        while matches!(*phase, Phase::Building) {
            phase = self
                .changed
                .wait(phase)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// Ends a build whatever happens to it. If the build panics, the callers
/// waiting on the slot are still woken and the half-filled table is still
/// dropped.
struct BuildGuard<'a> {
    inner: &'a Inner,
    slot: &'a ViewSlot,
    /// The view's table, once it has a number.
    table: Option<u64>,
    finished: bool,
}

impl Drop for BuildGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Some(table) = self.table {
            if let Err(e) = self.inner.lock().drop_view(table) {
                tracing::warn!(error = %e, "Failed to drop a view that was not finished");
            }
        }
        self.slot.set(Phase::Unavailable);
    }
}

/// Build the view `slot` stands for and mark the slot with the outcome.
///
/// Called without the store's lock, which is taken a turn at a time. Never
/// fails: a view that cannot be built (no room in the store, most likely)
/// is marked unavailable and its reads run the query instead.
pub(super) fn build(
    inner: &Inner,
    result_id: &str,
    meta: &ResultMeta,
    plan: &Plan,
    slot: &Arc<ViewSlot>,
) {
    let mut guard = BuildGuard {
        inner,
        slot,
        table: None,
        finished: false,
    };
    let outcome = fill(inner, meta, plan, &mut guard);

    let mut state = inner.lock();
    // Still wanted? The result may have been released, or the view pushed
    // out by newer ones, while it was being built.
    let listed = !slot.is_cancelled()
        && state
            .catalog
            .get(result_id)
            .is_some_and(|entry| entry.views.iter().any(|kept| Arc::ptr_eq(kept, slot)));
    match (outcome, guard.table) {
        (Ok(Some(len)), Some(table)) if listed => {
            inner.views_built.fetch_add(1, Ordering::Relaxed);
            slot.set(Phase::Ready { table, len });
        }
        (outcome, table) => {
            if let Err(e) = outcome {
                // Expected when the store is full; the read still answers.
                tracing::warn!(error = %e, "A view could not be built; reading without it");
            }
            if let Some(table) = table {
                if let Err(e) = state.drop_view(table) {
                    tracing::warn!(error = %e, "Failed to drop a view that was not finished");
                }
            }
            slot.set(Phase::Unavailable);
        }
    }
    guard.finished = true;
}

/// Create the view's table and fill it. `Ok(None)` when the build was
/// cancelled; otherwise how many rows the view has.
fn fill(
    inner: &Inner,
    meta: &ResultMeta,
    plan: &Plan,
    guard: &mut BuildGuard<'_>,
) -> Result<Option<u64>, CoreError> {
    let slot = guard.slot;
    let view = {
        let mut state = inner.lock();
        if slot.is_cancelled() {
            return Ok(None);
        }
        let view = state.next_view;
        state.next_view += 1;
        // Known to the guard before the table exists: a table half created
        // (the store filled up between the two statements) is still dropped.
        guard.table = Some(view);
        // `pos` is the position in the view, from 1, and the table's row
        // id, so a range of positions is a range scan. The index is the
        // way back, from a row to where it is.
        state
            .conn()?
            .execute_batch(&format!(
                "CREATE TABLE {name} (pos INTEGER PRIMARY KEY, rid INTEGER NOT NULL); \
                 CREATE INDEX {name}i ON {name} (rid);",
                name = table_name(view)
            ))
            .map_err(|e| inner.write_error(e))?;
        view
    };

    if plan.sort.is_empty() {
        fill_filtered(inner, meta, plan, slot, view)
    } else {
        fill_sorted(inner, meta, plan, slot, view)
    }
}

/// How many rows of the result to read per turn: fewer when its rows are
/// large, so a turn stays about as long whatever the result holds.
fn scan_rows(meta: &ResultMeta) -> u64 {
    let widest_row: u64 = meta
        .columns
        .iter()
        .map(|column| column.max_len)
        .fold(0, u64::saturating_add);
    (SCAN_BYTES / widest_row.max(1)).clamp(1, SCAN_ROWS)
}

/// The filter's operands, then the two ends of a range of row ids.
fn range_params(plan: &Plan, after: u64, up_to: u64) -> Vec<Value> {
    let bound = |id: u64| Value::Integer(i64::try_from(id).unwrap_or(i64::MAX));
    plan.params
        .iter()
        .cloned()
        .map(Value::Text)
        .chain([bound(after), bound(up_to)])
        .collect()
}

/// ` AND (<filters>)`, or nothing when no filter is active.
fn and_filters(plan: &Plan) -> String {
    if plan.where_sql.is_empty() {
        String::new()
    } else {
        format!(" AND ({})", plan.where_sql)
    }
}

/// A view that filters and does not sort: the rows that pass, in arrival
/// order. No sort is needed, so it is filled inside the store, one range of
/// the result per turn.
fn fill_filtered(
    inner: &Inner,
    meta: &ResultMeta,
    plan: &Plan,
    slot: &ViewSlot,
    view: u64,
) -> Result<Option<u64>, CoreError> {
    let first = plan.params.len() + 1;
    // No `pos` is given, so each row gets the one after the highest so far:
    // rows are inserted in the order the SELECT yields them.
    let sql = format!(
        "INSERT INTO {} (rid) SELECT t.rowid FROM {} AS t \
         WHERE t.rowid > ?{first} AND t.rowid <= ?{}{} ORDER BY t.rowid",
        table_name(view),
        result_table(meta.table),
        first + 1,
        and_filters(plan)
    );
    let step = scan_rows(meta);
    let mut done = 0_u64;
    let mut len = 0_u64;
    while done < meta.row_count {
        let up_to = done.saturating_add(step).min(meta.row_count);
        {
            let mut state = inner.lock();
            if slot.is_cancelled() {
                return Ok(None);
            }
            let mut insert = state.conn()?.prepare_cached(&sql)?;
            let added = insert
                .execute(rusqlite::params_from_iter(range_params(plan, done, up_to)))
                .map_err(|e| inner.write_error(e))?;
            len += added as u64;
        }
        done = up_to;
        inner.after_build_step();
    }
    Ok(Some(len))
}

/// A sorted view: the sort keys are copied out, sorted in a database of the
/// build's own, and the row ids written back in order.
fn fill_sorted(
    inner: &Inner,
    meta: &ResultMeta,
    plan: &Plan,
    slot: &ViewSlot,
    view: u64,
) -> Result<Option<u64>, CoreError> {
    // Each sort column once, under the name it has in the result, so the
    // store's `ORDER BY` reads the same against the scratch table.
    let mut key_columns: Vec<usize> = Vec::new();
    for key in &plan.sort {
        if !key_columns.contains(&key.column) {
            key_columns.push(key.column);
        }
    }
    let names: String = key_columns
        .iter()
        .map(|index| format!(", c{index}"))
        .collect();

    let scratch = Scratch::open(inner)?;
    let keys = scratch.conn()?;
    // `rid` is the scratch table's row id, which is what the `t.rowid` at
    // the end of the store's `ORDER BY` then means.
    keys.execute_batch(&format!(
        "BEGIN; CREATE TABLE k (rid INTEGER PRIMARY KEY{names});"
    ))?;

    // 1. Copy the keys of the rows that pass the filters.
    let first = plan.params.len() + 1;
    let select = format!(
        "SELECT t.rowid{names} FROM {} AS t WHERE t.rowid > ?{first} AND t.rowid <= ?{}{} \
         ORDER BY t.rowid",
        result_table(meta.table),
        first + 1,
        and_filters(plan)
    );
    let mut insert = keys.prepare(&format!(
        "INSERT INTO k VALUES (?{})",
        ", ?".repeat(key_columns.len())
    ))?;
    let step = scan_rows(meta);
    let mut done = 0_u64;
    let mut batch: Vec<Vec<Value>> = Vec::new();
    while done < meta.row_count {
        let up_to = done.saturating_add(step).min(meta.row_count);
        let mut reached = up_to;
        {
            let mut state = inner.lock();
            if slot.is_cancelled() {
                return Ok(None);
            }
            let mut statement = state.conn()?.prepare_cached(&select)?;
            let mut rows =
                statement.query(rusqlite::params_from_iter(range_params(plan, done, up_to)))?;
            let mut bytes = 0_u64;
            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(key_columns.len() + 1);
                for index in 0..=key_columns.len() {
                    let value: Value = row.get(index)?;
                    bytes += match &value {
                        Value::Text(text) => text.len() as u64,
                        Value::Blob(blob) => blob.len() as u64,
                        _ => 8,
                    };
                    values.push(value);
                }
                let row_id = match values.first() {
                    Some(Value::Integer(id)) => u64::try_from(*id).unwrap_or(up_to),
                    _ => up_to,
                };
                batch.push(values);
                if bytes >= SCAN_BYTES {
                    // Enough for one turn; the next starts after this row.
                    reached = row_id;
                    break;
                }
            }
        }
        for values in batch.drain(..) {
            insert.execute(rusqlite::params_from_iter(values))?;
        }
        done = reached;
        inner.after_build_step();
    }
    drop(insert);

    // 2. Sort, and 3. write the row ids back in order. The first row asked
    // of `ordered` is where the sort happens, with no lock held.
    let mut ordered = keys.prepare(&format!(
        "SELECT t.rid FROM k AS t ORDER BY {}",
        plan.order_sql
    ))?;
    let mut rows = ordered.query([])?;
    let write = format!(
        "INSERT INTO {} (pos, rid) VALUES (?1, ?2)",
        table_name(view)
    );
    let mut len = 0_i64;
    let mut ids: Vec<i64> = Vec::with_capacity(WRITE_ROWS);
    loop {
        ids.clear();
        while ids.len() < WRITE_ROWS {
            match rows.next()? {
                Some(row) => ids.push(row.get(0)?),
                None => break,
            }
        }
        if ids.is_empty() {
            break;
        }
        {
            let mut state = inner.lock();
            if slot.is_cancelled() {
                return Ok(None);
            }
            let tx = state.conn()?.transaction()?;
            {
                let mut statement = tx.prepare_cached(&write)?;
                for id in &ids {
                    len += 1;
                    statement
                        .execute([len, *id])
                        .map_err(|e| inner.write_error(e))?;
                }
            }
            tx.commit().map_err(|e| inner.write_error(e))?;
        }
        inner.after_build_step();
    }
    Ok(Some(u64::try_from(len).unwrap_or_default()))
}

/// The database a view's keys are sorted in: private to one build, deleted
/// when the build ends.
struct Scratch {
    /// `None` only while it is being dropped.
    conn: Option<Connection>,
    path: Option<PathBuf>,
}

impl Scratch {
    fn open(inner: &Inner) -> Result<Self, CoreError> {
        // Beside the store's file when it has one: the keys are the user's
        // data like the rest, and belong in the same private place. The
        // name is one the store's sweep at start deletes after a crash.
        let path = inner
            .path
            .as_ref()
            .and_then(|store| store.parent())
            .map(|dir| dir.join(format!("results-{}-sort.db", uuid::Uuid::new_v4())));
        let mut scratch = Self {
            conn: None,
            path: None,
        };
        let conn = match path {
            Some(path) => {
                create_private_file(&path).map_err(|e| {
                    CoreError::Storage(format!("Cannot create a file to sort in: {e}"))
                })?;
                // Owned from here, so it is deleted whatever fails next.
                scratch.path = Some(path.clone());
                Connection::open(path)?
            }
            None => Connection::open_in_memory()?,
        };
        // Nothing here has to survive anything: no journal, no fsync.
        conn.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
        conn.pragma_update(None, "journal_mode", "OFF")?;
        conn.pragma_update(None, "synchronous", "OFF")?;
        conn.pragma_update(None, "cache_size", -SCRATCH_CACHE_KIB)?;
        // The keys of a result are never more than the result, so the
        // store's budget is a ceiling here too.
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let page_size = u64::try_from(page_size).unwrap_or(4096).max(512);
        let max_pages = i64::try_from((inner.budget_bytes / page_size).max(1)).unwrap_or(i64::MAX);
        conn.pragma_update(None, "max_page_count", max_pages)?;
        register_functions(&conn)?;
        scratch.conn = Some(conn);
        Ok(scratch)
    }

    fn conn(&self) -> Result<&Connection, CoreError> {
        self.conn
            .as_ref()
            .ok_or_else(|| CoreError::Storage("The sort database is closed".to_string()))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Close before deleting: Windows will not delete an open file.
        if let Some(conn) = self.conn.take() {
            if let Err((_, e)) = conn.close() {
                tracing::warn!(error = %e, "Failed to close a sort database");
            }
        }
        if let Some(path) = &self.path {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!(error = %e, "Failed to delete a sort database");
            }
        }
    }
}
