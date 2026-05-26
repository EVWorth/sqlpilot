//! Integration tests for mas-core against a real MySQL 8 database.
//!
//! Prerequisites:
//!   docker compose -f docker-compose.test.yml up -d mysql-8
//!   # Wait for health check, then seed:
//!   docker exec -i mas-mysql-8 mysql -u root -ptest_root_password < tests/fixtures/sql/seed.sql

use chrono::Utc;
use mas_core::connection::{self, ConnectionManager, ConnectionStore};
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;

fn setup_keyring() {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let config = db_keystore::DbKeyStoreConfig {
            path: "".into(),
            vfs: Some("memory".into()),
            ..Default::default()
        };
        let store = db_keystore::DbKeyStore::new(config).expect("Failed to init keyring store");
        connection::init_keyring(store);
    });
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
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn root_profile() -> ConnectionProfile {
    let mut p = test_profile();
    p.username = "root".to_string();
    p.password = "test_root_password".to_string();
    p
}

// ====== CONNECTION TESTS ======

#[tokio::test]
async fn test_connect_mysql8() {
    let manager = ConnectionManager::new();
    let profile = test_profile();
    let info = manager.connect(&profile).await.unwrap();
    assert!(info.server_version.contains("8."));
    assert!(!info.id.is_empty());
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_connect_invalid_credentials() {
    let manager = ConnectionManager::new();
    let mut profile = test_profile();
    profile.password = "wrong_password".to_string();
    let result = manager.connect(&profile).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_connect_invalid_host() {
    let manager = ConnectionManager::new();
    let mut profile = test_profile();
    profile.host = "nonexistent.invalid".to_string();
    let result = manager.connect(&profile).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_test_connection_success() {
    let profile = test_profile();
    let result = ConnectionManager::test_connection(&profile).await.unwrap();
    assert!(result.success);
    assert!(result.server_version.is_some());
    assert!(result.latency_ms > 0);
}

#[tokio::test]
async fn test_test_connection_failure() {
    let mut profile = test_profile();
    profile.password = "wrong".to_string();
    let result = ConnectionManager::test_connection(&profile).await.unwrap();
    assert!(!result.success);
    let msg_lower = result.message.to_lowercase();
    assert!(
        msg_lower.contains("fail")
            || msg_lower.contains("denied")
            || msg_lower.contains("access")
            || msg_lower.contains("error"),
        "Expected failure message, got: {}",
        result.message
    );
}

#[tokio::test]
async fn test_disconnect_cleanup() {
    let manager = ConnectionManager::new();
    let profile = test_profile();
    let info = manager.connect(&profile).await.unwrap();
    assert_eq!(manager.list_connections().len(), 1);
    manager.disconnect(&info.id).await.unwrap();
    assert_eq!(manager.list_connections().len(), 0);
}

#[tokio::test]
async fn test_disconnect_nonexistent() {
    let manager = ConnectionManager::new();
    let result = manager.disconnect("nonexistent").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_concurrent_connections() {
    let manager = ConnectionManager::new();
    let profile1 = test_profile();
    let mut profile2 = test_profile();
    profile2.name = "Second connection".to_string();

    let info1 = manager.connect(&profile1).await.unwrap();
    let info2 = manager.connect(&profile2).await.unwrap();
    assert_eq!(manager.list_connections().len(), 2);
    assert_ne!(info1.id, info2.id);

    manager.disconnect(&info1.id).await.unwrap();
    manager.disconnect(&info2.id).await.unwrap();
}

// ====== CONNECTION STORE TESTS ======

#[test]
fn test_connection_store_crud() {
    setup_keyring();
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::new(&dir.path().join("test.db")).unwrap();

    let profile = test_profile();
    store.save(&profile).unwrap();

    let profiles = store.list().unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].name, "Test MySQL 8");
    assert_eq!(profiles[0].host, "127.0.0.1");
    assert_eq!(profiles[0].port, 13306);

    let fetched = store.get(&profile.id).unwrap();
    assert_eq!(fetched.id, profile.id);

    store.delete(&profile.id).unwrap();
    let profiles = store.list().unwrap();
    assert_eq!(profiles.len(), 0);
}

#[test]
fn test_connection_store_get_nonexistent() {
    setup_keyring();
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::new(&dir.path().join("test.db")).unwrap();
    let result = store.get("nonexistent");
    assert!(result.is_err());
}

#[test]
fn test_connection_store_update() {
    setup_keyring();
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::new(&dir.path().join("test.db")).unwrap();

    let mut profile = test_profile();
    store.save(&profile).unwrap();

    profile.name = "Updated Name".to_string();
    profile.port = 3307;
    store.save(&profile).unwrap();

    let profiles = store.list().unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].name, "Updated Name");
    assert_eq!(profiles[0].port, 3307);
}

// ====== QUERY TESTS ======

#[tokio::test]
async fn test_execute_select() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(&info.id, "SELECT 1 AS num, 'hello' AS greeting", None, None)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].columns.len(), 2);
    assert_eq!(results[0].columns[0].name, "num");
    assert_eq!(results[0].columns[1].name, "greeting");
    assert_eq!(results[0].rows.len(), 1);

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_execute_select_from_table() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, username, email FROM users ORDER BY id",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(
        results[0].rows.len() >= 5,
        "Expected at least 5 users, got {}",
        results[0].rows.len()
    );
    assert_eq!(results[0].columns.len(), 3);

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_execute_insert_update_delete() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&root_profile()).await.unwrap();

    // Insert
    let results = executor
        .execute(
            &info.id,
            "INSERT INTO categories (name, description) VALUES ('Test Category', 'For testing')",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].rows_affected, 1);

    // Update
    let results = executor
        .execute(
            &info.id,
            "UPDATE categories SET description = 'Updated' WHERE name = 'Test Category'",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results[0].rows_affected, 1);

    // Delete
    let results = executor
        .execute(
            &info.id,
            "DELETE FROM categories WHERE name = 'Test Category'",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results[0].rows_affected, 1);

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_execute_multi_statement() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(&info.id, "SELECT 1; SELECT 2; SELECT 3", None, None)
        .await
        .unwrap();
    assert_eq!(
        results.len(),
        3,
        "Expected 3 result sets for 3 statements, got {}",
        results.len()
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_execute_show_commands() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(&info.id, "SHOW DATABASES", None, None)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(!results[0].rows.is_empty());

    let results = executor
        .execute(&info.id, "SHOW TABLES", None, None)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(!results[0].rows.is_empty());

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_execute_with_error() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let result = executor
        .execute(&info.id, "SELECT * FROM nonexistent_table", None, None)
        .await;
    assert!(result.is_err());

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_execute_ddl() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&root_profile()).await.unwrap();

    // Create table
    let _ = executor
        .execute(&info.id, "DROP TABLE IF EXISTS test_temp", None, None)
        .await;
    let results = executor
        .execute(
            &info.id,
            "CREATE TABLE test_temp (id INT PRIMARY KEY, name VARCHAR(50))",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);

    // Insert and select
    executor
        .execute(
            &info.id,
            "INSERT INTO test_temp VALUES (1, 'test')",
            None,
            None,
        )
        .await
        .unwrap();
    let results = executor
        .execute(&info.id, "SELECT * FROM test_temp", None, None)
        .await
        .unwrap();
    assert_eq!(results[0].rows.len(), 1);

    // Clean up
    executor
        .execute(&info.id, "DROP TABLE test_temp", None, None)
        .await
        .unwrap();

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_null_handling() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT NULL AS null_val, 'not null' AS str_val",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results[0].rows.len(), 1);
    // First value should be null
    let null_val = &results[0].rows[0][0];
    match null_val {
        mas_core::models::SqlValue::Null => {}
        _ => panic!("Expected Null, got {:?}", null_val),
    }

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_data_types() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT * FROM data_types_test WHERE id = 1",
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results[0].rows.len(), 1);
    assert!(
        results[0].columns.len() > 20,
        "Expected many columns, got {}",
        results[0].columns.len()
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_unicode_data() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, content_utf8, content_emoji FROM unicode_test",
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        results[0].rows.len() >= 6,
        "Expected at least 6 unicode rows, got {}",
        results[0].rows.len()
    );

    // Check that unicode content is preserved
    let has_japanese = results[0].rows.iter().any(|row| {
        row.iter().any(|v| match v {
            mas_core::models::SqlValue::String(s) => s.contains("日本語"),
            mas_core::models::SqlValue::Bytes(b) => String::from_utf8_lossy(b).contains("日本語"),
            _ => false,
        })
    });
    assert!(has_japanese, "Japanese unicode data should be preserved");

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_json_data() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT metadata FROM products WHERE metadata IS NOT NULL LIMIT 1",
            None,
            None,
        )
        .await
        .unwrap();
    assert!(!results[0].rows.is_empty());
    let val = &results[0].rows[0][0];
    match val {
        mas_core::models::SqlValue::String(s) => {
            assert!(
                s.contains("{"),
                "JSON data should be returned as string containing '{{', got: {}",
                s
            );
        }
        _ => panic!("Expected string for JSON column, got {:?}", val),
    }

    manager.disconnect(&info.id).await.unwrap();
}

// ====== SCHEMA TESTS ======

#[tokio::test]
async fn test_list_databases() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let dbs = inspector.get_databases(&info.id).await.unwrap();
    let db_names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
    assert!(
        db_names.contains(&"test_db"),
        "Should contain test_db, got: {:?}",
        db_names
    );
    assert!(
        db_names.contains(&"test_db_empty"),
        "Should contain test_db_empty, got: {:?}",
        db_names
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_list_tables() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let tables = inspector.get_tables(&info.id, "test_db").await.unwrap();
    let table_names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(
        table_names.contains(&"users"),
        "Should contain users table, got: {:?}",
        table_names
    );
    assert!(
        table_names.contains(&"orders"),
        "Should contain orders table, got: {:?}",
        table_names
    );
    assert!(
        table_names.contains(&"products"),
        "Should contain products table, got: {:?}",
        table_names
    );
    assert!(
        table_names.contains(&"categories"),
        "Should contain categories table, got: {:?}",
        table_names
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_list_views() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let tables = inspector.get_tables(&info.id, "test_db").await.unwrap();
    let views: Vec<&str> = tables
        .iter()
        .filter(|t| t.table_type == "VIEW")
        .map(|t| t.name.as_str())
        .collect();
    assert!(
        views.contains(&"active_users"),
        "Should contain active_users view, got: {:?}",
        views
    );
    assert!(
        views.contains(&"order_summary"),
        "Should contain order_summary view, got: {:?}",
        views
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_list_columns() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let columns = inspector
        .get_columns(&info.id, "test_db", "users")
        .await
        .unwrap();
    assert!(
        columns.len() >= 10,
        "Expected at least 10 columns, got {}",
        columns.len()
    );

    let id_col = columns
        .iter()
        .find(|c| c.name == "id")
        .expect("Should have id column");
    assert!(id_col.is_primary_key, "id should be primary key");
    assert_eq!(id_col.data_type, "bigint");

    let email_col = columns
        .iter()
        .find(|c| c.name == "email")
        .expect("Should have email column");
    assert!(!email_col.nullable, "email should not be nullable");

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_list_indexes() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let indexes = inspector
        .get_indexes(&info.id, "test_db", "users")
        .await
        .unwrap();
    assert!(!indexes.is_empty(), "Should have at least one index");

    let pk = indexes
        .iter()
        .find(|i| i.name == "PRIMARY")
        .expect("Should have PRIMARY index");
    assert!(pk.is_unique);
    assert!(pk.columns.contains(&"id".to_string()));

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_get_table_ddl() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let ddl = inspector
        .get_table_ddl(&info.id, "test_db", "users")
        .await
        .unwrap();
    assert!(
        ddl.contains("CREATE TABLE"),
        "DDL should contain CREATE TABLE, got: {}",
        &ddl[..100.min(ddl.len())]
    );
    assert!(ddl.contains("username"), "DDL should contain username");
    assert!(ddl.contains("email"), "DDL should contain email");

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_schema_empty_database() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let tables = inspector
        .get_tables(&info.id, "test_db_empty")
        .await
        .unwrap();
    assert_eq!(tables.len(), 0, "Empty database should have no tables");

    manager.disconnect(&info.id).await.unwrap();
}

// ====== EXPORT TESTS ======

#[tokio::test]
async fn test_export_csv() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, username, email FROM users LIMIT 3",
            None,
            None,
        )
        .await
        .unwrap();
    let csv = mas_export::export_csv(&results[0]);

    assert!(
        csv.starts_with("id,username,email\n"),
        "CSV should start with header, got: {}",
        &csv[..50.min(csv.len())]
    );
    let lines: Vec<&str> = csv.trim().lines().collect();
    assert_eq!(
        lines.len(),
        4,
        "Expected header + 3 data rows, got {} lines",
        lines.len()
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_export_json() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, username FROM users LIMIT 2",
            None,
            None,
        )
        .await
        .unwrap();
    let json = mas_export::export_json(&results[0]);

    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(parsed.is_array());
    assert_eq!(parsed.as_array().unwrap().len(), 2);

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_export_sql_insert() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, username FROM users LIMIT 1",
            None,
            None,
        )
        .await
        .unwrap();
    let sql = mas_export::export_sql_insert(&results[0], "users");

    assert!(
        sql.contains("INSERT INTO `users`"),
        "SQL should contain INSERT INTO `users`, got: {}",
        sql
    );
    assert!(sql.contains("`id`"), "SQL should contain `id` column");
    assert!(
        sql.contains("`username`"),
        "SQL should contain `username` column"
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_export_markdown() {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    let results = executor
        .execute(
            &info.id,
            "SELECT id, username FROM users LIMIT 2",
            None,
            None,
        )
        .await
        .unwrap();
    let md = mas_export::export_markdown(&results[0]);

    assert!(
        md.contains("| id | username |"),
        "Markdown should contain header, got: {}",
        md
    );
    assert!(
        md.contains("| --- | --- |"),
        "Markdown should contain separator"
    );

    manager.disconnect(&info.id).await.unwrap();
}

// ====== ADMIN TESTS ======

#[tokio::test]
async fn test_get_process_list() {
    let manager = Arc::new(ConnectionManager::new());
    let admin = mas_admin::AdminService::new(manager.clone());
    let info = manager.connect(&root_profile()).await.unwrap();

    let processes = admin.get_process_list(&info.id).await.unwrap();
    assert!(!processes.is_empty(), "Should have at least one process");
    assert!(
        processes.iter().any(|p| p.user.contains("root")),
        "Should see root user process"
    );

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
async fn test_get_server_variables() {
    let manager = Arc::new(ConnectionManager::new());
    let admin = mas_admin::AdminService::new(manager.clone());
    let info = manager.connect(&root_profile()).await.unwrap();

    let vars = admin.get_server_variables(&info.id).await.unwrap();
    assert!(!vars.is_empty(), "Should have server variables");
    assert!(
        vars.iter().any(|v| v.name == "version"),
        "Should have version variable"
    );

    manager.disconnect(&info.id).await.unwrap();
}
