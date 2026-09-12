//! The window, behind the surface trait.
//!
//! Each method is one question to the frontend and one answer back, shaped
//! into the types `mas-mcp` returns. The shaping is here rather than in the
//! frontend so that a change to what an agent sees is a change in one file,
//! and so the window cannot decide — by leaving a field out — that something
//! should not be reported.

use std::sync::Arc;
use std::time::Duration;

use mas_mcp::surface::{EditOutcome, EditorContext, RawResult, Surface, SurfaceError};
use serde::Deserialize;

use crate::mcp::bridge::{AgentAsk, WindowBridge, DECISION_TIMEOUT, READ_TIMEOUT};

pub struct WindowSurface {
    bridge: Arc<WindowBridge>,
}

impl WindowSurface {
    pub fn new(bridge: Arc<WindowBridge>) -> Self {
        Self { bridge }
    }

    async fn ask<T: serde::de::DeserializeOwned>(
        &self,
        ask: AgentAsk,
        timeout: Duration,
    ) -> Result<T, SurfaceError> {
        let value = self.bridge.ask(ask, timeout).await?;
        // A shape mismatch is a bug in the pair of this file and the frontend
        // handler, not something the agent did. Saying so beats a serde
        // message about a missing field at line 1 column 87.
        serde_json::from_value(value).map_err(|e| {
            SurfaceError::Failed(format!(
                "SQLPilot answered with something this version does not understand: {e}"
            ))
        })
    }
}

/// The window's answer for `get_result_context`.
///
/// Deserialised into its own type rather than into `RawResult` so the wire
/// shape can stay camelCase without putting serde attributes on a type in
/// `mas-mcp` that has nothing to do with this app's IPC.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultAnswer {
    sql: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    row_count: usize,
    execution_time_ms: u64,
    truncated: bool,
    connection: Option<String>,
}

#[async_trait::async_trait]
impl Surface for WindowSurface {
    async fn editor_context(&self) -> Result<EditorContext, SurfaceError> {
        self.ask(AgentAsk::EditorContext, READ_TIMEOUT).await
    }

    async fn result_context(&self) -> Result<Option<RawResult>, SurfaceError> {
        let answer: Option<ResultAnswer> = self.ask(AgentAsk::ResultContext, READ_TIMEOUT).await?;
        Ok(answer.map(|a| RawResult {
            sql: a.sql,
            columns: a.columns,
            rows: a.rows,
            row_count: a.row_count,
            execution_time_ms: a.execution_time_ms,
            truncated: a.truncated,
            connection: a.connection,
        }))
    }

    async fn propose_edit(
        &self,
        tab: Option<String>,
        sql: String,
        rationale: String,
    ) -> Result<EditOutcome, SurfaceError> {
        // The long timeout: this one is waiting for a person to read a diff.
        self.ask(
            AgentAsk::ProposeEdit {
                tab,
                sql,
                rationale,
            },
            DECISION_TIMEOUT,
        )
        .await
    }

    async fn open_draft(
        &self,
        sql: String,
        title: Option<String>,
        connection: Option<String>,
        database: Option<String>,
    ) -> Result<String, SurfaceError> {
        self.ask(
            AgentAsk::OpenDraft {
                sql,
                title,
                connection,
                database,
            },
            READ_TIMEOUT,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A bridge that answers whatever the test says, immediately.
    fn answering(answer: serde_json::Value) -> Arc<WindowBridge> {
        let bridge = Arc::new(WindowBridge::new());
        let inner = bridge.clone();
        let answer = Arc::new(Mutex::new(answer));
        bridge.connect(Arc::new(move |request| {
            let answer = answer.lock().unwrap().clone();
            inner.answer(&request.id, Ok(answer));
            Ok(())
        }));
        bridge
    }

    #[tokio::test]
    async fn an_editor_context_arrives_as_the_agent_sees_it() {
        let surface = WindowSurface::new(answering(serde_json::json!({
            "tab": "t1",
            "title": "Untitled Query",
            "connection": "p1",
            "database": "shop",
            "sql": "SELECT * FROM orders",
            "selection": "FROM orders",
        })));

        let context = surface.editor_context().await.unwrap();
        assert_eq!(context.tab, "t1");
        assert_eq!(context.selection.as_deref(), Some("FROM orders"));
    }

    #[tokio::test]
    async fn a_window_with_no_result_yet_says_so_rather_than_failing() {
        // "Nothing has been run" is an answer, and an agent can act on it.
        let surface = WindowSurface::new(answering(serde_json::Value::Null));
        assert!(surface.result_context().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_result_keeps_the_connection_it_came_from() {
        // Without it there is no posture to apply, and the rows would either
        // leak or be withheld from every connection alike.
        let surface = WindowSurface::new(answering(serde_json::json!({
            "sql": "SELECT 1",
            "columns": ["one"],
            "rows": [[1]],
            "rowCount": 1,
            "executionTimeMs": 3,
            "truncated": false,
            "connection": "p1",
        })));

        let result = surface.result_context().await.unwrap().unwrap();
        assert_eq!(result.connection.as_deref(), Some("p1"));
        assert_eq!(result.rows.len(), 1);
    }

    #[tokio::test]
    async fn an_answer_this_version_cannot_read_says_which_side_is_wrong() {
        // Not the agent's fault, and a serde message about column 87 would
        // send it rewriting its arguments.
        let surface = WindowSurface::new(answering(serde_json::json!({"tab": 7})));
        let error = surface.editor_context().await.unwrap_err().to_string();
        assert!(error.contains("SQLPilot answered"), "{error}");
    }

    #[tokio::test]
    async fn a_rejected_proposal_comes_back_as_a_decision_not_an_error() {
        let surface = WindowSurface::new(answering(
            serde_json::json!({"accepted": false, "edited": false}),
        ));
        let outcome = surface
            .propose_edit(None, "SELECT 1".into(), "faster".into())
            .await
            .unwrap();
        assert!(!outcome.accepted);
        assert!(outcome.sql.is_none());
    }

    #[tokio::test]
    async fn an_edited_acceptance_carries_what_the_user_actually_kept() {
        let surface = WindowSurface::new(answering(serde_json::json!({
            "accepted": true,
            "edited": true,
            "sql": "SELECT id FROM orders LIMIT 10",
        })));
        let outcome = surface
            .propose_edit(
                Some("t1".into()),
                "SELECT id FROM orders".into(),
                "why".into(),
            )
            .await
            .unwrap();
        assert!(outcome.accepted && outcome.edited);
        assert_eq!(
            outcome.sql.as_deref(),
            Some("SELECT id FROM orders LIMIT 10")
        );
    }

    #[tokio::test]
    async fn every_question_fails_the_same_way_with_no_window() {
        let surface = WindowSurface::new(Arc::new(WindowBridge::new()));
        assert_eq!(
            surface.editor_context().await.unwrap_err(),
            SurfaceError::NoWindow
        );
        assert_eq!(
            surface
                .open_draft("SELECT 1".into(), None, None, None)
                .await
                .unwrap_err(),
            SurfaceError::NoWindow
        );
    }
}
