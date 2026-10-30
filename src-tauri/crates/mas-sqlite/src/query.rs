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
    pub rows_truncated: bool,
}

pub struct SqliteQueryExecutor {
    manager: Arc<SqliteConnectionManager>,
}

impl SqliteQueryExecutor {
    pub fn new(manager: Arc<SqliteConnectionManager>) -> Self {
        Self { manager }
    }

    pub async fn execute(
        &self,
        connection_id: &str,
        sql: &str,
    ) -> Result<Vec<SqliteQueryResult>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let sql = sql.to_string();
        tokio::task::spawn_blocking(move || execute_sync(&conn, &sql))
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
fn execute_sync(
    conn: &crate::connection::SqliteConnection,
    sql: &str,
) -> Result<Vec<SqliteQueryResult>, SqliteError> {
    let db = conn
        .db
        .lock()
        .map_err(|e| SqliteError::Query(e.to_string()))?;

    let mut results = Vec::new();
    for (index, statement) in crate::split::split_statements(sql).iter().enumerate() {
        match execute_one(&db, index, statement) {
            Ok(result) => results.push(result),
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
fn execute_one(
    db: &rusqlite::Connection,
    index: usize,
    statement: &crate::split::Statement<'_>,
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
    let mut rows = Vec::new();
    if col_count > 0 {
        let mut cursor = stmt.query([])?;
        while let Some(row) = cursor.next()? {
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
        rows_truncated: false,
    })
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
        let results = execute_sync(&conn, "CREATE TABLE a(x); CREATE TABLE b(y);").expect("runs");
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
        let results = execute_sync(
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
        let err = execute_sync(
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
        let err = execute_sync(&conn, "SELEC 1; SELECT 2").expect_err("fails");
        assert!(matches!(
            err,
            SqliteError::AtStatement { index: 0, ref completed, .. } if completed.is_empty()
        ));
    }

    #[test]
    fn a_trigger_body_with_semicolons_is_one_statement() {
        let conn = memory();
        let results = execute_sync(
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
        let results = execute_sync(
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
        let results = execute_sync(&conn, "-- nothing here\n/* or here */;").expect("runs");
        assert!(results.is_empty());
    }

    #[test]
    fn insert_returning_reports_rows_and_count() {
        let conn = memory();
        let results = execute_sync(
            &conn,
            "CREATE TABLE t(x); INSERT INTO t VALUES (5) RETURNING x",
        )
        .expect("runs");
        assert_eq!(results[1].rows, vec![vec![serde_json::json!(5)]]);
        assert_eq!(results[1].rows_affected, 1);
    }
}
