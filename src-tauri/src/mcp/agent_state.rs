//! The endpoint's lifecycle, as Tauri state.
//!
//! One place that knows whether the endpoint is running, where, and with which
//! token — so that starting it twice is a no-op rather than a second listener,
//! and so that the settings screen and the tool surface cannot disagree about
//! what is shared.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::commands::agents::AgentEndpoint;
use crate::commands::AppState;
use crate::mcp::state::McpState;
use crate::mcp::workspace::AppWorkspace;
use mas_mcp::endpoint::{self, Endpoint};

pub struct AgentState {
    /// The grants, shared with the running server so a change takes effect at
    /// the agent's next call rather than at the next restart.
    pub state: McpState,
    data_dir: PathBuf,
    running: Mutex<Option<Endpoint>>,
}

impl AgentState {
    pub fn new(data_dir: PathBuf, state: McpState) -> Self {
        Self {
            state,
            data_dir,
            running: Mutex::new(None),
        }
    }

    pub fn status(&self) -> AgentEndpoint {
        match self.running().as_ref() {
            Some(endpoint) => AgentEndpoint {
                running: true,
                url: Some(endpoint.url()),
                token: Some(endpoint.token.clone()),
            },
            None => AgentEndpoint {
                running: false,
                url: None,
                // The token exists whether or not the endpoint is listening,
                // and showing it lets someone prepare a harness config before
                // turning the endpoint on.
                token: endpoint::load_or_create_token(&self.data_dir).ok(),
            },
        }
    }

    pub async fn start(&self, app: &AppState) -> std::io::Result<()> {
        if self.running().is_some() {
            // Already listening. Starting again would bind a second port and
            // leave the first one serving, which is worse than doing nothing.
            return Ok(());
        }

        let token = endpoint::load_or_create_token(&self.data_dir)?;
        let workspace = Arc::new(AppWorkspace::new(
            app.connection_manager.clone(),
            app.schema_inspector.clone(),
            app.query_executor.clone(),
            self.state.clone(),
        ));

        let endpoint = endpoint::start(workspace, token, endpoint::PREFERRED_PORT).await?;
        *self.running() = Some(endpoint);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(endpoint) = self.running().take() {
            endpoint.stop();
        }
    }

    /// Issue a new token, and stop the endpoint if it was listening.
    ///
    /// Returns whether it was, so the caller can start it again on the new
    /// token. The old one has to stop working now: a rotation that only takes
    /// effect at the next launch leaves the token someone wanted revoked
    /// working for the rest of the day.
    pub fn rotate_token(&self) -> std::io::Result<bool> {
        endpoint::rotate_token(&self.data_dir)?;
        match self.running().take() {
            Some(endpoint) => {
                let address = endpoint.address;
                endpoint.stop();
                tracing::info!(%address, "agent endpoint stopped to take a new token");
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn running(&self) -> std::sync::MutexGuard<'_, Option<Endpoint>> {
        // A panic while holding this lock would otherwise make the endpoint
        // impossible to start or stop for the rest of the session.
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }
}
