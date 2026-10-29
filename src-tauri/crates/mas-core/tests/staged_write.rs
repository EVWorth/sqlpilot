//! Staging a write, against a live server.
//!
//! The whole approval model rests on one claim: a write can be run, measured,
//! and then undone if the user says no. That claim is about the server, not
//! about this code, and it is not true for every statement — MySQL commits the
//! open transaction before a schema change, which is why `StagedWrite` refuses
//! DDL rather than pretending.
//!
//! Both servers, because "does ROLLBACK put this back" is exactly the sort of
//! thing MySQL and MariaDB answer differently.

use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::staged::{StageError, StagedWrite, DEFAULT_DEADLINE};
use sqlx::Row;
use std::sync::Arc;
use std::time::Duration;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "staged-write".to_string(),
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB.
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        default_database: Some("test_db".to_string()),
        pool_min: 1,
        pool_max: 4,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        ..Default::default()
    }
}

const DB: &str = "staged_write_probe";

async fn setup(pool: &sqlx::MySqlPool) {
    for statement in [
        format!("DROP DATABASE IF EXISTS `{DB}`"),
        format!("CREATE DATABASE `{DB}`"),
        format!(
            "CREATE TABLE `{DB}`.`orders` (id INT PRIMARY KEY, status VARCHAR(20)) ENGINE=InnoDB"
        ),
        format!(
            "INSERT INTO `{DB}`.`orders` VALUES (1,'new'),(2,'new'),(3,'shipped'),(4,'shipped')"
        ),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

async fn count(pool: &sqlx::MySqlPool, status: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) AS n FROM `{DB}`.`orders` WHERE status = ?"
    )))
    .bind(status)
    .fetch_one(pool)
    .await
    .unwrap()
    .get::<i64, _>("n")
}

async fn connect() -> (Arc<ConnectionManager>, String, sqlx::MySqlPool) {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;
    (manager, info.id, pool)
}

async fn finish(manager: Arc<ConnectionManager>, id: String, pool: &sqlx::MySqlPool) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP DATABASE `{DB}`")))
        .execute(pool)
        .await
        .unwrap();
    manager.disconnect(&id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_write_reports_what_it_actually_changed() {
    // The number nobody can work out from the statement, which is the whole
    // reason the user is asked after it runs rather than before.
    let (manager, id, pool) = connect().await;

    let staged = StagedWrite::begin(
        &pool,
        Some(DB),
        "UPDATE orders SET status = 'cancelled' WHERE status = 'new'",
        DEFAULT_DEADLINE,
    )
    .await
    .expect("it stages");

    assert_eq!(staged.rows_affected, 2);
    staged.rollback().await.unwrap();

    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn rolling_back_puts_everything_back() {
    let (manager, id, pool) = connect().await;

    let staged = StagedWrite::begin(&pool, Some(DB), "DELETE FROM orders", DEFAULT_DEADLINE)
        .await
        .unwrap();
    assert_eq!(staged.rows_affected, 4);

    staged.rollback().await.unwrap();

    // The claim the approval model rests on.
    assert_eq!(count(&pool, "new").await, 2);
    assert_eq!(count(&pool, "shipped").await, 2);

    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn committing_keeps_it() {
    let (manager, id, pool) = connect().await;

    let staged = StagedWrite::begin(
        &pool,
        Some(DB),
        "UPDATE orders SET status = 'cancelled' WHERE status = 'new'",
        DEFAULT_DEADLINE,
    )
    .await
    .unwrap();

    assert_eq!(staged.commit().await.unwrap(), 2);
    assert_eq!(count(&pool, "cancelled").await, 2);
    assert_eq!(count(&pool, "new").await, 0);

    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn nothing_is_visible_to_anyone_else_before_it_is_committed() {
    // A staged write that other sessions could already see would not be a
    // question, it would be a fait accompli.
    let (manager, id, pool) = connect().await;

    let staged = StagedWrite::begin(
        &pool,
        Some(DB),
        "UPDATE orders SET status = 'cancelled' WHERE status = 'new'",
        DEFAULT_DEADLINE,
    )
    .await
    .unwrap();

    // A different connection from the same pool: the default isolation level
    // on both servers is REPEATABLE READ, so this sees the old rows.
    assert_eq!(count(&pool, "cancelled").await, 0);

    staged.rollback().await.unwrap();
    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_schema_change_is_refused_rather_than_staged() {
    // The verified reason: ROLLBACK after CREATE TABLE leaves the table,
    // because the server committed before running it. Staging DDL would
    // promise an undo that does not exist.
    let (manager, id, pool) = connect().await;

    let error = StagedWrite::begin(
        &pool,
        Some(DB),
        "ALTER TABLE orders ADD COLUMN note TEXT",
        DEFAULT_DEADLINE,
    )
    .await
    .err()
    .expect("DDL cannot be staged");

    assert!(matches!(error, StageError::CannotBeStaged { .. }));
    assert!(error.to_string().contains("commit"), "{error}");

    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn the_server_really_does_commit_before_ddl() {
    // The premise behind the refusal above, asserted rather than assumed —
    // if a future server version changes this, the refusal should be revisited
    // and this test is where that conversation starts.
    let (manager, id, pool) = connect().await;
    let mut conn = pool.acquire().await.unwrap();

    for statement in [
        format!("USE `{DB}`"),
        "START TRANSACTION".to_string(),
        "INSERT INTO orders VALUES (99, 'new')".to_string(),
        "CREATE TABLE staged_probe (a INT)".to_string(),
        "ROLLBACK".to_string(),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
    drop(conn);

    let survived: i64 = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema = '{DB}' AND table_name = 'staged_probe'"
    )))
    .fetch_one(&pool)
    .await
    .unwrap()
    .get("n");
    assert_eq!(survived, 1, "the CREATE survived the ROLLBACK");

    let row: i64 = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) AS n FROM `{DB}`.`orders` WHERE id = 99"
    )))
    .fetch_one(&pool)
    .await
    .unwrap()
    .get("n");
    assert_eq!(
        row, 1,
        "and so did the INSERT before it, because the CREATE committed it"
    );

    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_statement_that_fails_leaves_nothing_open() {
    // The connection has to go back clean, or the next caller inherits an open
    // transaction on a pooled connection.
    let (manager, id, pool) = connect().await;

    let error = StagedWrite::begin(
        &pool,
        Some(DB),
        "UPDATE orders SET nope = 1",
        DEFAULT_DEADLINE,
    )
    .await
    .err()
    .expect("no such column");
    assert!(matches!(error, StageError::Failed(_)));

    // The pool still works, and nothing was left half-done.
    assert_eq!(count(&pool, "new").await, 2);

    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_deadline_that_has_passed_is_visible_to_the_caller() {
    let (manager, id, pool) = connect().await;

    let staged = StagedWrite::begin(
        &pool,
        Some(DB),
        "DELETE FROM orders WHERE id = 1",
        Duration::from_millis(1),
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        staged.expired(),
        "a staged write nobody answers has a limit"
    );

    staged.rollback().await.unwrap();
    finish(manager, id, &pool).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_staged_write_stops_at_the_connections_query_timeout() {
    // The executor bounds every query by the connection's timeout; a staged
    // write ran without it, so one nobody cancelled held its connection and
    // its locks for as long as it took (#902).
    let manager = Arc::new(ConnectionManager::new());
    let info = manager
        .connect(&ConnectionProfile {
            query_timeout_secs: Some(1),
            ..profile()
        })
        .await
        .unwrap();
    let id = info.id;
    let pool = manager.get_pool(&id).unwrap();
    setup(&pool).await;
    let timeout = manager.get_query_timeout(&id);
    assert_eq!(timeout, Some(Duration::from_secs(1)));

    // Once on its own, once registered for cancel as the agent's staged
    // writes are: the two find the thread to kill differently.
    let executor = mas_core::query::QueryExecutor::new(manager.clone());
    let tracker = executor.tracker();
    let route = mas_core::connection::Route::Agent("timeout".to_string());
    for registered in [false, true] {
        let reach = registered.then(|| mas_core::query::CancelReach {
            tracker: &tracker,
            connection_id: &id,
            route: &route,
        });
        let started = std::time::Instant::now();
        let outcome = StagedWrite::begin_in(
            &pool,
            Some(DB),
            "DELETE FROM orders WHERE SLEEP(5) = 0",
            DEFAULT_DEADLINE,
            reach,
            timeout,
        )
        .await;
        let elapsed = started.elapsed();

        match outcome {
            Err(StageError::Failed(mas_core::error::CoreError::Timeout(message))) => {
                assert!(message.contains("1s timeout"), "{message}");
            }
            Err(other) => panic!("registered={registered}: expected the timeout error, got {other}"),
            Ok(staged) => panic!(
                "registered={registered}: expected the timeout error, got a staged write of {} rows",
                staged.rows_affected
            ),
        }
        assert!(
            elapsed < Duration::from_secs(4),
            "registered={registered}: stopped at its timeout, not after a row's SLEEP(5): {elapsed:?}"
        );

        // Killed on the server, not just abandoned here: nothing of it is
        // still running, and none of it was kept.
        let still_running: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.PROCESSLIST \
             WHERE INFO LIKE 'DELETE FROM orders WHERE SLEEP%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(still_running, 0, "registered={registered}: still running");
        assert_eq!(count(&pool, "new").await, 2);
        assert_eq!(count(&pool, "shipped").await, 2);
    }

    finish(manager, id, &pool).await;
}
