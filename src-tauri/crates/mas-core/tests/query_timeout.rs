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
        port: 13306,
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
        matches!(err, CoreError::Timeout(_)),
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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

    assert!(matches!(err, CoreError::Timeout(_)), "got {err:?}");
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
