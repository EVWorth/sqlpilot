//! The Claude Code adapter against the real CLI.
//!
//! The parser tests in `src/claude.rs` assert what this code does with a given
//! line. Only the CLI can say whether those are the lines it sends, and it is
//! a surface that moves — 2.1.270 no longer has the `--permission-prompt-tool`
//! flag the design was written against, which is exactly the sort of thing a
//! test like this catches and a document does not.
//!
//! Ignored by default: needs the CLI installed and logged in, and a turn costs
//! the user's own quota. Run with
//! `cargo test -p mas-agent --test live_claude -- --ignored`.

use mas_agent::claude::{self, ClaudeSession};
use mas_agent::event::SessionEvent;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedReceiver;

fn start(
    mcp_config: Option<&str>,
) -> (
    Arc<ClaudeSession>,
    UnboundedReceiver<SessionEvent>,
    tokio::process::Child,
) {
    let mut child = claude::spawn("/tmp", mcp_config).expect("claude is installed");
    let stdout = child.stdout.take().expect("piped");
    let stdin = child.stdin.take().expect("piped");
    let (session, events) = ClaudeSession::attach(stdout, stdin);
    (session, events, child)
}

/// Collect events until the turn ends, or until the deadline.
async fn drain(events: &mut UnboundedReceiver<SessionEvent>) -> Vec<SessionEvent> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(60), events.recv()).await {
            Ok(Some(event)) => {
                let ended = matches!(event, SessionEvent::TurnEnded { .. });
                seen.push(event);
                if ended {
                    break;
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    seen
}

#[tokio::test]
#[ignore = "needs Claude Code, logged in: costs the user's own quota"]
async fn a_turn_starts_streams_and_ends() {
    let (session, mut events, mut child) = start(None);

    session.prompt("Reply with exactly: pong").await.unwrap();
    let seen = drain(&mut events).await;

    // The session announces itself with the id the CLI gave it.
    assert!(
        matches!(seen.first(), Some(SessionEvent::Started { session }) if !session.is_empty()),
        "{seen:?}"
    );

    let answer: String = seen
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Text { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        answer.to_lowercase().contains("pong"),
        "answer was {answer:?}"
    );

    // Exactly one ending, and it is the last thing. A doubled ending would
    // mean the whole message was emitted after its own deltas.
    assert!(
        matches!(seen.last(), Some(SessionEvent::TurnEnded { .. })),
        "{seen:?}"
    );
    assert_eq!(
        seen.iter()
            .filter(|e| matches!(e, SessionEvent::TurnEnded { .. }))
            .count(),
        1
    );

    let _ = child.kill().await;
}

#[tokio::test]
#[ignore = "needs Claude Code, logged in: costs the user's own quota"]
async fn one_process_answers_more_than_one_message() {
    // The whole reason for `--input-format stream-json`: a session is a
    // conversation, not a command that answers once and exits.
    let (session, mut events, mut child) = start(None);

    session.prompt("Reply with exactly: one").await.unwrap();
    let first = drain(&mut events).await;
    assert!(matches!(first.last(), Some(SessionEvent::TurnEnded { .. })));

    session.prompt("Reply with exactly: two").await.unwrap();
    let second = drain(&mut events).await;

    let answer: String = second
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Text { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        answer.to_lowercase().contains("two"),
        "answer was {answer:?}"
    );

    let _ = child.kill().await;
}

#[tokio::test]
#[ignore = "needs Claude Code, logged in: costs the user's own quota"]
async fn a_session_is_given_our_server_and_nothing_else() {
    // `--strict-mcp-config` keeps the user's own MCP servers out of a session
    // opened from a database client. The endpoint is not running here, so the
    // server fails to connect — and the adapter says so at once rather than
    // leaving the agent to discover it has no tools.
    let config = claude::mcp_config("http://127.0.0.1:1/mcp", "not-a-real-token");
    let (session, mut events, mut child) = start(Some(&config));

    session.prompt("Reply with exactly: ok").await.unwrap();
    let seen = drain(&mut events).await;

    assert!(
        seen.iter().any(|event| matches!(
            event,
            SessionEvent::Failed { message } if message.contains("could not reach SQLPilot")
        )),
        "{seen:?}"
    );

    let _ = child.kill().await;
}
