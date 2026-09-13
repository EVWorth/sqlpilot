//! What the Settings → Agents screen can do.
//!
//! Sharing a connection with an agent is a decision the user makes once and
//! lives with afterwards, so all of it is here in one place: which connections
//! are shared, on what terms, where the harness connects, and how to stop.
//!
//! Nothing in this module decides whether a *call* is allowed — that is
//! `mas-mcp`'s job and it happens per tool call. These commands decide what is
//! on the table at all.

use mas_core::connection::store::StoredGrant;
use mas_mcp::grants::{Grant, Grants};
use mas_mcp::policy::DataPosture;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::mcp::sessions::StartedSession;
use crate::mcp::{AgentSessions, AgentState};
use mas_agent::harness::HarnessStatus;

/// A connection as the settings screen shows it: what it is, and how it is
/// shared, if it is.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnection {
    pub connection_id: String,
    pub name: String,
    /// "development", "staging", "production", or "unknown".
    pub environment: String,
    pub read_only: bool,
    /// Whether the connection is live right now. A grant on a connection that
    /// is not connected is not an error — it takes effect when it connects —
    /// but the screen should say so rather than implying an agent can use it.
    pub connected: bool,
    /// None when the connection is not shared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posture: Option<DataPosture>,
    /// The databases it is shared for, when it is not all of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub databases: Option<Vec<String>>,
    /// Column-name patterns this connection hides, on top of the built-in
    /// credential list.
    pub redact: Vec<String>,
    /// Whether this session may make schema changes on a production
    /// connection. Never persisted; see `mas_mcp::grants`.
    pub ddl_unlocked: bool,
}

/// Where a harness connects, if anywhere.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentEndpoint {
    pub running: bool,
    /// The URL to configure a harness with. Present whenever it is running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The bearer token. Shown in the app because the user has to paste it
    /// into their own harness; it is not a secret from them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// What SQLPilot can write setup instructions for.
///
/// Wider than the harnesses it can *run* in-app: any MCP client can use the
/// endpoint, and the third case exists so there is always an answer for one
/// this list has not caught up with.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SetupTarget {
    ClaudeCode,
    Copilot,
    /// Anything else that speaks MCP over HTTP. Shown as the raw values, so
    /// there is always an answer for a harness this list has not caught up
    /// with.
    Other,
}

/// Every connection, with its sharing state.
#[tauri::command]
#[specta::specta]
pub async fn list_agent_connections(
    state: State<'_, AppState>,
    agents: State<'_, AgentState>,
) -> Result<Vec<AgentConnection>, String> {
    let profiles = state.connection_store.list().map_err(|e| e.to_string())?;
    let grants = agents.state.grants();
    let live: std::collections::HashSet<String> = state
        .connection_manager
        .list_connections()
        .into_iter()
        .map(|info| info.profile_id)
        .collect();

    Ok(profiles
        .into_iter()
        .map(|profile| {
            let grant = grants.get(&profile.id);
            AgentConnection {
                connected: live.contains(&profile.id),
                environment: profile
                    .environment
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                read_only: profile.read_only,
                posture: grant.map(|g| g.posture),
                databases: grant.and_then(|g| g.databases.clone()),
                redact: grant.map(|g| g.redact.clone()).unwrap_or_default(),
                ddl_unlocked: grant.is_some_and(|g| g.ddl_unlocked),
                connection_id: profile.id,
                name: profile.name,
            }
        })
        .collect())
}

/// Share a connection with agents, or change the terms it is shared on.
///
/// `redact` names column patterns whose values never leave. The built-in
/// credential list applies regardless of what is passed here.
#[tauri::command]
#[specta::specta]
pub async fn share_connection_with_agents(
    state: State<'_, AppState>,
    agents: State<'_, AgentState>,
    connection_id: String,
    posture: DataPosture,
    databases: Option<Vec<String>>,
    redact: Option<Vec<String>>,
) -> Result<(), String> {
    // An empty list would be a grant that shares nothing, which is a confusing
    // way to spell "revoke". Treated as "every database", which is what the
    // absence of a restriction means everywhere else.
    let databases = databases.filter(|list| !list.is_empty());
    // Blank entries dropped here as well as in the matcher: a pattern that
    // survives to storage is one someone will later wonder about.
    let redact: Vec<String> = redact
        .unwrap_or_default()
        .into_iter()
        .map(|pattern| pattern.trim().to_string())
        .filter(|pattern| !pattern.is_empty())
        .collect();

    state
        .connection_store
        .save_agent_grant(&StoredGrant {
            connection_id: connection_id.clone(),
            posture: posture_to_stored(posture).to_string(),
            databases: databases
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| e.to_string())?,
            redact: (!redact.is_empty())
                .then(|| serde_json::to_string(&redact))
                .transpose()
                .map_err(|e| e.to_string())?,
        })
        .map_err(|e| e.to_string())?;

    let mut grant = Grant::new(connection_id).with_posture(posture);
    grant.databases = databases;
    grant.redact = redact;
    agents.state.set(grant);
    Ok(())
}

/// Stop sharing a connection. Takes effect at the agent's next tool call.
#[tauri::command]
#[specta::specta]
pub async fn revoke_agent_connection(
    state: State<'_, AppState>,
    agents: State<'_, AgentState>,
    connection_id: String,
) -> Result<(), String> {
    state
        .connection_store
        .delete_agent_grant(&connection_id)
        .map_err(|e| e.to_string())?;
    agents.state.revoke(&connection_id);
    Ok(())
}

/// Allow, or stop allowing, schema changes on a production connection.
///
/// Deliberately not persisted: it lapses when the app closes. Someone who
/// unlocked production to let an agent add an index this afternoon should not
/// find it still unlocked next week.
#[tauri::command]
#[specta::specta]
pub async fn unlock_agent_ddl(
    agents: State<'_, AgentState>,
    connection_id: String,
    unlocked: bool,
) -> Result<(), String> {
    agents.state.unlock_ddl(&connection_id, unlocked);
    Ok(())
}

/// Where a harness connects, if the endpoint is running.
#[tauri::command]
#[specta::specta]
pub async fn agent_endpoint_status(agents: State<'_, AgentState>) -> Result<AgentEndpoint, String> {
    Ok(agents.status())
}

/// Start listening for harnesses.
#[tauri::command]
#[specta::specta]
pub async fn start_agent_endpoint(
    state: State<'_, AppState>,
    agents: State<'_, AgentState>,
) -> Result<AgentEndpoint, String> {
    agents.start(&state).await.map_err(|e| e.to_string())?;
    Ok(agents.status())
}

/// Stop listening. Harnesses lose the connection at once.
#[tauri::command]
#[specta::specta]
pub async fn stop_agent_endpoint(agents: State<'_, AgentState>) -> Result<AgentEndpoint, String> {
    agents.stop();
    Ok(agents.status())
}

/// Issue a new token, invalidating the old one.
///
/// Every configured harness stops working until it is given the new token.
/// That is the point of the button.
#[tauri::command]
#[specta::specta]
pub async fn rotate_agent_token(
    state: State<'_, AppState>,
    agents: State<'_, AgentState>,
) -> Result<AgentEndpoint, String> {
    // Rotating restarts a running endpoint rather than leaving it stopped: the
    // user asked for a new token, not for their agents to be turned off.
    let was_running = agents.rotate_token().map_err(|e| e.to_string())?;
    if was_running {
        agents.start(&state).await.map_err(|e| e.to_string())?;
    }
    Ok(agents.status())
}

/// What to paste, or run, to point a harness at this app.
#[tauri::command]
#[specta::specta]
pub async fn agent_harness_setup(
    agents: State<'_, AgentState>,
    harness: SetupTarget,
) -> Result<String, String> {
    let status = agents.status();
    let (url, token) =
        match (status.url, status.token) {
            (Some(url), Some(token)) => (url, token),
            _ => return Err(
                "The agent endpoint is not running, so there is nothing to point a harness at yet."
                    .to_string(),
            ),
        };
    Ok(setup_text(harness, &url, &token))
}

/// The setup text for a harness. Pure, so it is testable without an endpoint.
pub fn setup_text(harness: SetupTarget, url: &str, token: &str) -> String {
    match harness {
        // A command rather than a file: `claude mcp add` writes the config in
        // whichever scope the user picks, and telling someone to edit JSON by
        // hand is how a setup step becomes a support question.
        SetupTarget::ClaudeCode => format!(
            "claude mcp add --transport http sqlpilot {url} \\\n  --header \"Authorization: \
             Bearer {token}\"\n"
        ),
        SetupTarget::Copilot => format!(
            "copilot mcp add --transport http sqlpilot {url} \\\n  --header \"Authorization: \
             Bearer {token}\"\n"
        ),
        // The values themselves, in the shape every MCP client's config file
        // uses, for the harness this list has not caught up with.
        SetupTarget::Other => serde_json::json!({
            "mcpServers": {
                "sqlpilot": {
                    "type": "http",
                    "url": url,
                    "headers": {"Authorization": format!("Bearer {token}")}
                }
            }
        })
        .to_string(),
    }
}

fn posture_to_stored(posture: DataPosture) -> &'static str {
    match posture {
        DataPosture::SchemaOnly => "schema-only",
        DataPosture::Samples => "samples",
        DataPosture::Full => "full",
    }
}

fn posture_from_stored(stored: &str) -> DataPosture {
    match stored {
        "full" => DataPosture::Full,
        "samples" => DataPosture::Samples,
        // Anything unrecognised reads as the narrowest posture. A grant whose
        // posture cannot be understood should share less than intended, never
        // more — that is the only direction in which being wrong is safe.
        _ => DataPosture::SchemaOnly,
    }
}

/// The grants as they were last saved.
pub fn load_grants(store: &mas_core::connection::ConnectionStore) -> Grants {
    let stored = match store.list_agent_grants() {
        Ok(stored) => stored,
        Err(e) => {
            // Sharing nothing is the safe reading of "cannot tell what is
            // shared", and the screen will show that nothing is shared rather
            // than pretending the list is empty for a better reason.
            tracing::error!(error = %e, "could not read which connections are shared with agents");
            return Grants::default();
        }
    };

    Grants::new(
        stored
            .into_iter()
            .map(|row| {
                let mut grant =
                    Grant::new(row.connection_id).with_posture(posture_from_stored(&row.posture));
                grant.databases = row
                    .databases
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok());
                grant.redact = row
                    .redact
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok())
                    .unwrap_or_default();
                grant
            })
            .collect(),
    )
}

/// The harnesses on this machine, and their versions.
///
/// SQLPilot never installs or authenticates one: BYOH means the answer to "it
/// is not there" is the command that installs it, not an offer to do it.
#[tauri::command]
#[specta::specta]
pub async fn list_harnesses() -> Result<Vec<HarnessStatus>, String> {
    Ok(mas_agent::harness::discover().await)
}

/// Start a session with a harness, with SQLPilot's tools wired into it.
///
/// The endpoint is started if it is not already: a session whose agent cannot
/// reach the database is not what anyone opened this panel for.
#[tauri::command]
#[specta::specta]
pub async fn start_agent_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    agents: State<'_, AgentState>,
    sessions: State<'_, AgentSessions>,
    harness: mas_agent::harness::Harness,
) -> Result<StartedSession, String> {
    agents.start(&state).await.map_err(|e| e.to_string())?;
    let status = agents.status();
    let endpoint = status.url.zip(status.token);

    sessions
        .start(harness, agents.data_dir(), endpoint, move |event| {
            use tauri_specta::Event as _;
            if let Err(e) = event.emit(&app) {
                tracing::warn!(error = %e, "could not deliver an agent session event");
            }
        })
        .await
}

/// Send a message. The answer arrives as events, not as a return value.
#[tauri::command]
#[specta::specta]
pub async fn send_agent_message(
    app: tauri::AppHandle,
    sessions: State<'_, AgentSessions>,
    session: String,
    text: String,
) -> Result<(), String> {
    sessions.send(&session, text, move |event| {
        use tauri_specta::Event as _;
        let _ = event.emit(&app);
    })
}

/// Stop the turn in progress. The session stays open.
#[tauri::command]
#[specta::specta]
pub async fn cancel_agent_turn(
    sessions: State<'_, AgentSessions>,
    session: String,
) -> Result<(), String> {
    sessions.cancel(&session).await
}

/// Answer the harness's own permission prompt, in SQLPilot's window.
///
/// `option` is absent when the user dismissed it without deciding, which the
/// protocol distinguishes from a refusal: the agent should stop rather than
/// look for another way round.
#[tauri::command]
#[specta::specta]
pub async fn answer_agent_permission(
    sessions: State<'_, AgentSessions>,
    session: String,
    request: String,
    option: Option<String>,
) -> Result<(), String> {
    sessions.answer_permission(&session, &request, option).await
}

/// End a session and clean up after it.
#[tauri::command]
#[specta::specta]
pub async fn stop_agent_session(
    sessions: State<'_, AgentSessions>,
    session: String,
) -> Result<(), String> {
    sessions.stop(&session);
    Ok(())
}

/// The window's answer to something an agent asked.
///
/// The other half of `AgentRequest`: a tool call is waiting on this, and an id
/// nobody is waiting for is ignored rather than reported — the request may
/// have timed out a moment before the user clicked, and the window has no way
/// to know that.
///
/// `value` is the answer, shaped by the request's kind. `error` is sent
/// instead when the window could not answer — no connection selected, no such
/// tab — and reaches the agent as the failure it is.
///
/// `value` is JSON text rather than a typed value: its shape depends on what
/// was asked, and typing it would mean a second union to keep in step with
/// `AgentAsk`.
#[tauri::command]
#[specta::specta]
pub async fn answer_agent_request(
    agents: State<'_, AgentState>,
    id: String,
    value: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let answer = match (error, value) {
        (Some(reason), _) => Err(reason),
        (None, Some(json)) => serde_json::from_str(&json)
            .map_err(|e| format!("SQLPilot could not read its own answer: {e}"))?,
        (None, None) => Ok(serde_json::Value::Null),
    };
    agents.bridge.answer(&id, answer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_posture_survives_a_round_trip() {
        for posture in [
            DataPosture::SchemaOnly,
            DataPosture::Samples,
            DataPosture::Full,
        ] {
            assert_eq!(posture_from_stored(posture_to_stored(posture)), posture);
        }
    }

    #[test]
    fn an_unreadable_posture_shares_less_rather_than_more() {
        // A row written by a future version, or corrupted: the failure has to
        // land on the restrictive side.
        assert_eq!(
            posture_from_stored("whatever-comes-next"),
            DataPosture::SchemaOnly
        );
        assert_eq!(posture_from_stored(""), DataPosture::SchemaOnly);
    }

    #[test]
    fn the_claude_code_setup_is_a_command_that_can_be_run() {
        let text = setup_text(
            SetupTarget::ClaudeCode,
            "http://127.0.0.1:47311/mcp",
            "abc123",
        );
        assert!(text.starts_with("claude mcp add --transport http sqlpilot"));
        assert!(text.contains("http://127.0.0.1:47311/mcp"));
        assert!(text.contains("Bearer abc123"));
    }

    #[test]
    fn the_copilot_setup_uses_copilots_own_command() {
        // Same transport, different CLI. Pasting Claude's command into Copilot
        // is the mistake this exists to prevent.
        let text = setup_text(SetupTarget::Copilot, "http://127.0.0.1:47311/mcp", "abc123");
        assert!(text.starts_with("copilot mcp add"));
    }

    #[test]
    fn any_other_harness_gets_the_values_it_needs() {
        let text = setup_text(SetupTarget::Other, "http://127.0.0.1:1/mcp", "abc123");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(
            parsed["mcpServers"]["sqlpilot"]["url"],
            "http://127.0.0.1:1/mcp"
        );
        assert_eq!(
            parsed["mcpServers"]["sqlpilot"]["headers"]["Authorization"],
            "Bearer abc123"
        );
    }

    #[test]
    fn the_token_is_in_the_setup_text_because_the_user_has_to_paste_it() {
        // Worth stating: this is the one place a secret is deliberately shown.
        for harness in [
            SetupTarget::ClaudeCode,
            SetupTarget::Copilot,
            SetupTarget::Other,
        ] {
            assert!(setup_text(harness, "http://x/mcp", "s3cret").contains("s3cret"));
        }
    }
}
