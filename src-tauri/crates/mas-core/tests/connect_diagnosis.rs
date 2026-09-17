//! What the app says when a connection cannot be made at all.
//!
//! This is the first thing a new user sees when their server is not running,
//! and for a while it was wrong: sqlx reports a pool that never opened its
//! first connection with the same `PoolTimedOut` it uses for a pool whose
//! connections are all busy, and the app read that as exhaustion. Someone
//! whose database was simply stopped was told they had "reached the limit of 5
//! simultaneous connections" and invited to raise it.
//!
//! No server needed, which is the point: the failure under test is the absence
//! of one.

use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;

/// A port with nothing behind it: bound to learn a free number, then released.
fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

fn profile(port: u16) -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Unraid".to_string(),
        host: "127.0.0.1".to_string(),
        port,
        username: "root".to_string(),
        password: "irrelevant".to_string(),
        default_database: None,
        pool_min: 1,
        pool_max: 5,
        connect_timeout_secs: Some(2),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_server_that_is_not_running_is_not_described_as_a_pool_limit() {
    let manager = ConnectionManager::new();
    let error = manager
        .connect(&profile(closed_port()))
        .await
        .expect_err("nothing is listening, so this cannot succeed");
    let message = error.to_string();

    // What it must say: the port is not answering.
    assert!(message.contains("Nothing is listening"), "{message}");
    assert!(message.contains("Unraid"), "{message}");

    // What it must not say. Both of these sent the user to change a setting
    // that had no bearing on the failure.
    assert!(!message.contains("Max pool size"), "{message}");
    assert!(!message.contains("simultaneous connections"), "{message}");
    assert!(!message.to_lowercase().contains("exhausted"), "{message}");
}

#[tokio::test]
async fn a_host_that_does_not_resolve_says_that_rather_than_timing_out() {
    let manager = ConnectionManager::new();
    let mut profile = profile(3306);
    profile.host = "sqlpilot-no-such-host.invalid".to_string();

    let error = manager
        .connect(&profile)
        .await
        .expect_err("a .invalid name cannot resolve");
    let message = error.to_string();

    assert!(message.contains("does not resolve"), "{message}");
    assert!(!message.contains("Max pool size"), "{message}");
}
