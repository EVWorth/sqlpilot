use chrono::Utc;
use mas_core::connection::{ConnectionManager, Lane, Route};
use mas_core::models::{ConnectionProfile, SqlValue};
use mas_core::query::{explain_in, ExplainFormat, QueryExecutor};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Each editor tab runs on its own server session (#731).
///
/// Before, a tab's statements went to whichever pooled connection was free,
/// so anything tied to the session — a temporary table, `SET @var`, a
/// transaction opened in one run and committed in the next — could land on a
/// connection where it did not exist. These tests run what a user would type
/// across separate runs and check the session is the same one each time.
fn profile(pool_max: u32) -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "sessions".to_string(),
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
        pool_max,
        read_only: false,
        // Short, so a busy session fails in two seconds rather than ten.
        connect_timeout_secs: Some(2),
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

async fn connect(pool_max: u32) -> (Arc<ConnectionManager>, Arc<QueryExecutor>, String) {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager
        .connect(&profile(pool_max))
        .await
        .expect("connects to the test server");
    let executor = Arc::new(QueryExecutor::new(manager.clone()));
    (manager, executor, info.id)
}

/// Run `sql` as editor tab `tab` would.
async fn run(
    executor: &QueryExecutor,
    id: &str,
    tab: &str,
    sql: &str,
) -> Result<Vec<mas_core::models::QueryResult>, mas_core::error::CoreError> {
    executor
        .execute_in_session(
            tab,
            id.to_string(),
            sql.to_string(),
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
}

/// The single value a one-row, one-column result holds, as text.
fn scalar(results: &[mas_core::models::QueryResult]) -> String {
    let result = results.last().expect("a result");
    match result.rows.first().and_then(|row| row.first()) {
        Some(SqlValue::Int(v)) => v.to_string(),
        Some(SqlValue::UInt(v)) => v.to_string(),
        Some(SqlValue::String(v)) => v.clone(),
        Some(SqlValue::Null) | None => "NULL".to_string(),
        Some(other) => format!("{other:?}"),
    }
}

/// A table of its own per test, so tests can run side by side.
async fn fresh_table(executor: &QueryExecutor, id: &str, name: &str) {
    executor
        .execute(
            id,
            &format!("DROP TABLE IF EXISTS {name}; CREATE TABLE {name} (id INT PRIMARY KEY)"),
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
        .expect("creates the probe table");
}

async fn count_rows(executor: &QueryExecutor, id: &str, table: &str) -> String {
    let results = executor
        .execute(
            id,
            &format!("SELECT COUNT(*) FROM {table}"),
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
        .expect("counts from another session");
    scalar(&results)
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn what_one_run_sets_up_is_there_for_the_next() {
    // Five shared connections, so a statement that drifted onto another one
    // would be likely to miss what the previous run left behind.
    let (_manager, executor, id) = connect(5).await;

    run(&executor, &id, "tab-1", "SET @greeting = 'hello'")
        .await
        .unwrap();
    run(
        &executor,
        &id,
        "tab-1",
        "CREATE TEMPORARY TABLE scratch (n INT)",
    )
    .await
    .unwrap();
    run(
        &executor,
        &id,
        "tab-1",
        "INSERT INTO scratch VALUES (1), (2), (3)",
    )
    .await
    .unwrap();

    for _ in 0..5 {
        let greeting = run(&executor, &id, "tab-1", "SELECT @greeting")
            .await
            .unwrap();
        assert_eq!(scalar(&greeting), "hello", "the session variable was lost");
        let counted = run(&executor, &id, "tab-1", "SELECT COUNT(*) FROM scratch")
            .await
            .expect("the temporary table is still there");
        assert_eq!(scalar(&counted), "3");
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn tabs_do_not_share_a_session() {
    let (_manager, executor, id) = connect(5).await;

    run(&executor, &id, "tab-1", "SET @mine = 'one'")
        .await
        .unwrap();
    run(
        &executor,
        &id,
        "tab-1",
        "CREATE TEMPORARY TABLE only_mine (n INT)",
    )
    .await
    .unwrap();

    let other = run(&executor, &id, "tab-2", "SELECT @mine").await.unwrap();
    assert_eq!(scalar(&other), "NULL", "a variable leaked into another tab");
    assert!(
        run(&executor, &id, "tab-2", "SELECT * FROM only_mine")
            .await
            .is_err(),
        "a temporary table leaked into another tab"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_transaction_can_span_runs() {
    let (_manager, executor, id) = connect(5).await;
    fresh_table(&executor, &id, "session_tx_span").await;

    run(&executor, &id, "tab-1", "START TRANSACTION")
        .await
        .unwrap();
    run(
        &executor,
        &id,
        "tab-1",
        "INSERT INTO session_tx_span VALUES (1)",
    )
    .await
    .unwrap();

    // Uncommitted, so nothing outside the tab sees it yet.
    assert_eq!(count_rows(&executor, &id, "session_tx_span").await, "0");

    run(&executor, &id, "tab-1", "COMMIT").await.unwrap();
    assert_eq!(count_rows(&executor, &id, "session_tx_span").await, "1");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn closing_a_tab_rolls_back_what_it_left_open() {
    // The same as closing a tab in any other client: the server ends the
    // session, and an uncommitted transaction goes with it.
    let (manager, executor, id) = connect(5).await;
    fresh_table(&executor, &id, "session_tx_close").await;

    run(&executor, &id, "tab-1", "START TRANSACTION")
        .await
        .unwrap();
    run(
        &executor,
        &id,
        "tab-1",
        "INSERT INTO session_tx_close VALUES (1)",
    )
    .await
    .unwrap();
    assert_eq!(manager.session_count(&id), 1);

    manager.close_session(&id, "tab-1").await;
    assert_eq!(manager.session_count(&id), 0);

    // The row lock is released too, which is what makes this insert succeed
    // rather than wait.
    executor
        .execute(
            &id,
            "INSERT INTO session_tx_close VALUES (1)",
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
        .expect("the closed tab's insert was rolled back and its lock released");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_tab_with_a_session_runs_while_the_shared_pool_is_full() {
    // A tab's session is its own connection; the schema tree or a dialog
    // holding every shared one does not stop it.
    let (manager, executor, id) = connect(1).await;
    run(&executor, &id, "tab-1", "SELECT 1").await.unwrap();

    let shared = manager.get_lane_pool(&id, Lane::Interactive).unwrap();
    let _held = shared.acquire().await.unwrap();

    let started = Instant::now();
    run(&executor, &id, "tab-1", "SELECT 1")
        .await
        .expect("the tab runs on its own connection");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_second_statement_on_a_busy_tab_says_the_tab_is_busy() {
    let (_manager, executor, id) = connect(5).await;
    let first = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move { run(&executor, &id, "tab-1", "SELECT SLEEP(4)").await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;

    let message = run(&executor, &id, "tab-1", "SELECT 1")
        .await
        .expect_err("the tab's one connection is busy")
        .to_string();
    assert!(message.contains("This tab is still running"), "{message}");
    assert!(!message.contains("Max pool size"), "{message}");

    first.await.unwrap().expect("the first statement finishes");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn cancel_stops_a_statement_running_on_a_tab() {
    let (_manager, executor, id) = connect(5).await;
    let running = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move { run(&executor, &id, "tab-1", "SELECT SLEEP(20)").await })
    };
    tokio::time::sleep(Duration::from_millis(700)).await;

    executor.cancel(&id).await.expect("cancel is issued");
    tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("the tab's statement stopped when cancelled")
        .unwrap()
        .ok();

    // KILL QUERY ends the statement, not the session: the tab still works,
    // and still has what it set up before.
    run(&executor, &id, "tab-1", "SELECT 1")
        .await
        .expect("the tab's session survives a cancel");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_plan_sees_the_tabs_temporary_tables() {
    // EXPLAIN made anywhere but the tab's session would not find the table.
    let (manager, executor, id) = connect(5).await;
    run(
        &executor,
        &id,
        "tab-1",
        "CREATE TEMPORARY TABLE planned (n INT)",
    )
    .await
    .unwrap();

    explain_in(
        Route::Session("tab-1".to_string()),
        &manager,
        &executor,
        id.clone(),
        "SELECT * FROM planned".to_string(),
        Some("test_db".to_string()),
        false,
        ExplainFormat::Classic,
    )
    .await
    .expect("the plan is made on the tab's session");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn sessions_are_known_as_the_apps_own_and_close_on_disconnect() {
    let (manager, executor, id) = connect(5).await;
    let thread = run(&executor, &id, "tab-1", "SELECT CONNECTION_ID()")
        .await
        .unwrap();
    let thread_id: u64 = scalar(&thread).parse().unwrap();
    assert!(
        manager.is_own_thread(&id, thread_id),
        "the admin panel would offer to kill a tab's session"
    );

    let session = manager.session_pool(&id, "tab-1").unwrap();
    manager.disconnect(&id).await.unwrap();
    assert!(
        session.is_closed(),
        "a tab's session outlived its connection"
    );
}
