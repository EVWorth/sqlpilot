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
use mas_agent::claude::{self, ClaudeSession};
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

/// The harness behind a session.
///
/// Two protocols, and everything above this point sees neither: the session
/// commands take an id and a message, and the events come out the same shape
/// whichever of these answered.
enum Driver {
    /// Copilot, over the Agent Client Protocol.
    Acp {
        client: Arc<AcpClient>,
        /// The harness's own session id, for `session/prompt`.
        remote: String,
    },
    /// Claude Code, over its own NDJSON stream.
    Claude(Arc<ClaudeSession>),
}

struct Running {
    driver: Driver,
    /// Held so the process is killed when the session is dropped.
    child: Child,
    workspace: PathBuf,
}

/// What starting a harness produced, before it is registered: the driver, the
/// process, the agent's name and version for the header, whether it has
/// SQLPilot's tools, and its event stream.
type Parts = (
    Driver,
    Child,
    String,
    String,
    bool,
    tokio::sync::mpsc::UnboundedReceiver<SessionEvent>,
);

/// A driver taken out of the register, so the lock is not held across an await.
enum DriverHandle {
    Acp {
        client: Arc<AcpClient>,
        remote: String,
    },
    Claude(Arc<ClaudeSession>),
}

/// The message for a harness that would not start.
fn not_started(harness: Harness, e: std::io::Error) -> String {
    format!(
        "Could not start {}: {e}. Install it with `{}`.",
        harness.label(),
        harness.install_hint()
    )
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

        let cwd = workspace.to_string_lossy().to_string();
        let started = match harness {
            Harness::Copilot => self.start_acp(harness, &cwd, endpoint).await,
            Harness::ClaudeCode => self.start_claude(&cwd, endpoint).await,
        };
        let (driver, child, agent, version, tools_available, mut events) = match started {
            Ok(parts) => parts,
            Err(e) => {
                // The directory was made for a session that never happened.
                let _ = std::fs::remove_dir_all(&workspace);
                return Err(e);
            }
        };

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
                    driver,
                    child,
                    workspace,
                },
            );

        Ok(StartedSession {
            session: id,
            agent,
            version,
            tools_available,
        })
    }

    /// Copilot: handshake, then a session with our server in it.
    async fn start_acp(
        &self,
        harness: Harness,
        cwd: &str,
        endpoint: Option<(String, String)>,
    ) -> Result<Parts, String> {
        let mut child = spawn_acp(harness, cwd).map_err(|e| not_started(harness, e))?;
        let stdout = child.stdout.take().ok_or("The agent has no output.")?;
        let stdin = child.stdin.take().ok_or("The agent takes no input.")?;

        let (client, events) = AcpClient::new(stdout, stdin);
        let info = client.initialize().await?;

        // No endpoint means no database tools. The session still works — an
        // agent that can read its working directory is useful — so this is
        // reported rather than refused.
        let servers = match &endpoint {
            Some((url, token)) if info.http_mcp => vec![McpServer::sqlpilot(url, token)],
            _ => Vec::new(),
        };
        let tools_available = !servers.is_empty();
        let remote = client.new_session(cwd, &servers).await?;

        Ok((
            Driver::Acp { client, remote },
            child,
            info.name,
            info.version,
            tools_available,
            events,
        ))
    }

    /// Claude Code: one process, configured entirely by its arguments.
    ///
    /// There is no handshake to read a version from, so the version is asked
    /// for separately — a session header that says which agent is answering is
    /// worth one extra process at startup.
    async fn start_claude(
        &self,
        cwd: &str,
        endpoint: Option<(String, String)>,
    ) -> Result<Parts, String> {
        let config = endpoint
            .as_ref()
            .map(|(url, token)| claude::mcp_config(url, token));
        let tools_available = config.is_some();

        let mut child = claude::spawn(cwd, config.as_deref())
            .map_err(|e| not_started(Harness::ClaudeCode, e))?;
        let stdout = child.stdout.take().ok_or("The agent has no output.")?;
        let stdin = child.stdin.take().ok_or("The agent takes no input.")?;

        let (session, events) = ClaudeSession::attach(stdout, stdin);
        let version = mas_agent::harness::version_of(Harness::ClaudeCode)
            .await
            .unwrap_or_default();

        Ok((
            Driver::Claude(session),
            child,
            Harness::ClaudeCode.label().to_string(),
            version,
            tools_available,
            events,
        ))
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
        let driver = self.handle(session)?;
        let id = session.to_string();
        tokio::spawn(async move {
            match driver {
                DriverHandle::Acp { client, remote } => {
                    // ACP's prompt call resolves when the turn ends, so the
                    // ending is reported from here.
                    let event = match client.prompt(&remote, &text).await {
                        Ok(reason) => SessionEvent::TurnEnded { reason },
                        Err(message) => SessionEvent::Failed { message },
                    };
                    emit(AgentSessionEvent { session: id, event });
                }
                DriverHandle::Claude(claude) => {
                    // Claude's stream reports its own ending, so only a
                    // failure to send is worth an event here.
                    if let Err(message) = claude.prompt(&text).await {
                        emit(AgentSessionEvent {
                            session: id,
                            event: SessionEvent::Failed { message },
                        });
                    }
                }
            }
        });
        Ok(())
    }

    pub async fn cancel(&self, session: &str) -> Result<(), String> {
        match self.handle(session)? {
            DriverHandle::Acp { client, remote } => {
                client.cancel(&remote).await;
                Ok(())
            }
            DriverHandle::Claude(claude) => claude.cancel().await,
        }
    }

    /// Answer a permission request. `None` means the user did not decide.
    pub async fn answer_permission(
        &self,
        session: &str,
        request: &str,
        option: Option<String>,
    ) -> Result<(), String> {
        match self.handle(session)? {
            DriverHandle::Acp { client, .. } => {
                client.answer_permission(request, option.as_deref()).await;
                Ok(())
            }
            // Claude Code sessions answer their own prompts with "no" — the
            // session has SQLPilot's tools allow-listed and nothing else — so
            // there is never one of these waiting.
            DriverHandle::Claude(_) => Ok(()),
        }
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

    /// The driver for a session, taken out of the register so the lock is not
    /// held across an await.
    fn handle(&self, session: &str) -> Result<DriverHandle, String> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let running = sessions
            .get(session)
            .ok_or_else(|| "That session is not running any more. Start a new one.".to_string())?;
        Ok(match &running.driver {
            Driver::Acp { client, remote } => DriverHandle::Acp {
                client: client.clone(),
                remote: remote.clone(),
            },
            Driver::Claude(claude) => DriverHandle::Claude(claude.clone()),
        })
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
