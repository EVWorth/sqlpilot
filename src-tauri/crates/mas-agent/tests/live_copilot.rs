//! The ACP client against the real Copilot CLI.
//!
//! The scripted tests in `acp.rs` assert what this client does with a given
//! message. Only the CLI itself can say whether those are the messages it
//! sends — and this is a surface that moves, so a test that notices when it
//! moves is worth more than a note in a design document.
//!
//! Ignored by default: it needs the CLI installed and logged in, and a prompt
//! costs the user's own quota. Run it with
//! `cargo test -p mas-agent --test live_copilot -- --ignored`.

use mas_agent::acp::{AcpClient, McpServer};
use mas_agent::event::SessionEvent;
use mas_agent::harness::{spawn_acp, Harness};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedReceiver;

/// Start the real thing, and hand back the pieces a test needs.
async fn start() -> (
    Arc<AcpClient>,
    UnboundedReceiver<SessionEvent>,
    tokio::process::Child,
) {
    let mut child = spawn_acp(Harness::Copilot, "/tmp").expect("copilot is installed");
    let stdout = child.stdout.take().expect("piped");
    let stdin = child.stdin.take().expect("piped");
    let (client, events) = AcpClient::new(stdout, stdin);
    (client, events, child)
}

#[tokio::test]
#[ignore = "needs GitHub Copilot CLI, logged in: cargo test -p mas-agent --test live_copilot -- --ignored"]
async fn it_speaks_the_protocol_this_client_implements() {
    let (client, _events, mut child) = start().await;

    let info = client.initialize().await.expect("the handshake completes");

    assert_eq!(info.name, "Copilot");
    assert!(!info.version.is_empty());
    // The capability the whole integration rests on: without it SQLPilot's own
    // tools cannot be wired into the session at all.
    assert!(
        info.http_mcp,
        "Copilot no longer accepts an HTTP MCP server at session/new"
    );

    let _ = child.kill().await;
}

#[tokio::test]
#[ignore = "needs GitHub Copilot CLI, logged in: cargo test -p mas-agent --test live_copilot -- --ignored"]
async fn a_session_accepts_sqlpilots_server_without_complaint() {
    // The token is nonsense and the endpoint is not running: what is being
    // tested is that the CLI takes the shape we send, not that it can reach
    // the server.
    let (client, _events, mut child) = start().await;
    client.initialize().await.unwrap();

    let session = client
        .new_session(
            "/tmp",
            &[McpServer::sqlpilot("http://127.0.0.1:1/mcp", "nope")],
        )
        .await
        .expect("a session opens");
    assert!(!session.is_empty());

    let _ = child.kill().await;
}

#[tokio::test]
#[ignore = "needs GitHub Copilot CLI, logged in: costs the user's own quota"]
async fn a_turn_streams_and_ends() {
    let (client, mut events, mut child) = start().await;
    client.initialize().await.unwrap();
    let session = client.new_session("/tmp", &[]).await.unwrap();

    let turn = {
        let client = client.clone();
        let session = session.clone();
        tokio::spawn(async move { client.prompt(&session, "Reply with exactly: pong").await })
    };

    let mut answer = String::new();
    let mut reasoning = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(30), events.recv()).await {
            Ok(Some(SessionEvent::Text { delta })) => answer.push_str(&delta),
            Ok(Some(SessionEvent::Thought { delta })) => reasoning.push_str(&delta),
            Ok(Some(SessionEvent::Failed { message })) => panic!("{message}"),
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => break,
        }
        if turn.is_finished() && !answer.is_empty() {
            break;
        }
    }

    assert_eq!(turn.await.unwrap().unwrap(), "end_turn");
    assert!(
        answer.to_lowercase().contains("pong"),
        "answer was {answer:?}"
    );
    // The reasoning, if there was any, did not end up in the answer — which is
    // the whole point of the splitter.
    assert!(!answer.contains("<think>"), "answer was {answer:?}");
    assert!(!reasoning.contains("<think>"));

    let _ = child.kill().await;
}
