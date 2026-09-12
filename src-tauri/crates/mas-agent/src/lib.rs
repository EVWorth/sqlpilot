//! Running the user's own agent harness inside SQLPilot.
//!
//! ADR-011: SQLPilot does not call a model. It spawns the CLI the user already
//! has, already logged in, and shows the conversation natively — so a session
//! in the app is the same session they would get in a terminal, with the same
//! account, the same limits and the same tools.
//!
//! Two harnesses, two protocols, one [`SessionEvent`] stream. Copilot speaks
//! the Agent Client Protocol; Claude Code speaks its own NDJSON. Everything
//! above this crate sees only the normalised events.

pub mod acp;
pub mod claude;
pub mod event;
pub mod harness;
pub mod think;

pub use acp::{AcpClient, AgentInfo, McpServer};
pub use event::{PermissionOption, PlanEntry, SessionEvent};
pub use harness::{discover, Harness, HarnessStatus};
pub use think::{Piece, ThinkSplitter};
