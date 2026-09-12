//! The Agent Client Protocol, as a client.
//!
//! ACP is JSON-RPC over the agent's stdio, one message per line. It is the
//! protocol editors use to embed an agent, and it gives a host everything this
//! app needs without parsing a terminal: streaming text and reasoning, tool
//! calls with their status, a plan, and — the one that matters most here —
//! permission requests that come back to *us* to answer.
//!
//! Copilot CLI 1.0.75 speaks it behind `--acp`, verified against this machine
//! on 2026-09-12, including `mcpCapabilities: {http: true}` so SQLPilot's own
//! server goes in at `session/new` rather than into the user's global config.
//!
//! The client here is written against a pair of streams rather than against a
//! child process, so the tests drive a scripted agent through an in-memory
//! pipe. A protocol client whose only test is "it worked against the real
//! binary once" is a client whose error handling has never run.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::event::{PermissionOption, PlanEntry, SessionEvent};
use crate::think::{Piece, ThinkSplitter};

/// What every call fails with once the agent is gone. One sentence, because
/// it reaches the user as the reason their session ended.
const AGENT_STOPPED: &str = "The agent stopped.";

/// The protocol version this client implements.
pub const PROTOCOL_VERSION: u32 = 1;

/// An MCP server to hand the agent at `session/new`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub url: String,
    /// `Authorization` and friends. SQLPilot's own server needs one.
    pub headers: Vec<McpHeader>,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpHeader {
    pub name: String,
    pub value: String,
}

impl McpServer {
    /// SQLPilot's endpoint, as an agent is told about it.
    pub fn sqlpilot(url: impl Into<String>, token: &str) -> Self {
        Self {
            name: "sqlpilot".to_string(),
            url: url.into(),
            headers: vec![McpHeader {
                name: "Authorization".to_string(),
                value: format!("Bearer {token}"),
            }],
            kind: "http",
        }
    }
}

/// Requests we have sent and not yet had answered, by JSON-RPC id.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A live ACP conversation.
pub struct AcpClient {
    outgoing: mpsc::UnboundedSender<Value>,
    pending: Pending,
    permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    next_id: std::sync::atomic::AtomicU64,
    /// False once the agent's output has ended.
    ///
    /// Checked on both sides of registering a request, because the agent can
    /// die between the two — and a request registered after the last sweep
    /// would otherwise wait for a reply that nothing will ever fail.
    alive: Arc<std::sync::atomic::AtomicBool>,
}

impl AcpClient {
    /// Start speaking ACP over a pair of streams.
    ///
    /// Returns the client and the event stream. The reader task ends when the
    /// agent's output does, which is also how a crashed agent is noticed.
    pub fn new<R, W>(reader: R, mut writer: W) -> (Arc<Self>, mpsc::UnboundedReceiver<SessionEvent>)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (outgoing, mut to_write) = mpsc::unbounded_channel::<Value>();
        let (events, event_stream) = mpsc::unbounded_channel::<SessionEvent>();

        let client = Arc::new(Self {
            outgoing,
            pending: Arc::new(Mutex::new(HashMap::new())),
            permissions: Arc::new(Mutex::new(HashMap::new())),
            next_id: std::sync::atomic::AtomicU64::new(1),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        });

        tokio::spawn(async move {
            while let Some(message) = to_write.recv().await {
                let line = format!("{message}\n");
                if writer.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = writer.flush().await;
            }
        });

        let reading = client.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            let mut splitter = ThinkSplitter::new();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) if !line.trim().is_empty() => {
                        reading.receive(&line, &mut splitter, &events).await;
                    }
                    Ok(Some(_)) => continue,
                    // End of output: the agent exited. Anything still waiting
                    // for a reply will never get one, so it is failed rather
                    // than left hanging.
                    Ok(None) | Err(_) => {
                        reading.fail_everything(AGENT_STOPPED).await;
                        let _ = events.send(SessionEvent::Failed {
                            message: AGENT_STOPPED.to_string(),
                        });
                        return;
                    }
                }
            }
        });

        (client, event_stream)
    }

    /// The handshake. Returns the agent's own description of itself.
    pub async fn initialize(&self) -> Result<AgentInfo, String> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {
                        // No filesystem access through us: the agent has its
                        // own, and granting a second path would be a second
                        // thing to police.
                        "fs": {"readTextFile": false, "writeTextFile": false},
                        "terminal": false
                    }
                }),
            )
            .await?;

        Ok(AgentInfo {
            name: result["agentInfo"]["name"]
                .as_str()
                .unwrap_or("agent")
                .to_string(),
            version: result["agentInfo"]["version"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            http_mcp: result["agentCapabilities"]["mcpCapabilities"]["http"]
                .as_bool()
                .unwrap_or(false),
            auth_methods: result["authMethods"]
                .as_array()
                .map(|methods| {
                    methods
                        .iter()
                        .filter_map(|m| m["name"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    /// Open a session, with SQLPilot's MCP server wired into it.
    pub async fn new_session(&self, cwd: &str, servers: &[McpServer]) -> Result<String, String> {
        let result = self
            .request("session/new", json!({"cwd": cwd, "mcpServers": servers}))
            .await?;
        result["sessionId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "The agent opened a session without giving it an id.".to_string())
    }

    /// Send a turn. Resolves when the turn ends, with the harness's own reason.
    pub async fn prompt(&self, session: &str, text: &str) -> Result<String, String> {
        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session,
                    "prompt": [{"type": "text", "text": text}]
                }),
            )
            .await?;
        Ok(result["stopReason"]
            .as_str()
            .unwrap_or("end_turn")
            .to_string())
    }

    /// Stop the turn in progress. The prompt call then ends with "cancelled".
    pub async fn cancel(&self, session: &str) {
        self.notify("session/cancel", json!({"sessionId": session}));
    }

    /// Answer a permission request the user has decided on.
    ///
    /// Unknown ids are ignored: a request can be superseded by the session
    /// ending, and the UI has no way to know that before the click.
    pub async fn answer_permission(&self, id: &str, option: Option<&str>) {
        let Some(respond) = self.permissions.lock().await.remove(id) else {
            return;
        };
        let answer = match option {
            Some(option) => json!({"outcome": {"outcome": "selected", "optionId": option}}),
            None => json!({"outcome": {"outcome": "cancelled"}}),
        };
        let _ = respond.send(answer);
    }

    // ------------------------------------------------------------- internals

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.is_alive() {
            return Err(AGENT_STOPPED.to_string());
        }

        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        // The agent can die between the check above and this line, after the
        // reader's last sweep. Checking again here is what stops the caller
        // waiting for a reply nothing will ever fail.
        if !self.is_alive() {
            self.pending.lock().await.remove(&id);
            return Err(AGENT_STOPPED.to_string());
        }

        self.outgoing
            .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .map_err(|_| AGENT_STOPPED.to_string())?;

        rx.await.map_err(|_| AGENT_STOPPED.to_string())?
    }

    fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn notify(&self, method: &str, params: Value) {
        let _ = self
            .outgoing
            .send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn respond(&self, id: Value, result: Value) {
        let _ = self
            .outgoing
            .send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    /// One line from the agent.
    async fn receive(
        &self,
        line: &str,
        splitter: &mut ThinkSplitter,
        events: &mpsc::UnboundedSender<SessionEvent>,
    ) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            // Agents print things. A line that is not JSON is not a protocol
            // violation worth ending the session over.
            tracing::debug!(line = %line, "ignoring a non-JSON line from the agent");
            return;
        };

        // A reply to something we asked.
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if message.get("method").is_none() {
                let answer = match message.get("error") {
                    Some(error) => Err(error["message"]
                        .as_str()
                        .unwrap_or("The agent reported an error.")
                        .to_string()),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                if let Some(waiting) = self.pending.lock().await.remove(&id) {
                    let _ = waiting.send(answer);
                }
                return;
            }
        }

        match message.get("method").and_then(Value::as_str) {
            Some("session/update") => {
                for event in updates(&message["params"]["update"], splitter) {
                    let _ = events.send(event);
                }
            }
            Some("session/request_permission") => {
                self.ask_permission(&message, events).await;
            }
            // Anything else the agent asks of us — filesystem reads, terminal
            // creation — was declined at initialize, so refusing is the
            // consistent answer rather than a surprise.
            Some(other) => {
                if let Some(id) = message.get("id") {
                    tracing::debug!(method = %other, "refusing an agent request we do not serve");
                    self.respond(
                        id.clone(),
                        json!({"error": "SQLPilot does not provide this capability."}),
                    );
                }
            }
            None => {}
        }
    }

    async fn ask_permission(&self, message: &Value, events: &mpsc::UnboundedSender<SessionEvent>) {
        let Some(request_id) = message.get("id").cloned() else {
            return;
        };
        let params = &message["params"];
        let options: Vec<PermissionOption> = params["options"]
            .as_array()
            .map(|options| {
                options
                    .iter()
                    .map(|option| PermissionOption {
                        id: option["optionId"].as_str().unwrap_or_default().to_string(),
                        label: option["name"].as_str().unwrap_or("Allow").to_string(),
                        kind: option["kind"].as_str().unwrap_or("unknown").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        if options.is_empty() {
            // A request with nothing to choose cannot be answered. Refusing is
            // the only safe reading.
            self.respond(request_id, json!({"outcome": {"outcome": "cancelled"}}));
            return;
        }

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.permissions.lock().await.insert(id.clone(), tx);

        let _ = events.send(SessionEvent::PermissionRequested {
            id,
            title: params["toolCall"]["title"]
                .as_str()
                .or_else(|| params["toolCall"]["rawInput"]["command"].as_str())
                .unwrap_or("The agent is asking for permission")
                .to_string(),
            detail: params["toolCall"]["kind"].as_str().map(str::to_string),
            options,
        });

        // Answered off the protocol loop: a dialog left open must not stop the
        // transcript from updating.
        let outgoing = self.outgoing.clone();
        tokio::spawn(async move {
            let answer = rx
                .await
                .unwrap_or_else(|_| json!({"outcome": {"outcome": "cancelled"}}));
            let _ = outgoing.send(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": answer
            }));
        });
    }

    async fn fail_everything(&self, reason: &str) {
        // Set first: a request that arrives during this sweep sees a dead
        // client and fails itself rather than being missed by it.
        self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
        for (_, waiting) in self.pending.lock().await.drain() {
            let _ = waiting.send(Err(reason.to_string()));
        }
        for (_, respond) in self.permissions.lock().await.drain() {
            let _ = respond.send(json!({"outcome": {"outcome": "cancelled"}}));
        }
    }
}

/// What the agent said it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInfo {
    pub name: String,
    pub version: String,
    /// Whether it can take an HTTP MCP server. Without this SQLPilot's own
    /// tools cannot be wired into the session at all, and the user should be
    /// told that rather than left wondering why the agent cannot see anything.
    pub http_mcp: bool,
    /// How to log in, if it is not logged in already.
    pub auth_methods: Vec<String>,
}

/// One `session/update` turned into events.
fn updates(update: &Value, splitter: &mut ThinkSplitter) -> Vec<SessionEvent> {
    match update["sessionUpdate"].as_str() {
        Some("agent_message_chunk") => {
            let text = update["content"]["text"].as_str().unwrap_or_default();
            // Some models write their reasoning inline. Separating it is this
            // crate's job, not the transcript's.
            splitter
                .push(text)
                .into_iter()
                .map(|piece| match piece {
                    Piece::Answer(delta) => SessionEvent::Text { delta },
                    Piece::Thought(delta) => SessionEvent::Thought { delta },
                })
                .collect()
        }

        Some("agent_thought_chunk") => vec![SessionEvent::Thought {
            delta: update["content"]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        }],

        Some("tool_call") => vec![SessionEvent::ToolStarted {
            id: update["toolCallId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            title: update["title"].as_str().unwrap_or("Working").to_string(),
            kind: update["kind"].as_str().unwrap_or("other").to_string(),
        }],

        Some("tool_call_update") => {
            let status = update["status"].as_str().unwrap_or_default();
            // "in_progress" is not news: the transcript already shows the call
            // as running, and an event per progress tick is noise.
            if status != "completed" && status != "failed" {
                return Vec::new();
            }
            vec![SessionEvent::ToolFinished {
                id: update["toolCallId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                status: status.to_string(),
                detail: update["content"][0]["content"]["text"]
                    .as_str()
                    .map(str::to_string),
            }]
        }

        Some("plan") => vec![SessionEvent::Plan {
            entries: update["entries"]
                .as_array()
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| PlanEntry {
                            content: entry["content"].as_str().unwrap_or_default().to_string(),
                            status: entry["status"].as_str().unwrap_or("pending").to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }],

        // The user's own message echoed back, the command list, mode changes:
        // real parts of the protocol with nothing to show in a transcript that
        // already knows what the user typed.
        _ => Vec::new(),
    }
}
