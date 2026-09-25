use chrono::Utc;
use mas_core::connection::manager::{AGENT_LANE_MAX, JOB_LANE_MAX};
use mas_core::connection::{ConnectionManager, Lane};
use mas_core::error::CoreError;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Each kind of work draws from its own pool (#731).
///
/// Before, every profile had one pool, and the agent, backups, restores and
/// the editor all took from it. A busy agent or a long dump could leave the
/// editor waiting out the acquire timeout and then failing with "pool timed
/// out". These tests fill the other lanes and check the editor is untouched.
///
/// A short acquire timeout keeps the failure cases quick: a full lane fails in
/// two seconds rather than ten.
fn profile(pool_max: u32) -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "lanes".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB.
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
        pool_max,
        read_only: false,
        connect_timeout_secs: Some(2),
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

async fn connect(pool_max: u32) -> (Arc<ConnectionManager>, String) {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager
        .connect(&profile(pool_max))
        .await
        .expect("connects to the test server");
    (manager, info.id)
}

/// Hold every connection a lane allows until the returned guards are dropped.
async fn fill(
    manager: &ConnectionManager,
    connection_id: &str,
    lane: Lane,
    count: u32,
) -> Vec<sqlx::pool::PoolConnection<sqlx::MySql>> {
    let pool = manager.get_lane_pool(connection_id, lane).unwrap();
    let mut held = Vec::new();
    for _ in 0..count {
        held.push(pool.acquire().await.expect("the lane has room"));
    }
    held
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_full_agent_lane_and_a_full_job_lane_leave_the_editor_alone() {
    // The editor gets a single connection, so any slot taken from it by the
    // agent or a backup would show immediately.
    let (manager, id) = connect(1).await;
    let executor = QueryExecutor::new(manager.clone());

    let _agent = fill(&manager, &id, Lane::Agent, AGENT_LANE_MAX).await;
    let _jobs = fill(&manager, &id, Lane::Job, JOB_LANE_MAX).await;

    let started = Instant::now();
    let results = executor
        .execute(&id, "SELECT 1", None, None, None)
        .await
        .expect("the editor still has its connection");
    assert_eq!(results.len(), 1);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the editor waited {:?}; with its own lane it should not wait at all",
        started.elapsed()
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn running_agent_queries_do_not_take_the_editors_connections() {
    // The shape of the original complaint: an agent with queries in flight,
    // and the user trying to run one of their own.
    let (manager, id) = connect(1).await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let mut agent_queries = Vec::new();
    for _ in 0..AGENT_LANE_MAX {
        let executor = executor.clone();
        let id = id.clone();
        agent_queries.push(tokio::spawn(async move {
            executor
                .execute_in(Lane::Agent, &id, "SELECT SLEEP(3)", None, None, None)
                .await
        }));
    }
    // Long enough for both to be on the server.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let started = Instant::now();
    executor
        .execute(&id, "SELECT 1", None, None, None)
        .await
        .expect("the editor runs while the agent is busy");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the editor waited {:?} behind the agent",
        started.elapsed()
    );

    for query in agent_queries {
        query
            .await
            .unwrap()
            .expect("the agent's own queries finish");
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_full_agent_lane_is_reported_as_the_agents() {
    let (manager, id) = connect(5).await;
    let executor = QueryExecutor::new(manager.clone());
    let _agent = fill(&manager, &id, Lane::Agent, AGENT_LANE_MAX).await;

    let err = executor
        .execute_in(Lane::Agent, &id, "SELECT 1", None, None, None)
        .await
        .expect_err("a full lane cannot take another query");
    let message = err.to_string();
    assert!(
        matches!(err, CoreError::PoolExhausted(_))
            || matches!(&err, CoreError::AtStatement { source, .. }
                if matches!(**source, CoreError::PoolExhausted(_))),
        "{err:?}"
    );
    assert!(message.contains("agent"), "{message}");
    // The editor's setting cannot help, so it is not what the message offers.
    assert!(!message.contains("Max pool size"), "{message}");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn the_side_lanes_cost_nothing_until_used() {
    // Most sessions never run an agent or a backup. Those lanes should not
    // hold server threads on the chance that they might.
    let (manager, id) = connect(5).await;
    let agent = manager.get_lane_pool(&id, Lane::Agent).unwrap();
    let job = manager.get_lane_pool(&id, Lane::Job).unwrap();
    assert_eq!(
        agent.size(),
        0,
        "the agent lane connected before it was used"
    );
    assert_eq!(job.size(), 0, "the job lane connected before it was used");

    let executor = QueryExecutor::new(manager.clone());
    executor
        .execute_in(Lane::Agent, &id, "SELECT 1", None, None, None)
        .await
        .unwrap();
    assert_eq!(agent.size(), 1);
    assert_eq!(job.size(), 0, "using one lane opened another");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn every_lanes_sessions_are_known_as_the_apps_own() {
    // The admin panel refuses to kill the application's own sessions (#433).
    // An agent's or a backup's session is just as much the app's, and killing
    // one would break it mid-flight.
    let (manager, id) = connect(5).await;
    for lane in [Lane::Agent, Lane::Job] {
        let pool = manager.get_lane_pool(&id, lane).unwrap();
        let (thread_id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            manager.is_own_thread(&id, thread_id),
            "{lane:?} session {thread_id} is not known as the app's own"
        );
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn disconnect_closes_every_lane() {
    // A lane left open after disconnect is a server thread nothing in the app
    // can see or reach any more.
    let (manager, id) = connect(5).await;
    let agent = manager.get_lane_pool(&id, Lane::Agent).unwrap();
    let job = manager.get_lane_pool(&id, Lane::Job).unwrap();
    sqlx::query("SELECT 1").execute(&agent).await.unwrap();
    sqlx::query("SELECT 1").execute(&job).await.unwrap();

    manager.disconnect(&id).await.unwrap();
    assert!(agent.is_closed(), "the agent lane survived disconnect");
    assert!(job.is_closed(), "the job lane survived disconnect");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn cancel_still_stops_what_the_agent_is_running() {
    // The agent moved to its own lane but not its own executor, so the user's
    // Cancel still reaches it: stopping an agent's runaway query from the app
    // has to keep working.
    let (manager, id) = connect(5).await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let running = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute_in(Lane::Agent, &id, "SELECT SLEEP(20)", None, None, None)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(700)).await;

    let started = Instant::now();
    executor.cancel(&id).await.expect("cancel is issued");
    let _ = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("the agent's query stopped when cancelled");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_full_editor_lane_counts_only_the_editors_queries() {
    // The message counts what is running to say why the pool is full. An
    // agent's query runs on its own lane and holds none of the editor's
    // connections, so counting it would blame the wrong thing.
    let (manager, id) = connect(1).await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let agent = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute_in(Lane::Agent, &id, "SELECT SLEEP(6)", None, None, None)
                .await
        })
    };
    let editor = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute(&id, "SELECT SLEEP(6)", None, None, None)
                .await
        })
    };
    // Both on the server, and the editor's one connection taken.
    tokio::time::sleep(Duration::from_millis(700)).await;

    let message = executor
        .execute(&id, "SELECT 1", None, None, None)
        .await
        .expect_err("the editor's only connection is busy")
        .to_string();
    assert!(
        message.contains("One editor query is still running"),
        "the agent's query was counted as the editor's: {message}"
    );

    editor.await.unwrap().expect("the editor's query finishes");
    agent.await.unwrap().expect("the agent's query finishes");
}
