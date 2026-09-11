use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;

/// Events, foreign keys and partitions, against a live server.
///
/// FR-4.1.1 lists events alongside the other object types and there was no
/// query for them at all (#291); FR-4.2.1 asks for foreign keys and partitions
/// in the details panel, and partitions had nothing behind them (#292).
///
/// Written against both servers because `information_schema` is where MySQL
/// and MariaDB diverge most often — see the flavour splits already in the
/// admin queries.
fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "schema-objects".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        port: 13306,
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 2,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

const DB: &str = "schema_objects_probe";

async fn run(pool: &sqlx::MySqlPool, statements: &[String]) {
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

async fn setup(pool: &sqlx::MySqlPool) {
    run(
        pool,
        &[
            format!("DROP DATABASE IF EXISTS `{DB}`"),
            format!("CREATE DATABASE `{DB}`"),
            format!("CREATE TABLE `{DB}`.`parent` (a INT, b INT, PRIMARY KEY (a, b))"),
            format!(
                "CREATE TABLE `{DB}`.`child` (
                    x INT, y INT,
                    CONSTRAINT fk_two FOREIGN KEY (x, y)
                        REFERENCES `{DB}`.`parent` (a, b)
                        ON DELETE CASCADE ON UPDATE SET NULL
                 )"
            ),
            format!("CREATE TABLE `{DB}`.`plain` (id INT PRIMARY KEY)"),
            format!(
                "CREATE TABLE `{DB}`.`by_range` (id INT, created_year INT, PRIMARY KEY (id, created_year))
                 PARTITION BY RANGE (created_year) (
                    PARTITION p_old VALUES LESS THAN (2020),
                    PARTITION p_new VALUES LESS THAN MAXVALUE
                 )"
            ),
            format!(
                "CREATE EVENT `{DB}`.`nightly` ON SCHEDULE EVERY 1 DAY
                 COMMENT 'tidies up' DO SELECT 1"
            ),
            format!(
                "CREATE EVENT `{DB}`.`once` ON SCHEDULE AT '2099-01-01 00:00:00'
                 DISABLE DO SELECT 1"
            ),
        ],
    )
    .await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn reads_events() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let events = inspector.get_events(&info.id, DB).await.unwrap();

    assert_eq!(events.len(), 2, "two events were created");
    let nightly = events.iter().find(|e| e.name == "nightly").unwrap();
    assert_eq!(nightly.event_type, "RECURRING");
    assert_eq!(nightly.status, "ENABLED");
    assert_eq!(
        nightly.interval, "1 DAY",
        "a recurring event names its period"
    );
    assert_eq!(nightly.comment, "tidies up");
    assert!(
        !nightly.definer.is_empty(),
        "the definer decides what it can do"
    );

    let once = events.iter().find(|e| e.name == "once").unwrap();
    assert_eq!(once.event_type, "ONE TIME");
    assert_eq!(once.status, "DISABLED");
    assert_eq!(
        once.interval, "",
        "a one-shot event has a time, not an interval, and inventing one would be a lie"
    );

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_database_with_no_events_reports_none() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();

    // An empty list, not an error: most databases have no events.
    assert_eq!(
        inspector
            .get_events(&info.id, "test_db")
            .await
            .unwrap()
            .len(),
        0
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn reads_a_composite_foreign_key_in_order() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let keys = inspector
        .get_foreign_keys(&info.id, DB, "child")
        .await
        .unwrap();

    assert_eq!(keys.len(), 1, "one constraint, not one row per column");
    let key = &keys[0];
    assert_eq!(key.name, "fk_two");
    assert_eq!(key.columns, vec!["x", "y"], "in key order");
    assert_eq!(key.referenced_table, "parent");
    assert_eq!(key.referenced_columns, vec!["a", "b"]);
    assert_eq!(key.on_delete, "CASCADE");
    assert_eq!(key.on_update, "SET NULL");

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn reads_partitions() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let partitions = inspector
        .get_partitions(&info.id, DB, "by_range")
        .await
        .unwrap();

    assert_eq!(partitions.len(), 2);
    assert_eq!(partitions[0].name, "p_old", "in declared order");
    assert_eq!(partitions[1].name, "p_new");
    assert!(partitions[0].method.starts_with("RANGE"));
    assert!(
        partitions[0].expression.contains("created_year"),
        "the expression names what it partitions on: {}",
        partitions[0].expression
    );
    assert_eq!(partitions[0].description, "2020");
    assert_eq!(partitions[1].description, "MAXVALUE");

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn an_unpartitioned_table_reports_no_partitions() {
    // information_schema.PARTITIONS has a row for every table either way; the
    // unpartitioned case is one row with a NULL name, which would otherwise
    // show as a partition called "null".
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    assert_eq!(
        inspector
            .get_partitions(&info.id, DB, "plain")
            .await
            .unwrap()
            .len(),
        0
    );

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}
