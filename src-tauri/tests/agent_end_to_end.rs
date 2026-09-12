//! An agent, the endpoint, and a real database.
//!
//! Every other test in this feature checks one seam. This checks all of them
//! at once, the way a user does: a live MySQL connection, the policy, the
//! endpoint on loopback with its token, and a real harness on the other end
//! being asked a question in English — then asserting the answer contains
//! something only the database could have told it.
//!
//! It is the test that would have caught any of: a tool the model cannot
//! understand, a description that leads it to the wrong one, an MCP server
//! that never connects, a policy that refuses everything, a shape the harness
//! cannot parse. None of those are visible from either side alone.
//!
//! Ignored by default: it needs the databases up, the CLI installed and logged
//! in, and it spends the user's own quota. Run it with
//! `cargo test -p sqlpilot --test agent_end_to_end -- --ignored`.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use mas_agent::acp::{AcpClient, McpServer};
use mas_agent::event::SessionEvent;
use mas_agent::harness::{spawn_acp, Harness};
use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::history::HistoryStore;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use mas_mcp::endpoint;
use mas_mcp::grants::{Grant, Grants};
use mas_mcp::policy::DataPosture;
use sqlpilot_lib::mcp::state::McpState;
use sqlpilot_lib::mcp::workspace::AppWorkspace;

/// A database per run, so two runs cannot tear down each other's fixture.
fn probe_database() -> String {
    format!(
        "agent_e2e_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

fn profile(id: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.to_string(),
        name: "e2e-shop".to_string(),
        host: "127.0.0.1".to_string(),
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        // Not the probe database: it does not exist until this test makes it,
        // and a profile cannot connect to a database that is not there.
        // Not the probe database: it does not exist until this test makes it,
        // and a profile cannot connect to a database that is not there.
        default_database: Some("test_db".to_string()),
        pool_min: 1,
        pool_max: 4,
        // Deliberately development: production would refuse the schema
        // changes this fixture makes, which is a different test.
        environment: Some(mas_core::models::ConnectionEnvironment::Development),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        ..Default::default()
    }
}

/// A database with a shape only this test knows about, so an answer that
/// contains it cannot have come from the model's training.
async fn setup(pool: &sqlx::MySqlPool, db: &str) {
    for statement in [
        format!("DROP DATABASE IF EXISTS `{db}`"),
        format!("CREATE DATABASE `{db}`"),
        format!(
            "CREATE TABLE `{db}`.`zzquokka_ledger` (
                id INT PRIMARY KEY,
                quokka_count INT NOT NULL,
                noted_at DATETIME
             )"
        ),
        format!("INSERT INTO `{db}`.`zzquokka_ledger` VALUES (1, 7, NOW()), (2, 11, NOW())"),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

struct Harnessed {
    endpoint: Option<endpoint::Endpoint>,
    manager: Arc<ConnectionManager>,
    connection: String,
    pool: sqlx::MySqlPool,
    database: String,
}

impl Drop for Harnessed {
    fn drop(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.stop();
        }
    }
}

/// Connect, share the connection with agents, and start the endpoint.
async fn running(posture: DataPosture) -> (Harnessed, String, String) {
    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
    let store = Arc::new(ConnectionStore::in_memory().unwrap());
    let profile = profile(&uuid::Uuid::new_v4().to_string());
    store.save(&profile).unwrap();

    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    let database = probe_database();
    setup(&pool, &database).await;

    // Shared, on the user's terms — without this the agent sees nothing.
    let mut grants = Grants::default();
    grants.set(Grant::new(profile.id.clone()).with_posture(posture));

    let workspace = Arc::new(AppWorkspace::new(
        manager.clone(),
        store,
        Arc::new(HistoryStore::in_memory().unwrap()),
        Arc::new(SchemaInspector::new(manager.clone())),
        Arc::new(QueryExecutor::new(manager.clone())),
        McpState::new(grants),
    ));

    let token = uuid::Uuid::new_v4().simple().to_string();
    let endpoint = endpoint::start(workspace, None, token.clone(), 0)
        .await
        .expect("the endpoint starts");
    let url = endpoint.url();

    (
        Harnessed {
            endpoint: Some(endpoint),
            manager,
            connection: info.id,
            pool,
            database,
        },
        url,
        token,
    )
}

/// Ask a harness a question, and collect everything it said and did.
async fn ask(url: &str, token: &str, question: &str) -> (String, Vec<String>) {
    let mut child = spawn_acp(Harness::Copilot, "/tmp").expect("copilot is installed");
    let stdout = child.stdout.take().unwrap();
    let stdin = child.stdin.take().unwrap();
    let (client, mut events) = AcpClient::new(stdout, stdin);

    client.initialize().await.expect("the handshake completes");
    let session = client
        .new_session("/tmp", &[McpServer::sqlpilot(url, token)])
        .await
        .expect("a session opens");

    let turn = {
        let client = client.clone();
        let session = session.clone();
        let question = question.to_string();
        tokio::spawn(async move { client.prompt(&session, &question).await })
    };

    let mut answer = String::new();
    let mut tools: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(60), events.recv()).await {
            Ok(Some(SessionEvent::Text { delta })) => answer.push_str(&delta),
            Ok(Some(SessionEvent::ToolStarted { title, .. })) => {
                eprintln!("[e2e] tool: {title}");
                tools.push(title);
            }
            // Standing in for the user. Copilot asks before calling an MCP
            // tool, and in the app that question goes to the panel; here it is
            // answered yes, because what is under test is the tools rather
            // than the prompting. SQLPilot's own approval for a *write* is a
            // different question, and the last test in this file is about
            // what happens when nobody can answer it.
            Ok(Some(SessionEvent::PermissionRequested { id, options, .. })) => {
                let allow = options.iter().find(|option| option.is_allow());
                client
                    .answer_permission(&id, allow.map(|option| option.id.as_str()))
                    .await;
            }
            Ok(Some(SessionEvent::ToolFinished { status, detail, .. })) => {
                eprintln!("[e2e] tool {status}: {detail:?}");
            }
            Ok(Some(SessionEvent::Failed { message })) => panic!("the session failed: {message}"),
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
        if turn.is_finished() {
            // Drain whatever is already queued, then stop.
            while let Ok(event) = events.try_recv() {
                if let SessionEvent::Text { delta } = event {
                    answer.push_str(&delta);
                }
            }
            break;
        }
    }

    // Aborted rather than awaited: a turn that never ended is a failed test,
    // not a reason to wait forever for it.
    turn.abort();
    let _ = child.kill().await;
    (answer, tools)
}

async fn teardown(running: &Harnessed) {
    let db = &running.database;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS `{db}`"
    )))
    .execute(&running.pool)
    .await
    .unwrap();
    running
        .manager
        .disconnect(&running.connection)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the databases, a logged-in harness, and the user's own quota"]
async fn an_agent_can_find_a_table_it_has_never_heard_of() {
    // The name is deliberately absurd: an answer containing it came from the
    // database through the tools, not from the model's memory.
    let (running, url, token) = running(DataPosture::Samples).await;
    let db = &running.database;

    let (answer, tools) = ask(
        &url,
        &token,
        &format!(
            "Using the sqlpilot tools, list the tables in the {db} database and tell me the name \
             of each one. Answer with the table names only."
        ),
    )
    .await;

    assert!(
        answer.contains("zzquokka_ledger"),
        "the agent did not find the table. It said: {answer}\ntools used: {tools:?}"
    );
    teardown(&running).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the databases, a logged-in harness, and the user's own quota"]
async fn an_agent_can_answer_a_question_about_the_data() {
    // Reading rows, under a posture that allows them.
    let (running, url, token) = running(DataPosture::Samples).await;
    let db = &running.database;

    let (answer, tools) = ask(
        &url,
        &token,
        &format!(
            "Using the sqlpilot tools, what is the total of the quokka_count column in \
             {db}.zzquokka_ledger? Answer with the number."
        ),
    )
    .await;

    assert!(
        answer.contains("18"),
        "7 + 11 = 18, and the agent said: {answer}\ntools used: {tools:?}"
    );
    teardown(&running).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the databases, a logged-in harness, and the user's own quota"]
async fn a_schema_only_connection_gives_up_its_shape_and_not_its_rows() {
    // The posture, end to end: the agent can describe the table and cannot
    // read it, and is told which is which rather than left guessing.
    let (running, url, token) = running(DataPosture::SchemaOnly).await;
    let db = &running.database;

    let (answer, tools) = ask(
        &url,
        &token,
        &format!(
            "Using the sqlpilot tools, try to read the rows of {db}.zzquokka_ledger. Then tell me \
             two things: the names of its columns, and whether you were able to see any row \
             values."
        ),
    )
    .await;

    assert!(
        answer.contains("quokka_count"),
        "the shape should be available: {answer}\ntools used: {tools:?}"
    );
    // The numbers in the table. Their absence is the posture working.
    assert!(
        !answer.contains("11"),
        "a schema-only connection leaked a row value: {answer}"
    );
    teardown(&running).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the databases, a logged-in harness, and the user's own quota"]
async fn a_write_is_refused_when_there_is_no_window_to_approve_it_in() {
    // A headless endpoint — no app window — must not apply a write. The agent
    // is told why, and the row it tried to change is untouched.
    let (running, url, token) = running(DataPosture::Full).await;
    let db = &running.database;

    let (answer, tools) = ask(
        &url,
        &token,
        &format!(
            "Using the sqlpilot tools, set quokka_count to 999 for every row in \
             {db}.zzquokka_ledger. If you cannot, say why in one sentence."
        ),
    )
    .await;

    let survived: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM `{db}`.`zzquokka_ledger` WHERE quokka_count = 999"
    )))
    .fetch_one(&running.pool)
    .await
    .unwrap();
    assert_eq!(
        survived, 0,
        "a write was applied with nobody to approve it. The agent said: {answer}\ntools: {tools:?}"
    );

    teardown(&running).await;
}
