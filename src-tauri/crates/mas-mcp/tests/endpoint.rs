//! The endpoint, over real HTTP.
//!
//! The tools have their own tests against a fake workspace, and the token has
//! unit tests. What neither covers is the thing in between: that a harness
//! pointed at this URL gets an MCP server, that the token is actually required
//! by the wire and not merely computed, and that an unauthenticated request
//! cannot reach a tool. Those are wiring failures, and wiring failures are
//! invisible to every test that does not use a socket.

use std::sync::Arc;

use mas_core::error::CoreError;
use mas_core::history::HistoryEntry;
use mas_core::models::query::{ColumnMeta, QueryResult, SqlValue};
use mas_core::query::{ExplainFormat, ExplainResponse};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RoutineInfo, SchemaMatch,
    TableInfo, TriggerInfo, ViewInfo,
};
use mas_mcp::endpoint;
use mas_mcp::grants::{ConnectionFacts, Grant, Grants};
use mas_mcp::workspace::{HistoryFilter, LiveConnection, ObjectKind, StagedWrite, Workspace};
use serde_json::json;

/// A workspace with one shared connection and nothing else.
struct OneConnection;

#[async_trait::async_trait]
impl Workspace for OneConnection {
    fn grants(&self) -> Grants {
        let mut grants = Grants::default();
        grants.set(Grant::new("c1"));
        grants
    }

    fn live_connections(&self) -> Vec<LiveConnection> {
        vec![LiveConnection {
            id: "c1".into(),
            name: "shop".into(),
            server_version: "8.0.46".into(),
            environment: "development".into(),
            read_only: false,
            default_database: Some("shop".into()),
        }]
    }

    fn facts(&self, connection_id: &str) -> Option<ConnectionFacts> {
        (connection_id == "c1").then(|| ConnectionFacts {
            id: "c1".into(),
            name: "shop".into(),
            environment: Some("development".into()),
            read_only: false,
        })
    }

    async fn databases(&self, _: &str) -> Result<Vec<DatabaseInfo>, CoreError> {
        Ok(vec![DatabaseInfo {
            name: "shop".into(),
            default_charset: "utf8mb4".into(),
            default_collation: "utf8mb4_0900_ai_ci".into(),
            is_system: false,
        }])
    }

    async fn tables(&self, _: &str, _: &str) -> Result<Vec<TableInfo>, CoreError> {
        Ok(vec![])
    }

    async fn columns(&self, _: &str, _: &str, _: &str) -> Result<Vec<ColumnInfo>, CoreError> {
        Ok(vec![])
    }

    async fn indexes(&self, _: &str, _: &str, _: &str) -> Result<Vec<IndexInfo>, CoreError> {
        Ok(vec![])
    }

    async fn foreign_keys(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Vec<ForeignKeyInfo>, CoreError> {
        Ok(vec![])
    }

    async fn referencing_keys(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Vec<ReferencingKey>, CoreError> {
        Ok(vec![])
    }

    async fn views(&self, _: &str, _: &str) -> Result<Vec<ViewInfo>, CoreError> {
        Ok(vec![])
    }

    async fn routines(&self, _: &str, _: &str) -> Result<Vec<RoutineInfo>, CoreError> {
        Ok(vec![])
    }

    async fn triggers(&self, _: &str, _: &str) -> Result<Vec<TriggerInfo>, CoreError> {
        Ok(vec![])
    }

    async fn ddl(&self, _: &str, _: &str, _: &str, _: ObjectKind) -> Result<String, CoreError> {
        Ok(String::new())
    }

    async fn search_schema(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: u32,
    ) -> Result<Vec<SchemaMatch>, CoreError> {
        Ok(vec![])
    }

    async fn stage_write(
        &self,
        _: &str,
        _: Option<&str>,
        _: &str,
    ) -> Result<StagedWrite, CoreError> {
        Ok(StagedWrite {
            id: "staged-1".into(),
            rows_affected: 1,
        })
    }

    async fn commit_write(&self, _: &str) -> Result<u64, CoreError> {
        Ok(1)
    }

    async fn rollback_write(&self, _: &str) -> Result<(), CoreError> {
        Ok(())
    }

    async fn run_ddl(&self, _: &str, _: Option<&str>, _: &str) -> Result<(), CoreError> {
        Ok(())
    }

    async fn history(&self, _: HistoryFilter) -> Result<Vec<HistoryEntry>, CoreError> {
        Ok(vec![])
    }

    async fn explain(
        &self,
        _: &str,
        _: Option<&str>,
        sql: &str,
        _: bool,
        format: ExplainFormat,
    ) -> Result<ExplainResponse, CoreError> {
        Ok(ExplainResponse {
            result: self.run("", None, sql, None).await?,
            analyzed: false,
            refusal: None,
            tabular: true,
            format,
            format_fallback: None,
        })
    }

    async fn run(
        &self,
        _: &str,
        _: Option<&str>,
        sql: &str,
        _: Option<u32>,
    ) -> Result<QueryResult, CoreError> {
        Ok(QueryResult {
            query_id: "q".into(),
            statement_index: 0,
            sql: sql.to_string(),
            columns: vec![ColumnMeta {
                name: "one".into(),
                data_type: "int".into(),
                nullable: false,
                is_primary_key: false,
            }],
            rows: vec![vec![SqlValue::Int(1)]],
            rows_affected: 0,
            execution_time_ms: 0,
            warnings: vec![],
            rows_truncated: false,
            truncation_reason: None,
            total_rows_available: None,
        })
    }
}

struct Running {
    url: String,
    token: String,
    endpoint: Option<endpoint::Endpoint>,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.stop();
        }
    }
}

async fn start() -> Running {
    // Port 0: these tests must not fight each other, or the user's own running
    // copy of the app, over the preferred port.
    let endpoint = endpoint::start(Arc::new(OneConnection), None, "test-token".into(), 0)
        .await
        .expect("the endpoint starts");
    Running {
        url: endpoint.url(),
        token: endpoint.token.clone(),
        endpoint: Some(endpoint),
    }
}

/// Initialize, and return the session id the server assigned.
async fn initialize(client: &reqwest::Client, running: &Running) -> String {
    let response = client
        .post(&running.url)
        .bearer_auth(&running.token)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"}
            }
        }))
        .send()
        .await
        .expect("initialize is answered");

    assert!(
        response.status().is_success(),
        "initialize failed: {}",
        response.status()
    );
    response
        .headers()
        .get("mcp-session-id")
        .expect("a session id comes back")
        .to_str()
        .unwrap()
        .to_string()
}

async fn call(
    client: &reqwest::Client,
    running: &Running,
    session: &str,
    body: serde_json::Value,
) -> String {
    client
        .post(&running.url)
        .bearer_auth(&running.token)
        .header("Accept", "application/json, text/event-stream")
        .header("mcp-session-id", session)
        .json(&body)
        .send()
        .await
        .expect("the call is answered")
        .text()
        .await
        .expect("a body")
}

#[tokio::test]
async fn a_request_without_the_token_is_refused() {
    let running = start().await;
    let response = reqwest::Client::new()
        .post(&running.url)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
    // Named so a misconfigured harness can tell its user what to do.
    assert!(response.text().await.unwrap().contains("token"));
}

#[tokio::test]
async fn a_request_with_the_wrong_token_is_refused() {
    let running = start().await;
    let response = reqwest::Client::new()
        .post(&running.url)
        .bearer_auth("not-the-token")
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn the_endpoint_only_listens_on_loopback() {
    // The one property of this server that would be a disaster to get wrong.
    let endpoint = endpoint::start(Arc::new(OneConnection), None, "t".into(), 0)
        .await
        .unwrap();
    assert!(endpoint.address.ip().is_loopback(), "{}", endpoint.address);
    endpoint.stop();
}

#[tokio::test]
async fn a_harness_can_list_the_tools() {
    let running = start().await;
    let client = reqwest::Client::new();
    let session = initialize(&client, &running).await;

    let body = call(
        &client,
        &running,
        &session,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    )
    .await;

    // The tools a harness needs to get started, by the names the design
    // settled on. A rename here is a breaking change for every config anyone
    // has written, so it should fail loudly.
    for tool in [
        "list_connections",
        "list_databases",
        "list_tables",
        "describe_table",
        "get_ddl",
        "list_objects",
        "search_schema",
        "related_tables",
        "run_select",
        "explain",
        "table_stats",
        "profile_column",
        "get_editor_context",
        "get_result_context",
        "get_last_error",
        "propose_edit",
        "open_draft",
        "query_history",
        "run_write",
        "run_ddl",
        "estimate_impact",
    ] {
        assert!(body.contains(tool), "{tool} is missing from tools/list");
    }
}

#[tokio::test]
async fn the_instructions_tell_a_harness_where_to_start() {
    let running = start().await;
    let client = reqwest::Client::new();

    let response = client
        .post(&running.url)
        .bearer_auth(&running.token)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"}
            }
        }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(response.contains("list_connections"), "{response}");
}

#[tokio::test]
async fn a_tool_call_reaches_the_workspace() {
    let running = start().await;
    let client = reqwest::Client::new();
    let session = initialize(&client, &running).await;

    let body = call(
        &client,
        &running,
        &session,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "list_connections", "arguments": {}}
        }),
    )
    .await;

    assert!(body.contains("shop"), "{body}");
    assert!(body.contains("8.0.46"), "{body}");
}

#[tokio::test]
async fn a_refusal_comes_back_as_a_tool_error_and_not_a_dropped_call() {
    // A model can act on a tool error. A transport failure just looks broken.
    let running = start().await;
    let client = reqwest::Client::new();
    let session = initialize(&client, &running).await;

    let body = call(
        &client,
        &running,
        &session,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "run_select",
                "arguments": {"connection": "c1", "sql": "SELECT 1; DROP TABLE users"}
            }
        }),
    )
    .await;

    assert!(
        body.contains("isError") || body.contains("is_error"),
        "{body}"
    );
    assert!(body.contains("one at a time"), "{body}");
}

#[tokio::test]
async fn a_request_from_a_web_page_is_refused_even_with_the_token() {
    // A page cannot read our replies — nothing here sends CORS headers — but
    // DNS rebinding can make one same-origin with 127.0.0.1, and a request it
    // cannot read is still a request that ran. No harness sends `Origin`; a
    // browser always does.
    let running = start().await;

    let response = reqwest::Client::new()
        .post(&running.url)
        .bearer_auth(&running.token)
        .header("Origin", "https://example.com")
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 403);
    assert!(response.text().await.unwrap().contains("web pages"));
}

#[tokio::test]
async fn a_page_pretending_to_be_the_app_itself_is_refused_too() {
    // "Origin: http://127.0.0.1:47311" is what a rebound page would send.
    let running = start().await;

    let response = reqwest::Client::new()
        .post(&running.url)
        .bearer_auth(&running.token)
        .header("Origin", "http://127.0.0.1:47311")
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 403);
}
