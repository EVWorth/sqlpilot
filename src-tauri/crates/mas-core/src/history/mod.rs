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
    /// What issued this statement — "editor", "grid", "admin", "import",
    /// "restore", "designer", "routine" or "internal".
    ///
    /// Only editor queries were ever recorded, so which statements appeared in
    /// history was an accident of which call sites had been refactored rather
    /// than a decision (#586). Everything is recorded now and tagged with where
    /// it came from, which is what makes it possible to show the user's own
    /// work by default without hiding the rest.
    pub origin: String,
}

/// How to sort a history listing.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum HistorySort {
    /// Newest first. What the panel shows unless asked otherwise.
    #[default]
    Recent,
    /// Slowest first — the "what is costing me time" view.
    Slowest,
    /// Largest result first.
    MostRows,
}

/// What to return from [`HistoryStore::list`].
///
/// Everything recorded on an entry used to be unusable for finding it: the
/// panel matched a substring of the SQL and nothing else, so "what did I run
/// against staging yesterday that failed" and "what were my slowest queries"
/// were both unanswerable (#589). Filtering is a WHERE clause rather than an
/// array scan, which is the other half of why history moved to SQLite.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Substring match over the SQL text. Case-insensitive.
    pub search: Option<String>,
    /// Keep only these connections. Empty or absent means all of them.
    pub connection_names: Option<Vec<String>>,
    /// Keep only these databases.
    pub databases: Option<Vec<String>>,
    /// Keep only these origins. Absent means every origin.
    pub origins: Option<Vec<String>>,
    /// "success" or "error". Absent means both.
    pub status: Option<String>,
    /// ISO 8601, inclusive. Compared as text, which sorts chronologically.
    pub executed_after: Option<String>,
    pub executed_before: Option<String>,
    /// Keep only entries at least this slow, in milliseconds.
    pub min_duration_ms: Option<u32>,
    pub sort: Option<HistorySort>,
    /// Page size. Absent means every match — which is what an export wants.
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// The distinct values a filter can offer, read from what is actually stored.
///
/// Offering every connection the user has ever configured would list ones with
/// no history; offering these lists only what filtering by would return
/// something.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFacets {
    pub connection_names: Vec<String>,
    pub databases: Vec<String>,
    pub origins: Vec<String>,
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
                row_count, status, error, error_code, error_sql_state, redacted, truncated,
                origin
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                stored.origin,
            ],
        )?;

        prune_locked(&db, limit)?;
        Ok(stored)
    }

    pub fn list(&self, query: &HistoryQuery) -> Result<Vec<HistoryEntry>, CoreError> {
        let db = self.conn()?;
        let (where_clause, args) = build_filter(query);

        let sql = format!(
            "SELECT id, sql, connection_name, database, executed_at, execution_time_ms,
                    row_count, status, error, error_code, error_sql_state, redacted, truncated,
                    origin
             FROM query_history {where_clause}
             ORDER BY {}
             LIMIT {} OFFSET {}",
            order_by(query.sort.unwrap_or_default()),
            // -1 is SQLite's "no limit". Defaulting to a number here would
            // have quietly capped an export at that number.
            query.limit.map(i64::from).unwrap_or(-1),
            query.offset.unwrap_or(0),
        );

        let mut stmt = db.prepare(&sql)?;
        let rows: rusqlite::Result<Vec<HistoryEntry>> = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), row_to_entry)?
            .collect();
        rows.map_err(CoreError::from)
    }

    /// How many entries the same filter matches, ignoring limit and offset.
    ///
    /// The panel needs this to say "showing 50 of 812": without it a full page
    /// of results is indistinguishable from a page that happens to be the last.
    pub fn count_matching(&self, query: &HistoryQuery) -> Result<i64, CoreError> {
        let db = self.conn()?;
        let (where_clause, args) = build_filter(query);
        let sql = format!("SELECT COUNT(*) FROM query_history {where_clause}");
        let n = db.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0))?;
        Ok(n)
    }

    /// The connections and databases that actually appear in the history.
    pub fn facets(&self) -> Result<HistoryFacets, CoreError> {
        let db = self.conn()?;

        let mut stmt = db.prepare(
            "SELECT DISTINCT connection_name FROM query_history ORDER BY connection_name",
        )?;
        let connection_names: rusqlite::Result<Vec<String>> =
            stmt.query_map([], |r| r.get(0))?.collect();

        let mut stmt = db.prepare(
            "SELECT DISTINCT database FROM query_history
             WHERE database IS NOT NULL AND database <> '' ORDER BY database",
        )?;
        let databases: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();

        let mut stmt = db.prepare("SELECT DISTINCT origin FROM query_history ORDER BY origin")?;
        let origins: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();

        Ok(HistoryFacets {
            connection_names: connection_names?,
            databases: databases?,
            origins: origins?,
        })
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

    /// Drop entries older than `cutoff` (ISO 8601). Returns how many went.
    ///
    /// The other half of FR-9.1.3, which asked for a retention *period* and
    /// only ever got a count (#592). Both apply; whichever bites first wins,
    /// because they answer different questions — "how much clutter will I
    /// tolerate" and "how long should this be kept at all".
    pub fn prune_older_than(&self, cutoff: &str) -> Result<usize, CoreError> {
        let db = self.conn()?;
        let removed = db.execute(
            "DELETE FROM query_history WHERE executed_at < ?1",
            params![cutoff],
        )?;
        Ok(removed)
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
                    row_count, status, error, error_code, error_sql_state, redacted, truncated,
                    origin
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                    stored.origin,
                ],
            )?;
            imported += changed;
        }

        prune_locked(&tx, limit)?;
        tx.commit()?;
        Ok(imported)
    }
}

/// Build the WHERE clause and its bound values for a query.
///
/// Every value is bound rather than interpolated. The search text is the one a
/// user types, and the connection and database names come from rows written by
/// the app — but a name is still data, and building SQL by concatenation here
/// would be the one place in the app that does.
fn build_filter(query: &HistoryQuery) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(search) = query.search.as_deref().map(str::trim) {
        if !search.is_empty() {
            // ESCAPE, or a search for `100%` matches every row containing 100
            // and a search for `_` matches everything.
            clauses.push(format!("sql LIKE ?{} ESCAPE '\\'", args.len() + 1));
            args.push(Box::new(format!("%{}%", escape_like(search))));
        }
    }

    if let Some(names) = query.connection_names.as_ref().filter(|n| !n.is_empty()) {
        clauses.push(format!(
            "connection_name IN ({})",
            placeholders(args.len(), names.len())
        ));
        for name in names {
            args.push(Box::new(name.clone()));
        }
    }

    if let Some(databases) = query.databases.as_ref().filter(|d| !d.is_empty()) {
        clauses.push(format!(
            "database IN ({})",
            placeholders(args.len(), databases.len())
        ));
        for database in databases {
            args.push(Box::new(database.clone()));
        }
    }

    if let Some(origins) = query.origins.as_ref().filter(|o| !o.is_empty()) {
        clauses.push(format!(
            "origin IN ({})",
            placeholders(args.len(), origins.len())
        ));
        for origin in origins {
            args.push(Box::new(origin.clone()));
        }
    }

    if let Some(status) = query.status.as_deref().filter(|s| !s.is_empty()) {
        clauses.push(format!("status = ?{}", args.len() + 1));
        args.push(Box::new(status.to_string()));
    }

    if let Some(after) = query.executed_after.as_deref().filter(|s| !s.is_empty()) {
        clauses.push(format!("executed_at >= ?{}", args.len() + 1));
        args.push(Box::new(after.to_string()));
    }

    if let Some(before) = query.executed_before.as_deref().filter(|s| !s.is_empty()) {
        clauses.push(format!("executed_at <= ?{}", args.len() + 1));
        args.push(Box::new(before.to_string()));
    }

    if let Some(min) = query.min_duration_ms {
        clauses.push(format!("execution_time_ms >= ?{}", args.len() + 1));
        args.push(Box::new(i64::from(min)));
    }

    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    (where_clause, args)
}

/// `?n, ?n+1, …` for an IN list, continuing from the arguments already bound.
fn placeholders(bound: usize, count: usize) -> String {
    (1..=count)
        .map(|i| format!("?{}", bound + i))
        .collect::<Vec<_>>()
        .join(", ")
}

fn order_by(sort: HistorySort) -> &'static str {
    match sort {
        // rowid breaks the tie: timestamps have second resolution, so a fast
        // pair would otherwise come back in whatever order SQLite chose.
        HistorySort::Recent => "executed_at DESC, rowid DESC",
        HistorySort::Slowest => "execution_time_ms DESC, executed_at DESC",
        HistorySort::MostRows => "row_count DESC, executed_at DESC",
    }
}

/// What an export is written as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum HistoryExportFormat {
    /// Every column, for a spreadsheet.
    Csv,
    /// The statements alone, each with a comment carrying its context, so the
    /// file can be read back by any SQL client — including this one.
    Sql,
}

/// One CSV field, quoted the way RFC 4180 asks.
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// Render entries as CSV or as a runnable SQL file.
pub fn render_export(entries: &[HistoryEntry], format: HistoryExportFormat) -> String {
    match format {
        HistoryExportFormat::Csv => {
            let mut out = String::from(
                "executed_at,connection,database,status,duration_ms,rows,error_code,sql,error\n",
            );
            for e in entries {
                out.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{}\n",
                    csv_field(&e.executed_at),
                    csv_field(&e.connection_name),
                    csv_field(e.database.as_deref().unwrap_or("")),
                    csv_field(&e.status),
                    e.execution_time_ms,
                    e.row_count,
                    e.error_code.map(|c| c.to_string()).unwrap_or_default(),
                    csv_field(&e.sql),
                    csv_field(e.error.as_deref().unwrap_or("")),
                ));
            }
            out
        }
        HistoryExportFormat::Sql => {
            let mut out = String::from("-- SQLPilot query history export\n\n");
            for e in entries {
                out.push_str(&format!(
                    "-- {} · {}{} · {} · {}ms\n",
                    e.executed_at,
                    e.connection_name,
                    e.database
                        .as_deref()
                        .map(|d| format!("/{d}"))
                        .unwrap_or_default(),
                    e.status,
                    e.execution_time_ms,
                ));
                if let Some(err) = &e.error {
                    // A newline inside the message would end the comment and
                    // leave the rest of it as SQL.
                    out.push_str(&format!("-- error: {}\n", err.replace('\n', " ")));
                }
                if e.redacted {
                    out.push_str("-- a credential was removed; this will not run as written\n");
                }
                out.push_str(e.sql.trim_end());
                if !e.sql.trim_end().ends_with(';') {
                    out.push(';');
                }
                out.push_str("\n\n");
            }
            out
        }
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
        origin: row.get(13)?,
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
