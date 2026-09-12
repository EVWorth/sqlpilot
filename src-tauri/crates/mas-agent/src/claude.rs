//! Claude Code, over its own streaming protocol.
//!
//! Claude Code does not speak ACP. It has its own NDJSON transport, which is
//! what the Agent SDK uses: messages in on stdin, a stream of events out on
//! stdout, one JSON object per line. This turns that into the same
//! [`SessionEvent`]s the ACP client produces, so the session panel does not
//! know or care which harness is answering.
//!
//! Verified against Claude Code 2.1.270 on 2026-09-12, by running it: the
//! shapes below are from real output, not from documentation.
//!
//! Two decisions worth stating, both about what the session is *not* allowed
//! to become:
//!
//! - `--strict-mcp-config` with our own `--mcp-config`, so the session has
//!   SQLPilot's tools and none of the user's other MCP servers. Confirmed:
//!   with it, the init line reports our server and nothing else.
//! - `--permission-prompts none`, with our own tools allow-listed. Claude's
//!   built-in file and shell tools would otherwise prompt in a terminal
//!   nobody is looking at; here they are simply refused, and the refusals are
//!   reported at the end of the turn. What SQLPilot's own tools do about
//!   permission is decided by SQLPilot, in its own window, and is not
//!   negotiable through this flag.
//!
//! What is deliberately *not* passed is `--bare`. Bare mode does not read the
//! subscription login and expects an API key — the thing this whole feature
//! exists to avoid handling.

use serde_json::{json, Value};

use crate::event::SessionEvent;

/// The MCP server name the session sees, and the prefix its tools carry.
pub const SERVER_NAME: &str = "sqlpilot";

/// The arguments for a session.
///
/// Built here rather than at the call site so that the flags and the parser
/// stay in one file: they are two halves of the same contract with the CLI.
pub fn session_args(mcp_config: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        // Messages in as well as out: without this the process answers once
        // and exits, and a session is a conversation.
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        // `--verbose` is required for stream-json output, and
        // `--include-partial-messages` is what makes the answer appear as it
        // is written rather than all at once when the turn ends.
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-prompts".to_string(),
        "none".to_string(),
    ];

    if let Some(config) = mcp_config {
        args.extend([
            "--strict-mcp-config".to_string(),
            "--mcp-config".to_string(),
            config.to_string(),
            // Server-wide: every tool SQLPilot exposes is allowed without a
            // prompt, because SQLPilot asks its own questions about the ones
            // that matter.
            "--allowedTools".to_string(),
            format!("mcp__{SERVER_NAME}"),
        ]);
    }

    args
}

/// The `--mcp-config` value for SQLPilot's endpoint.
pub fn mcp_config(url: &str, token: &str) -> String {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": url,
                "headers": {"Authorization": format!("Bearer {token}")}
            }
        }
    })
    .to_string()
}

/// A message to send on stdin.
pub fn user_message(text: &str) -> String {
    json!({
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]}
    })
    .to_string()
}

/// Ask the turn in progress to stop.
///
/// The control protocol rather than a signal: a signal would end the process,
/// and the session with it, when what the user asked for was to stop this
/// answer.
pub fn interrupt(request_id: &str) -> String {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": "interrupt"}
    })
    .to_string()
}

/// What the parser remembers between lines.
#[derive(Debug, Default)]
pub struct ParseState {
    /// Tool calls seen this turn, so a result can be matched to its call.
    started: std::collections::HashSet<String>,
    /// True once partial deltas have been seen, so the whole message that
    /// follows them is not emitted a second time.
    streaming: bool,
}

/// Turn one line of Claude Code's output into events.
///
/// A line that is not JSON, or is JSON this version does not know, produces
/// nothing rather than an error: the CLI adds message types between releases,
/// and a session that failed on an unfamiliar one would break on upgrade.
pub fn parse_line(line: &str, state: &mut ParseState) -> Vec<SessionEvent> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };

    match message["type"].as_str() {
        Some("system") if message["subtype"] == "init" => {
            let mut events = vec![SessionEvent::Started {
                session: message["session_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            }];
            // A server that did not connect means the session has no database
            // tools. Better said now than discovered when the agent claims it
            // cannot see anything.
            if let Some(servers) = message["mcp_servers"].as_array() {
                for server in servers {
                    if server["name"] == SERVER_NAME && server["status"] != "connected" {
                        events.push(SessionEvent::Failed {
                            message: format!(
                                "The agent could not reach SQLPilot's tools ({}), so it cannot see \
                                 your databases.",
                                server["status"].as_str().unwrap_or("no status")
                            ),
                        });
                    }
                }
            }
            events
        }

        // Partial deltas: the answer as it is written.
        Some("stream_event") => {
            let delta = &message["event"]["delta"];
            match delta["type"].as_str() {
                Some("text_delta") => {
                    state.streaming = true;
                    vec![SessionEvent::Text {
                        delta: delta["text"].as_str().unwrap_or_default().to_string(),
                    }]
                }
                Some("thinking_delta") => {
                    state.streaming = true;
                    vec![SessionEvent::Thought {
                        delta: delta["thinking"].as_str().unwrap_or_default().to_string(),
                    }]
                }
                _ => Vec::new(),
            }
        }

        Some("assistant") => assistant(&message["message"]["content"], state),

        // Tool results come back as a user message, which is how the SDK
        // reports them.
        Some("user") => tool_results(&message["message"]["content"], state),

        Some("result") => {
            state.streaming = false;
            let mut events = Vec::new();

            // Anything Claude's own permission model refused. Reported rather
            // than hidden: an agent that quietly could not read a file gives
            // an answer that looks like an opinion.
            if let Some(denials) = message["permission_denials"].as_array() {
                if !denials.is_empty() {
                    let names: Vec<&str> = denials
                        .iter()
                        .filter_map(|denial| denial["tool_name"].as_str())
                        .collect();
                    events.push(SessionEvent::Failed {
                        message: format!(
                            "This session refused {} outside SQLPilot's own tools. A session here \
                             can reach the databases you shared, not the filesystem or the shell.",
                            if names.is_empty() {
                                "some actions".to_string()
                            } else {
                                names.join(", ")
                            }
                        ),
                    });
                }
            }

            if message["is_error"].as_bool().unwrap_or(false) {
                events.push(SessionEvent::Failed {
                    message: message["result"]
                        .as_str()
                        .unwrap_or("The turn failed.")
                        .to_string(),
                });
            }

            events.push(SessionEvent::TurnEnded {
                reason: message["stop_reason"]
                    .as_str()
                    .or_else(|| message["subtype"].as_str())
                    .unwrap_or("end_turn")
                    .to_string(),
            });
            events
        }

        _ => Vec::new(),
    }
}

/// The content blocks of an assistant message.
fn assistant(content: &Value, state: &mut ParseState) -> Vec<SessionEvent> {
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };

    blocks
        .iter()
        .filter_map(|block| match block["type"].as_str() {
            // Already delivered as deltas. Emitting it again would double
            // every answer.
            Some("text") if state.streaming => None,
            Some("text") => Some(SessionEvent::Text {
                delta: block["text"].as_str().unwrap_or_default().to_string(),
            }),
            Some("thinking") if state.streaming => None,
            Some("thinking") => Some(SessionEvent::Thought {
                delta: block["thinking"].as_str().unwrap_or_default().to_string(),
            }),
            Some("tool_use") => {
                let id = block["id"].as_str().unwrap_or_default().to_string();
                state.started.insert(id.clone());
                Some(SessionEvent::ToolStarted {
                    title: describe(block),
                    kind: kind_of(block["name"].as_str().unwrap_or_default()),
                    id,
                })
            }
            _ => None,
        })
        .collect()
}

fn tool_results(content: &Value, state: &mut ParseState) -> Vec<SessionEvent> {
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };

    blocks
        .iter()
        .filter(|block| block["type"] == "tool_result")
        .filter_map(|block| {
            let id = block["tool_use_id"].as_str()?.to_string();
            // A result for a call we never saw start would show as a tool with
            // no title; the transcript drops it rather than inventing one.
            if !state.started.remove(&id) {
                return None;
            }
            let failed = block["is_error"].as_bool().unwrap_or(false);
            Some(SessionEvent::ToolFinished {
                id,
                status: if failed { "failed" } else { "completed" }.to_string(),
                detail: summarise(&block["content"]),
            })
        })
        .collect()
}

/// What to show for a tool call.
///
/// The tool's own name is the fallback; where the arguments say something
/// useful — a path, a statement, a command — that is what a person reading the
/// transcript actually wants.
fn describe(block: &Value) -> String {
    let name = block["name"].as_str().unwrap_or("Working");
    let input = &block["input"];

    for field in [
        "sql",
        "command",
        "file_path",
        "pattern",
        "query",
        "fragment",
    ] {
        if let Some(value) = input[field].as_str() {
            let short = first_line(value, 80);
            return format!("{} · {short}", pretty(name));
        }
    }
    pretty(name).to_string()
}

/// SQLPilot's own tools are shown by their bare name: `mcp__sqlpilot__` in
/// front of every one of them is noise in a panel that is already inside
/// SQLPilot.
fn pretty(name: &str) -> &str {
    name.strip_prefix(&format!("mcp__{SERVER_NAME}__"))
        .unwrap_or(name)
}

fn kind_of(name: &str) -> String {
    let bare = pretty(name);
    match bare {
        "Read" | "Glob" | "NotebookRead" => "read",
        "Edit" | "Write" | "NotebookEdit" | "propose_edit" | "open_draft" => "edit",
        "Grep" | "WebSearch" | "search_schema" => "search",
        "Bash" | "run_select" | "run_write" | "run_ddl" | "estimate_impact" => "execute",
        "Task" => "think",
        _ => "other",
    }
    .to_string()
}

/// A tool result, short enough to sit on one line of a transcript.
fn summarise(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(first_line(trimmed, 120))
}

/// The first line, cut to `limit` characters, with an ellipsis if it was cut.
fn first_line(text: &str, limit: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= limit {
        return line.to_string();
    }
    let cut: String = line.chars().take(limit).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[&str]) -> Vec<SessionEvent> {
        let mut state = ParseState::default();
        lines
            .iter()
            .flat_map(|line| parse_line(line, &mut state))
            .collect()
    }

    #[test]
    fn the_session_id_comes_from_the_init_line() {
        // Captured from a real run.
        let events = parse(&[
            r#"{"type":"system","subtype":"init","session_id":"45f8b3f7","model":"claude-sonnet-5","mcp_servers":[{"name":"sqlpilot","status":"connected"}]}"#,
        ]);
        assert_eq!(
            events,
            vec![SessionEvent::Started {
                session: "45f8b3f7".into()
            }]
        );
    }

    #[test]
    fn a_server_that_did_not_connect_is_reported_at_once() {
        // Otherwise the first symptom is an agent claiming it cannot see any
        // databases, which reads as a bug in the tools rather than in the
        // connection to them.
        let events = parse(&[
            r#"{"type":"system","subtype":"init","session_id":"s","mcp_servers":[{"name":"sqlpilot","status":"failed"}]}"#,
        ]);
        assert!(matches!(events[1], SessionEvent::Failed { .. }));
    }

    #[test]
    fn text_arrives_as_deltas_and_is_not_repeated_when_the_message_lands() {
        // Both are sent: the partials as they are written, then the whole
        // message. Emitting both would double every answer.
        let events = parse(&[
            r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"po"}}}"#,
            r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"ng"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}"#,
        ]);
        assert_eq!(
            events,
            vec![
                SessionEvent::Text { delta: "po".into() },
                SessionEvent::Text { delta: "ng".into() },
            ]
        );
    }

    #[test]
    fn a_whole_message_with_no_partials_is_still_shown() {
        // `--include-partial-messages` can be unavailable, and an empty
        // transcript would be worse than an unstreamed one.
        let events = parse(&[
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}"#,
        ]);
        assert_eq!(
            events,
            vec![SessionEvent::Text {
                delta: "pong".into()
            }]
        );
    }

    #[test]
    fn thinking_is_reported_as_reasoning_rather_than_as_the_answer() {
        let events = parse(&[
            r#"{"type":"stream_event","event":{"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#,
        ]);
        assert_eq!(
            events,
            vec![SessionEvent::Thought {
                delta: "hmm".into()
            }]
        );
    }

    #[test]
    fn a_tool_call_is_described_by_what_it_is_doing() {
        // "run_select · SELECT id FROM orders" beats "mcp__sqlpilot__run_select".
        let events = parse(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__sqlpilot__run_select","input":{"sql":"SELECT id FROM orders","connection":"c1"}}]}}"#,
        ]);
        assert_eq!(
            events,
            vec![SessionEvent::ToolStarted {
                id: "t1".into(),
                title: "run_select · SELECT id FROM orders".into(),
                kind: "execute".into(),
            }]
        );
    }

    #[test]
    fn a_tool_with_nothing_worth_showing_falls_back_to_its_name() {
        let events = parse(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__sqlpilot__list_connections","input":{}}]}}"#,
        ]);
        assert_eq!(
            events,
            vec![SessionEvent::ToolStarted {
                id: "t1".into(),
                title: "list_connections".into(),
                kind: "other".into(),
            }]
        );
    }

    #[test]
    fn a_long_statement_is_cut_rather_than_wrapped_across_the_panel() {
        let sql = "SELECT ".to_string() + &"column_name, ".repeat(40);
        let line = json!({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"sql": sql}}]}
        })
        .to_string();
        let events = parse(&[&line]);
        let SessionEvent::ToolStarted { title, .. } = &events[0] else {
            panic!("expected a tool call");
        };
        assert!(title.ends_with('…'), "{title}");
        assert!(title.chars().count() < 100);
    }

    #[test]
    fn a_result_finishes_the_call_it_belongs_to() {
        let events = parse(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/x"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"3 rows"}]}}"#,
        ]);
        assert_eq!(
            events[1],
            SessionEvent::ToolFinished {
                id: "t1".into(),
                status: "completed".into(),
                detail: Some("3 rows".into()),
            }
        );
    }

    #[test]
    fn a_failed_tool_says_so() {
        let events = parse(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"no such file"}]}]}}"#,
        ]);
        assert_eq!(
            events[1],
            SessionEvent::ToolFinished {
                id: "t1".into(),
                status: "failed".into(),
                detail: Some("no such file".into()),
            }
        );
    }

    #[test]
    fn a_result_for_a_call_we_never_saw_is_dropped() {
        let events = parse(&[
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"ghost","content":"x"}]}}"#,
        ]);
        assert!(events.is_empty());
    }

    #[test]
    fn the_turn_ends_with_the_reason_the_cli_gave() {
        let events = parse(&[
            r#"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","permission_denials":[],"result":"pong"}"#,
        ]);
        assert_eq!(
            events,
            vec![SessionEvent::TurnEnded {
                reason: "end_turn".into()
            }]
        );
    }

    #[test]
    fn a_failed_turn_says_what_went_wrong_before_it_ends() {
        let events = parse(&[
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Credit balance too low","permission_denials":[]}"#,
        ]);
        assert_eq!(
            events[0],
            SessionEvent::Failed {
                message: "Credit balance too low".into()
            }
        );
        assert!(matches!(events[1], SessionEvent::TurnEnded { .. }));
    }

    #[test]
    fn refusals_by_the_harnesss_own_permissions_are_reported() {
        // A session that quietly could not read a file gives an answer that
        // looks like an opinion.
        let events = parse(&[
            r#"{"type":"result","subtype":"success","is_error":false,"permission_denials":[{"tool_name":"Bash"}]}"#,
        ]);
        let SessionEvent::Failed { message } = &events[0] else {
            panic!("expected a note about the refusal");
        };
        assert!(message.contains("Bash"), "{message}");
        assert!(message.contains("databases you shared"), "{message}");
    }

    #[test]
    fn noise_between_the_messages_is_ignored() {
        // Rate-limit notices, post-turn summaries, and whatever the next
        // release adds. A session that failed on an unfamiliar type would
        // break on upgrade.
        let events = parse(&[
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}"#,
            r#"{"type":"system","subtype":"post_turn_summary","status_detail":"replied with pong"}"#,
            r#"{"type":"something_new","payload":{}}"#,
            "not json at all",
            "",
        ]);
        assert!(events.is_empty());
    }

    #[test]
    fn the_session_gets_our_server_and_not_the_users_own() {
        // Verified against 2.1.270: with --strict-mcp-config the init line
        // reports only the server we passed.
        let args = session_args(Some("{}"));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args.contains(&"--mcp-config".to_string()));
        assert!(args.contains(&"mcp__sqlpilot".to_string()));
    }

    #[test]
    fn a_session_without_an_endpoint_passes_no_mcp_flags() {
        let args = session_args(None);
        assert!(!args.iter().any(|a| a.contains("mcp")));
    }

    #[test]
    fn the_session_is_never_started_in_bare_mode() {
        // Bare mode does not read the subscription login and expects an API
        // key — the thing this whole feature exists to avoid handling.
        assert!(!session_args(Some("{}")).contains(&"--bare".to_string()));
    }

    #[test]
    fn prompts_are_answered_by_nobody_rather_than_by_default() {
        // The alternative is a prompt in a terminal nobody is looking at,
        // which is a hung session.
        let args = session_args(None);
        let at = args
            .iter()
            .position(|a| a == "--permission-prompts")
            .unwrap();
        assert_eq!(args[at + 1], "none");
    }

    #[test]
    fn the_config_carries_the_endpoint_and_its_token() {
        let config: Value =
            serde_json::from_str(&mcp_config("http://127.0.0.1:47311/mcp", "s3cret")).unwrap();
        let server = &config["mcpServers"]["sqlpilot"];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "http://127.0.0.1:47311/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer s3cret");
    }

    #[test]
    fn a_user_message_is_one_line_of_json() {
        let message = user_message("what is in this database?");
        assert!(!message.contains('\n'));
        let parsed: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(parsed["type"], "user");
        assert_eq!(
            parsed["message"]["content"][0]["text"],
            "what is in this database?"
        );
    }

    #[test]
    fn a_message_with_a_newline_in_it_stays_one_line() {
        // Two lines would be two messages, and the second would be nonsense.
        let message = user_message("first\nsecond");
        assert!(!message.contains('\n'));
    }
}

/// A running Claude Code session.
///
/// Owns the process's stdin and the task reading its stdout. The events come
/// out of the same channel type the ACP client uses, so the layer above holds
/// one of these or the other and does not branch on which.
pub struct ClaudeSession {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    /// The id the CLI gave this conversation, once it has said.
    pub session: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl ClaudeSession {
    /// Start reading a spawned process, and return the handle and its events.
    pub fn attach(
        stdout: tokio::process::ChildStdout,
        stdin: tokio::process::ChildStdin,
    ) -> (
        std::sync::Arc<Self>,
        tokio::sync::mpsc::UnboundedReceiver<SessionEvent>,
    ) {
        use tokio::io::AsyncBufReadExt;

        let (events, stream) = tokio::sync::mpsc::unbounded_channel();
        let session = std::sync::Arc::new(std::sync::Mutex::new(None));

        let seen = session.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let mut state = ParseState::default();
            while let Ok(Some(line)) = lines.next_line().await {
                for event in parse_line(&line, &mut state) {
                    if let SessionEvent::Started { session } = &event {
                        *seen.lock().unwrap_or_else(|e| e.into_inner()) = Some(session.clone());
                    }
                    if events.send(event).is_err() {
                        return;
                    }
                }
            }
            // The process ended. Anything still expected is not coming.
            let _ = events.send(SessionEvent::Failed {
                message: "The agent stopped.".to_string(),
            });
        });

        (
            std::sync::Arc::new(Self {
                stdin: tokio::sync::Mutex::new(stdin),
                session,
            }),
            stream,
        )
    }

    /// Send a turn. The answer arrives as events.
    pub async fn prompt(&self, text: &str) -> Result<(), String> {
        self.write(&user_message(text)).await
    }

    /// Ask the turn in progress to stop, leaving the session open.
    pub async fn cancel(&self) -> Result<(), String> {
        self.write(&interrupt(&uuid::Uuid::new_v4().to_string()))
            .await
    }

    async fn write(&self, line: &str) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| format!("The agent is no longer listening: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("The agent is no longer listening: {e}"))
    }
}

/// Start Claude Code as a session.
pub fn spawn(cwd: &str, mcp_config: Option<&str>) -> std::io::Result<tokio::process::Child> {
    tokio::process::Command::new("claude")
        .args(session_args(mcp_config))
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // Inherited, so the CLI's own diagnostics reach the app's log rather
        // than filling a pipe nobody reads.
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
}
