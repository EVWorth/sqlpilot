use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AiError;
use crate::models::{AiConfig, AiStatus, ChatMessage, CompletionOptions};
use crate::copilot::CopilotProvider;
use crate::ollama::OllamaProvider;

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn chat(
        &self,
        messages: Vec<ChatMessage>,
        options: &CompletionOptions,
    ) -> Result<String, AiError>;

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        options: &CompletionOptions,
        sender: mpsc::Sender<String>,
    ) -> Result<(), AiError>;

    fn name(&self) -> &str;
    fn is_available(&self) -> bool;
    fn model_name(&self) -> Option<String>;
}

pub struct ProviderRouter {
    ollama: OllamaProvider,
    copilot: CopilotProvider,
}

impl ProviderRouter {
    pub fn new() -> Self {
        Self {
            ollama: OllamaProvider::new(None, None),
            copilot: CopilotProvider::new(None),
        }
    }

    pub fn apply_config(&mut self, config: &AiConfig) {
        self.ollama = OllamaProvider::new(
            config.ollama_url.clone(),
            config.ollama_model.clone(),
        );
        self.copilot = CopilotProvider::new(config.copilot_token.clone());
    }

    fn active_provider(&self) -> Result<&dyn AiProvider, AiError> {
        if self.copilot.is_available() {
            return Ok(&self.copilot);
        }
        if self.ollama.is_available() {
            return Ok(&self.ollama);
        }
        Err(AiError::ProviderUnavailable(
            "No AI provider is available. Configure Ollama or provide a Copilot token.".into(),
        ))
    }

    pub async fn chat(
        &self,
        messages: Vec<ChatMessage>,
        options: &CompletionOptions,
    ) -> Result<String, AiError> {
        let provider = self.active_provider()?;
        provider.chat(messages, options).await
    }

    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        options: &CompletionOptions,
        sender: mpsc::Sender<String>,
    ) -> Result<(), AiError> {
        let provider = self.active_provider()?;
        provider.stream_chat(messages, options, sender).await
    }

    pub fn get_status(&self) -> AiStatus {
        if self.copilot.is_available() {
            return AiStatus {
                provider: self.copilot.name().to_string(),
                available: true,
                model: self.copilot.model_name(),
            };
        }
        AiStatus {
            provider: self.ollama.name().to_string(),
            available: self.ollama.is_available(),
            model: self.ollama.model_name(),
        }
    }
}
