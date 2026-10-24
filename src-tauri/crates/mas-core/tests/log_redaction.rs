use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::format::FmtSpan;

/// Nothing the executor logs while running a statement keeps the credentials
/// in it, at any level (#875).
///
/// The unit tests in `executor.rs` cover the spans that open before a
/// connection is reached. These run statements against a live server, so the
/// per-statement lines and the TRACE "full SQL" lines are exercised too, along
/// with connecting, whose profile carries the connection's own password.
fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Test MySQL 8".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs against MariaDB.
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
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

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
#[ignore]
async fn running_a_statement_logs_no_credential() {
    let captured = Captured::default();
    let writer = captured.clone();
    // JSON like the app's file log, at TRACE so the full-SQL lines are on.
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::TRACE)
        .with_span_events(FmtSpan::NEW)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();

    // Both are credential-shaped to the redactor (`password = '...'`) and run
    // on MySQL and MariaDB without touching any account. The first returns
    // rows; the second reports a count, which logs a preview at INFO.
    let results = executor
        .execute(
            &info.id,
            "SELECT password = 'hunter2' AS matched FROM (SELECT 'a' AS password) t; \
             SET @password = 'hunter3'",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 2);
    // The statement that ran, and what it returns, keep the real text.
    assert!(results[0].sql.contains("hunter2"));

    manager.disconnect(&info.id).await.unwrap();

    let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("Full SQL input"), "TRACE lines missing: {log}");
    assert!(
        log.contains("Statement executed"),
        "INFO line missing: {log}"
    );
    for secret in ["hunter2", "hunter3", "test_password"] {
        assert!(!log.contains(secret), "{secret} logged: {log}");
    }
    assert!(log.contains("<redacted>"), "{log}");
}
