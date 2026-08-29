//! EXPLAIN, timeout and cancellation against a real MySQL 8 server.
//!
//! Prerequisites:
//!   make db-up
//!
//! These cover the parts of #412/#418/#420 that unit tests cannot: whether the
//! server actually accepts the statement we build, and whether a timeout really
//! stops the query rather than just abandoning the client future.

use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::{explain, AnalyzeRefusal, QueryExecutor};
use std::sync::Arc;
use std::time::Instant;

/// Read a single scalar as an integer.
///
/// COUNT(*) is a BIGINT, and BIGINT is carried as text so JS cannot truncate it
/// (#502/#510) — so this must not assume a numeric variant.
fn scalar_int(result: &mas_core::models::QueryResult) -> i64 {
    match &result.rows[0][0] {
        mas_core::models::SqlValue::Int(v) => *v,
        mas_core::models::SqlValue::UInt(v) => *v as i64,
        mas_core::models::SqlValue::String(v) => v.parse().expect("numeric scalar"),
        other => panic!("expected a number, got {other:?}"),
    }
}

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

/// #418 — the editor sends the trailing `;` along, and `EXPLAIN ANALYZE x;;` is
/// a syntax error. Ask the server, rather than trusting the string.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn analyzes_a_statement_that_still_has_its_semicolon() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "SELECT id, username FROM users LIMIT 1;".to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .expect("EXPLAIN ANALYZE with a trailing semicolon should succeed");

    assert!(response.analyzed, "should have analyzed a plain SELECT");
    assert!(response.refusal.is_none());
    assert!(!response.result.rows.is_empty());

    manager.disconnect(&info.id).await.unwrap();
}

/// #418 — a script of several statements gets one clear message instead of a
/// raw ERROR 1064 from the server.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn refuses_a_multi_statement_script() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let err = explain(
        &manager,
        &executor,
        info.id.clone(),
        "SELECT 1; SELECT 2;".to_string(),
        Some("test_db".to_string()),
        false,
    )
    .await
    .expect_err("multi-statement EXPLAIN should be refused");

    assert!(err.to_string().contains("single statement"), "{err}");

    manager.disconnect(&info.id).await.unwrap();
}

/// #412 — the headline case. `EXPLAIN ANALYZE DELETE ...` must not delete.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn planning_a_delete_does_not_delete() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    // A real table, not TEMPORARY: each execute() may land on a different
    // pooled connection, and a temporary table would not be visible from the
    // next one.
    executor
        .execute(
            &info.id,
            "DROP TABLE IF EXISTS explain_canary",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    executor
        .execute(
            &info.id,
            "CREATE TABLE explain_canary (id INT)",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    executor
        .execute(
            &info.id,
            "INSERT INTO explain_canary VALUES (1), (2), (3)",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "DELETE FROM explain_canary WHERE 1=1".to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .expect("should fall back to a plain EXPLAIN rather than erroring");

    assert!(!response.analyzed, "must not have run the DELETE");
    assert_eq!(response.refusal, Some(AnalyzeRefusal::WouldMutate));

    let after = executor
        .execute(
            &info.id,
            "SELECT COUNT(*) FROM explain_canary",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    assert_eq!(scalar_int(&after[0]), 3, "the rows should still be there");

    executor
        .execute(
            &info.id,
            "DROP TABLE explain_canary",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    manager.disconnect(&info.id).await.unwrap();
}

/// #412 again — a write hidden behind a CTE.
///
/// `WITH ... DELETE` is valid MySQL 8 and really deletes. Reading only the
/// leading keyword called it a WITH and let ANALYZE execute it, which is the
/// same failure #412 describes wearing a different hat.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn planning_a_cte_prefixed_delete_does_not_delete() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    for stmt in [
        "DROP TABLE IF EXISTS cte_canary",
        "CREATE TABLE cte_canary (id INT)",
        "INSERT INTO cte_canary VALUES (1), (2), (3)",
    ] {
        executor
            .execute(&info.id, stmt, Some("test_db".to_string()), None)
            .await
            .unwrap();
    }

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "WITH doomed AS (SELECT id FROM cte_canary) DELETE FROM cte_canary WHERE id IN (SELECT id FROM doomed)"
            .to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .expect("should downgrade to a plain EXPLAIN");

    assert!(!response.analyzed, "must not have run the DELETE");
    assert_eq!(response.refusal, Some(AnalyzeRefusal::WouldMutate));

    let after = executor
        .execute(
            &info.id,
            "SELECT COUNT(*) FROM cte_canary",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    assert_eq!(scalar_int(&after[0]), 3, "the rows should still be there");

    executor
        .execute(
            &info.id,
            "DROP TABLE cte_canary",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    manager.disconnect(&info.id).await.unwrap();
}

/// A read behind a CTE is still worth analyzing — the fix must not overshoot.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_cte_prefixed_read_is_still_analyzed() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "WITH recent AS (SELECT id FROM users) SELECT * FROM recent".to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .unwrap();

    assert!(
        response.analyzed,
        "a CTE-prefixed SELECT is safe to analyze"
    );
    assert!(response.refusal.is_none());

    manager.disconnect(&info.id).await.unwrap();
}

/// #412 — a read-only profile refuses ANALYZE even for a harmless SELECT,
/// because ANALYZE executes.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_read_only_profile_refuses_to_analyze() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let mut profile = test_profile();
    profile.read_only = true;
    let info = manager.connect(&profile).await.unwrap();

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "SELECT 1".to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .unwrap();

    assert!(!response.analyzed);
    assert_eq!(response.refusal, Some(AnalyzeRefusal::ReadOnlyConnection));

    manager.disconnect(&info.id).await.unwrap();
}

/// #420 — a query that outlives the profile's timeout returns promptly *and*
/// stops server-side. The second half is what distinguishes a real timeout from
/// dropping the future.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_slow_query_times_out_and_stops_running_on_the_server() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let mut profile = test_profile();
    profile.query_timeout_secs = Some(2);
    let info = manager.connect(&profile).await.unwrap();

    let started = Instant::now();
    let err = executor
        .execute(
            &info.id,
            "SELECT SLEEP(30)",
            Some("test_db".to_string()),
            None,
        )
        .await
        .expect_err("SLEEP(30) under a 2s timeout should fail");
    let elapsed = started.elapsed();

    assert!(
        err.to_string().contains("timeout"),
        "expected a timeout error, got: {err}"
    );
    assert!(
        elapsed.as_secs() < 10,
        "should have given up promptly, took {elapsed:?}"
    );

    // The killed statement must be gone from the server's process list, and the
    // session must still be usable afterwards.
    let processes = executor
        .execute(
            &info.id,
            "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(30)%'",
            None,
            None,
        )
        .await
        .expect("connection should still work after a timeout");
    assert_eq!(
        scalar_int(&processes[0]),
        0,
        "the slow query should no longer be running"
    );

    manager.disconnect(&info.id).await.unwrap();
}

/// #420 — an explicit cancel reaches the server too.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn cancel_stops_a_running_query() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = Arc::new(QueryExecutor::new(manager.clone()));
    let info = manager.connect(&test_profile()).await.unwrap();

    let runner = {
        let executor = Arc::clone(&executor);
        let id = info.id.clone();
        tokio::spawn(async move {
            executor
                .execute(&id, "SELECT SLEEP(30)", Some("test_db".to_string()), None)
                .await
        })
    };

    // Give the statement time to reach the server and register its thread id.
    let started = Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;

    executor.cancel(&info.id).await.expect("cancel should work");
    let result = runner.await.unwrap();

    // MySQL does not fail an interrupted SLEEP — it returns 1 early — so the
    // evidence that KILL QUERY landed is the elapsed time, not an error. The
    // client discards the result either way via the cancel generation.
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_secs() < 10,
        "SLEEP(30) should have been cut short, took {elapsed:?}"
    );
    if let Ok(results) = &result {
        assert!(
            results[0].execution_time_ms < 10_000,
            "statement ran to completion despite the cancel: {}ms",
            results[0].execution_time_ms
        );
    }

    manager.disconnect(&info.id).await.unwrap();
}

/// Cancelling when nothing is running is harmless.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn cancel_is_a_no_op_when_idle() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    executor.cancel(&info.id).await.expect("should not error");

    manager.disconnect(&info.id).await.unwrap();
}

/// A plan for a SELECT still comes back in the tabular shape the table view
/// expects, with no timeout configured.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_plain_explain_returns_a_tabular_plan() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "SELECT * FROM users".to_string(),
        Some("test_db".to_string()),
        false,
    )
    .await
    .unwrap();

    assert!(!response.analyzed);
    assert!(response.tabular, "classic EXPLAIN is multi-column");
    let columns: Vec<String> = response
        .result
        .columns
        .iter()
        .map(|c| c.name.to_lowercase())
        .collect();
    assert!(columns.contains(&"select_type".to_string()), "{columns:?}");

    manager.disconnect(&info.id).await.unwrap();
}

// --- MariaDB (port 13308) -------------------------------------------------
//
// MariaDB spells EXPLAIN ANALYZE as `ANALYZE <stmt>` and answers in the same
// tabular shape as EXPLAIN, with measured r_rows/r_filtered columns alongside
// the estimates — not MySQL's single column of TREE text (#422).

fn mariadb_profile() -> ConnectionProfile {
    ConnectionProfile {
        name: "Test MariaDB 11".to_string(),
        port: 13308,
        ..test_profile()
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn mariadb_analyze_comes_back_tabular_with_measured_columns() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&mariadb_profile()).await.unwrap();
    assert!(
        info.server_version.to_lowercase().contains("mariadb"),
        "expected MariaDB on 13308, got {}",
        info.server_version
    );

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "SELECT * FROM users LIMIT 1".to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .unwrap();

    assert!(response.analyzed);
    assert!(
        response.tabular,
        "MariaDB ANALYZE is tabular, so it must not render as TREE text"
    );

    let columns: Vec<String> = response
        .result
        .columns
        .iter()
        .map(|c| c.name.to_lowercase())
        .collect();
    assert!(columns.contains(&"select_type".to_string()), "{columns:?}");
    // The measured columns are the reason to run ANALYZE at all.
    assert!(columns.contains(&"r_rows".to_string()), "{columns:?}");
    assert!(columns.contains(&"r_filtered".to_string()), "{columns:?}");

    manager.disconnect(&info.id).await.unwrap();
}

/// #412 on MariaDB too — the dialect differs, the refusal must not.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn mariadb_planning_a_delete_does_not_delete() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&mariadb_profile()).await.unwrap();

    let response = explain(
        &manager,
        &executor,
        info.id.clone(),
        "DELETE FROM users WHERE 1=1".to_string(),
        Some("test_db".to_string()),
        true,
    )
    .await
    .unwrap();

    assert!(!response.analyzed);
    assert_eq!(response.refusal, Some(AnalyzeRefusal::WouldMutate));

    let after = executor
        .execute(
            &info.id,
            "SELECT COUNT(*) FROM users",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();
    assert!(scalar_int(&after[0]) > 0, "users should still be there");

    manager.disconnect(&info.id).await.unwrap();
}
