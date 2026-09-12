use chrono::Utc;
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
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
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn pool_stats_report_what_the_profile_allows_and_what_is_open() {
    // FR-1.2.3's "pool statistics visible in status bar" needs numbers to
    // show; these are them.
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile(port())).await.unwrap();

    let stats = manager.pool_stats();
    let mine = stats
        .iter()
        .find(|s| s.connection_id == info.id)
        .expect("the live connection should be in the stats");
    assert_eq!(mine.max, 3, "the profile's limit");
    assert!(mine.size >= 1, "pool_min opens one");
    assert!(mine.idle <= mine.size);

    manager.disconnect(&info.id).await.unwrap();
    assert!(
        manager
            .pool_stats()
            .iter()
            .all(|s| s.connection_id != info.id),
        "a disconnected pool should not be reported"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_pool_size_out_of_range_still_connects() {
    // A profile can hold anything — an older build's value, or a hand-edited
    // row. A zero max makes sqlx panic and a min above the max makes it refuse
    // to build the pool; neither should reach a user as a failed connection.
    let mut p = profile(port());
    p.pool_min = 20;
    p.pool_max = 0;

    let manager = Arc::new(ConnectionManager::new());
    let info = manager
        .connect(&p)
        .await
        .expect("an out-of-range pool size should be clamped, not fatal");

    let stats = manager.pool_stats();
    let mine = stats.iter().find(|s| s.connection_id == info.id).unwrap();
    assert_eq!(mine.max, 1);

    manager.disconnect(&info.id).await.unwrap();
}
