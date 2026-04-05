use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AiError;
use crate::models::{ChatMessage, CompletionOptions};
use crate::provider::AiProvider;

// TODO: Integrate with Copilot SDK when available.
// This is a placeholder provider that returns unavailable.

pub struct CopilotProvider {
    #[allow(dead_code)]
    token: Option<String>,
}

impl CopilotProvider {
    pub fn new(token: Option<String>) -> Self {
        Self { token }
    }
}

#[async_trait]
impl AiProvider for CopilotProvider {
    async fn chat(
        &self,
        _messages: Vec<ChatMessage>,
        _options: &CompletionOptions,
    ) -> Result<String, AiError> {
        Err(AiError::ProviderUnavailable(
            "Copilot provider is not yet implemented".into(),
        ))
    }

    async fn stream_chat(
        &self,
        _messages: Vec<ChatMessage>,
        _options: &CompletionOptions,
        _sender: mpsc::Sender<String>,
    ) -> Result<(), AiError> {
        Err(AiError::ProviderUnavailable(
            "Copilot provider is not yet implemented".into(),
        ))
    }

    fn name(&self) -> &str {
        "copilot"
    }

    fn is_available(&self) -> bool {
        // TODO: Validate token and check Copilot API availability
        false
    }

    fn model_name(&self) -> Option<String> {
        if self.is_available() {
            Some("copilot".to_string())
        } else {
            None
        }
    }
}
