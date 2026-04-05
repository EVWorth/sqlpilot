pub mod context;
pub mod conversation;
pub mod copilot;
pub mod error;
pub mod models;
pub mod ollama;
pub mod prompts;
pub mod provider;
pub mod service;

pub use error::AiError;
pub use models::{AiConfig, AiStatus, AiStreamChunk, ChatMessage, CompletionOptions};
pub use service::AiService;
