//! Asking the window a question and waiting for the answer.
//!
//! Tauri commands run frontend → backend. Everything in `Surface` runs the
//! other way: the tool call is in Rust and the answer is in React. This is the
//! one piece of machinery that makes that direction work — an event out, a
//! reply back through a command, matched by request id.
//!
//! Every request has a deadline, and a request whose window never answers
//! fails rather than holding the tool call open forever. That matters more
//! than it sounds: an MCP client with a hung tool call looks, to the person
//! using it, exactly like a broken app.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mas_mcp::surface::SurfaceError;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// How long a question about what is on screen may take.
///
/// Short: the window is answering from state it already has, and a user
/// waiting on an agent should not wait on a render.
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a proposal may wait for the user.
///
/// Long, because this one is waiting for a person to read a diff and decide,
/// and five minutes of thinking is not a failure. It is not unbounded: an
/// agent left hanging forever cannot report anything, and a diff nobody ever
/// answered should end as "they did not answer" rather than as silence.
pub const DECISION_TIMEOUT: Duration = Duration::from_secs(600);

/// What an agent is asking the window for.
///
/// A tagged union rather than a kind string and a bag of JSON: the frontend
/// gets a discriminated union it can switch on exhaustively, so adding a
/// question here is a type error there rather than a silently unhandled event.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentAsk {
    /// The tab the user is looking at.
    EditorContext,
    /// The result underneath it, if anything has been run.
    ResultContext,
    /// The last statement that failed.
    LastError,
    /// Show a diff and wait for the user to accept, reject, or edit it.
    ProposeEdit {
        tab: Option<String>,
        sql: String,
        rationale: String,
    },
    /// Open a new tab. Never touches an existing one.
    OpenDraft {
        sql: String,
        title: Option<String>,
        connection: Option<String>,
        database: Option<String>,
    },
}

/// A question put to the window.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    /// Echoed back with the answer.
    pub id: String,
    #[serde(flatten)]
    pub ask: AgentAsk,
}

/// How a request reaches the window.
pub type Emit = Arc<dyn Fn(AgentRequest) -> Result<(), String> + Send + Sync>;

/// Requests waiting for an answer.
#[derive(Default)]
pub struct WindowBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>,
    /// How to put a request in front of the window. `None` before the app has
    /// finished starting, which is when "there is no window" is the truth.
    emit: Mutex<Option<Emit>>,
}

impl WindowBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Give the bridge a way to reach the window.
    pub fn connect(&self, emit: Emit) {
        *self.emit.lock().unwrap_or_else(|e| e.into_inner()) = Some(emit);
    }

    /// Ask, and wait for the answer.
    pub async fn ask(
        &self,
        ask: AgentAsk,
        timeout: Duration,
    ) -> Result<serde_json::Value, SurfaceError> {
        let emit = {
            let guard = self.emit.lock().unwrap_or_else(|e| e.into_inner());
            guard.clone().ok_or(SurfaceError::NoWindow)?
        };

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);

        let request = AgentRequest {
            id: id.clone(),
            ask,
        };

        if let Err(e) = emit(request) {
            self.forget(&id);
            return Err(SurfaceError::Failed(e));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(reason))) => Err(SurfaceError::Failed(reason)),
            // The sender was dropped: the window went away mid-question.
            Ok(Err(_)) => Err(SurfaceError::Abandoned),
            Err(_) => {
                // Leaving the entry would leak one per timed-out request, and
                // a late answer would then resolve nothing.
                self.forget(&id);
                Err(SurfaceError::TimedOut)
            }
        }
    }

    /// The window's answer to one request.
    ///
    /// An id nobody is waiting for is not an error: the request may have timed
    /// out a moment ago, and the window has no way to know that.
    pub fn answer(&self, id: &str, value: Result<serde_json::Value, String>) {
        if let Some(sender) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            let _ = sender.send(value);
        }
    }

    /// Fail everything still waiting.
    ///
    /// Used when the last window closes. Without it, every open tool call
    /// waits out its full timeout for an answer that is never coming.
    pub fn abandon_all(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub fn waiting(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    fn forget(&self, id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collecting() -> (Arc<WindowBridge>, Arc<Mutex<Vec<AgentRequest>>>) {
        let bridge = Arc::new(WindowBridge::new());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        bridge.connect(Arc::new(move |request| {
            sink.lock().unwrap().push(request);
            Ok(())
        }));
        (bridge, seen)
    }

    #[tokio::test]
    async fn with_no_window_there_is_no_question_to_ask() {
        let bridge = WindowBridge::new();
        let error = bridge
            .ask(AgentAsk::EditorContext, READ_TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(error, SurfaceError::NoWindow);
    }

    #[tokio::test]
    async fn an_answer_comes_back_to_the_request_that_asked() {
        let (bridge, seen) = collecting();
        let asking = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.ask(AgentAsk::EditorContext, READ_TIMEOUT).await })
        };

        // The request reaches the window with an id to answer.
        let id = loop {
            if let Some(request) = seen.lock().unwrap().first() {
                break request.id.clone();
            }
            tokio::task::yield_now().await;
        };
        bridge.answer(&id, Ok(serde_json::json!({"sql": "SELECT 1"})));

        let answer = asking.await.unwrap().unwrap();
        assert_eq!(answer["sql"], "SELECT 1");
    }

    #[tokio::test]
    async fn two_questions_do_not_get_each_others_answers() {
        // The failure this prevents is the worst kind: a proposal accepted
        // because a different request was.
        let (bridge, seen) = collecting();
        let first = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.ask(AgentAsk::EditorContext, READ_TIMEOUT).await })
        };
        let second = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.ask(AgentAsk::LastError, READ_TIMEOUT).await })
        };

        let ids = loop {
            // Scoped so the guard is gone before the yield: holding a
            // std::sync lock across an await is how a test deadlocks itself.
            let collected = {
                let requests = seen.lock().unwrap();
                (requests.len() == 2).then(|| {
                    requests
                        .iter()
                        .map(|r| {
                            let which = match r.ask {
                                AgentAsk::EditorContext => "a",
                                _ => "b",
                            };
                            (which.to_string(), r.id.clone())
                        })
                        .collect::<Vec<_>>()
                })
            };
            if let Some(ids) = collected {
                break ids;
            }
            tokio::task::yield_now().await;
        };

        for (which, id) in &ids {
            bridge.answer(id, Ok(serde_json::json!({"which": which})));
        }

        assert_eq!(first.await.unwrap().unwrap()["which"], "a");
        assert_eq!(second.await.unwrap().unwrap()["which"], "b");
    }

    #[tokio::test]
    async fn a_question_nobody_answers_times_out_rather_than_hanging() {
        let (bridge, _seen) = collecting();
        let error = bridge
            .ask(AgentAsk::EditorContext, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert_eq!(error, SurfaceError::TimedOut);
        assert_eq!(bridge.waiting(), 0, "a timed-out request is forgotten");
    }

    #[tokio::test]
    async fn an_answer_to_a_request_that_already_timed_out_is_harmless() {
        // The window cannot know the deadline passed a moment ago.
        let (bridge, seen) = collecting();
        let _ = bridge
            .ask(AgentAsk::EditorContext, Duration::from_millis(20))
            .await;
        let id = seen.lock().unwrap()[0].id.clone();
        bridge.answer(&id, Ok(serde_json::json!({})));
    }

    #[tokio::test]
    async fn a_window_that_goes_away_ends_the_wait() {
        // Otherwise every open tool call waits out its full timeout for an
        // answer that is never coming.
        let (bridge, _seen) = collecting();
        let asking = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .ask(
                        AgentAsk::ProposeEdit {
                            tab: None,
                            sql: "SELECT 1".into(),
                            rationale: "why".into(),
                        },
                        DECISION_TIMEOUT,
                    )
                    .await
            })
        };
        while bridge.waiting() == 0 {
            tokio::task::yield_now().await;
        }

        bridge.abandon_all();

        assert_eq!(asking.await.unwrap().unwrap_err(), SurfaceError::Abandoned);
    }

    #[tokio::test]
    async fn a_failure_from_the_window_is_reported_as_one() {
        let (bridge, seen) = collecting();
        let asking = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .ask(
                        AgentAsk::OpenDraft {
                            sql: "SELECT 1".into(),
                            title: None,
                            connection: None,
                            database: None,
                        },
                        READ_TIMEOUT,
                    )
                    .await
            })
        };
        let id = loop {
            if let Some(request) = seen.lock().unwrap().first() {
                break request.id.clone();
            }
            tokio::task::yield_now().await;
        };

        bridge.answer(&id, Err("no connection selected".into()));

        assert_eq!(
            asking.await.unwrap().unwrap_err(),
            SurfaceError::Failed("no connection selected".into())
        );
    }

    #[tokio::test]
    async fn an_emit_that_fails_does_not_leave_a_request_waiting() {
        let bridge = WindowBridge::new();
        bridge.connect(Arc::new(|_| Err("window is gone".into())));

        let error = bridge
            .ask(AgentAsk::EditorContext, READ_TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(error, SurfaceError::Failed("window is gone".into()));
        assert_eq!(bridge.waiting(), 0);
    }
}
