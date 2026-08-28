//! Regression cover for #508: a decode failure must never masquerade as NULL.
//! Needs the MySQL 8 test container (make db-up).
use mas_core::connection::{self, ConnectionManager};
use mas_core::models::SqlValue;
use mas_core::query::QueryExecutor;
use std::sync::Arc;

async fn run(sql: &str) -> Vec<SqlValue> {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let config = db_keystore::DbKeyStoreConfig {
            path: "".into(),
            vfs: Some("memory".into()),
            ..Default::default()
        };
        connection::init_keyring(db_keystore::DbKeyStore::new(config).unwrap());
    });
    let manager = Arc::new(ConnectionManager::new());
    let profile = mas_core::models::ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "types".into(),
        group: None,
        color: None,
        host: "127.0.0.1".into(),
        port: 13306,
        username: "root".into(),
        password: "test_root_password".into(),
        default_database: Some("test_db".into()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 2,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    let conn = manager.connect(&profile).await.unwrap();
    let exec = QueryExecutor::new(manager.clone());
    let results = exec.execute(&conn.id, sql, None, None).await.unwrap();
    results[0].rows[0].clone()
}

#[tokio::test]
async fn decimal_survives_with_full_precision() {
    let row = run("SELECT d, n FROM type_probe").await;
    // Was SqlValue::Null before #508 — sqlx cannot decode DECIMAL as f64, and
    // the error was being discarded.
    assert_eq!(row[0], SqlValue::String("12345678901234.5678".into()));
    assert_eq!(row[1], SqlValue::String("2.50".into()));
}

#[tokio::test]
async fn year_is_a_number_not_a_timestamp() {
    let row = run("SELECT yr FROM type_probe").await;
    assert_eq!(row[0], SqlValue::UInt(2026));
}

#[tokio::test]
async fn a_real_null_is_still_null() {
    let row = run("SELECT nullcol FROM type_probe").await;
    assert_eq!(row[0], SqlValue::Null);
}

#[tokio::test]
async fn common_types_still_decode() {
    let row = run("SELECT big, f, j, dt, tm, bl, vc FROM type_probe").await;
    assert_eq!(row[0], SqlValue::Int(9007199254740993));
    assert_eq!(row[1], SqlValue::Float(3.5));
    assert!(matches!(&row[2], SqlValue::String(s) if s.contains("\"k\"")));
    assert!(matches!(&row[3], SqlValue::String(s) if s.starts_with("2026-01-01")));
    assert!(matches!(&row[4], SqlValue::String(s) if s == "10:30:00"));
    assert_eq!(row[5], SqlValue::Bytes(b"blob".to_vec()));
    assert_eq!(row[6], SqlValue::String("text".into()));
}
