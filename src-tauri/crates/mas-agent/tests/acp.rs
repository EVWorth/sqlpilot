//! The ACP client, against a scripted agent.
//!
//! The real agent is a CLI that has to be installed, logged in, and paid for.
//! These drive the protocol through an in-memory pipe instead, which is the
//! only way to exercise the parts that matter and are hard to provoke on
//! purpose: an agent that dies mid-turn, a permission request answered after
//! the session ended, a line of output that is not JSON at all.
//!
//! The shapes come from a live Copilot CLI 1.0.75 session, captured 2026-09-12.

use std::sync::Arc;

use mas_agent::acp::{AcpClient, McpServer};
use mas_agent::event::SessionEvent;
use serde_json::{json, Value};
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc::UnboundedReceiver;

/// The far end of the pipe: what the agent sees, and what it can say.
struct Agent {
    lines: tokio::io::Lines<BufReader<DuplexStream>>,
    out: DuplexStream,
}

impl Agent {
    /// The next message the client sent.
    async fn next(&mut self) -> Value {
        let line = self
            .lines
            .next_line()
            .await
            .expect("readable")
            .expect("the client sent something");
        serde_json::from_str(&line).expect("the client speaks JSON")
    }

    async fn say(&mut self, message: Value) {
        self.out
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
        self.out.flush().await.unwrap();
    }

    /// Anything at all, including things that are not JSON.
    async fn say_raw(&mut self, line: &str) {
        self.out
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        self.out.flush().await.unwrap();
    }

    fn update(session: &str, update: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session, "update": update}
        })
    }
}

fn connect() -> (Arc<AcpClient>, UnboundedReceiver<SessionEvent>, Agent) {
    let (client_side_in, agent_out) = duplex(64 * 1024);
    let (agent_in, client_side_out) = duplex(64 * 1024);
    let (client, events) = AcpClient::new(client_side_in, client_side_out);
    (
        client,
        events,
        Agent {
            lines: BufReader::new(agent_in).lines(),
            out: agent_out,
        },
    )
}

/// Wait for the next event, failing the test rather than hanging forever.
async fn next_event(events: &mut UnboundedReceiver<SessionEvent>) -> SessionEvent {
    tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
        .await
        .expect("an event arrives")
        .expect("the stream is open")
}

#[tokio::test]
async fn the_handshake_reports_what_the_agent_is() {
    let (client, _events, mut agent) = connect();

    let handshake = tokio::spawn(async move { client.initialize().await });

    let request = agent.next().await;
    assert_eq!(request["method"], "initialize");
    assert_eq!(request["params"]["protocolVersion"], 1);

    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"mcpCapabilities": {"http": true}},
                "agentInfo": {"name": "Copilot", "version": "1.0.75"},
                "authMethods": [{"id": "copilot-login", "name": "Log in with Copilot CLI"}]
            }
        }))
        .await;

    let info = handshake.await.unwrap().unwrap();
    assert_eq!(info.name, "Copilot");
    assert_eq!(info.version, "1.0.75");
    assert!(
        info.http_mcp,
        "without this SQLPilot's own tools cannot be wired in at all"
    );
    assert_eq!(info.auth_methods, vec!["Log in with Copilot CLI"]);
}

#[tokio::test]
async fn we_do_not_offer_the_agent_a_second_way_into_the_filesystem() {
    // The agent has its own file access, policed by its own permissions.
    // Granting a second path through us would be a second thing to police.
    let (client, _events, mut agent) = connect();
    tokio::spawn(async move { client.initialize().await });

    let request = agent.next().await;
    let fs = &request["params"]["clientCapabilities"]["fs"];
    assert_eq!(fs["readTextFile"], false);
    assert_eq!(fs["writeTextFile"], false);
}

#[tokio::test]
async fn a_session_carries_sqlpilots_own_server() {
    let (client, _events, mut agent) = connect();
    let servers = vec![McpServer::sqlpilot("http://127.0.0.1:47311/mcp", "s3cret")];

    tokio::spawn({
        let client = client.clone();
        async move { client.new_session("/tmp/work", &servers).await }
    });

    let request = agent.next().await;
    assert_eq!(request["method"], "session/new");
    assert_eq!(request["params"]["cwd"], "/tmp/work");

    let server = &request["params"]["mcpServers"][0];
    assert_eq!(server["name"], "sqlpilot");
    assert_eq!(server["type"], "http");
    assert_eq!(server["url"], "http://127.0.0.1:47311/mcp");
    // The token travels with the session rather than being written into the
    // user's global config, where it would outlive the session.
    assert_eq!(server["headers"][0]["name"], "Authorization");
    assert_eq!(server["headers"][0]["value"], "Bearer s3cret");
}

#[tokio::test]
async fn a_session_without_an_id_is_an_error_rather_than_an_empty_string() {
    let (client, _events, mut agent) = connect();
    let opening = tokio::spawn({
        let client = client.clone();
        async move { client.new_session("/tmp", &[]).await }
    });

    let request = agent.next().await;
    agent
        .say(json!({"jsonrpc": "2.0", "id": request["id"], "result": {}}))
        .await;

    assert!(opening.await.unwrap().is_err());
}

#[tokio::test]
async fn text_arrives_as_it_is_written() {
    let (client, mut events, mut agent) = connect();
    let turn = tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hello").await }
    });

    let request = agent.next().await;
    assert_eq!(request["method"], "session/prompt");
    assert_eq!(request["params"]["prompt"][0]["text"], "hello");

    for chunk in ["The ", "answer ", "is 42."] {
        agent
            .say(Agent::update(
                "s1",
                json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": chunk}}),
            ))
            .await;
    }
    agent
        .say(json!({"jsonrpc": "2.0", "id": request["id"], "result": {"stopReason": "end_turn"}}))
        .await;

    // Deltas, not a whole message at the end: a transcript that only updates
    // when a turn ends reads as a hang.
    for expected in ["The ", "answer ", "is 42."] {
        assert_eq!(
            next_event(&mut events).await,
            SessionEvent::Text {
                delta: expected.to_string()
            }
        );
    }
    assert_eq!(turn.await.unwrap().unwrap(), "end_turn");
}

#[tokio::test]
async fn reasoning_written_inline_is_separated_from_the_answer() {
    // The model Copilot defaults to writes its reasoning as <think>…</think>
    // in the ordinary message stream, split across chunks.
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    for chunk in ["<thi", "nk>weighing it up</think>", "pong"] {
        agent
            .say(Agent::update(
                "s1",
                json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": chunk}}),
            ))
            .await;
    }

    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::Thought {
            delta: "weighing it up".into()
        }
    );
    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::Text {
            delta: "pong".into()
        }
    );
}

#[tokio::test]
async fn reasoning_reported_properly_is_passed_through_as_reasoning() {
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    agent
        .say(Agent::update(
            "s1",
            json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}),
        ))
        .await;

    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::Thought {
            delta: "hmm".into()
        }
    );
}

#[tokio::test]
async fn tool_calls_show_what_the_agent_is_doing() {
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    agent
        .say(Agent::update(
            "s1",
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "run_select on shop",
                "kind": "execute",
                "status": "pending"
            }),
        ))
        .await;
    agent
        .say(Agent::update(
            "s1",
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "in_progress"
            }),
        ))
        .await;
    agent
        .say(Agent::update(
            "s1",
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{"content": {"type": "text", "text": "3 rows"}}]
            }),
        ))
        .await;

    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::ToolStarted {
            id: "t1".into(),
            title: "run_select on shop".into(),
            kind: "execute".into(),
        }
    );
    // "in_progress" produced nothing: the transcript already shows it running,
    // and an event per progress tick is noise.
    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::ToolFinished {
            id: "t1".into(),
            status: "completed".into(),
            detail: Some("3 rows".into()),
        }
    );
}

#[tokio::test]
async fn a_permission_request_becomes_a_question_for_the_user() {
    let (client, mut events, mut agent) = connect();

    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": {"title": "Run `rm -rf build`", "kind": "execute"},
                "options": [
                    {"optionId": "yes", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                    {"optionId": "no", "name": "Reject", "kind": "reject_once"}
                ]
            }
        }))
        .await;

    let SessionEvent::PermissionRequested {
        id, title, options, ..
    } = next_event(&mut events).await
    else {
        panic!("expected a permission request");
    };
    assert_eq!(title, "Run `rm -rf build`");
    assert_eq!(options.len(), 3);
    assert!(options[0].is_allow() && !options[0].is_persistent());
    assert!(options[1].is_persistent());
    assert!(!options[2].is_allow());

    client.answer_permission(&id, Some("yes")).await;

    let reply = agent.next().await;
    assert_eq!(reply["id"], 99);
    assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
    assert_eq!(reply["result"]["outcome"]["optionId"], "yes");
}

#[tokio::test]
async fn a_permission_nobody_answers_does_not_block_the_transcript() {
    // The failure this prevents: a dialog left open stopping text from
    // arriving, so the app looks frozen while it waits for a click.
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": {"title": "Do something"},
                "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]
            }
        }))
        .await;
    let _ = next_event(&mut events).await;

    agent
        .say(Agent::update(
            "s1",
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "still talking"}}),
        ))
        .await;

    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::Text {
            delta: "still talking".into()
        }
    );
}

#[tokio::test]
async fn declining_a_permission_says_cancelled_rather_than_nothing() {
    let (client, mut events, mut agent) = connect();

    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": {"title": "Do something"},
                "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]
            }
        }))
        .await;

    let SessionEvent::PermissionRequested { id, .. } = next_event(&mut events).await else {
        panic!("expected a permission request");
    };
    client.answer_permission(&id, None).await;

    assert_eq!(
        agent.next().await["result"]["outcome"]["outcome"],
        "cancelled"
    );
}

#[tokio::test]
async fn a_permission_request_with_nothing_to_choose_is_refused() {
    // Unanswerable. Treating it as consent would be the worst reading.
    let (_client, mut events, mut agent) = connect();

    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": {"sessionId": "s1", "toolCall": {"title": "x"}, "options": []}
        }))
        .await;

    assert_eq!(
        agent.next().await["result"]["outcome"]["outcome"],
        "cancelled"
    );
    assert!(events.try_recv().is_err(), "and the user is not asked");
}

#[tokio::test]
async fn answering_a_permission_that_no_longer_exists_is_harmless() {
    // The session can end between the question and the click.
    let (client, _events, _agent) = connect();
    client.answer_permission("never-existed", Some("yes")).await;
}

#[tokio::test]
async fn a_capability_we_declined_is_refused_rather_than_ignored() {
    // Silence would leave the agent waiting for a reply that never comes.
    let (_client, _events, mut agent) = connect();

    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "fs/read_text_file",
            "params": {"path": "/etc/passwd"}
        }))
        .await;

    let reply = agent.next().await;
    assert_eq!(reply["id"], 5);
    assert!(reply["result"]["error"]
        .as_str()
        .unwrap()
        .contains("SQLPilot"));
}

#[tokio::test]
async fn a_line_that_is_not_json_is_ignored_rather_than_fatal() {
    // Agents print things: update notices, warnings, progress bars.
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    agent
        .say_raw("Run 'copilot update' to check for updates.")
        .await;
    agent
        .say(Agent::update(
            "s1",
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}),
        ))
        .await;

    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::Text { delta: "hi".into() }
    );
}

#[tokio::test]
async fn an_agent_that_dies_mid_turn_fails_the_turn_rather_than_hanging() {
    let (client, mut events, agent) = connect();
    let turn = tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });

    drop(agent);

    assert!(
        turn.await.unwrap().is_err(),
        "the caller is told, not left waiting"
    );
    assert!(matches!(
        next_event(&mut events).await,
        SessionEvent::Failed { .. }
    ));
}

#[tokio::test]
async fn an_error_reply_carries_the_agents_own_message() {
    let (client, _events, mut agent) = connect();
    let turn = tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });

    let request = agent.next().await;
    agent
        .say(json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": -32000, "message": "Not authenticated. Run `copilot login`."}
        }))
        .await;

    let error = turn.await.unwrap().unwrap_err();
    assert!(error.contains("copilot login"), "{error}");
}

#[tokio::test]
async fn cancelling_asks_the_agent_to_stop() {
    let (client, _events, mut agent) = connect();
    client.cancel("s1").await;

    let message = agent.next().await;
    assert_eq!(message["method"], "session/cancel");
    assert_eq!(message["params"]["sessionId"], "s1");
    assert!(message.get("id").is_none(), "a notification, not a request");
}

#[tokio::test]
async fn a_plan_comes_through_so_the_user_can_see_where_it_is_going() {
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    agent
        .say(Agent::update(
            "s1",
            json!({
                "sessionUpdate": "plan",
                "entries": [
                    {"content": "Read the schema", "status": "completed"},
                    {"content": "Write the migration", "status": "in_progress"}
                ]
            }),
        ))
        .await;

    let SessionEvent::Plan { entries } = next_event(&mut events).await else {
        panic!("expected a plan");
    };
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].status, "in_progress");
}

#[tokio::test]
async fn updates_with_nothing_to_show_produce_nothing() {
    // The command list and mode changes are real protocol, and a transcript
    // full of them would bury the conversation.
    let (client, mut events, mut agent) = connect();
    tokio::spawn({
        let client = client.clone();
        async move { client.prompt("s1", "hi").await }
    });
    agent.next().await;

    agent
        .say(Agent::update(
            "s1",
            json!({"sessionUpdate": "available_commands_update", "availableCommands": []}),
        ))
        .await;
    agent
        .say(Agent::update(
            "s1",
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}),
        ))
        .await;

    assert_eq!(
        next_event(&mut events).await,
        SessionEvent::Text { delta: "hi".into() }
    );
}
