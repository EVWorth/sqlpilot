use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::error::CoreError;
use mas_core::models::{ConnectionProfile, SqlValue};
use mas_core::query::{apply_in_session, GridEditOutcome, QueryExecutor, TransactionState};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Grid edits land on the editor tab's own session, and never commit a
/// transaction the user opened there (#735).
///
/// Before, a grid save went to the shared pool: an edit to rows the tab had
/// locked waited on the tab itself, and an edit made inside the tab's
/// transaction committed on its own. Sending the old `START TRANSACTION … COMMIT`
/// batch to the session instead would have committed the user's open
/// transaction implicitly. These tests run what a user would do in a tab and
/// check where the edits went and what was committed.
fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "grid edits".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB.
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
        username: "test_user".to_string(),
        password: "test_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 5,
        read_only: false,
        // Short, so a save stuck behind the tab fails in two seconds rather
        // than ten.
        connect_timeout_secs: Some(2),
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

async fn connect() -> (Arc<ConnectionManager>, Arc<QueryExecutor>, String) {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager
        .connect(&profile())
        .await
        .expect("connects to the test server");
    let executor = Arc::new(QueryExecutor::new(manager.clone()));
    (manager, executor, info.id)
}

const TAB: &str = "tab-1";

/// Run `sql` as the editor tab would.
async fn in_tab(
    executor: &QueryExecutor,
    id: &str,
    sql: &str,
) -> Vec<mas_core::models::QueryResult> {
    executor
        .execute_in_session(
            TAB,
            id.to_string(),
            sql.to_string(),
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("the tab ran {sql}: {e}"))
}

/// Run `sql` on the shared pool, which is what anyone outside the tab sees.
async fn outside(
    executor: &QueryExecutor,
    id: &str,
    sql: &str,
) -> Vec<mas_core::models::QueryResult> {
    executor
        .execute(id, sql, Some("test_db".to_string()), None, None)
        .await
        .unwrap_or_else(|e| panic!("ran {sql} outside the tab: {e}"))
}

async fn save(
    manager: &ConnectionManager,
    id: &str,
    statements: &[&str],
) -> Result<Option<GridEditOutcome>, CoreError> {
    let statements: Vec<String> = statements.iter().map(|s| s.to_string()).collect();
    apply_in_session(manager, id, TAB, Some("test_db"), &statements).await
}

/// The rows of a single-column integer table, in order, as text.
fn ids(results: &[mas_core::models::QueryResult]) -> Vec<String> {
    results
        .last()
        .expect("a result")
        .rows
        .iter()
        .map(|row| match row.first() {
            Some(SqlValue::Int(v)) => v.to_string(),
            Some(SqlValue::UInt(v)) => v.to_string(),
            other => format!("{other:?}"),
        })
        .collect()
}

/// A table of its own per test, so tests can run side by side.
async fn fresh_table(executor: &QueryExecutor, id: &str, name: &str, rows: &str) {
    outside(
        executor,
        id,
        &format!(
            "DROP TABLE IF EXISTS {name}; CREATE TABLE {name} (id INT PRIMARY KEY); \
             INSERT INTO {name} VALUES {rows}"
        ),
    )
    .await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn with_no_transaction_open_the_save_commits() {
    let (manager, executor, id) = connect().await;
    fresh_table(&executor, &id, "grid_no_tx", "(1), (2)").await;
    // The tab has a session already, as it would after running the query
    // whose result is being edited.
    in_tab(&executor, &id, "SELECT id FROM grid_no_tx").await;

    let outcome = save(
        &manager,
        &id,
        &[
            "UPDATE grid_no_tx SET id = 10 WHERE id = 1",
            "DELETE FROM grid_no_tx WHERE id = 2",
            "INSERT INTO grid_no_tx VALUES (3)",
        ],
    )
    .await
    .expect("the save runs")
    .expect("the session can say whether it is in a transaction");

    assert_eq!(outcome.transaction, TransactionState::None);
    assert_eq!(outcome.rows_affected, vec![1, 1, 1]);
    // Committed, so it is visible outside the tab.
    let rows = outside(&executor, &id, "SELECT id FROM grid_no_tx ORDER BY id").await;
    assert_eq!(ids(&rows), vec!["3", "10"]);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn an_open_transaction_is_not_committed_by_the_save() {
    let (manager, executor, id) = connect().await;
    fresh_table(&executor, &id, "grid_open_tx", "(1)").await;

    in_tab(&executor, &id, "START TRANSACTION").await;
    in_tab(&executor, &id, "INSERT INTO grid_open_tx VALUES (2)").await;

    let outcome = save(
        &manager,
        &id,
        &["UPDATE grid_open_tx SET id = 20 WHERE id = 2"],
    )
    .await
    .expect("the save runs")
    .expect("the session can say whether it is in a transaction");
    assert_eq!(outcome.transaction, TransactionState::Open);
    assert_eq!(outcome.rows_affected, vec![1]);

    // The tab sees its own uncommitted work and the edit…
    let inside = in_tab(&executor, &id, "SELECT id FROM grid_open_tx ORDER BY id").await;
    assert_eq!(ids(&inside), vec!["1", "20"]);
    // …and nobody else sees either: the user's transaction was not committed.
    let elsewhere = outside(&executor, &id, "SELECT id FROM grid_open_tx ORDER BY id").await;
    assert_eq!(ids(&elsewhere), vec!["1"]);

    // Rolling back undoes the user's insert and the edit together, because the
    // edit was part of the user's transaction.
    in_tab(&executor, &id, "ROLLBACK").await;
    let after = outside(&executor, &id, "SELECT id FROM grid_open_tx ORDER BY id").await;
    assert_eq!(ids(&after), vec!["1"]);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_failed_save_inside_a_transaction_undoes_only_itself() {
    let (manager, executor, id) = connect().await;
    fresh_table(&executor, &id, "grid_fail_tx", "(1), (2)").await;

    in_tab(&executor, &id, "START TRANSACTION").await;
    in_tab(&executor, &id, "INSERT INTO grid_fail_tx VALUES (3)").await;

    let err = save(
        &manager,
        &id,
        &[
            "UPDATE grid_fail_tx SET id = 10 WHERE id = 1",
            // Collides with the row the user inserted.
            "UPDATE grid_fail_tx SET id = 3 WHERE id = 2",
        ],
    )
    .await
    .expect_err("the duplicate key fails the save");
    assert!(
        matches!(err, CoreError::AtStatement { index: 1, .. }),
        "the failing statement is named: {err:?}"
    );

    // The save's first edit is gone; the user's insert is still there, and
    // still uncommitted.
    let inside = in_tab(&executor, &id, "SELECT id FROM grid_fail_tx ORDER BY id").await;
    assert_eq!(ids(&inside), vec!["1", "2", "3"]);
    let elsewhere = outside(&executor, &id, "SELECT id FROM grid_fail_tx ORDER BY id").await;
    assert_eq!(ids(&elsewhere), vec!["1", "2"]);
    in_tab(&executor, &id, "COMMIT").await;
    let committed = outside(&executor, &id, "SELECT id FROM grid_fail_tx ORDER BY id").await;
    assert_eq!(ids(&committed), vec!["1", "2", "3"]);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_failed_save_leaves_no_transaction_open() {
    let (manager, executor, id) = connect().await;
    fresh_table(&executor, &id, "grid_fail_no_tx", "(1), (2)").await;
    in_tab(&executor, &id, "SELECT 1").await;

    save(
        &manager,
        &id,
        &[
            "UPDATE grid_fail_no_tx SET id = 10 WHERE id = 1",
            "UPDATE grid_fail_no_tx SET id = 10 WHERE id = 2",
        ],
    )
    .await
    .expect_err("the duplicate key fails the save");

    // Nothing from the save was applied.
    let rows = outside(&executor, &id, "SELECT id FROM grid_fail_no_tx ORDER BY id").await;
    assert_eq!(ids(&rows), vec!["1", "2"]);

    // And the tab is not left inside the save's transaction: what it runs next
    // commits on its own, as it did before the save.
    in_tab(&executor, &id, "INSERT INTO grid_fail_no_tx VALUES (3)").await;
    let rows = outside(&executor, &id, "SELECT id FROM grid_fail_no_tx ORDER BY id").await;
    assert_eq!(ids(&rows), vec!["1", "2", "3"]);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn an_edit_to_rows_the_tab_has_locked_does_not_wait_on_the_tab() {
    let (manager, executor, id) = connect().await;
    fresh_table(&executor, &id, "grid_locked", "(1)").await;

    in_tab(&executor, &id, "START TRANSACTION").await;
    in_tab(
        &executor,
        &id,
        "SELECT id FROM grid_locked WHERE id = 1 FOR UPDATE",
    )
    .await;

    // On the shared pool this waited for the lock until innodb_lock_wait_timeout
    // (50 seconds by default) and then failed.
    let started = Instant::now();
    let outcome = save(
        &manager,
        &id,
        &["UPDATE grid_locked SET id = 5 WHERE id = 1"],
    )
    .await
    .expect("the save runs on the session that holds the lock")
    .expect("the session can say whether it is in a transaction");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the save waited on the tab's own lock"
    );
    assert_eq!(outcome.transaction, TransactionState::Open);
    in_tab(&executor, &id, "COMMIT").await;
    let rows = outside(&executor, &id, "SELECT id FROM grid_locked").await;
    assert_eq!(ids(&rows), vec!["5"]);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn the_probe_keeps_the_session_read_only_setting() {
    let (manager, executor, id) = connect().await;
    fresh_table(&executor, &id, "grid_read_only", "(1)").await;
    in_tab(&executor, &id, "SET SESSION TRANSACTION READ ONLY").await;

    // `SET TRANSACTION READ WRITE`, the obvious probe, would have let this
    // write through by overriding the session setting for the next
    // transaction.
    save(
        &manager,
        &id,
        &["UPDATE grid_read_only SET id = 2 WHERE id = 1"],
    )
    .await
    .expect_err("a READ ONLY session refuses the write");
    let rows = outside(&executor, &id, "SELECT id FROM grid_read_only").await;
    assert_eq!(ids(&rows), vec!["1"]);
}
