use chrono::Utc;
use mas_core::connection::manager::{AGENT_SESSION_MAX, INTERACTIVE_LANE_MAX};
use mas_core::connection::{ConnectionManager, Route};
use mas_core::error::CoreError;
use mas_core::models::ConnectionProfile;
use mas_core::query::{CancelScope, QueryExecutor};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Each kind of work has connections of its own (#731).
///
/// Before, every profile had one pool, and the agent, backups, restores and
/// the editor all took from it. A busy agent or a long dump could leave the
/// editor waiting out the acquire timeout and then failing with "pool timed
/// out". Now each agent session has its own connections and each backup or
/// restore its own connection; these tests keep them busy and check nobody
/// else waits.
///
/// A short acquire timeout keeps the failure cases quick: a full session fails
/// in two seconds rather than ten.
fn profile() -> ConnectionProfile {
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
        pool_max: 5,
        read_only: false,
        connect_timeout_secs: Some(2),
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

async fn connect() -> (Arc<ConnectionManager>, String) {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager
        .connect(&profile())
        .await
        .expect("connects to the test server");
    (manager, info.id)
}

fn agent(name: &str) -> Route {
    Route::Agent(name.to_string())
}

/// Hold every connection a route allows until the returned guards are dropped.
async fn fill(
    manager: &ConnectionManager,
    connection_id: &str,
    route: &Route,
    count: u32,
) -> Vec<sqlx::pool::PoolConnection<sqlx::MySql>> {
    let pool = manager.route_pool(connection_id, route).unwrap();
    let mut held = Vec::new();
    for _ in 0..count {
        held.push(pool.acquire().await.expect("the route has room"));
    }
    held
}

async fn thread_id(pool: &sqlx::MySqlPool) -> u64 {
    let (id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
        .fetch_one(pool)
        .await
        .unwrap();
    id
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_busy_agent_and_a_running_job_leave_the_interactive_lane_alone() {
    let (manager, id) = connect().await;
    let executor = QueryExecutor::new(manager.clone());

    let _agent = fill(&manager, &id, &agent("a"), AGENT_SESSION_MAX).await;
    let job = manager.start_job(&id).unwrap();
    let _dump = job.pool().acquire().await.unwrap();

    let started = Instant::now();
    let results = executor
        .execute(&id, "SELECT 1", None, None, None)
        .await
        .expect("the interactive lane still has its connections");
    assert_eq!(results.len(), 1);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the interactive lane waited {:?}; it should not wait at all",
        started.elapsed()
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn running_agent_queries_do_not_take_the_editors_connections() {
    // The shape of the original complaint: an agent with queries in flight,
    // and the user trying to run one of their own.
    let (manager, id) = connect().await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let mut agent_queries = Vec::new();
    for _ in 0..AGENT_SESSION_MAX {
        let executor = executor.clone();
        let id = id.clone();
        agent_queries.push(tokio::spawn(async move {
            executor
                .execute_in(agent("a"), &id, "SELECT SLEEP(3)", None, None, None)
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
async fn two_agent_sessions_do_not_share_connections() {
    // FR-6.3.2: one agent's runaway query cannot hold up another agent.
    let (manager, id) = connect().await;
    let executor = QueryExecutor::new(manager.clone());

    let first = manager.route_pool(&id, &agent("a")).unwrap();
    let second = manager.route_pool(&id, &agent("b")).unwrap();
    assert_ne!(
        thread_id(&first).await,
        thread_id(&second).await,
        "two agent sessions ran on the same server session"
    );

    let _busy = fill(&manager, &id, &agent("a"), AGENT_SESSION_MAX).await;
    let started = Instant::now();
    executor
        .execute_in(agent("b"), &id, "SELECT 1", None, None, None)
        .await
        .expect("the second agent is not held up by the first");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_full_agent_session_is_reported_as_the_agents() {
    let (manager, id) = connect().await;
    let executor = QueryExecutor::new(manager.clone());
    let _agent = fill(&manager, &id, &agent("a"), AGENT_SESSION_MAX).await;

    let err = executor
        .execute_in(agent("a"), &id, "SELECT 1", None, None, None)
        .await
        .expect_err("a full session cannot take another query");
    let message = err.to_string();
    assert!(
        matches!(err, CoreError::PoolExhausted(_))
            || matches!(&err, CoreError::AtStatement { source, .. }
                if matches!(**source, CoreError::PoolExhausted(_))),
        "{err:?}"
    );
    assert!(message.contains("agent session"), "{message}");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn agent_sessions_cost_nothing_until_used_and_close_when_they_end() {
    // Most sessions never run an agent. Nothing should hold server threads
    // on the chance that one might, or after it has gone.
    let (manager, id) = connect().await;
    assert_eq!(manager.agent_session_count(&id), 0);

    let executor = QueryExecutor::new(manager.clone());
    executor
        .execute_in(agent("a"), &id, "SELECT 1", None, None, None)
        .await
        .unwrap();
    assert_eq!(manager.agent_session_count(&id), 1);
    let pool = manager.route_pool(&id, &agent("a")).unwrap();

    manager.close_agent_session("a").await;
    assert_eq!(manager.agent_session_count(&id), 0);
    assert!(
        pool.is_closed(),
        "the agent session's connections survived it"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_job_gives_its_connection_back_when_it_ends() {
    let (manager, id) = connect().await;
    assert_eq!(manager.job_count(&id), 0);

    let job = manager.start_job(&id).unwrap();
    let pool = job.pool().clone();
    sqlx::query("SELECT 1").execute(&pool).await.unwrap();
    assert_eq!(manager.job_count(&id), 1);

    drop(job);
    assert_eq!(manager.job_count(&id), 0);
    // The close runs on the runtime; give it a moment.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pool.is_closed() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(pool.is_closed(), "the job's connection outlived the job");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn agent_and_job_sessions_are_known_as_the_apps_own() {
    // The admin panel refuses to kill the application's own sessions (#433).
    // An agent's or a backup's session is just as much the app's, and killing
    // one would break it mid-flight.
    let (manager, id) = connect().await;
    let job = manager.start_job(&id).unwrap();
    for (what, pool) in [
        ("agent", manager.route_pool(&id, &agent("a")).unwrap()),
        ("job", job.pool().clone()),
    ] {
        let thread = thread_id(&pool).await;
        assert!(
            manager.is_own_thread(&id, thread),
            "the {what} session {thread} is not known as the app's own"
        );
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn disconnect_closes_agent_and_job_connections() {
    // A connection left open after disconnect is a server thread nothing in
    // the app can see or reach any more.
    let (manager, id) = connect().await;
    let agent_pool = manager.route_pool(&id, &agent("a")).unwrap();
    let job = manager.start_job(&id).unwrap();
    sqlx::query("SELECT 1").execute(&agent_pool).await.unwrap();
    sqlx::query("SELECT 1").execute(job.pool()).await.unwrap();

    manager.disconnect(&id).await.unwrap();
    assert!(
        agent_pool.is_closed(),
        "the agent session survived disconnect"
    );
    assert!(job.pool().is_closed(), "the job survived disconnect");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn cancel_still_stops_what_the_agent_is_running() {
    // The agent has its own connections but not its own executor, so a
    // cancel of everything on the connection still reaches it. The user's
    // Cancel in the editor is scoped to a tab or the shared pool and does not.
    let (manager, id) = connect().await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let running = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute_in(agent("a"), &id, "SELECT SLEEP(20)", None, None, None)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(700)).await;

    let started = Instant::now();
    executor
        .cancel(&id, CancelScope::All)
        .await
        .expect("cancel is issued");
    let _ = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("the agent's query stopped when cancelled");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn an_agent_cancel_stops_only_that_agents_statements() {
    // The agent panel's Stop (#868): it reaches what this agent is running on
    // the server, and nothing another agent or an editor tab is running.
    let (manager, id) = connect().await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let run_on = |route: Route| {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute_in(route, &id, "SELECT SLEEP(20)", None, None, None)
                .await
        })
    };
    let a = run_on(agent("a"));
    let b = run_on(agent("b"));
    let tab = run_on(Route::Session("tab-1".to_string()));
    tokio::time::sleep(Duration::from_millis(700)).await;

    let started = Instant::now();
    executor
        .cancel(&id, CancelScope::Agent("a".to_string()))
        .await
        .expect("cancel is issued");
    let _ = tokio::time::timeout(Duration::from_secs(5), a)
        .await
        .expect("agent a's query stopped when cancelled");
    assert!(started.elapsed() < Duration::from_secs(5));

    // Give a stray KILL time to land before checking the others survived it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!b.is_finished(), "another agent's query keeps running");
    assert!(!tab.is_finished(), "an editor tab's query keeps running");

    executor
        .cancel(&id, CancelScope::All)
        .await
        .expect("cleanup cancel is issued");
    for rest in [b, tab] {
        let _ = tokio::time::timeout(Duration::from_secs(5), rest)
            .await
            .expect("cleanup stopped the rest");
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_full_interactive_lane_counts_only_its_own_queries() {
    // The message counts what is running to say why the lane is full. An
    // agent's query runs on its own lane and holds none of these connections,
    // so counting it would blame the wrong thing.
    let (manager, id) = connect().await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));

    let agent = {
        let executor = executor.clone();
        let id = id.clone();
        tokio::spawn(async move {
            executor
                .execute_in(agent("a"), &id, "SELECT SLEEP(6)", None, None, None)
                .await
        })
    };
    let mut interactive = Vec::new();
    for _ in 0..INTERACTIVE_LANE_MAX {
        let executor = executor.clone();
        let id = id.clone();
        interactive.push(tokio::spawn(async move {
            executor
                .execute(&id, "SELECT SLEEP(6)", None, None, None)
                .await
        }));
    }
    // All on the server, and every interactive connection taken.
    tokio::time::sleep(Duration::from_millis(700)).await;

    let message = executor
        .execute(&id, "SELECT 1", None, None, None)
        .await
        .expect_err("every interactive connection is busy")
        .to_string();
    let expected = format!("{INTERACTIVE_LANE_MAX} queries are still running");
    assert!(
        message.contains(&expected),
        "the agent's query was counted as the lane's own: {message}"
    );

    for query in interactive {
        query.await.unwrap().expect("the lane's queries finish");
    }
    agent.await.unwrap().expect("the agent's query finishes");
}
