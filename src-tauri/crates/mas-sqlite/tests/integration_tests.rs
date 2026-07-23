//! Integration tests for mas-sqlite using in-memory SQLite (`:memory:`).
//!
//! No Docker / external services required. The `bundled` feature on
//! `rusqlite` (workspace dependency) means SQLite is statically linked.

use mas_sqlite::connection::SqliteConnectionManager;
use mas_sqlite::error::SqliteError;
use mas_sqlite::query::SqliteQueryExecutor;
use mas_sqlite::schema::SqliteSchemaInspector;
use std::sync::Arc;

fn manager() -> Arc<SqliteConnectionManager> {
    Arc::new(SqliteConnectionManager::new())
}

async fn open_in_memory(mgr: &SqliteConnectionManager, id: &str) {
    mgr.open(id, ":memory:").expect("open in-memory db");
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manager_open_in_memory_and_get() {
    let mgr = manager();
    open_in_memory(&mgr, "c1").await;

    let conn = mgr.get("c1").expect("get c1");
    assert_eq!(conn.id, "c1");
    assert_eq!(conn.path.to_string_lossy(), ":memory:");
}

#[tokio::test]
async fn manager_list_returns_open_ids() {
    let mgr = manager();
    open_in_memory(&mgr, "a").await;
    open_in_memory(&mgr, "b").await;
    open_in_memory(&mgr, "c").await;

    let mut ids = mgr.list();
    ids.sort();
    assert_eq!(ids, vec!["a", "b", "c"]);
}

#[tokio::test]
async fn manager_close_removes_from_list() {
    let mgr = manager();
    open_in_memory(&mgr, "x").await;
    open_in_memory(&mgr, "y").await;

    mgr.close("x").expect("close x");
    assert_eq!(mgr.list(), vec!["y"]);
}

#[tokio::test]
async fn manager_get_missing_returns_not_found() {
    let mgr = manager();
    match mgr.get("nope") {
        Ok(_) => panic!("expected error"),
        Err(SqliteError::NotFound(msg)) => assert!(msg.contains("nope")),
        Err(e) => panic!("expected NotFound variant, got: {e}"),
    }
}

#[tokio::test]
async fn manager_close_missing_returns_not_found() {
    let mgr = manager();
    match mgr.close("nope") {
        Ok(()) => panic!("expected error"),
        Err(SqliteError::NotFound(msg)) => assert!(msg.contains("nope")),
        Err(e) => panic!("expected NotFound variant, got: {e}"),
    }
}

#[tokio::test]
async fn manager_open_same_id_replaces_previous() {
    let mgr = manager();
    open_in_memory(&mgr, "dup").await;
    // Second open with the same id replaces (DashMap insert semantics).
    mgr.open("dup", ":memory:").expect("re-open dup");
    // Only one entry should remain.
    assert_eq!(mgr.list(), vec!["dup"]);
}

// ---------------------------------------------------------------------------
// Query executor
// ---------------------------------------------------------------------------

// For query tests we need to share the manager between test setup and the
// executor. Helper builds an executor bound to the same manager.
fn executor_for(mgr: &Arc<SqliteConnectionManager>) -> SqliteQueryExecutor {
    SqliteQueryExecutor::new(mgr.clone())
}

#[tokio::test]
async fn query_select_returns_rows_and_columns() {
    let mgr = manager();
    open_in_memory(&mgr, "q").await;
    let exec = executor_for(&mgr);

    // CREATE + INSERT via the executor (it routes non-SELECT to execute).
    exec.execute("q", "CREATE TABLE users (id INTEGER, name TEXT)")
        .await
        .expect("create");
    exec.execute("q", "INSERT INTO users VALUES (1, 'alice'), (2, 'bob')")
        .await
        .expect("insert");

    let results = exec
        .execute("q", "SELECT * FROM users ORDER BY id")
        .await
        .expect("select");
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(r.columns.len(), 2);
    assert_eq!(r.columns[0].name, "id");
    assert_eq!(r.columns[1].name, "name");
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows_affected, 0);
}

#[tokio::test]
async fn query_insert_returns_rows_affected() {
    let mgr = manager();
    open_in_memory(&mgr, "q").await;
    let exec = executor_for(&mgr);

    exec.execute("q", "CREATE TABLE t (x INTEGER)")
        .await
        .unwrap();
    let r = exec
        .execute("q", "INSERT INTO t VALUES (10), (20), (30)")
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].rows_affected, 3);
    assert_eq!(r[0].columns.len(), 0);
    assert!(r[0].rows.is_empty());
}

#[tokio::test]
async fn query_unknown_connection_returns_not_found() {
    let mgr = manager();
    let exec = executor_for(&mgr);
    let err = exec.execute("ghost", "SELECT 1").await.unwrap_err();
    assert!(matches!(err, SqliteError::NotFound(_)));
}

#[tokio::test]
async fn query_invalid_sql_returns_query_error() {
    let mgr = manager();
    open_in_memory(&mgr, "q").await;
    let exec = executor_for(&mgr);
    let err = exec.execute("q", "SELEKT 1").await.unwrap_err();
    // rusqlite error wrapped via spawn_blocking failure path
    assert!(
        err.to_string().to_lowercase().contains("selekt")
            || err.to_string().to_lowercase().contains("error")
    );
}

#[tokio::test]
async fn query_pragma_routed_as_select() {
    let mgr = manager();
    open_in_memory(&mgr, "q").await;
    let exec = executor_for(&mgr);
    exec.execute("q", "CREATE TABLE t (x INTEGER)")
        .await
        .unwrap();

    let r = exec.execute("q", "PRAGMA table_info(t)").await.unwrap();
    assert_eq!(r.len(), 1);
    // PRAGMA returns columns; rows_affected should be 0
    assert_eq!(r[0].rows_affected, 0);
    assert!(!r[0].columns.is_empty());
}

#[tokio::test]
async fn query_explain_routed_as_select() {
    let mgr = manager();
    open_in_memory(&mgr, "q").await;
    let exec = executor_for(&mgr);
    exec.execute("q", "CREATE TABLE t (x INTEGER)")
        .await
        .unwrap();

    let r = exec.execute("q", "EXPLAIN SELECT * FROM t").await.unwrap();
    assert_eq!(r.len(), 1);
    assert!(!r[0].columns.is_empty());
}

#[tokio::test]
async fn query_null_value_serialized_as_null() {
    let mgr = manager();
    open_in_memory(&mgr, "q").await;
    let exec = executor_for(&mgr);
    exec.execute("q", "CREATE TABLE t (x INTEGER)")
        .await
        .unwrap();
    exec.execute("q", "INSERT INTO t VALUES (NULL)")
        .await
        .unwrap();

    let r = exec.execute("q", "SELECT x FROM t").await.unwrap();
    assert_eq!(r[0].rows[0][0], serde_json::Value::Null);
}

// ---------------------------------------------------------------------------
// Schema inspector
// ---------------------------------------------------------------------------

async fn seed_two_tables(mgr: &Arc<SqliteConnectionManager>) {
    open_in_memory(mgr, "s").await;
    let exec = executor_for(mgr);
    exec.execute(
        "s",
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)",
    )
    .await
    .unwrap();
    exec.execute(
        "s",
        "INSERT INTO users (id, name, email) VALUES (1, 'alice', 'a@x'), (2, 'bob', NULL)",
    )
    .await
    .unwrap();
    exec.execute(
        "s",
        "CREATE TABLE orders (id INTEGER, total REAL, UNIQUE(id))",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn schema_get_tables_returns_user_tables_only() {
    let mgr = manager();
    seed_two_tables(&mgr).await;
    let insp = SqliteSchemaInspector::new(mgr.clone());

    let tables = insp.get_tables("s").await.unwrap();
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"users"));
    assert!(names.contains(&"orders"));
    // No sqlite_* internals leaked
    assert!(!names.iter().any(|n| n.starts_with("sqlite_")));

    let users = tables.iter().find(|t| t.name == "users").unwrap();
    assert_eq!(users.table_type, "table");
    assert_eq!(users.row_count, Some(2));
    assert!(users.sql.as_ref().unwrap().contains("CREATE TABLE users"));
}

#[tokio::test]
async fn schema_get_columns_returns_metadata() {
    let mgr = manager();
    seed_two_tables(&mgr).await;
    let insp = SqliteSchemaInspector::new(mgr.clone());

    let cols = insp.get_columns("s", "users").await.unwrap();
    let by_name: std::collections::HashMap<_, _> =
        cols.iter().map(|c| (c.name.as_str(), c)).collect();

    assert!(by_name.contains_key("id"));
    assert!(by_name.contains_key("name"));
    assert!(by_name.contains_key("email"));

    let id = by_name["id"];
    assert!(id.is_primary_key);
    // SQLite's PRAGMA table_info reports notnull=0 for INTEGER PRIMARY KEY
    // (the NOT NULL is implied, not stored as a constraint flag), so nullable
    // here is true. Documenting current behavior.
    assert!(id.nullable);

    let name = by_name["name"];
    assert!(!name.nullable);
    assert!(!name.is_primary_key);

    let email = by_name["email"];
    assert!(email.nullable);
}

#[tokio::test]
async fn schema_get_columns_unknown_table_returns_empty() {
    let mgr = manager();
    open_in_memory(&mgr, "s").await;
    let insp = SqliteSchemaInspector::new(mgr.clone());

    // Current behavior: PRAGMA table_info on a missing table returns empty
    // rows, not an error. (Implementation does not pre-validate the table.)
    let cols = insp.get_columns("s", "no_such_table").await.unwrap();
    assert!(cols.is_empty());
}

#[tokio::test]
async fn schema_get_indexes_returns_explicit_indexes() {
    let mgr = manager();
    open_in_memory(&mgr, "s").await;
    let exec = executor_for(&mgr);
    exec.execute("s", "CREATE TABLE t (id INTEGER, email TEXT)")
        .await
        .unwrap();
    exec.execute("s", "CREATE UNIQUE INDEX idx_t_email ON t(email)")
        .await
        .unwrap();

    let insp = SqliteSchemaInspector::new(mgr.clone());
    let indexes = insp.get_indexes("s", "t").await.unwrap();
    assert_eq!(indexes.len(), 1);
    let idx = &indexes[0];
    assert_eq!(idx.name, "idx_t_email");
    assert_eq!(idx.columns, vec!["email".to_string()]);
    assert!(idx.is_unique);
}

#[tokio::test]
async fn schema_get_table_ddl_returns_create_sql() {
    let mgr = manager();
    seed_two_tables(&mgr).await;
    let insp = SqliteSchemaInspector::new(mgr.clone());

    let ddl = insp.get_table_ddl("s", "users").await.unwrap();
    assert!(ddl.contains("CREATE TABLE users"));
    assert!(ddl.contains("name"));
}

#[tokio::test]
async fn schema_get_table_ddl_missing_table_fails() {
    let mgr = manager();
    open_in_memory(&mgr, "s").await;
    let insp = SqliteSchemaInspector::new(mgr.clone());

    let err = insp.get_table_ddl("s", "no_such_table").await.unwrap_err();
    assert!(matches!(err, SqliteError::Schema(_)));
}

#[tokio::test]
async fn schema_unknown_connection_returns_not_found() {
    let mgr = manager();
    let insp = SqliteSchemaInspector::new(mgr.clone());
    let err = insp.get_tables("ghost").await.unwrap_err();
    assert!(matches!(err, SqliteError::NotFound(_)));
}
