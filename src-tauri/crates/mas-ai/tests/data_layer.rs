//! Tests for the mas-ai data layer.
//!
//! Scope: pin the data contracts (AiMode, AiStatus, AiConfig,
//! AiStreamEvent, ChatMessage, AiError). The service + tools layers
//! require a real Copilot SDK session and are covered separately when
//! the SDK gets a mock backend.

use mas_ai::error::AiError;
use mas_ai::models::{AiConfig, AiMode, AiStatus, AiStreamEvent, ChatMessage};
use serde_json::json;

#[test]
fn ai_mode_serializes_to_snake_case() {
    assert_eq!(serde_json::to_string(&AiMode::Ask).unwrap(), "\"ask\"");
    assert_eq!(serde_json::to_string(&AiMode::Agent).unwrap(), "\"agent\"");
    assert_eq!(serde_json::to_string(&AiMode::Plan).unwrap(), "\"plan\"");
}

#[test]
fn ai_mode_roundtrips_through_serde() {
    for variant in [AiMode::Ask, AiMode::Agent, AiMode::Plan] {
        let s = serde_json::to_string(&variant).unwrap();
        let back: AiMode = serde_json::from_str(&s).unwrap();
        assert_eq!(back, variant);
    }
}

#[test]
fn ai_status_serializes_with_all_fields() {
    let status = AiStatus {
        provider: "copilot".to_string(),
        available: true,
        model: Some("claude-3.5".to_string()),
    };
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["provider"], "copilot");
    assert_eq!(json["available"], true);
    assert_eq!(json["model"], "claude-3.5");
}

#[test]
fn ai_status_with_no_model_serializes_to_null() {
    let status = AiStatus {
        provider: "copilot".to_string(),
        available: false,
        model: None,
    };
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["model"], serde_json::Value::Null);
}

#[test]
fn ai_config_model_roundtrips() {
    let cfg = AiConfig {
        model: Some("gpt-4".to_string()),
    };
    let s = serde_json::to_string(&cfg).unwrap();
    let back: AiConfig = serde_json::from_str(&s).unwrap();
    assert_eq!(back.model, cfg.model);

    let cfg_none = AiConfig { model: None };
    let s = serde_json::to_string(&cfg_none).unwrap();
    let back: AiConfig = serde_json::from_str(&s).unwrap();
    assert_eq!(back.model, None);
}

#[test]
fn ai_stream_event_text_delta_serializes_with_tag() {
    let event = AiStreamEvent::TextDelta {
        conversation_id: "conv-1".to_string(),
        content: "hello".to_string(),
    };
    let v = serde_json::to_value(&event).unwrap();
    // Externally tagged with snake_case rename.
    assert_eq!(v["type"], "text_delta");
    assert_eq!(v["conversation_id"], "conv-1");
    assert_eq!(v["content"], "hello");
}

#[test]
fn ai_stream_event_tool_start_roundtrips() {
    let event = AiStreamEvent::ToolStart {
        conversation_id: "c".to_string(),
        tool_name: "execute_query".to_string(),
        tool_call_id: "tc-1".to_string(),
        arguments: Some(json!({"sql": "SELECT 1"})),
    };
    let s = serde_json::to_string(&event).unwrap();
    let back: AiStreamEvent = serde_json::from_str(&s).unwrap();
    match back {
        AiStreamEvent::ToolStart {
            conversation_id,
            tool_name,
            tool_call_id,
            arguments,
        } => {
            assert_eq!(conversation_id, "c");
            assert_eq!(tool_name, "execute_query");
            assert_eq!(tool_call_id, "tc-1");
            assert_eq!(arguments, Some(json!({"sql": "SELECT 1"})));
        }
        other => panic!("expected ToolStart, got {other:?}"),
    }
}

#[test]
fn ai_stream_event_permission_request_carries_request_id() {
    let event = AiStreamEvent::PermissionRequest {
        conversation_id: "c".to_string(),
        tool_name: "run_shell".to_string(),
        description: "Drop a table".to_string(),
        request_id: "req-1".to_string(),
    };
    let v = serde_json::to_value(&event).unwrap();
    assert_eq!(v["type"], "permission_request");
    assert_eq!(v["request_id"], "req-1");
    assert_eq!(v["tool_name"], "run_shell");
}

#[test]
fn ai_stream_event_error_carries_message() {
    let event = AiStreamEvent::Error {
        conversation_id: "c".to_string(),
        message: "boom".to_string(),
    };
    let v = serde_json::to_value(&event).unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["message"], "boom");
}

#[test]
fn chat_message_serializes_role_and_content() {
    let msg = ChatMessage {
        role: "user".to_string(),
        content: "hi".to_string(),
    };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["role"], "user");
    assert_eq!(v["content"], "hi");
}

#[test]
fn ai_error_displays_useful_messages() {
    assert_eq!(
        AiError::NotConnected.to_string(),
        "Not connected to database"
    );
    assert_eq!(AiError::PermissionDenied.to_string(), "Permission denied");
    assert_eq!(AiError::Cancelled.to_string(), "Cancelled");
    assert_eq!(
        AiError::SessionNotFound("abc".to_string()).to_string(),
        "Session not found: abc"
    );
    assert_eq!(
        AiError::SdkError("boom".to_string()).to_string(),
        "Copilot SDK error: boom"
    );
}

#[test]
fn ai_error_serializes_as_string() {
    // The custom Serialize impl flattens the variant to a string so the
    // frontend gets a readable error rather than a tagged enum.
    let err = AiError::ToolError("sql syntax".to_string());
    let json = serde_json::to_string(&err).unwrap();
    assert_eq!(json, "\"Tool execution failed: sql syntax\"");

    let json2 = serde_json::to_string(&AiError::PermissionDenied).unwrap();
    assert_eq!(json2, "\"Permission denied\"");
}
