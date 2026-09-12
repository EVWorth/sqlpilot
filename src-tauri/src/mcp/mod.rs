//! The app's side of the agent surface.
//!
//! `mas-mcp` defines what an agent may ask for and what it is allowed to
//! receive. This module is the part that can actually answer: it holds the
//! connection manager, the schema inspector and the executor, and it holds the
//! grants — the user's record of which connections are shared and on what
//! terms.

pub mod agent_state;
pub mod state;
pub mod workspace;

pub use agent_state::AgentState;
pub use state::McpState;
pub use workspace::AppWorkspace;
