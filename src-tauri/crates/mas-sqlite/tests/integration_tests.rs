//! Integration tests for mas-sqlite using in-memory SQLite (`:memory:`).
//!
//! No Docker / external services required. The `bundled` feature on
//! `rusqlite` (workspace dependency) means SQLite is statically linked.

use mas_sqlite::connection::SqliteConnectionManager;
use mas_sqlite::error::SqliteError;
use mas_sqlite::query::SqliteQueryExecutor;
use mas_sqlite::schema::{SqliteForeignKeyInfo, SqliteSchemaInspector};
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

/// An in-memory database with `statements` run in it, one at a time (the
/// executor runs only the first statement of a string), and an inspector
/// over it.
async fn inspector_with(statements: &[&str]) -> SqliteSchemaInspector {
    let mgr = manager();
    open_in_memory(&mgr, "s").await;
    let exec = executor_for(&mgr);
    for sql in statements {
        exec.execute("s", sql).await.unwrap();
    }
    SqliteSchemaInspector::new(mgr)
}

#[tokio::test]
async fn schema_get_foreign_keys_groups_a_composite_key_in_order() {
    let insp = inspector_with(&[
        "CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b))",
        "CREATE TABLE child (
           id INTEGER PRIMARY KEY,
           pb INTEGER,
           pa INTEGER,
           CONSTRAINT fk_child_parent FOREIGN KEY (pa, pb) REFERENCES parent (a, b)
             ON DELETE CASCADE ON UPDATE SET NULL
         )",
    ])
    .await;

    let keys = insp.get_foreign_keys("s", "child").await.unwrap();
    assert_eq!(
        keys,
        vec![SqliteForeignKeyInfo {
            // SQLite keeps no constraint names; this one is made up.
            name: "fk_child_0".into(),
            columns: vec!["pa".into(), "pb".into()],
            referenced_table: "parent".into(),
            referenced_columns: vec!["a".into(), "b".into()],
            on_update: "SET NULL".into(),
            on_delete: "CASCADE".into(),
        }]
    );
}

#[tokio::test]
async fn schema_get_foreign_keys_reports_each_key_and_its_actions() {
    let insp = inspector_with(&[
        "CREATE TABLE users (id INTEGER PRIMARY KEY)",
        "CREATE TABLE teams (id INTEGER PRIMARY KEY)",
        "CREATE TABLE members (
           user_id INTEGER REFERENCES users (id) ON DELETE RESTRICT,
           team_id INTEGER REFERENCES teams (id) ON DELETE SET DEFAULT ON UPDATE CASCADE
         )",
    ])
    .await;

    let mut keys = insp.get_foreign_keys("s", "members").await.unwrap();
    keys.sort_by(|a, b| a.referenced_table.cmp(&b.referenced_table));
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0].name, keys[1].name);

    assert_eq!(keys[0].referenced_table, "teams");
    assert_eq!(keys[0].columns, vec!["team_id".to_string()]);
    assert_eq!(keys[0].on_delete, "SET DEFAULT");
    assert_eq!(keys[0].on_update, "CASCADE");

    assert_eq!(keys[1].referenced_table, "users");
    assert_eq!(keys[1].columns, vec!["user_id".to_string()]);
    assert_eq!(keys[1].referenced_columns, vec!["id".to_string()]);
    assert_eq!(keys[1].on_delete, "RESTRICT");
    // Unspecified actions read as SQLite's default.
    assert_eq!(keys[1].on_update, "NO ACTION");
}

#[tokio::test]
async fn schema_get_foreign_keys_resolves_an_implicit_parent_key() {
    let insp = inspector_with(&[
        "CREATE TABLE parent (x TEXT, y TEXT, PRIMARY KEY (y, x))",
        "CREATE TABLE child (p TEXT, q TEXT, FOREIGN KEY (p, q) REFERENCES parent)",
    ])
    .await;

    let keys = insp.get_foreign_keys("s", "child").await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].columns, vec!["p".to_string(), "q".to_string()]);
    // The parent's primary key, in its key order rather than column order.
    assert_eq!(
        keys[0].referenced_columns,
        vec!["y".to_string(), "x".to_string()]
    );
}

#[tokio::test]
async fn schema_get_foreign_keys_is_empty_without_keys() {
    let insp = inspector_with(&["CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)"]).await;
    assert!(insp
        .get_foreign_keys("s", "plain")
        .await
        .unwrap()
        .is_empty());
    assert!(insp
        .get_foreign_keys("s", "no_such_table")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn schema_get_foreign_keys_takes_any_table_name() {
    // Quotes and a semicolon in the name: it is bound, never spliced in.
    let insp = inspector_with(&[
        "CREATE TABLE p (id INTEGER PRIMARY KEY)",
        r#"CREATE TABLE "we""ird; name" (pid INTEGER REFERENCES p (id))"#,
    ])
    .await;

    let keys = insp.get_foreign_keys("s", r#"we"ird; name"#).await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].referenced_table, "p");
    assert_eq!(keys[0].columns, vec!["pid".to_string()]);
}

// ---------------------------------------------------------------------------
// Names that need quoting, and indexes read from the pragmas (#929)
// ---------------------------------------------------------------------------

const ODD_TABLE: &str = r#"we"ird; name"#;

async fn odd_inspector() -> SqliteSchemaInspector {
    inspector_with(&[r#"CREATE TABLE "we""ird; name" (
             "id" INTEGER PRIMARY KEY,
             "co""l; x" TEXT NOT NULL DEFAULT 'a;b',
             email TEXT,
             created INTEGER
           );
           INSERT INTO "we""ird; name" ("co""l; x", email, created)
             VALUES ('x', 'A@x', 1), ('y', 'b@x', 2), ('z', 'c@x', 3);
           CREATE UNIQUE INDEX "ix""q; 1" ON "we""ird; name" ("co""l; x");
           CREATE INDEX ix_desc ON "we""ird; name" (created DESC, email COLLATE NOCASE);
           CREATE INDEX ix_expr ON "we""ird; name" (lower(email), created);"#])
    .await
}

#[tokio::test]
async fn schema_get_tables_counts_a_table_whose_name_needs_quoting() {
    let insp = odd_inspector().await;
    let tables = insp.get_tables("s").await.unwrap();
    let t = tables.iter().find(|t| t.name == ODD_TABLE).expect("listed");
    assert_eq!(t.row_count, Some(3));
}

#[tokio::test]
async fn schema_get_columns_reads_a_table_whose_name_needs_quoting() {
    let insp = odd_inspector().await;
    let cols = insp.get_columns("s", ODD_TABLE).await.unwrap();
    let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", r#"co"l; x"#, "email", "created"]);
    assert!(cols[0].is_primary_key);
    assert!(!cols[1].nullable);
    assert_eq!(cols[1].default_value.as_deref(), Some("'a;b'"));
}

#[tokio::test]
async fn schema_get_columns_does_not_run_sql_from_a_name() {
    let insp = inspector_with(&["CREATE TABLE victim (x)"]).await;
    // Would have closed the quoted name and run a DROP under the old
    // `PRAGMA table_info("{}")`.
    let cols = insp
        .get_columns("s", r#"victim"); DROP TABLE victim; --"#)
        .await
        .unwrap();
    assert!(cols.is_empty());
    let tables = insp.get_tables("s").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "victim"));
}

#[tokio::test]
async fn schema_get_indexes_reads_key_columns_from_the_pragmas() {
    let insp = odd_inspector().await;
    let indexes = insp.get_indexes("s", ODD_TABLE).await.unwrap();
    let summary: Vec<(&str, Vec<&str>, bool)> = indexes
        .iter()
        .map(|i| {
            (
                i.name.as_str(),
                i.columns.iter().map(String::as_str).collect(),
                i.is_unique,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            // In name order, which puts `"` before `_`.
            (r#"ix"q; 1"#, vec![r#"co"l; x"#], true),
            // DESC and COLLATE do not leak into the column names.
            ("ix_desc", vec!["created", "email"], false),
            // An expression has no name; the plain column after it keeps its own.
            (
                "ix_expr",
                vec![mas_sqlite::schema::EXPRESSION_COLUMN, "created"],
                false
            ),
        ]
    );
}

#[tokio::test]
async fn schema_get_indexes_leaves_out_constraint_indexes() {
    let insp = inspector_with(&[
        "CREATE TABLE t (a TEXT PRIMARY KEY, b TEXT UNIQUE, c TEXT)",
        "CREATE UNIQUE INDEX ix_c ON t (c)",
    ])
    .await;
    let indexes = insp.get_indexes("s", "t").await.unwrap();
    let names: Vec<&str> = indexes.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["ix_c"]);
    assert!(indexes[0].is_unique);
}

#[tokio::test]
async fn schema_get_foreign_keys_unknown_connection_returns_not_found() {
    let insp = SqliteSchemaInspector::new(manager());
    let err = insp.get_foreign_keys("ghost", "t").await.unwrap_err();
    assert!(matches!(err, SqliteError::NotFound(_)));
}

#[tokio::test]
async fn schema_unknown_connection_returns_not_found() {
    let mgr = manager();
    let insp = SqliteSchemaInspector::new(mgr.clone());
    let err = insp.get_tables("ghost").await.unwrap_err();
    assert!(matches!(err, SqliteError::NotFound(_)));
}

// ---------------------------------------------------------------------------
// Opening a path that is not a database
//
// `rusqlite::Connection::open` is accommodating in two ways that are wrong for
// an "open" action. Verified against the version in this tree: a path that
// does not exist is created as a new empty database, and a file that is not a
// database opens fine and fails on the first query with "file is not a
// database" — describing the symptom rather than the cause (#463).
// ---------------------------------------------------------------------------

#[test]
fn open_refuses_a_file_that_is_not_a_database() {
    let mgr = manager();
    let path = std::env::temp_dir().join("mas_sqlite_not_a_db.txt");
    std::fs::write(&path, b"just some text, definitely not a database").unwrap();

    let err = mgr
        .open("c1", path.to_str().unwrap())
        .err()
        .expect("should refuse a non-database file");
    assert!(err.to_string().contains("not a SQLite database"), "{err}");

    std::fs::remove_file(&path).ok();
}

#[test]
fn open_refuses_an_empty_file() {
    // Zero bytes is a valid *new* database to SQLite, but opening is meant to
    // open something that is already there.
    let mgr = manager();
    let path = std::env::temp_dir().join("mas_sqlite_empty.db");
    std::fs::write(&path, b"").unwrap();

    assert!(mgr.open("c1", path.to_str().unwrap()).is_err());

    std::fs::remove_file(&path).ok();
}

#[test]
fn open_does_not_create_a_missing_file() {
    let mgr = manager();
    let path = std::env::temp_dir().join("mas_sqlite_should_not_appear.db");
    std::fs::remove_file(&path).ok();

    assert!(mgr.open("c1", path.to_str().unwrap()).is_err());
    assert!(
        !path.exists(),
        "opening a missing path must not leave a database behind"
    );
}

#[test]
fn open_refuses_a_directory() {
    let mgr = manager();
    let dir = std::env::temp_dir();
    let err = mgr
        .open("c1", dir.to_str().unwrap())
        .err()
        .expect("should refuse a directory");
    assert!(err.to_string().contains("not a regular file"), "{err}");
}

#[test]
fn open_accepts_a_real_database() {
    // The guard must not refuse the thing it exists to protect.
    let path = std::env::temp_dir().join("mas_sqlite_real.db");
    std::fs::remove_file(&path).ok();
    {
        let seed = rusqlite::Connection::open(&path).unwrap();
        seed.execute_batch("CREATE TABLE t (a INT); INSERT INTO t VALUES (1);")
            .unwrap();
    }

    let mgr = manager();
    assert!(mgr.open("c1", path.to_str().unwrap()).is_ok());

    std::fs::remove_file(&path).ok();
}

#[test]
fn open_still_accepts_in_memory() {
    let mgr = manager();
    assert!(mgr.open("c1", ":memory:").is_ok());
}

// ---------------------------------------------------------------------------
// The cases the issue named, and the one it proposed that is deliberately not
// implemented (#463).
// ---------------------------------------------------------------------------

/// A file with the given bytes, in a directory that lives as long as the
/// returned handle. The tests above name files in the shared temp directory,
/// which two runs at once would fight over.
fn file_with(bytes: &[u8]) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("candidate");
    std::fs::write(&path, bytes).unwrap();
    let name = path.to_string_lossy().into_owned();
    (dir, name)
}

#[test]
fn open_refuses_the_real_etc_passwd() {
    // The case the issue names, against the actual file where there is one.
    if !std::path::Path::new("/etc/passwd").exists() {
        return;
    }
    let err = manager()
        .open("c1", "/etc/passwd")
        .err()
        .expect("/etc/passwd is not a database");
    assert!(err.to_string().contains("not a SQLite database"), "{err}");
}

#[test]
fn open_refuses_a_file_shorter_than_the_header() {
    // The read has to be checked for length as well as content, or a 3-byte
    // file compares equal on the part that was read.
    let (_dir, path) = file_with(b"SQL");
    let err = manager()
        .open("c1", &path)
        .err()
        .expect("three bytes are not a database");
    assert!(err.to_string().contains("not a SQLite database"), "{err}");
}

#[test]
fn a_large_database_is_not_refused_for_being_large() {
    // The issue proposed a 256 MB cap. Deliberately not implemented: a real
    // database can be tens of gigabytes, and refusing to open one because it
    // is big would be a bug wearing the clothes of a safety check. Proven
    // past that figure with a sparse file, so it costs no disk.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.db");
    {
        let seed = rusqlite::Connection::open(&path).unwrap();
        seed.execute_batch("CREATE TABLE t (a INT);").unwrap();
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(300 * 1024 * 1024)
        .unwrap();

    manager()
        .open("c1", &path.to_string_lossy())
        .expect("a large database should still open");
}
