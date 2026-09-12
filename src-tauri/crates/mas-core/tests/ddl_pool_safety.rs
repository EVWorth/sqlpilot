use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;

/// DDL reads used to run `USE <database>` and then an unqualified
/// `SHOW CREATE`, as two statements against a pool.
///
/// With `pool_max > 1` the second is not guaranteed to land on the session the
/// first one changed. It then either failed with "no database selected" or
/// returned the object of that name from whichever database that connection
/// happened to be pointing at — silently, and only sometimes (#290). The `USE`
/// error was discarded with `let _ =`, so the cause never surfaced either.
///
/// Two databases hold a table of the same name with different columns, which
/// is what makes a wrong answer visible rather than merely possible.
fn profile(pool_max: u32) -> ConnectionProfile {
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
        // root, because this creates two databases of its own: `test_user`
        // is granted only on `test_db`, which is one database and therefore
        // cannot show the failure this is about.
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

const DB_A: &str = "ddl_pool_a";
const DB_B: &str = "ddl_pool_b";

async fn setup(pool: &sqlx::MySqlPool) {
    for (db, column) in [(DB_A, "only_in_a"), (DB_B, "only_in_b")] {
        for statement in [
            format!("CREATE DATABASE IF NOT EXISTS `{db}`"),
            format!("DROP TABLE IF EXISTS `{db}`.`shared_name`"),
            format!("CREATE TABLE `{db}`.`shared_name` (`{column}` INT)"),
            format!("DROP VIEW IF EXISTS `{db}`.`shared_view`"),
            format!("CREATE VIEW `{db}`.`shared_view` AS SELECT 1 AS `{column}`"),
            format!("DROP PROCEDURE IF EXISTS `{db}`.`shared_proc`"),
            format!("CREATE PROCEDURE `{db}`.`shared_proc`() SELECT '{column}'"),
        ] {
            sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
                .execute(pool)
                .await
                .unwrap();
        }
    }
}

async fn teardown(pool: &sqlx::MySqlPool) {
    for db in [DB_A, DB_B] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS `{db}`"
        )))
        .execute(pool)
        .await
        .unwrap();
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn ddl_names_the_database_it_was_asked_for_at_any_pool_size() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    // Four connections, so the read is very unlikely to land on the session a
    // `USE` would have changed.
    let info = manager.connect(&profile(4)).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    // Enough iterations that a one-in-four race would show.
    for _ in 0..20 {
        let a = inspector
            .get_table_ddl(&info.id, DB_A, "shared_name")
            .await
            .expect("a DDL read must not depend on which connection it lands on");
        assert!(a.contains("only_in_a"), "got B's table for A: {a}");

        let b = inspector
            .get_table_ddl(&info.id, DB_B, "shared_name")
            .await
            .unwrap();
        assert!(b.contains("only_in_b"), "got A's table for B: {b}");
    }

    teardown(&pool).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn views_and_routines_are_qualified_too() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile(4)).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    for _ in 0..10 {
        let view = inspector
            .get_view_ddl(&info.id, DB_B, "shared_view")
            .await
            .unwrap();
        assert!(view.contains("only_in_b"), "wrong database's view: {view}");

        let proc = inspector
            .get_routine_ddl(&info.id, DB_A, "shared_proc", "PROCEDURE")
            .await
            .unwrap();
        assert!(
            proc.contains("only_in_a"),
            "wrong database's routine: {proc}"
        );
    }

    teardown(&pool).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_missing_object_is_an_error_rather_than_an_empty_string() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile(2)).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let err = inspector
        .get_table_ddl(&info.id, DB_A, "no_such_table")
        .await
        .expect_err("a table that does not exist has no DDL");
    assert!(
        err.to_string().to_lowercase().contains("no_such_table"),
        "the error should name what was not found: {err}"
    );

    teardown(&pool).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_database_that_does_not_exist_says_so() {
    // Previously the `USE` failed, its error was discarded, and the
    // `SHOW CREATE` ran against whatever database the session already had —
    // so this either succeeded with the wrong object or failed with a message
    // about the table rather than the database.
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile(2)).await.unwrap();

    let err = inspector
        .get_table_ddl(&info.id, "no_such_database", "users")
        .await
        .expect_err("a database that does not exist has no tables");
    assert!(
        err.to_string().to_lowercase().contains("no_such_database"),
        "the error should name the database: {err}"
    );

    manager.disconnect(&info.id).await.unwrap();
}
