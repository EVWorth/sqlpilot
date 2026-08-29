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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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

/// A password containing a backslash must survive being written into SQL and
/// come back out intact.
///
/// The admin panel builds `CREATE USER` / `ALTER USER` as text, and its quoting
/// helper doubled single quotes but left backslashes alone. MySQL treats a
/// backslash as an escape inside a string literal unless NO_BACKSLASH_ESCAPES
/// is set — off by default — so `pa\ss` written as `'pa\ss'` is stored as
/// `pass`: the account gets a password the user never typed and cannot log in
/// with, and nothing reports an error.
///
/// This pins the server-side rule that `quoteStringLiteral` implements. The
/// frontend unit tests cover the escaping itself; this proves the escaping is
/// the one the server actually needs.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_password_containing_a_backslash_round_trips() {
    use sqlx::mysql::MySqlConnection;
    use sqlx::Connection;

    let manager = Arc::new(ConnectionManager::new());
    // root, because creating users needs more than test_user has.
    let mut admin =
        MySqlConnection::connect("mysql://root:test_root_password@127.0.0.1:13306/test_db")
            .await
            .expect("connect as root");

    let typed_password = r"pa\ss";
    // What quoteStringLiteral produces for that input: backslash doubled.
    let quoted = r"'pa\\ss'";

    sqlx::raw_sql(sqlx::AssertSqlSafe(
        "DROP USER IF EXISTS 'bsprobe'@'%'".to_string(),
    ))
    .execute(&mut admin)
    .await
    .expect("drop any leftover");

    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE USER 'bsprobe'@'%' IDENTIFIED BY {}",
        quoted
    )))
    .execute(&mut admin)
    .await
    .expect("create user");

    // The account must accept exactly what was typed.
    // No database in the URL: the account has no grants, and a "no access to
    // that schema" error (1044) would otherwise look like a pass when what is
    // being tested is authentication (1045).
    let typed_ok = MySqlConnection::connect(&format!(
        "mysql://bsprobe:{}@127.0.0.1:13306",
        urlencoding_encode(typed_password)
    ))
    .await;

    // And must NOT accept the mangled form the old quoting would have stored.
    let mangled_ok = MySqlConnection::connect("mysql://bsprobe:pass@127.0.0.1:13306").await;

    sqlx::raw_sql(sqlx::AssertSqlSafe("DROP USER 'bsprobe'@'%'".to_string()))
        .execute(&mut admin)
        .await
        .expect("cleanup");

    assert!(
        typed_ok.is_ok(),
        "the password the user typed should authenticate: {:?}",
        typed_ok.err()
    );
    assert!(
        mangled_ok.is_err(),
        "the backslash-stripped password must NOT authenticate — that would mean \
         the escaping collapsed and the stored password is not the typed one"
    );

    drop(manager);
}

/// Percent-encode the few characters that would otherwise break a connection URL.
fn urlencoding_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            other => format!("%{:02X}", other as u32),
        })
        .collect()
}

/// The admin panel must not be able to disconnect the app from the server it
/// is managing.
///
/// PROCESSLIST includes the sessions SQLPilot itself is using to read that
/// very list. Killing one worked; killing the last exhausted the pool and
/// surfaced "pool timed out", which does not tell the user that they had just
/// cut their own connection (#433).
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn kill_process_refuses_the_apps_own_connection() {
    let manager = Arc::new(ConnectionManager::new());
    let service = AdminService::new(manager.clone());
    let info = manager.connect(&test_profile()).await.expect("connect");

    let own = manager.own_thread_ids(&info.id);
    assert!(
        !own.is_empty(),
        "the pool should have recorded at least one server thread of its own"
    );

    for thread_id in &own {
        let err = service
            .kill_process(&info.id, *thread_id as i64)
            .await
            .expect_err("killing our own session should be refused");
        assert!(
            err.to_string().contains("own connection"),
            "expected a self-protection message, got: {err}"
        );
    }

    // The connection is still usable, which is the whole point.
    let processes = service
        .get_process_list(&info.id)
        .await
        .expect("connection still works after the refusal");
    assert!(!processes.is_empty());

    manager.disconnect(&info.id).await.unwrap();
}

/// Somebody else's session is still killable — the guard must not be a blanket
/// refusal.
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn kill_process_still_kills_a_foreign_connection() {
    use sqlx::mysql::MySqlConnection;
    use sqlx::Connection;

    let manager = Arc::new(ConnectionManager::new());
    let service = AdminService::new(manager.clone());
    let info = manager.connect(&test_profile()).await.expect("connect");

    let mut victim =
        MySqlConnection::connect("mysql://test_user:test_password@127.0.0.1:13306/test_db")
            .await
            .expect("open a separate connection");
    let victim_id: (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
        .fetch_one(&mut victim)
        .await
        .expect("read victim thread id");

    assert!(
        !manager.is_own_thread(&info.id, victim_id.0),
        "a connection opened outside the pool must not be treated as ours"
    );

    service
        .kill_process(&info.id, victim_id.0 as i64)
        .await
        .expect("killing another session should be allowed");

    manager.disconnect(&info.id).await.unwrap();
}

/// `KILL QUERY` must abort the statement and leave the session usable.
///
/// The panel could only issue `KILL`, which drops the connection along with
/// its transaction, prepared statements and session variables — a heavy answer
/// to "this SELECT is taking too long" (#430).
#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn kill_query_stops_the_statement_but_keeps_the_session() {
    use sqlx::mysql::MySqlConnection;
    use sqlx::Connection;

    let manager = Arc::new(ConnectionManager::new());
    let service = AdminService::new(manager.clone());
    let admin = manager.connect(&test_profile()).await.expect("connect");

    let mut victim =
        MySqlConnection::connect("mysql://test_user:test_password@127.0.0.1:13306/test_db")
            .await
            .expect("open the session to interrupt");
    let (victim_id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
        .fetch_one(&mut victim)
        .await
        .expect("read thread id");

    // Give the session something to be interrupted out of, and a session
    // variable that must survive the interruption.
    sqlx::query("SET @survives = 'yes'")
        .execute(&mut victim)
        .await
        .expect("set a session variable");

    let sleeper = tokio::spawn(async move {
        let result = sqlx::query("SELECT SLEEP(30)").execute(&mut victim).await;
        (victim, result)
    });
    tokio::time::sleep(Duration::from_millis(750)).await;

    let started = std::time::Instant::now();
    service
        .kill_query(&admin.id, victim_id as i64)
        .await
        .expect("kill query should be permitted");
    let (mut victim, _result) = sleeper.await.expect("the sleeping task should finish");

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "SLEEP(30) should have been cut short, took {:?}",
        started.elapsed()
    );

    // The distinguishing property: the session is still there, with its state.
    let (survives,): (String,) = sqlx::query_as("SELECT @survives")
        .fetch_one(&mut victim)
        .await
        .expect("the session should still be usable after KILL QUERY");
    assert_eq!(
        survives, "yes",
        "session state should survive an aborted statement"
    );

    manager.disconnect(&admin.id).await.unwrap();
}
