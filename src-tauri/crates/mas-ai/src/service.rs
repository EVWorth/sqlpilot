use mas_core::connection::ConnectionManager;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

use crate::context::build_schema_context;
use crate::conversation::ConversationManager;
use crate::error::AiError;
use crate::models::{AiConfig, AiStatus, CompletionOptions};
use crate::prompts;
use crate::provider::ProviderRouter;

pub struct AiService {
    provider_router: Arc<RwLock<ProviderRouter>>,
    conversation_manager: RwLock<ConversationManager>,
    schema_inspector: Arc<SchemaInspector>,
}

impl AiService {
    pub fn new(
        connection_manager: Arc<ConnectionManager>,
    ) -> Self {
        let schema_inspector = Arc::new(SchemaInspector::new(connection_manager));
        Self {
            provider_router: Arc::new(RwLock::new(ProviderRouter::new())),
            conversation_manager: RwLock::new(ConversationManager::new()),
            schema_inspector,
        }
    }

    async fn get_schema_context(
        &self,
        connection_id: Option<&str>,
        database: Option<&str>,
    ) -> Result<String, AiError> {
        match (connection_id, database) {
            (Some(conn_id), Some(db)) => {
                build_schema_context(&self.schema_inspector, conn_id, db).await
            }
            _ => Ok(String::new()),
        }
    }

    pub async fn chat(
        &self,
        message: &str,
        conversation_id: &str,
        connection_id: Option<&str>,
        database: Option<&str>,
        sender: mpsc::Sender<String>,
    ) -> Result<String, AiError> {
        tracing::info!(conversation_id = %conversation_id, "Processing chat message");

        let schema_context = self.get_schema_context(connection_id, database).await?;

        {
            let mut conv = self.conversation_manager.write().await;
            let existing = conv.get_messages(conversation_id);
            if existing.is_empty() {
                let system_prompt = if schema_context.is_empty() {
                    "You are an expert MySQL database assistant. Help users with queries, schema design, performance tuning, and database management.".to_string()
                } else {
                    format!(
                        "You are an expert MySQL database assistant. Help users with queries, schema design, performance tuning, and database management.\n\nAvailable schema:\n{}",
                        schema_context
                    )
                };
                conv.add_message(conversation_id, "system", &system_prompt);
            }
            conv.add_message(conversation_id, "user", message);
        }

        let messages = {
            let conv = self.conversation_manager.read().await;
            conv.get_messages(conversation_id)
        };

        let options = CompletionOptions::default();

        let mut full_response = String::new();
        let (tx, mut rx) = mpsc::channel::<String>(256);

        // Clone the Arc so the spawned task is 'static.
        let router_arc = Arc::clone(&self.provider_router);
        let messages_clone = messages.clone();
        let options_clone = options.clone();

        let stream_task = tokio::spawn(async move {
            let router = router_arc.read().await;
            router
                .stream_chat(messages_clone, &options_clone, tx)
                .await
        });

        // Receive chunks and forward to the caller's sender
        while let Some(delta) = rx.recv().await {
            full_response.push_str(&delta);
            let _ = sender.send(delta).await;
        }

        // Check for streaming errors
        match stream_task.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if full_response.is_empty() {
                    return Err(e);
                }
                tracing::warn!(error = %e, "Stream ended with error but partial content received");
            }
            Err(e) => {
                return Err(AiError::StreamError(format!(
                    "Stream task panicked: {}",
                    e
                )));
            }
        }

        // Store assistant response
        {
            let mut conv = self.conversation_manager.write().await;
            conv.add_message(conversation_id, "assistant", &full_response);
        }

        tracing::info!(
            conversation_id = %conversation_id,
            response_len = full_response.len(),
            "Chat completed"
        );

        Ok(full_response)
    }

    pub async fn generate_sql(
        &self,
        prompt: &str,
        connection_id: Option<&str>,
        database: Option<&str>,
    ) -> Result<String, AiError> {
        tracing::info!("Generating SQL from natural language");

        let schema_context = self.get_schema_context(connection_id, database).await?;
        let db_name = database.unwrap_or("unknown");
        let messages = prompts::build_nl_to_sql(prompt, &schema_context, db_name);

        let options = CompletionOptions {
            temperature: 0.1,
            ..Default::default()
        };

        let router = self.provider_router.read().await;
        let result = router.chat(messages, &options).await?;

        tracing::info!(result_len = result.len(), "SQL generation completed");
        Ok(result)
    }

    pub async fn explain_query(&self, sql: &str) -> Result<String, AiError> {
        tracing::info!("Explaining SQL query");

        let messages = prompts::build_explain_query(sql);
        let options = CompletionOptions::default();

        let router = self.provider_router.read().await;
        let result = router.chat(messages, &options).await?;

        tracing::info!(result_len = result.len(), "Query explanation completed");
        Ok(result)
    }

    pub async fn optimize_query(
        &self,
        sql: &str,
        connection_id: Option<&str>,
        database: Option<&str>,
    ) -> Result<String, AiError> {
        tracing::info!("Optimizing SQL query");

        let schema_context = self.get_schema_context(connection_id, database).await?;
        let messages = prompts::build_optimize_query(sql, &schema_context);
        let options = CompletionOptions::default();

        let router = self.provider_router.read().await;
        let result = router.chat(messages, &options).await?;

        tracing::info!(result_len = result.len(), "Query optimization completed");
        Ok(result)
    }

    pub async fn fix_error(
        &self,
        sql: &str,
        error_message: &str,
    ) -> Result<String, AiError> {
        tracing::info!("Fixing SQL error");

        let messages = prompts::build_fix_error(sql, error_message);
        let options = CompletionOptions::default();

        let router = self.provider_router.read().await;
        let result = router.chat(messages, &options).await?;

        tracing::info!(result_len = result.len(), "Error fix completed");
        Ok(result)
    }

    pub async fn get_status(&self) -> AiStatus {
        let router = self.provider_router.read().await;
        router.get_status()
    }

    pub async fn set_config(&self, config: AiConfig) -> Result<(), AiError> {
        tracing::info!("Updating AI configuration");
        let mut router = self.provider_router.write().await;
        router.apply_config(&config);
        Ok(())
    }
}
