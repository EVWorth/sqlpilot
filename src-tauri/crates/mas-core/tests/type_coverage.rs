//! Regression cover for #508: a failed decode must never masquerade as NULL.
//!
//! Needs the MySQL 8 test container (`make db-up`). Each test builds its own
//! table so they can run in parallel and the file stays self-contained rather
//! than depending on seed.sql.

use mas_core::connection::{self, ConnectionManager};
use mas_core::models::SqlValue;
use mas_core::query::QueryExecutor;
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
        connection::init_keyring(db_keystore::DbKeyStore::new(config).unwrap());
    });
}

/// Build a one-row table of assorted types and return the selected columns.
///
/// `table` is per-test so parallel runs cannot clobber each other.
async fn probe(table: &str, select_list: &str) -> Vec<SqlValue> {
    setup_keyring();
    let manager = Arc::new(ConnectionManager::new());
    let profile = mas_core::models::ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "type-coverage".into(),
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

    macro_rules! run {
        ($sql:expr) => {
            exec.execute(&conn.id, &$sql, None, None).await.unwrap()
        };
    }

    run!(format!("DROP TABLE IF EXISTS {table}"));
    run!(format!(
        "CREATE TABLE {table} (
            d DECIMAL(20,4), n NUMERIC(10,2), yr YEAR, big BIGINT,
            f FLOAT, j JSON, dt DATETIME, tm TIME, bl BLOB, vc VARCHAR(20), nullcol INT
        )"
    ));
    run!(format!(
        "INSERT INTO {table} VALUES (
            12345678901234.5678, 2.50, 2026, 9007199254740993, 3.5, '{{\"k\":1}}',
            '2026-01-01 10:00:00', '10:30:00', 'blob', 'text', NULL
        )"
    ));

    let results = run!(format!("SELECT {select_list} FROM {table}"));
    let row = results[0].rows[0].clone();
    run!(format!("DROP TABLE IF EXISTS {table}"));
    row
}

#[tokio::test]
async fn decimal_survives_with_full_precision() {
    // Was SqlValue::Null: sqlx cannot decode DECIMAL as f64 and the error was
    // discarded. Read as text so the exactness the type exists for is kept.
    let row = probe("tc_decimal", "d, n").await;
    assert_eq!(row[0], SqlValue::String("12345678901234.5678".into()));
    assert_eq!(row[1], SqlValue::String("2.50".into()));
}

#[tokio::test]
async fn year_is_a_number_not_a_timestamp() {
    // Was SqlValue::Null: matched in the DATE/DATETIME arm and asked to decode
    // as a chrono timestamp, which a bare year is not.
    let row = probe("tc_year", "yr").await;
    assert_eq!(row[0], SqlValue::UInt(2026));
}

#[tokio::test]
async fn a_real_null_is_still_null() {
    // The counterpart to the two above: distinguishing decode failure from NULL
    // must not turn genuine NULLs into something else.
    let row = probe("tc_null", "nullcol").await;
    assert_eq!(row[0], SqlValue::Null);
}

#[tokio::test]
async fn bigint_keeps_every_digit() {
    // 9007199254740993 is 2^53 + 1: the smallest integer a JSON number cannot
    // represent. Carried as text so the last digit survives to the grid. (#502)
    let row = probe("tc_bigint", "big").await;
    assert_eq!(row[0], SqlValue::String("9007199254740993".into()));

    // and it must still be exact after a JSON round-trip, which is where the
    // truncation actually happened
    let json = serde_json::to_string(&row[0]).unwrap();
    assert_eq!(json, "\"9007199254740993\"");
}

#[tokio::test]
async fn common_types_are_unaffected() {
    let row = probe("tc_common", "big, f, j, dt, tm, bl, vc").await;
    assert_eq!(row[0], SqlValue::String("9007199254740993".into()));
    assert_eq!(row[1], SqlValue::Float(3.5));
    assert!(matches!(&row[2], SqlValue::String(s) if s.contains("\"k\"")));
    assert!(matches!(&row[3], SqlValue::String(s) if s.starts_with("2026-01-01")));
    assert!(matches!(&row[4], SqlValue::String(s) if s == "10:30:00"));
    assert_eq!(row[5], SqlValue::Bytes(b"blob".to_vec()));
    assert_eq!(row[6], SqlValue::String("text".into()));
}
