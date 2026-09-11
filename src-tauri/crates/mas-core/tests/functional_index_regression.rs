use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;

/// A functional index leaves INFORMATION_SCHEMA.STATISTICS.COLUMN_NAME NULL,
/// which used to be decoded as `String` and panic — taking down the whole
/// index read for the table, not just that one row.
///
/// EXPRESSION is not read instead: MariaDB has no such column and errors on
/// the query, so the portable answer is an index with no columns.
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

#[tokio::test]
#[ignore = "needs a live MySQL 8 server: make test-integration"]
async fn get_indexes_survives_a_functional_index() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let pool = manager.get_pool(&info.id).unwrap();
    sqlx::query("DROP TABLE IF EXISTS test_db.fn_index_probe")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE test_db.fn_index_probe (
             id INT PRIMARY KEY,
             a VARCHAR(20),
             UNIQUE KEY uq_lower_a ((LOWER(a)))
         )",
    )
    .execute(&pool)
    .await
    .unwrap();

    let indexes = inspector
        .get_indexes(&info.id, "test_db", "fn_index_probe")
        .await
        .expect("a functional index must not fail the index read");

    let functional = indexes
        .iter()
        .find(|i| i.name == "uq_lower_a")
        .expect("the functional index is still listed");
    assert!(
        functional.columns.is_empty(),
        "it indexes an expression, not a column"
    );

    let primary = indexes.iter().find(|i| i.name == "PRIMARY").unwrap();
    assert_eq!(primary.columns, vec!["id"]);

    sqlx::query("DROP TABLE test_db.fn_index_probe")
        .execute(&pool)
        .await
        .unwrap();
}
