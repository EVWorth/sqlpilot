//! Query history, kept in SQLite rather than the renderer's `localStorage`.
//!
//! History used to live in `localStorage` under one key, rewritten in full on
//! every query. That medium shares a five-to-ten megabyte origin quota with
//! settings and favorites, swallows a quota failure silently — so history
//! simply stops recording and nothing says so — and is wiped when the user
//! clears site data. A single entry is unbounded, so one pasted migration
//! script could consume the quota by itself (#585).
//!
//! Connections already live in SQLite next door, with the same migration
//! machinery. History joins them.

pub mod migrations;

use crate::error::CoreError;
use rusqlite::{params, Connection as SqliteConn, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

/// Longest statement kept in full.
///
/// Generous next to anything typed by hand and small next to the dumps people
/// paste into an editor to run once. Above this the text is cut and the entry
/// says so, because storing an unbounded blob per row is how the previous
/// medium filled up.
pub const MAX_SQL_BYTES: usize = 256 * 1024;

/// What is appended when a statement is cut. Present in the stored text so it
/// is visible wherever the entry is read, not only where `truncated` is
/// checked.
pub const TRUNCATION_MARKER: &str = "\n-- … truncated by SQLPilot: statement too long to keep";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub sql: String,
    pub connection_name: String,
    pub database: Option<String>,
    /// ISO 8601, UTC.
    pub executed_at: String,
    // Declared as Number for the same reason as QueryResult's counterparts:
    // JSON already serialises these as numbers, and specta forbids exporting
    // i64 outright rather than letting it silently lose precision.
    #[specta(type = specta_typescript::Number)]
    pub execution_time_ms: i64,
    #[specta(type = specta_typescript::Number)]
    pub row_count: i64,
    /// "success" or "error".
    pub status: String,
    pub error: Option<String>,
    /// Driver error number — MySQL's code, SQLite's extended result code.
    pub error_code: Option<u32>,
    pub error_sql_state: Option<String>,
    /// A credential was stripped before this was stored (#587).
    pub redacted: bool,
    /// The statement was longer than [`MAX_SQL_BYTES`] and is stored cut.
    pub truncated: bool,
}

/// What to return from [`HistoryStore::list`].
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Substring match over the SQL text. Case-insensitive.
    pub search: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

pub struct HistoryStore {
    db: Mutex<SqliteConn>,
}

impl HistoryStore {
    pub fn new(path: &Path) -> Result<Self, CoreError> {
        let db = SqliteConn::open(path)?;
        // WAL so a write does not block the reads the panel is doing, and
        // NORMAL because losing the last few history rows to a hard kill is not
        // worth an fsync per query.
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;

        let applied = migrations::run(&db)
            .map_err(|e| CoreError::Storage(format!("History migration failed: {e}")))?;
        if !applied.is_empty() {
            tracing::info!(?applied, "History store migrated");
        }

        tracing::info!(path = %path.display(), "History store initialized");
        Ok(Self { db: Mutex::new(db) })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, CoreError> {
        let db = SqliteConn::open_in_memory()?;
        migrations::run(&db).map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, SqliteConn>, CoreError> {
        self.db
            .lock()
            .map_err(|e| CoreError::Storage(format!("History store poisoned: {e}")))
    }

    /// Record one statement, then drop anything past `limit`.
    ///
    /// Pruning here rather than on a timer keeps the invariant true after every
    /// write, which is what the user is told the setting means.
    pub fn add(&self, entry: &HistoryEntry, limit: u32) -> Result<HistoryEntry, CoreError> {
        let stored = truncate_sql(entry);
        let db = self.conn()?;

        db.execute(
            "INSERT INTO query_history (
                id, sql, connection_name, database, executed_at, execution_time_ms,
                row_count, status, error, error_code, error_sql_state, redacted, truncated
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                stored.id,
                stored.sql,
                stored.connection_name,
                stored.database,
                stored.executed_at,
                stored.execution_time_ms,
                stored.row_count,
                stored.status,
                stored.error,
                stored.error_code,
                stored.error_sql_state,
                stored.redacted as i64,
                stored.truncated as i64,
            ],
        )?;

        prune_locked(&db, limit)?;
        Ok(stored)
    }

    pub fn list(&self, query: &HistoryQuery) -> Result<Vec<HistoryEntry>, CoreError> {
        let db = self.conn()?;

        // LIKE with an explicit ESCAPE: a user searching for `100%` or a
        // snake_case column name would otherwise get every row, because % and _
        // are LIKE's own wildcards.
        let (where_clause, pattern) = match query.search.as_deref().map(str::trim) {
            Some(s) if !s.is_empty() => (
                "WHERE sql LIKE ?1 ESCAPE '\\'",
                Some(format!("%{}%", escape_like(s))),
            ),
            _ => ("", None),
        };

        let sql = format!(
            "SELECT id, sql, connection_name, database, executed_at, execution_time_ms,
                    row_count, status, error, error_code, error_sql_state, redacted, truncated
             FROM query_history {where_clause}
             ORDER BY executed_at DESC, rowid DESC
             LIMIT {} OFFSET {}",
            query.limit.unwrap_or(500),
            query.offset.unwrap_or(0),
        );

        let mut stmt = db.prepare(&sql)?;
        let rows: rusqlite::Result<Vec<HistoryEntry>> = match pattern {
            Some(p) => stmt.query_map(params![p], row_to_entry)?.collect(),
            None => stmt.query_map([], row_to_entry)?.collect(),
        };
        rows.map_err(CoreError::from)
    }

    pub fn remove(&self, id: &str) -> Result<(), CoreError> {
        self.conn()?
            .execute("DELETE FROM query_history WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), CoreError> {
        self.conn()?.execute("DELETE FROM query_history", [])?;
        Ok(())
    }

    pub fn count(&self) -> Result<i64, CoreError> {
        let db = self.conn()?;
        let n = db
            .query_row("SELECT COUNT(*) FROM query_history", [], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(n)
    }

    /// Drop the oldest entries beyond `limit`. Returns how many went.
    pub fn prune(&self, limit: u32) -> Result<usize, CoreError> {
        let db = self.conn()?;
        prune_locked(&db, limit)
    }

    /// Insert entries that predate the SQLite store, skipping ids already held.
    ///
    /// Runs once, when the renderer hands over what was in `localStorage`. Ids
    /// carry across, so a half-finished import — the app killed midway — resumes
    /// rather than duplicating.
    pub fn import(&self, entries: &[HistoryEntry], limit: u32) -> Result<usize, CoreError> {
        let mut db = self.conn()?;
        let tx = db.transaction()?;
        let mut imported = 0;

        for entry in entries {
            let stored = truncate_sql(entry);
            let changed = tx.execute(
                "INSERT OR IGNORE INTO query_history (
                    id, sql, connection_name, database, executed_at, execution_time_ms,
                    row_count, status, error, error_code, error_sql_state, redacted, truncated
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    stored.id,
                    stored.sql,
                    stored.connection_name,
                    stored.database,
                    stored.executed_at,
                    stored.execution_time_ms,
                    stored.row_count,
                    stored.status,
                    stored.error,
                    stored.error_code,
                    stored.error_sql_state,
                    stored.redacted as i64,
                    stored.truncated as i64,
                ],
            )?;
            imported += changed;
        }

        prune_locked(&tx, limit)?;
        tx.commit()?;
        Ok(imported)
    }
}

fn prune_locked(db: &SqliteConn, limit: u32) -> Result<usize, CoreError> {
    let removed = db.execute(
        "DELETE FROM query_history WHERE id IN (
            SELECT id FROM query_history
            ORDER BY executed_at DESC, rowid DESC
            LIMIT -1 OFFSET ?1
        )",
        params![limit],
    )?;
    Ok(removed)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        sql: row.get(1)?,
        connection_name: row.get(2)?,
        database: row.get(3)?,
        executed_at: row.get(4)?,
        execution_time_ms: row.get(5)?,
        row_count: row.get(6)?,
        status: row.get(7)?,
        error: row.get(8)?,
        error_code: row.get(9)?,
        error_sql_state: row.get(10)?,
        redacted: row.get::<_, i64>(11)? != 0,
        truncated: row.get::<_, i64>(12)? != 0,
    })
}

/// Cut an over-long statement on a character boundary and mark it.
fn truncate_sql(entry: &HistoryEntry) -> HistoryEntry {
    if entry.sql.len() <= MAX_SQL_BYTES {
        return entry.clone();
    }

    // floor_char_boundary is unstable, so walk back to one. Cutting mid
    // codepoint would panic rather than merely look wrong.
    let mut cut = MAX_SQL_BYTES;
    while cut > 0 && !entry.sql.is_char_boundary(cut) {
        cut -= 1;
    }

    HistoryEntry {
        sql: format!("{}{}", &entry.sql[..cut], TRUNCATION_MARKER),
        truncated: true,
        ..entry.clone()
    }
}

/// Escape LIKE's wildcards so a search for them matches them literally.
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests;
