use chrono::Utc;
use mas_core::connection::manager::{AGENT_SESSION_MAX, INTERACTIVE_LANE_MAX};
use mas_core::connection::{ConnectionManager, Route};
use mas_core::error::CoreError;
use mas_core::models::ConnectionProfile;
use mas_core::query::staged::DEFAULT_DEADLINE;
use mas_core::query::{CancelReach, CancelScope, QueryExecutor, StagedWrite};
use mas_core::schema::SchemaInspector;
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

/// Start a staged write on `route` that sleeps for as long as it is let run.
fn stage_slow_delete(
    executor: &Arc<QueryExecutor>,
    manager: &Arc<ConnectionManager>,
    id: &str,
    route: Route,
    table: &str,
) -> tokio::task::JoinHandle<Result<StagedWrite, mas_core::query::StageError>> {
    let tracker = executor.tracker();
    let pool = manager.route_pool(id, &route).unwrap();
    let id = id.to_string();
    let sql = format!("DELETE FROM `{table}` WHERE SLEEP(20) = 0");
    tokio::spawn(async move {
        StagedWrite::begin_in(
            &pool,
            Some("test_db"),
            &sql,
            DEFAULT_DEADLINE,
            Some(CancelReach {
                tracker: &tracker,
                connection_id: &id,
                route: &route,
            }),
            None,
        )
        .await
    })
}

/// Whether a staged write stopped by a cancel left nothing behind: either the
/// server reported the interruption, or the interrupted `SLEEP` let no row
/// match. Rolled back either way.
async fn stopped_without_change(outcome: Result<StagedWrite, mas_core::query::StageError>) -> bool {
    match outcome {
        Err(_) => true,
        Ok(staged) => {
            let untouched = staged.rows_affected == 0;
            staged.rollback().await.expect("rolls back");
            untouched
        }
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn an_agent_cancel_reaches_its_staged_write() {
    // A staged write runs on a connection of its own, not through the
    // executor, so the agent panel's Stop could not see it and a long DELETE
    // ran on after the user asked it to stop (#894).
    let (manager, id) = connect().await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let tables = [
        format!("lanes_staged_a_{suffix}"),
        format!("lanes_staged_b_{suffix}"),
    ];
    for table in &tables {
        executor
            .execute(
                &id,
                &format!("CREATE TABLE `{table}` (id INT); INSERT INTO `{table}` VALUES (1)"),
                Some("test_db".to_string()),
                None,
                None,
            )
            .await
            .expect("creates the table");
    }

    let a = stage_slow_delete(&executor, &manager, &id, agent("a"), &tables[0]);
    let b = stage_slow_delete(&executor, &manager, &id, agent("b"), &tables[1]);
    tokio::time::sleep(Duration::from_millis(700)).await;

    let started = Instant::now();
    executor
        .cancel(&id, CancelScope::Agent("a".to_string()))
        .await
        .expect("cancel is issued");
    let a = tokio::time::timeout(Duration::from_secs(5), a)
        .await
        .expect("agent a's staged write stopped when cancelled")
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        stopped_without_change(a).await,
        "the cancelled write changed nothing"
    );

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !b.is_finished(),
        "another agent's staged write keeps running"
    );

    // Cancel everything reaches it too.
    executor
        .cancel(&id, CancelScope::All)
        .await
        .expect("cancel all is issued");
    let b = tokio::time::timeout(Duration::from_secs(5), b)
        .await
        .expect("cancel all stopped the other staged write")
        .unwrap();
    assert!(stopped_without_change(b).await);

    for table in &tables {
        executor
            .execute(
                &id,
                &format!("DROP TABLE `{table}`"),
                Some("test_db".to_string()),
                None,
                None,
            )
            .await
            .expect("drops the table");
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn an_agent_cancel_reaches_reads_outside_the_executor() {
    // The schema inspector reads through sqlx directly. Tracked, its reads
    // are registered the way a staged write is (#894). A metadata read cannot
    // be made slow on demand, so the registration is driven directly here on
    // the agent's own pool, and the tracked inspector is checked to read.
    let (manager, id) = connect().await;
    let executor = Arc::new(QueryExecutor::new(manager.clone()));
    let route = agent("a");

    let inspector =
        SchemaInspector::for_route(manager.clone(), route.clone()).tracked_by(executor.tracker());
    let databases = inspector.get_databases(&id).await.expect("reads tracked");
    assert!(databases.iter().any(|d| d.name == "test_db"));

    let read = {
        let tracker = executor.tracker();
        let pool = manager.route_pool(&id, &route).unwrap();
        let id = id.clone();
        let route = route.clone();
        tokio::spawn(async move {
            let mut connection = pool.acquire().await.expect("takes a connection");
            let _ticket = tracker
                .track(&mut connection, &id, &route)
                .await
                .expect("registers");
            sqlx::query("SELECT SLEEP(20)")
                .execute(&mut *connection)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(700)).await;

    let started = Instant::now();
    executor
        .cancel(&id, CancelScope::Agent("a".to_string()))
        .await
        .expect("cancel is issued");
    let _ = tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .expect("the tracked read stopped when cancelled");
    assert!(started.elapsed() < Duration::from_secs(5));
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
