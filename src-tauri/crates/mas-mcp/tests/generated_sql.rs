//! The generated analysis SQL, against a real server.
//!
//! The tool tests assert what these strings say. Only a server can say whether
//! they parse, whether `CAST(MIN(x) AS CHAR)` works on a date as well as on a
//! number, and whether MariaDB spells INFORMATION_SCHEMA the same way MySQL
//! does. Both servers, because that last question has surprised this codebase
//! before.

use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use mas_mcp::analysis::{profile_column_sql, table_stats_sql, top_values_sql};
use std::sync::Arc;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "generated-sql".to_string(),
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
        pool_max: 2,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        ..Default::default()
    }
}

const DB: &str = "generated_sql_probe";

async fn setup(pool: &sqlx::MySqlPool) {
    for statement in [
        format!("DROP DATABASE IF EXISTS `{DB}`"),
        format!("CREATE DATABASE `{DB}`"),
        format!(
            "CREATE TABLE `{DB}`.`orders` (
                id INT PRIMARY KEY,
                status VARCHAR(20),
                total DECIMAL(10,2),
                created_at DATETIME(6)
             )"
        ),
        format!(
            "INSERT INTO `{DB}`.`orders` VALUES
                (1, 'shipped', 10.50, '2024-01-01 10:00:00.123456'),
                (2, 'shipped', 20.00, '2024-06-01 10:00:00'),
                (3, 'pending', NULL,  '2024-12-31 23:59:59'),
                (4, NULL,      30.00, NULL)"
        ),
        // A name that needs quoting, to prove the quoting is real.
        format!("CREATE TABLE `{DB}`.`we``ird` (`a``b` INT)"),
        format!("INSERT INTO `{DB}`.`we``ird` VALUES (1), (2), (2)"),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

struct Live {
    manager: Arc<ConnectionManager>,
    executor: QueryExecutor,
    id: String,
}

impl Live {
    async fn connect() -> Self {
        let manager = Arc::new(ConnectionManager::new());
        let info = manager.connect(&profile()).await.unwrap();
        let pool = manager.get_pool(&info.id).unwrap();
        setup(&pool).await;
        Self {
            executor: QueryExecutor::new(manager.clone()),
            manager,
            id: info.id,
        }
    }

    async fn run(&self, sql: &str) -> mas_core::models::query::QueryResult {
        self.executor
            .execute(&self.id, sql, Some(DB.to_string()), Some(20), None)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
            .into_iter()
            .next()
            .expect("one statement, one result")
    }

    async fn finish(self) {
        let pool = self.manager.get_pool(&self.id).unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP DATABASE `{DB}`")))
            .execute(&pool)
            .await
            .unwrap();
        self.manager.disconnect(&self.id).await.unwrap();
    }
}

fn text(value: &mas_core::models::query::SqlValue) -> String {
    value.to_string()
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn table_stats_parses_and_finds_the_table() {
    let live = Live::connect().await;

    let result = live.run(&table_stats_sql(DB, "orders")).await;

    assert_eq!(result.rows.len(), 1, "the catalogue knows this table");
    let engine = result
        .columns
        .iter()
        .position(|c| c.name == "engine")
        .expect("engine comes back");
    assert_eq!(text(&result.rows[0][engine]), "InnoDB");

    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_table_that_does_not_exist_comes_back_empty_rather_than_failing() {
    // The tool turns this into "there is no such table", which is only
    // possible if the query itself succeeds.
    let live = Live::connect().await;
    assert!(live.run(&table_stats_sql(DB, "nope")).await.rows.is_empty());
    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn profiling_counts_nulls_and_distinct_values() {
    let live = Live::connect().await;

    let result = live.run(&profile_column_sql(DB, "orders", "status")).await;
    let row = &result.rows[0];

    assert_eq!(text(&row[0]), "4", "four rows");
    assert_eq!(text(&row[1]), "3", "three of them have a status");
    assert_eq!(text(&row[2]), "2", "two distinct statuses");
    assert_eq!(text(&row[3]), "pending");
    assert_eq!(text(&row[4]), "shipped");

    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_extremes_of_a_datetime_come_back_as_text_without_losing_precision() {
    // CAST(... AS CHAR) on a DATETIME(6) is the case that would quietly drop
    // sub-second precision if the cast were to something narrower — the same
    // class of loss the backup writer had.
    let live = Live::connect().await;

    let result = live
        .run(&profile_column_sql(DB, "orders", "created_at"))
        .await;
    let row = &result.rows[0];

    assert_eq!(text(&row[3]), "2024-01-01 10:00:00.123456");
    assert_eq!(text(&row[4]), "2024-12-31 23:59:59.000000");

    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_decimal_keeps_its_scale_through_the_cast() {
    // Through f64 this would come back as 10.5, and an agent writing
    // `WHERE total = 10.5` against a DECIMAL(10,2) is a subtly wrong query.
    let live = Live::connect().await;

    let result = live.run(&profile_column_sql(DB, "orders", "total")).await;
    assert_eq!(text(&result.rows[0][3]), "10.50");

    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn top_values_orders_by_frequency_and_skips_nulls() {
    let live = Live::connect().await;

    let result = live.run(&top_values_sql(DB, "orders", "status", 10)).await;

    assert_eq!(result.rows.len(), 2, "NULL is not a value");
    assert_eq!(text(&result.rows[0][0]), "shipped");
    assert_eq!(text(&result.rows[0][1]), "2");

    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn identifiers_that_need_quoting_actually_work() {
    // A backtick in a table or column name is legal, rare, and exactly the
    // case where string building without quoting produces a syntax error at
    // best and something else at worst.
    let live = Live::connect().await;

    let result = live.run(&profile_column_sql(DB, "we`ird", "a`b")).await;
    assert_eq!(text(&result.rows[0][0]), "3");
    assert_eq!(text(&result.rows[0][2]), "2");

    let stats = live.run(&table_stats_sql(DB, "we`ird")).await;
    assert_eq!(stats.rows.len(), 1);

    live.finish().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn an_empty_table_profiles_to_nulls_rather_than_an_error() {
    let live = Live::connect().await;
    let pool = live.manager.get_pool(&live.id).unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE `{DB}`.`empty` (a INT)"
    )))
    .execute(&pool)
    .await
    .unwrap();

    let result = live.run(&profile_column_sql(DB, "empty", "a")).await;
    assert_eq!(text(&result.rows[0][0]), "0");
    assert_eq!(text(&result.rows[0][3]), "NULL", "no rows, no minimum");

    live.finish().await;
}
