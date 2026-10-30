use crate::connection::SqliteConnectionManager;
use crate::error::SqliteError;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SqliteColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SqliteQueryResult {
    pub query_id: String,
    // JSON already serialises this as a number and JS truncates past 2^53;
    // declaring it as f64 documents the existing behaviour rather than
    // changing it. Row counts, byte sizes, timings and ids never approach it.
    #[specta(type = specta_typescript::Number)]
    pub statement_index: usize,
    /// The statement this result came from, trimmed and without its `;`, so
    /// history can say which statement of a script ran (#928).
    pub sql: String,
    pub columns: Vec<SqliteColumnMeta>,
    // SQLite is dynamically typed, so cell values are arbitrary JSON. Exported
    // as `unknown[][]`, matching the hand-written type this replaces, and
    // sidestepping serde_json::Value's i64 arm which specta refuses to export.
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
    pub rows: Vec<Vec<serde_json::Value>>,
    #[specta(type = specta_typescript::Number)]
    pub rows_affected: u64,
    #[specta(type = specta_typescript::Number)]
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    /// Whether rows were withheld. Set from `truncation_reason` where the
    /// result is built, so the two cannot disagree (#933).
    pub rows_truncated: bool,
    /// Why rows were withheld, when they were, as the MySQL executor reports
    /// it: the banner's advice depends on whether the cap was the row limit
    /// or memory.
    pub truncation_reason: Option<SqliteTruncationReason>,
    /// Whether the connection is inside a transaction after this statement,
    /// from `sqlite3_get_autocommit` rather than guessed from the SQL (#933).
    /// SQLite answers this for free, so every result carries it.
    pub in_transaction: bool,
}

/// What stopped a SQLite result set from being complete. The same values as
/// `mas_core`'s `TruncationReason`, which this crate does not depend on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SqliteTruncationReason {
    /// The caller's row limit was reached.
    RowLimit,
    /// Free system memory fell below the floor mid-fetch.
    MemoryGuard,
}

/// How much of each result set to keep, as the MySQL executor takes it.
#[derive(Debug, Clone, Copy, Default)]
pub struct FetchWindow {
    /// The most rows kept per result set; `None` keeps them all.
    pub limit: Option<u64>,
    /// Rows skipped before the first one kept, for paging.
    pub offset: Option<u64>,
}

/// The free-RAM floor a fetch stops at, in MB: `mas_core`'s default.
pub const DEFAULT_MEMORY_FLOOR_MB: u64 = 512;

/// How often, in rows kept, free memory is checked during a fetch.
const MEMORY_CHECK_EVERY: usize = 1000;

pub struct SqliteQueryExecutor {
    manager: Arc<SqliteConnectionManager>,
    /// How little free RAM stops a fetch, in MB. A field so a test can set it
    /// above the machine's free memory and reach the truncation path.
    memory_floor_mb: u64,
}

impl SqliteQueryExecutor {
    pub fn new(manager: Arc<SqliteConnectionManager>) -> Self {
        Self::with_memory_floor_mb(manager, DEFAULT_MEMORY_FLOOR_MB)
    }

    /// An executor that stops fetching at a chosen free-RAM floor.
    pub fn with_memory_floor_mb(
        manager: Arc<SqliteConnectionManager>,
        memory_floor_mb: u64,
    ) -> Self {
        Self {
            manager,
            memory_floor_mb,
        }
    }

    /// Run `sql` and keep every row, bounded only by the memory guard.
    pub async fn execute(
        &self,
        connection_id: &str,
        sql: &str,
    ) -> Result<Vec<SqliteQueryResult>, SqliteError> {
        self.execute_window(connection_id, sql, FetchWindow::default())
            .await
    }

    /// Run `sql`, keeping at most `window.limit` rows of each result set after
    /// skipping `window.offset` of them (#933).
    ///
    /// The cap is applied while reading rather than by editing the SQL, as
    /// the MySQL executor applies it, so it bounds `PRAGMA` output and
    /// `RETURNING` rows as well as a `SELECT` and cannot break a statement.
    #[tracing::instrument(skip(self, sql))]
    pub async fn execute_window(
        &self,
        connection_id: &str,
        sql: &str,
        window: FetchWindow,
    ) -> Result<Vec<SqliteQueryResult>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let sql = sql.to_string();
        let floor_mb = self.memory_floor_mb;
        tokio::task::spawn_blocking(move || {
            execute_sync(&conn, &sql, window, &mut MemoryGuard::new(floor_mb))
        })
        .await
        .map_err(|e| SqliteError::Query(e.to_string()))?
    }
}

/// Run every statement of `sql`, in order, one result per statement (#928).
///
/// `Connection::prepare` compiles only the first statement of its input and
/// ignores the rest, so a script used to run its first statement and report
/// success. The script is split as SQLite itself would split it (see
/// [`crate::split`]), and each statement is prepared only after the one
/// before it ran, so a script can use the table it has just created.
///
/// The first failure stops the run. It comes back tagged with the failing
/// statement's index and what the statements before it returned, as the MySQL
/// executor reports it, and those earlier statements stay done: SQLite is in
/// autocommit unless the script opened a transaction.
///
/// A result cut short by the memory guard ends the run: the statements after
/// it are not started, as the MySQL executor stops reading its batch.
fn execute_sync(
    conn: &crate::connection::SqliteConnection,
    sql: &str,
    window: FetchWindow,
    guard: &mut MemoryGuard,
) -> Result<Vec<SqliteQueryResult>, SqliteError> {
    let db = conn
        .db
        .lock()
        .map_err(|e| SqliteError::Query(e.to_string()))?;

    let mut results = Vec::new();
    for (index, statement) in crate::split::split_statements(sql).iter().enumerate() {
        match execute_one(&db, index, statement, window, guard) {
            Ok(result) => {
                let out_of_memory =
                    result.truncation_reason == Some(SqliteTruncationReason::MemoryGuard);
                results.push(result);
                if out_of_memory {
                    break;
                }
            }
            Err(source) => {
                return Err(SqliteError::AtStatement {
                    index,
                    source: Box::new(source),
                    completed: results,
                })
            }
        }
    }
    Ok(results)
}

/// Run one statement and collect what it returned.
///
/// Whether there are rows to read is the prepared statement's column count,
/// not the leading keyword: `INSERT ... RETURNING` has rows, a SELECT behind a
/// comment is still a SELECT, and `PRAGMA foreign_keys = ON` has none.
///
/// Rows past the window are not read at all: stepping stops there, so a
/// capped `SELECT` on a large table never visits the rest. A `RETURNING`
/// statement has made all of its changes by its first step, so stopping early
/// does not cut its writes short.
fn execute_one(
    db: &rusqlite::Connection,
    index: usize,
    statement: &crate::split::Statement<'_>,
    window: FetchWindow,
    guard: &mut MemoryGuard,
) -> Result<SqliteQueryResult, SqliteError> {
    let start = std::time::Instant::now();
    let mut stmt = db.prepare(statement.text)?;
    let col_count = stmt.column_count();
    let columns: Vec<SqliteColumnMeta> = (0..col_count)
        .map(|i| SqliteColumnMeta {
            name: stmt.column_name(i).unwrap_or("?").to_string(),
            data_type: "TEXT".to_string(),
            nullable: true,
            is_primary_key: false,
        })
        .collect();

    // `changes()` keeps the count of the last INSERT, UPDATE or DELETE, so a
    // CREATE TABLE after an INSERT would report the INSERT's rows. The total
    // only moves when this statement changed something.
    let total_before = db.total_changes();
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncation = None;
    if col_count > 0 {
        let mut cursor = stmt.query([])?;
        let mut skipped: u64 = 0;
        while let Some(row) = cursor.next()? {
            if window.offset.is_some_and(|skip| skipped < skip) {
                skipped += 1;
                continue;
            }
            // Set only once a row was actually withheld, so a result exactly
            // `limit` rows long is not called truncated.
            if window.limit.is_some_and(|max| rows.len() as u64 >= max) {
                truncation = Some(SqliteTruncationReason::RowLimit);
                break;
            }
            if !rows.is_empty() && rows.len().is_multiple_of(MEMORY_CHECK_EVERY) && !guard.check() {
                tracing::warn!(
                    rows_accumulated = rows.len(),
                    "Memory limit reached, stopping SQLite fetch"
                );
                truncation = Some(SqliteTruncationReason::MemoryGuard);
                break;
            }
            rows.push(
                (0..col_count)
                    .map(|i| match row.get_ref(i) {
                        Ok(v) => to_json_value(&v),
                        Err(_) => serde_json::Value::Null,
                    })
                    .collect(),
            );
        }
    } else {
        stmt.execute([])?;
    }
    let rows_affected = if db.total_changes() == total_before {
        0
    } else {
        db.changes()
    };

    Ok(SqliteQueryResult {
        query_id: uuid::Uuid::new_v4().to_string(),
        statement_index: index,
        sql: statement.display.to_string(),
        columns,
        rows,
        rows_affected,
        execution_time_ms: start.elapsed().as_millis() as u64,
        warnings: vec![],
        rows_truncated: truncation.is_some(),
        truncation_reason: truncation,
        in_transaction: !db.is_autocommit(),
    })
}

/// Watches system-wide free memory during a fetch, as `mas_core`'s guard
/// does, so a huge result stops before it takes the app down.
struct MemoryGuard {
    sys: sysinfo::System,
    floor_mb: u64,
}

impl MemoryGuard {
    fn new(floor_mb: u64) -> Self {
        Self {
            sys: sysinfo::System::new(),
            floor_mb,
        }
    }

    /// True while free memory is at or above the floor.
    fn check(&mut self) -> bool {
        self.sys.refresh_memory();
        let available_mb = self.sys.available_memory() / 1024 / 1024;
        if available_mb < self.floor_mb {
            tracing::warn!(
                available_mb,
                floor_mb = self.floor_mb,
                "System memory critically low"
            );
            return false;
        }
        true
    }
}

fn to_json_value(v: &rusqlite::types::ValueRef) -> serde_json::Value {
    match v {
        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
        rusqlite::types::ValueRef::Integer(i) => serde_json::json!(i),
        rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
        rusqlite::types::ValueRef::Text(s) => {
            serde_json::Value::String(String::from_utf8_lossy(s).to_string())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            serde_json::Value::String(format!("<blob {} bytes>", b.len()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::SqliteConnection;

    fn memory() -> SqliteConnection {
        SqliteConnection {
            id: "test".into(),
            path: ":memory:".into(),
            db: std::sync::Mutex::new(rusqlite::Connection::open_in_memory().expect("opens")),
        }
    }

    /// Run a script uncapped, with a guard that never trips.
    fn run(conn: &SqliteConnection, sql: &str) -> Result<Vec<SqliteQueryResult>, SqliteError> {
        execute_sync(conn, sql, FetchWindow::default(), &mut MemoryGuard::new(0))
    }

    fn windowed(
        conn: &SqliteConnection,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Vec<SqliteQueryResult> {
        let window = FetchWindow {
            limit: Some(limit),
            offset: Some(offset),
        };
        execute_sync(conn, sql, window, &mut MemoryGuard::new(0)).expect("runs")
    }

    /// A table `t` holding 1..=n.
    fn numbers(conn: &SqliteConnection, n: u32) {
        run(
            conn,
            &format!(
                "CREATE TABLE t(x INTEGER); \
                 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < {n}) \
                 INSERT INTO t SELECT x FROM c"
            ),
        )
        .expect("fills t");
    }

    #[test]
    fn a_result_past_the_limit_is_capped_and_marked_truncated() {
        let conn = memory();
        numbers(&conn, 50);
        let results = windowed(&conn, "SELECT x FROM t ORDER BY x", 10, 0);
        assert_eq!(results[0].rows.len(), 10);
        assert_eq!(results[0].rows[9], vec![serde_json::json!(10)]);
        assert!(results[0].rows_truncated);
        assert_eq!(
            results[0].truncation_reason,
            Some(SqliteTruncationReason::RowLimit)
        );
    }

    #[test]
    fn a_result_exactly_the_limit_long_is_not_truncated() {
        let conn = memory();
        numbers(&conn, 10);
        let results = windowed(&conn, "SELECT x FROM t", 10, 0);
        assert_eq!(results[0].rows.len(), 10);
        assert!(!results[0].rows_truncated);
        assert_eq!(results[0].truncation_reason, None);
    }

    #[test]
    fn the_limit_applies_to_each_statement_of_a_script() {
        let conn = memory();
        numbers(&conn, 30);
        let results = windowed(&conn, "SELECT x FROM t; SELECT x * 2 FROM t", 5, 0);
        assert_eq!(results.len(), 2);
        assert!(results
            .iter()
            .all(|r| r.rows.len() == 5 && r.rows_truncated));
    }

    #[test]
    fn an_offset_skips_to_the_page() {
        let conn = memory();
        numbers(&conn, 25);
        let results = windowed(&conn, "SELECT x FROM t ORDER BY x", 10, 20);
        let page: Vec<_> = results[0].rows.iter().map(|r| r[0].clone()).collect();
        assert_eq!(
            page,
            (21..=25).map(|x| serde_json::json!(x)).collect::<Vec<_>>()
        );
        assert!(!results[0].rows_truncated);
    }

    #[test]
    fn a_capped_insert_returning_still_writes_every_row() {
        let conn = memory();
        numbers(&conn, 1);
        let results = windowed(
            &conn,
            "INSERT INTO t VALUES (2), (3), (4), (5) RETURNING x",
            2,
            0,
        );
        assert_eq!(results[0].rows.len(), 2);
        assert!(results[0].rows_truncated);
        let count = run(&conn, "SELECT COUNT(*) FROM t").expect("counts");
        assert_eq!(count[0].rows[0], vec![serde_json::json!(5)]);
    }

    #[test]
    fn low_memory_stops_the_fetch_and_the_run() {
        let conn = memory();
        numbers(&conn, 2500);
        // A floor no machine has free trips the guard on its first check.
        let results = execute_sync(
            &conn,
            "SELECT x FROM t; CREATE TABLE never(y)",
            FetchWindow::default(),
            &mut MemoryGuard::new(u64::MAX),
        )
        .expect("runs");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].rows.len(), MEMORY_CHECK_EVERY);
        assert_eq!(
            results[0].truncation_reason,
            Some(SqliteTruncationReason::MemoryGuard)
        );
        assert!(results[0].rows_truncated);
        assert_eq!(tables(&conn), ["t"]);
    }

    #[test]
    fn each_result_says_whether_a_transaction_is_open() {
        let conn = memory();
        let results = run(
            &conn,
            "CREATE TABLE a(x); BEGIN; INSERT INTO a VALUES (1); COMMIT",
        )
        .expect("runs");
        let open: Vec<bool> = results.iter().map(|r| r.in_transaction).collect();
        assert_eq!(open, [false, true, true, false]);
    }

    fn tables(conn: &SqliteConnection) -> Vec<String> {
        let db = conn.db.lock().expect("lock");
        let mut stmt = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("prepares");
        let names = stmt
            .query_map([], |r| r.get(0))
            .expect("queries")
            .collect::<Result<Vec<String>, _>>()
            .expect("reads");
        names
    }

    #[test]
    fn a_two_statement_script_runs_both() {
        let conn = memory();
        let results = run(&conn, "CREATE TABLE a(x); CREATE TABLE b(y);").expect("runs");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].statement_index, 0);
        assert_eq!(results[0].sql, "CREATE TABLE a(x)");
        assert_eq!(results[1].statement_index, 1);
        assert_eq!(results[1].sql, "CREATE TABLE b(y)");
        assert_eq!(tables(&conn), ["a", "b"]);
    }

    #[test]
    fn each_statement_reports_its_own_rows_and_counts() {
        let conn = memory();
        let results = run(
            &conn,
            "CREATE TABLE t(x);\nINSERT INTO t VALUES (1), (2);\n-- a comment first\nSELECT x FROM t ORDER BY x;\nCREATE TABLE u(y)",
        )
        .expect("runs");
        assert_eq!(results.len(), 4);
        assert_eq!(results[1].rows_affected, 2);
        assert_eq!(results[2].columns.len(), 1);
        assert_eq!(
            results[2].rows,
            vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]]
        );
        // The INSERT's count does not leak into the DDL after it.
        assert_eq!(results[3].rows_affected, 0);
    }

    #[test]
    fn a_failure_in_the_second_statement_keeps_the_first() {
        let conn = memory();
        let err = run(
            &conn,
            "CREATE TABLE a(x); SELECT * FROM missing; CREATE TABLE b(y);",
        )
        .expect_err("the second statement fails");
        match err {
            SqliteError::AtStatement {
                index,
                source,
                completed,
            } => {
                assert_eq!(index, 1);
                assert!(matches!(*source, SqliteError::Rusqlite(_)));
                assert!(source.to_string().contains("no such table: missing"));
                assert_eq!(completed.len(), 1);
                assert_eq!(completed[0].sql, "CREATE TABLE a(x)");
            }
            other => panic!("expected a statement-tagged error, got {other:?}"),
        }
        // The first ran, the third never did.
        assert_eq!(tables(&conn), ["a"]);
    }

    #[test]
    fn a_failure_in_the_first_statement_is_index_zero() {
        let conn = memory();
        let err = run(&conn, "SELEC 1; SELECT 2").expect_err("fails");
        assert!(matches!(
            err,
            SqliteError::AtStatement { index: 0, ref completed, .. } if completed.is_empty()
        ));
    }

    #[test]
    fn a_trigger_body_with_semicolons_is_one_statement() {
        let conn = memory();
        let results = run(
            &conn,
            "CREATE TABLE t(x);\n\
             CREATE TABLE log(msg);\n\
             CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n\
               INSERT INTO log VALUES ('one; two');\n\
               INSERT INTO log VALUES (new.x);\n\
             END;\n\
             INSERT INTO t VALUES (7);\n\
             SELECT msg FROM log ORDER BY rowid;",
        )
        .expect("runs");
        assert_eq!(results.len(), 5);
        assert!(results[2].sql.starts_with("CREATE TRIGGER tr"));
        assert_eq!(
            results[4].rows,
            vec![
                vec![serde_json::json!("one; two")],
                vec![serde_json::json!(7)]
            ]
        );
    }

    #[test]
    fn strings_containing_semicolons_stay_whole() {
        let conn = memory();
        let results = run(
            &conn,
            "CREATE TABLE \"we;ird\"(v); INSERT INTO \"we;ird\" VALUES ('a;b'), ('c'';d'); SELECT v FROM \"we;ird\" ORDER BY v",
        )
        .expect("runs");
        assert_eq!(results.len(), 3);
        assert_eq!(
            results[2].rows,
            vec![
                vec![serde_json::json!("a;b")],
                vec![serde_json::json!("c';d")]
            ]
        );
    }

    #[test]
    fn a_script_of_only_comments_runs_nothing() {
        let conn = memory();
        let results = run(&conn, "-- nothing here\n/* or here */;").expect("runs");
        assert!(results.is_empty());
    }

    #[test]
    fn insert_returning_reports_rows_and_count() {
        let conn = memory();
        let results = run(
            &conn,
            "CREATE TABLE t(x); INSERT INTO t VALUES (5) RETURNING x",
        )
        .expect("runs");
        assert_eq!(results[1].rows, vec![vec![serde_json::json!(5)]]);
        assert_eq!(results[1].rows_affected, 1);
    }
}
