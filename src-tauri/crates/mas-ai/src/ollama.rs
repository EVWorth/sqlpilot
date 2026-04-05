use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::AiError;
use crate::models::{ChatMessage, CompletionOptions};
use crate::provider::AiProvider;

const DEFAULT_URL: &str = "http://localhost:11434";
const DEFAULT_MODEL: &str = "llama3.2";

#[derive(Debug, Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: Option<OllamaMessage>,
    #[allow(dead_code)]
    done: bool,
}

pub struct OllamaProvider {
    base_url: String,
    model: String,
    client: Client,
}

impl OllamaProvider {
    pub fn new(url: Option<String>, model: Option<String>) -> Self {
        Self {
            base_url: url.unwrap_or_else(|| DEFAULT_URL.to_string()),
            model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            client: Client::new(),
        }
    }

    fn to_ollama_messages(messages: &[ChatMessage]) -> Vec<OllamaMessage> {
        messages
            .iter()
            .map(|m| OllamaMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect()
    }
}

#[async_trait]
impl AiProvider for OllamaProvider {
    async fn chat(
        &self,
        messages: Vec<ChatMessage>,
        options: &CompletionOptions,
    ) -> Result<String, AiError> {
        let request = OllamaChatRequest {
            model: self.model.clone(),
            messages: Self::to_ollama_messages(&messages),
            stream: false,
            options: Some(OllamaOptions {
                temperature: options.temperature,
                num_predict: options.max_tokens,
            }),
        };

        let url = format!("{}/api/chat", self.base_url);
        tracing::debug!(url = %url, model = %self.model, "Sending non-streaming chat request to Ollama");

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::RequestFailed(format!("Ollama request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "Ollama returned {}: {}",
                status, body
            )));
        }

        let chat_response: OllamaChatResponse = response
            .json()
            .await
            .map_err(|e| AiError::RequestFailed(format!("Failed to parse Ollama response: {}", e)))?;

        Ok(chat_response
            .message
            .map(|m| m.content)
            .unwrap_or_default())
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        options: &CompletionOptions,
        sender: mpsc::Sender<String>,
    ) -> Result<(), AiError> {
        let request = OllamaChatRequest {
            model: self.model.clone(),
            messages: Self::to_ollama_messages(&messages),
            stream: true,
            options: Some(OllamaOptions {
                temperature: options.temperature,
                num_predict: options.max_tokens,
            }),
        };

        let url = format!("{}/api/chat", self.base_url);
        tracing::debug!(url = %url, model = %self.model, "Sending streaming chat request to Ollama");

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::RequestFailed(format!("Ollama request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "Ollama returned {}: {}",
                status, body
            )));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| AiError::StreamError(e.to_string()))?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            // Ollama sends newline-delimited JSON
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                match serde_json::from_str::<OllamaChatResponse>(&line) {
                    Ok(resp) => {
                        if let Some(msg) = resp.message {
                            if !msg.content.is_empty() {
                                if sender.send(msg.content).await.is_err() {
                                    tracing::debug!("Stream receiver dropped");
                                    return Ok(());
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(line = %line, error = %e, "Failed to parse Ollama stream chunk");
                    }
                }
            }
        }

        Ok(())
    }

    fn name(&self) -> &str {
        "ollama"
    }

    fn is_available(&self) -> bool {
        // Optimistic: assume available if configured.
        // Actual availability is checked when a request is made.
        true
    }

    fn model_name(&self) -> Option<String> {
        Some(self.model.clone())
    }
}
