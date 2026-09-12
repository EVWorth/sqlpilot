//! What a session looks like from the outside.
//!
//! Two harnesses, two protocols, one transcript. Copilot speaks the Agent
//! Client Protocol; Claude Code speaks its own NDJSON. Normalising both into
//! these events here rather than in the UI means the session view is written
//! once, and adding a third harness is a file in this crate rather than a
//! branch in every component.
//!
//! The events are deliberately coarse. A transcript needs to render text as it
//! arrives, show what the agent is doing, ask the user when something needs
//! permission, and say when the turn ended. Anything finer is a protocol
//! detail that has no business reaching React.

use serde::{Deserialize, Serialize};

/// One thing that happened in a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    /// The session is ready. Carries the harness's own id for it, which is
    /// what resuming later needs.
    Started { session: String },

    /// More of the agent's answer. Deltas, not whole messages: a transcript
    /// that only updates when a turn ends reads as a hang.
    Text { delta: String },

    /// More of the agent's reasoning, where the harness reports it separately
    /// — or where we have separated it out ourselves.
    Thought { delta: String },

    /// The agent started doing something.
    ToolStarted {
        id: String,
        /// What to show: "Reading src/lib.rs", "run_select on shop".
        title: String,
        /// A rough class for the icon: "read", "edit", "execute", "search",
        /// "think", "other". Not an enum, because each harness has its own
        /// list and an unknown kind should render as "other" rather than fail
        /// to parse.
        kind: String,
    },

    /// It finished, or failed.
    ToolFinished {
        id: String,
        /// "completed" or "failed".
        status: String,
        /// What came back, when it is worth showing.
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },

    /// The agent wants permission. The session is paused until the user
    /// answers with one of the options.
    ///
    /// This is the harness's own permission prompt, rendered in SQLPilot's
    /// window. Separate from the approval SQLPilot demands for a write —
    /// that one happens regardless, and is not negotiable through here.
    PermissionRequested {
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        options: Vec<PermissionOption>,
    },

    /// The plan the agent is working to, when it publishes one.
    Plan { entries: Vec<PlanEntry> },

    /// The turn ended.
    ///
    /// `reason` is the harness's own word — "end_turn", "cancelled",
    /// "max_tokens", "refusal" — passed through rather than mapped, because a
    /// turn that stopped for an unusual reason should say so in the harness's
    /// terms rather than be flattened into "done".
    TurnEnded { reason: String },

    /// Something went wrong with the session itself: the process died, the
    /// protocol was violated, the harness is not logged in.
    Failed { message: String },
}

/// One answer the user can give to a permission request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    /// "allow_once", "allow_always", "reject_once", "reject_always" — or
    /// whatever the harness calls it. Used to decide which button is the
    /// dangerous one.
    pub kind: String,
}

impl PermissionOption {
    /// Whether this option is a yes.
    ///
    /// Matched on a prefix rather than an exact list: harnesses spell these
    /// differently, and an option nobody recognised should read as a refusal
    /// rather than as consent.
    pub fn is_allow(&self) -> bool {
        self.kind.starts_with("allow")
    }

    /// Whether this option grants permission beyond this one request.
    pub fn is_persistent(&self) -> bool {
        self.kind.ends_with("always")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    /// "pending", "in_progress", "completed".
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(kind: &str) -> PermissionOption {
        PermissionOption {
            id: "o".into(),
            label: "l".into(),
            kind: kind.into(),
        }
    }

    #[test]
    fn an_allow_option_is_recognised_however_it_is_spelled() {
        assert!(option("allow_once").is_allow());
        assert!(option("allow_always").is_allow());
        assert!(option("allowForSession").is_allow());
    }

    #[test]
    fn anything_unrecognised_is_not_consent() {
        // The safe direction: a new option kind should read as a refusal, not
        // as a yes nobody meant.
        assert!(!option("reject_once").is_allow());
        assert!(!option("something_new").is_allow());
        assert!(!option("").is_allow());
    }

    #[test]
    fn a_standing_permission_is_distinguishable_from_a_one_off() {
        // The UI marks it differently, because "allow always" is a decision
        // that outlives the question being asked.
        assert!(option("allow_always").is_persistent());
        assert!(!option("allow_once").is_persistent());
    }

    #[test]
    fn events_serialise_with_a_tag_the_frontend_can_switch_on() {
        let json = serde_json::to_value(SessionEvent::Text { delta: "hi".into() }).unwrap();
        assert_eq!(json["type"], "text");
        assert_eq!(json["delta"], "hi");
    }

    #[test]
    fn a_turn_keeps_the_harnesss_own_reason() {
        // Flattening "refusal" and "max_tokens" into "done" would lose the
        // only thing worth telling the user about an unusual ending.
        let json = serde_json::to_value(SessionEvent::TurnEnded {
            reason: "max_tokens".into(),
        })
        .unwrap();
        assert_eq!(json["reason"], "max_tokens");
    }
}
