use chrono::Utc;
use mas_core::connection::manager::INTERACTIVE_LANE_MAX;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use std::sync::Arc;
use std::time::Duration;

/// The health checker, against a live server.
///
/// ARCHITECTURE §3.1 described one and nothing implemented it, so a tab whose
/// server had gone stayed looking normal until the next query failed with
/// "Connection not found" (#276).
fn profile(port: u16) -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "health".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        port,
        username: "test_user".to_string(),
        password: "test_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 3,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn port() -> u16 {
    std::env::var("MAS_TEST_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(13306)
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_new_connection_starts_healthy_and_can_be_pinged() {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile(port())).await.unwrap();

    let health = manager
        .health_of(&info.id)
        .expect("a live connection has a health record");
    assert!(health.healthy);
    assert_eq!(health.consecutive_failures, 0);

    let pool = manager.get_pool(&info.id).unwrap();
    let latency = mas_core::connection::health::ping(&pool)
        .await
        .expect("a live server answers a ping");
    // A local server answers in single-digit milliseconds; the bound is only
    // here to catch a latency that is obviously not one.
    assert!(latency < 5_000, "ping reported {latency}ms");

    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_disconnected_connection_has_no_health_and_stops_being_watched() {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile(port())).await.unwrap();
    manager.disconnect(&info.id).await.unwrap();

    assert!(manager.health_of(&info.id).is_none());

    // The task is stopped by dropping the connection entry, so nothing should
    // arrive after a disconnect. Long enough to cover a scheduled ping.
    let mut events = manager.subscribe_health();
    let quiet = tokio::time::timeout(Duration::from_secs(2), events.recv()).await;
    assert!(
        quiet.is_err(),
        "a disconnected connection is still being pinged"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_ping_against_a_closed_pool_reports_the_failure_rather_than_hanging() {
    // What the checker sees when the server goes away: an error, promptly.
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile(port())).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    pool.close().await;

    let started = std::time::Instant::now();
    let result = mas_core::connection::health::ping(&pool).await;
    assert!(result.is_err(), "a closed pool cannot answer");
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "the ping should give up promptly, took {:?}",
        started.elapsed()
    );

    let _ = manager.disconnect(&info.id).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_stored_pool_size_is_ignored() {
    // Profiles saved by older builds still carry a pool size, anything from a
    // zero (which sqlx panics on) to a hand-edited thousand. Connections are
    // no longer sized per profile (#731), so none of it should matter.
    for (min, max) in [(20, 0), (1, 1000), (1, 5)] {
        let mut p = profile(port());
        p.pool_min = min;
        p.pool_max = max;

        let manager = Arc::new(ConnectionManager::new());
        let info = manager
            .connect(&p)
            .await
            .unwrap_or_else(|e| panic!("pool_min {min}, pool_max {max} should still connect: {e}"));
        let pool = manager.get_pool(&info.id).unwrap();
        assert_eq!(pool.options().get_max_connections(), INTERACTIVE_LANE_MAX);

        manager.disconnect(&info.id).await.unwrap();
    }
}
