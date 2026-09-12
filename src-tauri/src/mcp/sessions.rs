//! Agent sessions running inside the app.
//!
//! One process per session, spawned from the user's own CLI, with SQLPilot's
//! MCP endpoint handed to it at startup — so the agent in the panel has
//! exactly the tools the policy allows and nothing else, without the user
//! editing a config file.
//!
//! Each session gets its own working directory under the app's data folder.
//! That is deliberate: a harness launched in the user's home or in whatever
//! repository they last opened picks up that directory's instructions, MCP
//! servers and memory. A session opened from a database client should have the
//! database tools and nothing it inherited by accident.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mas_agent::acp::{AcpClient, McpServer};
use mas_agent::event::SessionEvent;
use mas_agent::harness::{spawn_acp, Harness};
use serde::{Deserialize, Serialize};
use tokio::process::Child;

/// A session event, addressed to the session it came from.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionEvent {
    /// SQLPilot's id for the session, not the harness's.
    pub session: String,
    pub event: SessionEvent,
}

/// What starting a session produced.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartedSession {
    pub session: String,
    /// What the harness calls itself, and its version — worth showing, because
    /// "which model am I talking to" is answered by the harness, not by us.
    pub agent: String,
    pub version: String,
    /// False when the harness cannot take an HTTP MCP server, which means the
    /// session has no database tools at all. The panel says so rather than
    /// leaving the user to wonder why the agent cannot see anything.
    pub tools_available: bool,
}

struct Running {
    client: Arc<AcpClient>,
    /// The harness's own session id, for `session/prompt`.
    remote: String,
    /// Held so the process is killed when the session is dropped.
    child: Child,
    workspace: PathBuf,
}

#[derive(Default)]
pub struct AgentSessions {
    sessions: Mutex<HashMap<String, Running>>,
}

impl AgentSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a harness, open a session, and wire SQLPilot's tools into it.
    ///
    /// `emit` is how events reach the window; it is passed in rather than held
    /// so that this type has no opinion about Tauri.
    pub async fn start(
        &self,
        harness: Harness,
        data_dir: &std::path::Path,
        endpoint: Option<(String, String)>,
        emit: impl Fn(AgentSessionEvent) + Send + Sync + 'static,
    ) -> Result<StartedSession, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let workspace = data_dir.join("agent-sessions").join(&id);
        std::fs::create_dir_all(&workspace).map_err(|e| {
            format!(
                "Could not make a working directory for the session at {}: {e}",
                workspace.display()
            )
        })?;

        let mut child = spawn_acp(harness, &workspace.to_string_lossy()).map_err(|e| {
            format!(
                "Could not start {}: {e}. Install it with `{}`.",
                harness.label(),
                harness.install_hint()
            )
        })?;
        let stdout = child.stdout.take().ok_or("The agent has no output.")?;
        let stdin = child.stdin.take().ok_or("The agent takes no input.")?;

        let (client, mut events) = AcpClient::new(stdout, stdin);
        let info = client.initialize().await?;

        // No endpoint means no database tools. The session still works — an
        // agent that can read the repository is useful — so this is reported
        // rather than refused.
        let servers = match &endpoint {
            Some((url, token)) if info.http_mcp => vec![McpServer::sqlpilot(url, token)],
            _ => Vec::new(),
        };
        let tools_available = !servers.is_empty();

        let remote = client
            .new_session(&workspace.to_string_lossy(), &servers)
            .await?;

        // Forward events until the agent stops.
        let session_id = id.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                emit(AgentSessionEvent {
                    session: session_id.clone(),
                    event,
                });
            }
        });

        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.clone(),
                Running {
                    client,
                    remote,
                    child,
                    workspace,
                },
            );

        Ok(StartedSession {
            session: id,
            agent: info.name,
            version: info.version,
            tools_available,
        })
    }

    /// Send a turn. Returns at once; the answer arrives as events.
    ///
    /// A turn can take minutes, and a command that waits for one would leave
    /// the UI unable to do anything else — including cancel it.
    pub fn send(
        &self,
        session: &str,
        text: String,
        emit: impl Fn(AgentSessionEvent) + Send + Sync + 'static,
    ) -> Result<(), String> {
        let (client, remote) = self.handle(session)?;
        let id = session.to_string();
        tokio::spawn(async move {
            let event = match client.prompt(&remote, &text).await {
                Ok(reason) => SessionEvent::TurnEnded { reason },
                Err(message) => SessionEvent::Failed { message },
            };
            emit(AgentSessionEvent { session: id, event });
        });
        Ok(())
    }

    pub async fn cancel(&self, session: &str) -> Result<(), String> {
        let (client, remote) = self.handle(session)?;
        client.cancel(&remote).await;
        Ok(())
    }

    /// Answer a permission request. `None` means the user did not decide.
    pub async fn answer_permission(
        &self,
        session: &str,
        request: &str,
        option: Option<String>,
    ) -> Result<(), String> {
        let (client, _) = self.handle(session)?;
        client.answer_permission(request, option.as_deref()).await;
        Ok(())
    }

    /// End a session and clean up after it.
    ///
    /// The working directory goes too. It exists only to give the harness a
    /// place to stand, and leaving one per session behind would grow without
    /// limit in a folder nobody looks at.
    pub fn stop(&self, session: &str) {
        let running = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
        if let Some(mut running) = running {
            // `kill_on_drop` covers the drop, but asking first means the agent
            // gets to shut down rather than being killed mid-write.
            let _ = running.child.start_kill();
            let _ = std::fs::remove_dir_all(&running.workspace);
        }
    }

    /// Stop everything. Called when the app is closing.
    pub fn stop_all(&self) {
        let ids: Vec<String> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn count(&self) -> usize {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    fn handle(&self, session: &str) -> Result<(Arc<AcpClient>, String), String> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let running = sessions
            .get(session)
            .ok_or_else(|| "That session is not running any more. Start a new one.".to_string())?;
        Ok((running.client.clone(), running.remote.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_session_that_does_not_exist_is_a_message_rather_than_a_panic() {
        let sessions = AgentSessions::new();
        let error = sessions
            .cancel("nope")
            .await
            .expect_err("there is no such session");
        assert!(error.contains("not running"), "{error}");
    }

    #[tokio::test]
    async fn sending_to_a_dead_session_says_so() {
        let sessions = AgentSessions::new();
        assert!(sessions.send("nope", "hi".into(), |_| {}).is_err());
    }

    #[test]
    fn stopping_something_that_was_never_started_does_nothing() {
        let sessions = AgentSessions::new();
        sessions.stop("nope");
        sessions.stop_all();
        assert_eq!(sessions.count(), 0);
    }

    #[tokio::test]
    async fn a_harness_that_is_not_installed_says_how_to_install_it() {
        // The BYOH failure mode: SQLPilot does not install agents, so the
        // message has to carry the command that does.
        let sessions = AgentSessions::new();
        let dir = tempfile::tempdir().unwrap();

        let error = sessions
            .start(Harness::ClaudeCode, dir.path(), None, |_| {})
            .await
            .err();

        // Skipped where the harness really is installed: this asserts the
        // message, not the machine.
        if let Some(error) = error {
            assert!(error.contains("npm install"), "{error}");
            assert!(error.contains("Claude Agent"), "{error}");
        }
    }
}
