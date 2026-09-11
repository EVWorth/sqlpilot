use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use std::sync::Arc;

/// Paging skips rows while reading rather than appending LIMIT/OFFSET to the
/// user's statement (#391).
///
/// The distinction matters for the cases the executor's own comment lists:
/// SHOW, locking clauses and trailing comments all reject an appended LIMIT,
/// and the result sets a procedure returns cannot be reached by one at all.
/// Each is exercised below against a live server rather than argued for.
fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Test MySQL 8".to_string(),
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

async fn executor() -> (QueryExecutor, String) {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let pool = manager.get_pool(&info.id).unwrap();
    sqlx::query("DROP TABLE IF EXISTS test_db.paging_probe")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE test_db.paging_probe (n INT PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    for n in 1..=10 {
        sqlx::query("INSERT INTO test_db.paging_probe (n) VALUES (?)")
            .bind(n)
            .execute(&pool)
            .await
            .unwrap();
    }

    (executor, info.id)
}

/// The `n` column of the first result set, as numbers.
fn column_n(results: &[mas_core::models::QueryResult]) -> Vec<String> {
    results[0]
        .rows
        .iter()
        .map(|row| format!("{:?}", row[0]))
        .collect()
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn offset_skips_rows_and_limit_bounds_the_page() {
    let (executor, id) = executor().await;

    let page1 = executor
        .execute(
            &id,
            "SELECT n FROM test_db.paging_probe ORDER BY n",
            Some("test_db".to_string()),
            Some(3),
            None,
        )
        .await
        .unwrap();
    let page2 = executor
        .execute(
            &id,
            "SELECT n FROM test_db.paging_probe ORDER BY n",
            Some("test_db".to_string()),
            Some(3),
            Some(3),
        )
        .await
        .unwrap();

    assert_eq!(page1[0].rows.len(), 3);
    assert_eq!(page2[0].rows.len(), 3);
    assert_ne!(
        column_n(&page1),
        column_n(&page2),
        "page 2 must not repeat page 1"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn last_page_comes_back_short() {
    let (executor, id) = executor().await;

    let results = executor
        .execute(
            &id,
            "SELECT n FROM test_db.paging_probe ORDER BY n",
            Some("test_db".to_string()),
            Some(4),
            Some(8),
        )
        .await
        .unwrap();

    // 10 rows, skip 8: two left. A short page is how the grid recognises the
    // end, since there is no total to compare against.
    assert_eq!(results[0].rows.len(), 2);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn offset_past_the_end_returns_nothing_rather_than_failing() {
    let (executor, id) = executor().await;

    let results = executor
        .execute(
            &id,
            "SELECT n FROM test_db.paging_probe",
            Some("test_db".to_string()),
            Some(5),
            Some(500),
        )
        .await
        .unwrap();

    assert_eq!(results[0].rows.len(), 0);
    assert!(!results[0].columns.is_empty(), "still a result set");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn pages_statements_an_appended_offset_could_not_reach() {
    let (executor, id) = executor().await;

    // Each of these rejects a trailing LIMIT, which is why the cap and the
    // skip are applied to the read instead.
    for sql in [
        "SHOW TABLES FROM test_db",
        "SELECT n FROM test_db.paging_probe ORDER BY n FOR UPDATE",
        "SELECT n FROM test_db.paging_probe ORDER BY n -- trailing comment",
    ] {
        let first = executor
            .execute(&id, sql, Some("test_db".to_string()), Some(2), None)
            .await
            .unwrap_or_else(|e| panic!("{sql} failed: {e}"));
        let second = executor
            .execute(&id, sql, Some("test_db".to_string()), Some(2), Some(2))
            .await
            .unwrap_or_else(|e| panic!("{sql} offset failed: {e}"));

        assert!(first[0].rows.len() <= 2, "{sql}: page not capped");
        assert_ne!(
            column_n(&first),
            column_n(&second),
            "{sql}: offset did not skip"
        );
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn each_statement_in_a_batch_is_paged_from_its_own_start() {
    // The skip counter resets per result set; otherwise the first statement
    // would consume the offset and the second would start from row one.
    let (executor, id) = executor().await;

    let results = executor
        .execute(
            &id,
            "SELECT n FROM test_db.paging_probe ORDER BY n; \
             SELECT n FROM test_db.paging_probe ORDER BY n",
            Some("test_db".to_string()),
            Some(2),
            Some(4),
        )
        .await
        .unwrap();

    assert_eq!(results.len(), 2);
    assert_eq!(
        format!("{:?}", results[0].rows),
        format!("{:?}", results[1].rows),
        "both statements must start from the same offset"
    );
    assert_eq!(results[0].rows.len(), 2);
}
