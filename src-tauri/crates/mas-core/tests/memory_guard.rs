use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::{ConnectionProfile, TruncationReason};
use mas_core::query::QueryExecutor;
use std::sync::Arc;

/// The block that turns a tripped memory guard into a partial result.
///
/// Everything around it was covered — `truncation_for` picks the reason,
/// `truncationMessage` renders it, and integration tests confirm the row-limit
/// reason survives a round trip. The block joining them up was not, because
/// provoking the real 512 MB floor means starving the machine of RAM (#540).
/// The floor is injectable now, so a floor above the machine's free memory
/// trips the guard on its first check.
fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Test MySQL 8".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB. Running a suite against both is what found #658.
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
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

/// A statement returning more than the 1000 rows between memory checks, so the
/// guard gets a chance to run at all.
///
/// `@@cte_max_recursion_depth` defaults to 1000, so a recursive CTE cannot
/// reach 5000 without changing a server setting; a self-join over
/// information_schema needs no such permission.
const MANY_ROWS: &str = "SELECT a.ORDINAL_POSITION AS n
     FROM information_schema.COLUMNS a
     CROSS JOIN information_schema.COLUMNS b
     LIMIT 5000";

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_tripped_guard_returns_the_rows_it_has_and_says_why() {
    let manager = Arc::new(ConnectionManager::new());
    // No machine has u64::MAX MB free, so the first check fails.
    let executor = QueryExecutor::with_memory_floor_mb(manager.clone(), u64::MAX);
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(&info.id, MANY_ROWS, Some("test_db".to_string()), None, None)
        .await
        .expect("a memory stop is a partial answer, not an error");

    let result = &results[0];
    assert!(result.rows_truncated, "the result must admit it is partial");
    assert_eq!(
        result.truncation_reason,
        Some(TruncationReason::MemoryGuard),
        "telling the user to lower a row limit that was never binding sends \
         them somewhere that cannot help (#413)"
    );
    assert!(
        !result.rows.is_empty() && result.rows.len() < 5000,
        "some rows, but not all of them: got {}",
        result.rows.len()
    );
    assert!(
        !result.columns.is_empty(),
        "a partial result is still a result set"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_default_floor_does_not_trip_on_a_healthy_machine() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(&info.id, MANY_ROWS, Some("test_db".to_string()), None, None)
        .await
        .unwrap();

    assert_eq!(results[0].rows.len(), 5000);
    assert!(!results[0].rows_truncated);
    assert_eq!(results[0].truncation_reason, None);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_row_limit_is_reported_as_a_row_limit_even_when_memory_is_tight() {
    // Both caps can apply to one fetch. The row limit is the one the user can
    // do something about, and it is the one that stopped the read first.
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::with_memory_floor_mb(manager.clone(), u64::MAX);
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            MANY_ROWS,
            Some("test_db".to_string()),
            Some(10),
            None,
        )
        .await
        .unwrap();

    assert_eq!(results[0].rows.len(), 10);
    assert_eq!(
        results[0].truncation_reason,
        Some(TruncationReason::RowLimit)
    );
}
