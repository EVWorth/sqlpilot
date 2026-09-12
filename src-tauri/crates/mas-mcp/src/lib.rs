//! The database, exposed safely to an agent the user brought themselves.
//!
//! SQLPilot does not call a model (ADR-011). It answers one, through the
//! Model Context Protocol, and polices every call: what may be seen is the
//! connection's data posture, what may be done is graded by environment and
//! statement class, and anything destructive is approved by the user **in
//! SQLPilot's own window** rather than by whatever harness is driving.
//!
//! The design is `docs/design/AI_INTEGRATION.md`. This crate is the half that
//! does not depend on which harness is in use.

pub mod analysis;
pub mod classify;
pub mod grants;
pub mod policy;
pub mod server;
pub mod shapes;
pub mod workspace;

pub use classify::{classify, single_statement, Rejected, Statement};
pub use grants::{ConnectionFacts, Grant, Grants, NotGranted};
pub use policy::{ConnectionPolicy, DataPosture, Decision, Environment, VerbClass};
pub use workspace::{LiveConnection, ObjectKind, Workspace};
