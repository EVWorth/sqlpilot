use chrono::Utc;
use mas_core::connection::{ConnectionManager, Route};
use mas_core::models::{ConnectionProfile, SqlValue};
use mas_core::query::{explain_in, CancelScope, ExplainFormat, QueryExecutor, TransactionState};
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
    // Several shared connections, so a statement that drifted onto another
    // one would be likely to miss what the previous run left behind.
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
    let (manager, executor, id) = connect(5).await;
    run(&executor, &id, "tab-1", "SELECT 1").await.unwrap();

    let shared = manager.get_pool(&id).unwrap();
    let mut held = Vec::new();
    for _ in 0..shared.options().get_max_connections() {
        held.push(shared.acquire().await.unwrap());
    }

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

    executor
        .cancel(&id, CancelScope::Session("tab-1".to_string()))
        .await
        .expect("cancel is issued");
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

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn cancelling_one_tab_leaves_another_tab_running() {
    // Tabs run concurrently on the same connection. Cancelling tab 1 used to
    // KILL QUERY every thread on the connection, so tab 2's statement came
    // back "Query execution was interrupted" too.
    let (_manager, executor, id) = connect(5).await;
    let spawn = |tab: &'static str, sql: &'static str| {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move { run(&executor, &id, tab, sql).await })
    };
    let first = spawn("tab-1", "SELECT SLEEP(20)");
    let second = spawn("tab-2", "SELECT SLEEP(2)");
    tokio::time::sleep(Duration::from_millis(700)).await;

    executor
        .cancel(&id, CancelScope::Session("tab-1".to_string()))
        .await
        .expect("cancel is issued");
    tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("tab 1 stopped when cancelled")
        .unwrap()
        .ok();

    let results = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .expect("tab 2 finishes on its own")
        .unwrap()
        .expect("tab 2 was not interrupted");
    assert_eq!(scalar(&results), "0", "SLEEP ran to completion");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_session_less_cancel_leaves_a_tab_running() {
    // Cancelling a run on the shared pool (a designer ALTER, a grid refresh)
    // sends no session. That used to KILL QUERY every thread on the
    // connection, so a tab's statement came back interrupted too.
    let (_manager, executor, id) = connect(5).await;
    let tab = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move { run(&executor, &id, "tab-1", "SELECT SLEEP(2)").await })
    };
    let shared = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute(
                    &id,
                    "SELECT SLEEP(20)",
                    Some("test_db".to_string()),
                    None,
                    None,
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(700)).await;

    executor
        .cancel(&id, CancelScope::Interactive)
        .await
        .expect("cancel is issued");
    tokio::time::timeout(Duration::from_secs(5), shared)
        .await
        .expect("the shared pool's statement stopped when cancelled")
        .unwrap()
        .ok();

    let results = tokio::time::timeout(Duration::from_secs(5), tab)
        .await
        .expect("the tab finishes on its own")
        .unwrap()
        .expect("the tab was not interrupted");
    assert_eq!(scalar(&results), "0", "SLEEP ran to completion");
}

// ====== TRANSACTION STATE (#843) ======
//
// The frontend guessed whether a tab's session was inside a transaction from
// the SQL it sent. A run on a session now reports what the server says, on its
// last result.

/// The transaction state the last result of `sql` reports.
async fn transaction_after(
    executor: &QueryExecutor,
    id: &str,
    tab: &str,
    sql: &str,
) -> Option<TransactionState> {
    let results = run(executor, id, tab, sql).await.expect("runs");
    results.last().expect("a result").transaction
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_run_on_a_session_reports_its_transaction_state() {
    let (manager, executor, id) = connect(5).await;
    let tab = "tab-transaction-state";

    assert_eq!(
        transaction_after(&executor, &id, tab, "SELECT 1").await,
        Some(TransactionState::None),
    );
    assert_eq!(
        transaction_after(&executor, &id, tab, "BEGIN").await,
        Some(TransactionState::Open),
        "BEGIN leaves a transaction open"
    );
    assert_eq!(
        transaction_after(&executor, &id, tab, "SELECT 1").await,
        Some(TransactionState::Open),
        "still open on the next run"
    );
    assert_eq!(
        transaction_after(&executor, &id, tab, "COMMIT").await,
        Some(TransactionState::None),
        "COMMIT ends it"
    );

    manager.close_session(&id, tab).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn only_the_last_result_of_a_run_reports_the_transaction_state() {
    let (manager, executor, id) = connect(5).await;
    let tab = "tab-transaction-last";

    let results = run(&executor, &id, tab, "SELECT 1; START TRANSACTION; SELECT 2")
        .await
        .expect("runs");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0].transaction, None);
    assert_eq!(results[1].transaction, None);
    assert_eq!(results[2].transaction, Some(TransactionState::Open));

    let results = run(&executor, &id, tab, "ROLLBACK")
        .await
        .expect("rolls back");
    assert_eq!(results[0].transaction, Some(TransactionState::None));

    manager.close_session(&id, tab).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn the_transaction_state_follows_what_the_sql_cannot_show() {
    // The cases inferring from the statements gets wrong: autocommit off
    // opens a transaction on the next write, and DDL commits implicitly.
    let (manager, executor, id) = connect(5).await;
    let tab = "tab-transaction-implicit";
    fresh_table(&executor, &id, "tx_state_probe").await;

    assert_eq!(
        transaction_after(
            &executor,
            &id,
            tab,
            "SET autocommit = 0; INSERT INTO tx_state_probe VALUES (1)"
        )
        .await,
        Some(TransactionState::Open),
        "a write with autocommit off opens a transaction"
    );
    assert_eq!(
        transaction_after(
            &executor,
            &id,
            tab,
            "CREATE TABLE IF NOT EXISTS tx_state_probe_2 (a INT)"
        )
        .await,
        Some(TransactionState::None),
        "DDL commits implicitly"
    );

    manager.close_session(&id, tab).await;
    executor
        .execute(
            &id,
            "DROP TABLE IF EXISTS tx_state_probe, tx_state_probe_2",
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
        .expect("cleans up");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_run_off_a_session_reports_no_transaction_state() {
    let (_manager, executor, id) = connect(5).await;

    let results = executor
        .execute(
            &id,
            "BEGIN; SELECT 1",
            Some("test_db".to_string()),
            None,
            None,
        )
        .await
        .expect("runs");
    assert!(
        results.iter().all(|r| r.transaction.is_none()),
        "the shared pool keeps no session to report on"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_failed_run_on_a_session_keeps_what_ran_before_it() {
    let (manager, executor, id) = connect(5).await;
    let tab = "tab-failed-completed";

    let err = run(
        &executor,
        &id,
        tab,
        "SELECT 41 + 1; SELECT * FROM definitely_not_a_table",
    )
    .await
    .expect_err("the second statement fails");

    let reported = mas_core::QueryError::from_core(&err);
    assert_eq!(reported.statement_index, Some(1));
    let completed = reported
        .completed_results
        .expect("the first result is kept");
    assert_eq!(completed.len(), 1);
    assert_eq!(scalar(&completed), "42");

    manager.close_session(&id, tab).await;
}
