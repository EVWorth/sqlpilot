//! What is on screen, and how to put something there.
//!
//! This is the half of the tool surface that makes SQLPilot a client rather
//! than a driver. An agent that can only reach the database is a nicer psql;
//! an agent that can see the statement in the editor, the result underneath
//! it and the error that just came back — and can offer a change to that
//! statement as a diff the user accepts or rejects — is the thing people
//! actually want from an editor agent.
//!
//! Every method here is a question put to the window and waited on, rather
//! than a read of state the window pushed earlier. Pushed state has to be
//! pushed on every keystroke to be right, and is wrong in the way that matters
//! — a stale `get_editor_context` sends an agent to rewrite a statement the
//! user has already changed. The cost is that these can time out, and a
//! timeout is reported as one.

use serde::{Deserialize, Serialize};

/// Why the window could not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceError {
    /// No window is listening. The app is starting, or shutting down, or the
    /// last window was closed while the endpoint kept running.
    NoWindow,
    /// The window did not answer in time.
    TimedOut,
    /// The user closed the prompt, or the request was superseded.
    Abandoned,
    /// Anything else, already phrased for a reader.
    Failed(String),
}

impl std::fmt::Display for SurfaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SurfaceError::NoWindow => write!(
                f,
                "SQLPilot has no window open, so there is nothing on screen to read or change. \
                 The database tools still work."
            ),
            SurfaceError::TimedOut => write!(
                f,
                "SQLPilot did not answer in time. It may be busy running something; try again."
            ),
            SurfaceError::Abandoned => write!(
                f,
                "The user closed this without answering. Treat it as a no, and ask them what they \
                 would like instead."
            ),
            SurfaceError::Failed(reason) => write!(f, "{reason}"),
        }
    }
}

/// The tab the user is looking at.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    /// The tab's id, to pass back to `propose_edit`.
    pub tab: String,
    pub title: String,
    /// The connection profile id, or none for a tab with no connection yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// Everything in the editor.
    pub sql: String,
    /// What the user has selected, when anything is. Running a selection is
    /// how people run one statement out of a file, so a request to "fix this
    /// query" usually means this and not the whole tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
}

/// The result grid underneath it.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct ResultContext {
    /// The statement that produced it.
    pub sql: String,
    pub columns: Vec<String>,
    pub row_count: usize,
    pub execution_time_ms: u64,
    /// True when the grid is showing part of a larger result.
    pub truncated: bool,
    /// The rows on screen, where the connection's posture allows values. The
    /// agent is looking at the user's own screen, but "the user can see it"
    /// is not the same rule as "it may leave the machine".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What the user did with a proposed edit.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub accepted: bool,
    /// True when the user changed the proposal before accepting it. Worth
    /// knowing: it is the clearest signal an agent gets that its answer was
    /// close but not right.
    pub edited: bool,
    /// What is in the tab now, when the user accepted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
}

/// The app's window, as the tool surface needs it.
#[async_trait::async_trait]
pub trait Surface: Send + Sync + 'static {
    async fn editor_context(&self) -> Result<EditorContext, SurfaceError>;

    /// The result on screen. `Ok(None)` when nothing has been run yet.
    async fn result_context(&self) -> Result<Option<RawResult>, SurfaceError>;

    /// Show a diff on a tab and wait for the user to accept or reject it.
    ///
    /// Never writes on its own. This is the tool the whole in-app experience
    /// is built around, and an agent that could silently rewrite the editor
    /// would make the editor a thing you cannot trust.
    async fn propose_edit(
        &self,
        tab: Option<String>,
        sql: String,
        rationale: String,
    ) -> Result<EditOutcome, SurfaceError>;

    /// Open a new tab with this SQL in it. Never touches an existing one.
    async fn open_draft(
        &self,
        sql: String,
        title: Option<String>,
        connection: Option<String>,
        database: Option<String>,
    ) -> Result<String, SurfaceError>;
}

/// The result on screen, before the posture has been applied to it.
///
/// Separate from [`ResultContext`] so that the window hands over what it has
/// and the policy decides what leaves — rather than the window deciding, which
/// would put the same rule in two places.
#[derive(Debug, Clone)]
pub struct RawResult {
    pub sql: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub execution_time_ms: u64,
    pub truncated: bool,
    /// The connection profile the result came from, so its posture can be
    /// looked up.
    pub connection: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_says_what_to_do_next() {
        // A model that gets an error with no next step retries the same call.
        for error in [
            SurfaceError::NoWindow,
            SurfaceError::TimedOut,
            SurfaceError::Abandoned,
        ] {
            let message = error.to_string();
            assert!(message.len() > 40, "{message}");
            assert!(message.ends_with('.'), "{message}");
        }
    }

    #[test]
    fn a_closed_prompt_reads_as_a_no_rather_than_as_a_failure() {
        // The difference matters: an agent that reads "abandoned" as an error
        // retries the same proposal, which is how a dialog becomes a loop.
        let message = SurfaceError::Abandoned.to_string();
        assert!(message.contains("no"), "{message}");
    }

    #[test]
    fn no_window_says_the_database_tools_still_work() {
        // Otherwise an agent concludes the whole server is down.
        assert!(SurfaceError::NoWindow
            .to_string()
            .contains("database tools"));
    }
}
