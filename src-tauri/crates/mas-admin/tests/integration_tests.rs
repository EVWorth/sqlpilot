//! Integration tests for mas-admin against a real MySQL 8 database.
//!
//! Prerequisites:
//!   docker compose -f docker-compose.test.yml up -d mysql-8
//!
//! Tests the destructive `kill_process` command end-to-end:
//! - Happy path: spawn a second connection, kill its PROCESSLIST entry,
//!   verify it's gone.
//! - Error path: kill_process on a bogus ID returns a useful error string.

use chrono::Utc;
use mas_admin::AdminService;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use std::sync::Arc;
use std::time::Duration;

fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Test MySQL 8 (admin)".to_string(),
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
async fn kill_process_terminates_a_real_connection() {
    let manager = Arc::new(ConnectionManager::new());
    let service = AdminService::new(manager.clone());
    let profile = test_profile();
    let killer_info = manager.connect(&profile).await.expect("connect killer");
    let killer_id = killer_info.id.clone();

    // Open a separate raw MySqlConnection (not a pool — pools auto-reconnect
    // and mask the kill). Use CONNECTION_ID to get its thread id, then KILL
    // that id from the killer.
    use sqlx::mysql::MySqlConnection;
    use sqlx::Connection;

    let mut target_conn =
        MySqlConnection::connect("mysql://test_user:test_password@127.0.0.1:13306/test_db")
            .await
            .expect("connect target");

    let target_conn_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut target_conn)
        .await
        .expect("connection_id");
    assert!(
        target_conn_id > 0,
        "target connection_id should be positive"
    );

    // Kill it via the service. Returns Ok on success.
    service
        .kill_process(&killer_id, target_conn_id as i64)
        .await
        .expect("kill_process should succeed");

    // The target's socket is now closed by the server. Any subsequent
    // query on the killed connection should error.
    let probe = sqlx::query("SELECT 1").fetch_one(&mut target_conn).await;
    assert!(
        probe.is_err(),
        "expected target connection to be dead after KILL, got Ok: {probe:?}",
    );

    // Cleanup.
    manager.disconnect(&killer_id).await.ok();
}

#[tokio::test]
async fn kill_process_with_bogus_id_returns_error() {
    let manager = Arc::new(ConnectionManager::new());
    let service = AdminService::new(manager.clone());
    let profile = test_profile();
    let killer_info = manager.connect(&profile).await.expect("connect");
    let conn_id = killer_info.id.clone();

    // Use a PID that's vanishingly unlikely to exist.
    let result = service.kill_process(&conn_id, 999_999_999).await;
    assert!(result.is_err(), "kill_process on bogus ID should error");
    let err = result.unwrap_err();
    // The error should be a non-empty, somewhat descriptive string.
    let msg = err.to_string();
    assert!(!msg.is_empty(), "error message must not be empty: {msg:?}");
    assert!(
        msg.len() > 5,
        "error message too terse to be useful: {msg:?}"
    );

    manager.disconnect(&conn_id).await.ok();
}
