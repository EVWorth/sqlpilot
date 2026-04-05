use copilot_sdk::{
    Client, PermissionRequest, PermissionRequestResult, SessionConfig, SessionEventData,
    SessionMode, SystemMessageConfig, SystemMessageMode,
};
use mas_core::connection::ConnectionManager;
use mas_core::schema::SchemaInspector;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::error::AiError;
use crate::models::{AiConfig, AiMode, AiStatus, AiStreamEvent};
use crate::tools;

struct SessionEntry {
    session: Arc<copilot_sdk::Session>,
    connection_id: Option<String>,
    database: Option<String>,
    mode: AiMode,
}

pub struct AiService {
    client: Arc<RwLock<Option<Client>>>,
    connection_manager: Arc<ConnectionManager>,
    sessions: Arc<RwLock<HashMap<String, SessionEntry>>>,
    config: Arc<RwLock<AiConfig>>,
    pending_approvals: Arc<RwLock<HashMap<String, oneshot::Sender<bool>>>>,
}

impl AiService {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self {
            client: Arc::new(RwLock::new(None)),
            connection_manager,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            config: Arc::new(RwLock::new(AiConfig { model: None })),
            pending_approvals: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn ensure_started(&self) -> Result<&Self, AiError> {
        let needs_start = {
            let guard = self.client.read().await;
            guard.is_none()
        };

        if needs_start {
            let mut guard = self.client.write().await;
            // Double-check after acquiring write lock
            if guard.is_none() {
                tracing::info!("Starting Copilot SDK client");
                let client = Client::builder()
                    .build()
                    .map_err(|e| AiError::SdkError(format!("Failed to build client: {}", e)))?;

                client
                    .start()
                    .await
                    .map_err(|e| AiError::SdkError(format!("Failed to start client: {}", e)))?;

                tracing::info!("Copilot SDK client started successfully");
                *guard = Some(client);
            }
        }
        Ok(self)
    }

    async fn build_schema_context(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<String, AiError> {
        let inspector = SchemaInspector::new(self.connection_manager.clone());
        let tables = inspector
            .get_tables(connection_id, database)
            .await
            .map_err(|e| AiError::ContextError(e.to_string()))?;

        let mut context = format!("-- Database: {}\n", database);
        let base_tables: Vec<_> = tables
            .iter()
            .filter(|t| t.table_type == "BASE TABLE")
            .collect();
        context.push_str(&format!("-- Tables: {}\n\n", base_tables.len()));

        for table in &base_tables {
            let columns = inspector
                .get_columns(connection_id, database, &table.name)
                .await
                .map_err(|e| AiError::ContextError(e.to_string()))?;

            context.push_str(&format!("CREATE TABLE `{}` (\n", table.name));
            for (i, col) in columns.iter().enumerate() {
                context.push_str(&format!(
                    "  `{}` {}{}{}",
                    col.name,
                    col.column_type,
                    if col.nullable { "" } else { " NOT NULL" },
                    if col.is_primary_key {
                        " PRIMARY KEY"
                    } else {
                        ""
                    },
                ));
                if i < columns.len() - 1 {
                    context.push(',');
                }
                context.push('\n');
            }
            context.push_str(");\n\n");

            if context.len() > 4000 {
                context.push_str("-- ... (schema truncated)\n");
                break;
            }
        }

        Ok(context)
    }

    pub async fn chat(
        &self,
        message: &str,
        conversation_id: &str,
        mode: &AiMode,
        connection_id: Option<&str>,
        database: Option<&str>,
        event_sender: mpsc::Sender<AiStreamEvent>,
    ) -> Result<String, AiError> {
        self.ensure_started().await?;

        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| AiError::SdkError("Client not started".to_string()))?;

        // Build schema context if we have a database connection
        let schema_context = match (connection_id, database) {
            (Some(conn_id), Some(db)) => {
                match self.build_schema_context(conn_id, db).await {
                    Ok(ctx) => Some(ctx),
                    Err(e) => {
                        tracing::warn!(error = %e, "Failed to build schema context, proceeding without it");
                        None
                    }
                }
            }
            _ => None,
        };

        // Build system message based on mode
        let system_content = {
            let base = match mode {
                AiMode::Ask => {
                    "You are an expert MySQL database assistant integrated into SQLPilot. \
                     You are in READ-ONLY mode. Help users understand their database by inspecting schema, \
                     running SELECT queries, and explaining query plans. \
                     You may ONLY use the database tools provided to you — no shell commands, no file operations. \
                     Do NOT attempt to modify data or schema. If the user asks for modifications, \
                     provide the SQL they would need but explain they should switch to Agent mode to execute it."
                }
                AiMode::Agent => {
                    "You are an expert MySQL database assistant integrated into SQLPilot. \
                     You are in AGENT mode with full database access. \
                     Help users with queries, schema design, performance tuning, and database management. \
                     Use the available database tools to inspect schema, run queries, and make changes. \
                     You may ONLY use the database tools provided — no shell commands, no file operations."
                }
                AiMode::Plan => {
                    "You are an expert MySQL database assistant integrated into SQLPilot. \
                     You are in PLAN mode. Before executing any changes, create a detailed plan \
                     and explain each step. Use the available database tools to inspect the current state, \
                     then propose changes. Write operations will require user approval. \
                     You may ONLY use the database tools provided — no shell commands, no file operations."
                }
            };
            match &schema_context {
                Some(ctx) => format!("{}\n\nCurrent database schema:\n{}", base, ctx),
                None => base.to_string(),
            }
        };

        // Map AiMode to SDK SessionMode
        let sdk_mode = match mode {
            AiMode::Ask => SessionMode::Interactive,
            AiMode::Agent => SessionMode::Autopilot,
            AiMode::Plan => SessionMode::Plan,
        };

        // Check if we already have a session for this conversation
        let need_new_session = {
            let sessions = self.sessions.read().await;
            match sessions.get(conversation_id) {
                Some(entry) => {
                    // Create a new session if connection, database, or mode changed
                    entry.connection_id.as_deref() != connection_id
                        || entry.database.as_deref() != database
                        || entry.mode != *mode
                }
                None => true,
            }
        };

        let session = if need_new_session {
            // Build tools based on mode and connection availability
            let tool_pairs = if let Some(conn_id) = connection_id {
                match mode {
                    AiMode::Ask => {
                        tools::build_read_tool_handlers(self.connection_manager.clone(), conn_id.to_string())
                    }
                    AiMode::Agent | AiMode::Plan => {
                        tools::build_tool_handlers(self.connection_manager.clone(), conn_id.to_string())
                    }
                }
            } else {
                Vec::new()
            };

            let tool_defs: Vec<copilot_sdk::Tool> =
                tool_pairs.iter().map(|(t, _)| t.clone()).collect();

            // For Ask mode, restrict to ONLY our registered tools (blocks built-in bash, etc.)
            let available_tools = if *mode == AiMode::Ask {
                Some(tool_defs.iter().map(|t| t.name.clone()).collect::<Vec<_>>())
            } else {
                None
            };

            let config = self.config.read().await;
            let session_config = SessionConfig {
                tools: tool_defs,
                available_tools,
                system_message: Some(SystemMessageConfig {
                    mode: Some(SystemMessageMode::Replace),
                    content: Some(system_content),
                }),
                streaming: true,
                model: config.model.clone(),
                client_name: Some("sqlpilot".to_string()),
                ..Default::default()
            };

            let session = client
                .create_session(session_config)
                .await
                .map_err(|e| AiError::SdkError(format!("Failed to create session: {}", e)))?;

            // Register tool handlers
            for (tool, handler) in tool_pairs {
                session
                    .register_tool_with_handler(tool, Some(handler))
                    .await;
            }

            // Register permission handler based on mode
            if *mode == AiMode::Ask {
                session
                    .register_permission_handler(|_req| PermissionRequestResult::approved())
                    .await;
            } else {
                let approvals = self.pending_approvals.clone();
                let tx_for_handler = event_sender.clone();
                let conv_id_for_handler = conversation_id.to_string();

                session
                    .register_permission_handler(move |req: &PermissionRequest| {
                        let tool_name = req
                            .extension_data
                            .get("toolName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");

                        // Read-only tools auto-approve
                        const READ_TOOLS: &[&str] = &[
                            "list_databases",
                            "list_tables",
                            "describe_table",
                            "get_table_ddl",
                            "run_select_query",
                            "explain_query",
                            "list_routines",
                            "show_process_list",
                        ];
                        if READ_TOOLS.contains(&tool_name) {
                            return PermissionRequestResult::approved();
                        }

                        // For write tools, send to frontend and wait for response
                        let approvals = approvals.clone();
                        let tx = tx_for_handler.clone();
                        let conv_id = conv_id_for_handler.clone();
                        let tool = tool_name.to_string();

                        let approved = tokio::task::block_in_place(|| {
                            tokio::runtime::Handle::current().block_on(async {
                                let (response_tx, response_rx) = oneshot::channel::<bool>();
                                let request_id = uuid::Uuid::new_v4().to_string();

                                approvals
                                    .write()
                                    .await
                                    .insert(request_id.clone(), response_tx);

                                let _ = tx
                                    .send(AiStreamEvent::PermissionRequest {
                                        conversation_id: conv_id,
                                        tool_name: tool.clone(),
                                        description: format!("Execute: {}", tool),
                                        request_id: request_id.clone(),
                                    })
                                    .await;

                                // Wait up to 5 minutes for user response
                                match tokio::time::timeout(
                                    Duration::from_secs(300),
                                    response_rx,
                                )
                                .await
                                {
                                    Ok(Ok(val)) => val,
                                    _ => {
                                        // Timeout or channel error — clean up and deny
                                        approvals.write().await.remove(&request_id);
                                        false
                                    }
                                }
                            })
                        });

                        if approved {
                            PermissionRequestResult::approved()
                        } else {
                            PermissionRequestResult::denied()
                        }
                    })
                    .await;
            }

            // Set mode
            if sdk_mode != SessionMode::Interactive {
                if let Err(e) = session.set_mode(sdk_mode).await {
                    tracing::warn!(error = %e, "Failed to set session mode");
                }
            }

            // Store session
            {
                let mut sessions = self.sessions.write().await;
                sessions.insert(
                    conversation_id.to_string(),
                    SessionEntry {
                        session: session.clone(),
                        connection_id: connection_id.map(|s| s.to_string()),
                        database: database.map(|s| s.to_string()),
                        mode: mode.clone(),
                    },
                );
            }

            session
        } else {
            let sessions = self.sessions.read().await;
            sessions.get(conversation_id).unwrap().session.clone()
        };

        // Subscribe to events before sending
        let mut events = session.subscribe();
        let conv_id = conversation_id.to_string();

        // Send the message
        session
            .send(message)
            .await
            .map_err(|e| AiError::SdkError(format!("Failed to send message: {}", e)))?;

        // Process events until idle/error
        let mut full_response = String::new();
        let event_conv_id = conv_id.clone();

        loop {
            match events.recv().await {
                Ok(event) => {
                    match &event.data {
                        SessionEventData::AssistantMessageDelta(data) => {
                            full_response.push_str(&data.delta_content);
                            let _ = event_sender
                                .send(AiStreamEvent::TextDelta {
                                    conversation_id: event_conv_id.clone(),
                                    content: data.delta_content.clone(),
                                })
                                .await;
                        }
                        SessionEventData::AssistantMessage(data) => {
                            // Final complete message — if we didn't get deltas, use this
                            if full_response.is_empty() {
                                full_response = data.content.clone();
                                let _ = event_sender
                                    .send(AiStreamEvent::TextDelta {
                                        conversation_id: event_conv_id.clone(),
                                        content: data.content.clone(),
                                    })
                                    .await;
                            }
                        }
                        SessionEventData::ToolExecutionStart(data) => {
                            let _ = event_sender
                                .send(AiStreamEvent::ToolStart {
                                    conversation_id: event_conv_id.clone(),
                                    tool_name: data.tool_name.clone(),
                                    tool_call_id: data.tool_call_id.clone(),
                                    arguments: data.arguments.clone(),
                                })
                                .await;
                        }
                        SessionEventData::AssistantIntent(data) => {
                            let _ = event_sender
                                .send(AiStreamEvent::Intent {
                                    conversation_id: event_conv_id.clone(),
                                    intent: data.intent.clone(),
                                })
                                .await;
                        }
                        SessionEventData::ToolExecutionComplete(data) => {
                            let result_text = data
                                .result
                                .as_ref()
                                .map(|r| r.content.clone())
                                .or_else(|| {
                                    data.error.as_ref().map(|e| e.message.clone())
                                })
                                .unwrap_or_default();
                            let _ = event_sender
                                .send(AiStreamEvent::ToolComplete {
                                    conversation_id: event_conv_id.clone(),
                                    tool_name: String::new(), // not in complete data directly
                                    tool_call_id: data.tool_call_id.clone(),
                                    result: result_text,
                                    success: data.success,
                                })
                                .await;
                        }
                        SessionEventData::SessionError(data) => {
                            let _ = event_sender
                                .send(AiStreamEvent::Error {
                                    conversation_id: event_conv_id.clone(),
                                    message: data.message.clone(),
                                })
                                .await;
                            break;
                        }
                        SessionEventData::SessionIdle(_) => {
                            let _ = event_sender
                                .send(AiStreamEvent::Idle {
                                    conversation_id: event_conv_id.clone(),
                                })
                                .await;
                            break;
                        }
                        SessionEventData::Abort(data) => {
                            tracing::info!(reason = %data.reason, "Session aborted");
                            let _ = event_sender
                                .send(AiStreamEvent::Idle {
                                    conversation_id: event_conv_id.clone(),
                                })
                                .await;
                            break;
                        }
                        _ => {
                            // Ignore other events
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Event channel error");
                    break;
                }
            }
        }

        Ok(full_response)
    }

    pub async fn get_status(&self) -> AiStatus {
        // Try to start the client if not already started
        if let Err(e) = self.ensure_started().await {
            tracing::debug!(error = %e, "Copilot SDK not available");
            return AiStatus {
                provider: "copilot".to_string(),
                available: false,
                model: None,
            };
        }

        let guard = self.client.read().await;
        if let Some(client) = guard.as_ref() {
            match client.get_auth_status().await {
                Ok(auth) => AiStatus {
                    provider: "copilot".to_string(),
                    available: auth.is_authenticated,
                    model: self.config.read().await.model.clone(),
                },
                Err(_) => AiStatus {
                    provider: "copilot".to_string(),
                    available: false,
                    model: None,
                },
            }
        } else {
            AiStatus {
                provider: "copilot".to_string(),
                available: false,
                model: None,
            }
        }
    }

    pub async fn set_config(&self, config: AiConfig) -> Result<(), AiError> {
        let mut current = self.config.write().await;
        *current = config;
        Ok(())
    }

    pub async fn resolve_permission(
        &self,
        _conversation_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<(), AiError> {
        let mut approvals = self.pending_approvals.write().await;
        if let Some(tx) = approvals.remove(request_id) {
            let _ = tx.send(approved);
            Ok(())
        } else {
            Err(AiError::SessionNotFound(format!(
                "No pending approval: {}",
                request_id
            )))
        }
    }

    pub async fn cancel(&self, conversation_id: &str) -> Result<(), AiError> {
        let sessions = self.sessions.read().await;
        if let Some(entry) = sessions.get(conversation_id) {
            entry
                .session
                .abort()
                .await
                .map_err(|e| AiError::SdkError(format!("Failed to abort session: {}", e)))?;
            Ok(())
        } else {
            Err(AiError::SessionNotFound(conversation_id.to_string()))
        }
    }
}

impl Drop for AiService {
    fn drop(&mut self) {
        // Best-effort cleanup: stop the client if it's running
        let client = self.client.clone();
        tokio::spawn(async move {
            let mut guard = client.write().await;
            if let Some(c) = guard.take() {
                c.stop().await;
            }
        });
    }
}
