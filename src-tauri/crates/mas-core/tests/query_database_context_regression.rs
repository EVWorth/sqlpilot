use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use std::sync::Arc;

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
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

#[tokio::test]
async fn test_execute_select_with_explicit_database_context() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, username FROM users ORDER BY id LIMIT 1",
            Some("test_db".to_string()),
            None,
        )
        .await
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].columns.len(), 2);
    assert_eq!(results[0].rows.len(), 1);

    manager.disconnect(&info.id).await.unwrap();
}
