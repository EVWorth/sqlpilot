use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionOptions {
    pub temperature: f32,
    pub max_tokens: Option<u32>,
}

impl Default for CompletionOptions {
    fn default() -> Self {
        Self {
            temperature: 0.3,
            max_tokens: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStatus {
    pub provider: String,
    pub available: bool,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub ollama_url: Option<String>,
    pub ollama_model: Option<String>,
    pub copilot_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStreamChunk {
    pub conversation_id: String,
    pub delta: String,
    pub done: bool,
}
