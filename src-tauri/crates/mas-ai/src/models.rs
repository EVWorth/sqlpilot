use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiMode {
    Ask,
    Agent,
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStatus {
    pub provider: String,
    pub available: bool,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub model: Option<String>,
}

/// Structured events emitted to the frontend via Tauri events
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    TextDelta {
        conversation_id: String,
        content: String,
    },
    ToolStart {
        conversation_id: String,
        tool_name: String,
        tool_call_id: String,
    },
    ToolComplete {
        conversation_id: String,
        tool_name: String,
        tool_call_id: String,
        result: String,
        success: bool,
    },
    PermissionRequest {
        conversation_id: String,
        tool_name: String,
        description: String,
    },
    Idle {
        conversation_id: String,
    },
    Error {
        conversation_id: String,
        message: String,
    },
}

/// Kept for backward compat but prefer AiStreamEvent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}
