use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::error::CoreError;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use std::sync::Arc;
use std::time::Instant;

/// The per-connection query timeout, end to end.
///
/// `query_timeout_secs` was on the profile, in the migration, and in the
/// connection dialog long before anything read it — the column was cosmetic
/// and a `SELECT SLEEP(600)` ran to completion (#283). It was wired up in
/// #512; nothing tested it, which is what let it go unnoticed the first time.
fn profile(query_timeout_secs: Option<u32>) -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "timeout".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB, where a timed-out statement used to cost its connection
        // for good (#658).
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
        // Two, because cancelling needs a connection of its own: the one
        // running the statement is busy.
        pool_max: 2,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_statement_past_the_timeout_is_stopped_and_says_so() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(2))).await.unwrap();

    let started = Instant::now();
    let err = executor
        .execute(&info.id, "SELECT SLEEP(30)", None, None, None)
        .await
        .expect_err("a statement past its timeout is not a result");

    let elapsed = started.elapsed();
    assert!(
        matches!(err.root(), CoreError::Timeout(_)),
        "the error has to say it was a timeout, or the UI cannot tell it from \
         a server error the user should act on: {err:?}"
    );
    assert!(
        err.to_string().contains('2'),
        "the message names the limit that was hit: {err}"
    );
    assert!(
        elapsed.as_secs() < 10,
        "stopped at the timeout, not when the statement finished: took {elapsed:?}"
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn the_statement_is_killed_on_the_server_rather_than_abandoned() {
    // Dropping the stream on this side leaves the server running the query —
    // holding locks and a connection — for as long as it takes.
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(2))).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();

    let _ = executor
        .execute(&info.id, "SELECT SLEEP(30)", None, None, None)
        .await;

    // A killed statement leaves the thread list clean. Checked after a beat,
    // since the server tears the thread down asynchronously.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let sleeping: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sleeping, 0, "the statement was left running on the server");

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_statement_inside_the_timeout_is_untouched() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(10))).await.unwrap();

    let results = executor
        .execute(&info.id, "SELECT SLEEP(1)", None, None, None)
        .await
        .expect("a statement that finishes in time is a result");

    assert_eq!(results.len(), 1);
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn the_timeout_bounds_the_batch_rather_than_the_gap_between_rows() {
    // Three statements of a second each, against a two-second limit: a
    // per-statement timeout would let this through, and the point of the
    // setting is to bound how long the app can be stuck.
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(2))).await.unwrap();

    let err = executor
        .execute(
            &info.id,
            "SELECT SLEEP(1); SELECT SLEEP(1); SELECT SLEEP(1); SELECT SLEEP(1)",
            None,
            None,
            None,
        )
        .await
        .expect_err("four seconds of work against a two-second limit");

    assert!(matches!(err.root(), CoreError::Timeout(_)), "got {err:?}");
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn no_timeout_means_no_timeout() {
    // The column is optional, and a profile without one should not acquire a
    // limit from somewhere.
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(None)).await.unwrap();

    let results = executor
        .execute(&info.id, "SELECT SLEEP(3)", None, None, None)
        .await
        .expect("no configured timeout, so nothing to exceed");

    assert_eq!(results.len(), 1);
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_timed_out_statement_gives_its_connection_back() {
    // The timeout used to abandon the stream and then kill the statement,
    // which left sqlx draining a connection that, on MariaDB, never finished.
    // A few connections and ten timeouts: if each one lost a connection the
    // pool would be empty within the first few, and the later attempts would
    // take as long as the statement rather than as long as the timeout (#658).
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(1))).await.unwrap();

    for attempt in 1..=10 {
        let started = Instant::now();
        let err = executor
            .execute(&info.id, "SELECT SLEEP(5)", None, None, None)
            .await
            .expect_err("a 5s sleep under a 1s timeout is not a result");

        assert!(
            matches!(err.root(), CoreError::Timeout(_)),
            "attempt {attempt}: {err:?}"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "attempt {attempt} took {:?} — it waited for the statement, not the timeout, \
             so an earlier attempt kept its connection",
            started.elapsed()
        );
    }

    // And the pool is still usable afterwards.
    let results = executor
        .execute(&info.id, "SELECT 1", None, None, None)
        .await
        .expect("the connection should still work");
    assert_eq!(results.len(), 1);

    // Disconnect waits for every connection to come back, so it hangs for
    // ever if one never does. Bounded here rather than trusted.
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        manager.disconnect(&info.id),
    )
    .await
    .expect("disconnect should not hang after a timeout")
    .unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_script_that_times_out_keeps_what_ran_before_it() {
    // A timeout used to come back without a statement index, so the results
    // of the statements that had already finished were thrown away (#917).
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(1))).await.unwrap();

    let err = executor
        .execute(
            &info.id,
            "SELECT 'first' AS label; SELECT SLEEP(5); SELECT 'never'",
            None,
            None,
            None,
        )
        .await
        .expect_err("the second statement runs past the timeout");

    assert!(matches!(err.root(), CoreError::Timeout(_)), "got {err:?}");
    let reported = mas_core::QueryError::from_core(&err);
    assert_eq!(reported.statement_index, Some(1), "the second statement");
    assert!(
        reported.message.contains("timeout"),
        "still says it timed out: {}",
        reported.message
    );
    let completed = reported
        .completed_results
        .expect("the first statement's result is kept");
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].statement_index, 0);
    assert_eq!(
        completed[0].rows,
        vec![vec![mas_core::models::SqlValue::String("first".into())]]
    );
    assert_eq!(reported.transaction, None, "not an editor session");

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_timeout_on_a_session_reports_the_open_transaction() {
    // KILL QUERY stops the statement, not the transaction around it.
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&profile(Some(1))).await.unwrap();
    let tab = "tab-timeout-transaction";

    let started = Instant::now();
    let err = executor
        .execute_in_session(
            tab,
            info.id.clone(),
            "BEGIN; SELECT SLEEP(5)".to_string(),
            None,
            None,
            None,
        )
        .await
        .expect_err("the sleep runs past the timeout");

    assert!(matches!(err.root(), CoreError::Timeout(_)), "got {err:?}");
    let reported = mas_core::QueryError::from_core(&err);
    assert_eq!(reported.statement_index, Some(1));
    assert_eq!(
        reported.transaction,
        Some(mas_core::query::TransactionState::Open)
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(4),
        "the probe did not hold the error back: took {:?}",
        started.elapsed()
    );

    manager.close_session(&info.id, tab).await;
    manager.disconnect(&info.id).await.unwrap();
}
