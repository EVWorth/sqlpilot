pub mod error;
pub mod models;
pub mod service;
pub mod tools;

pub use error::AiError;
pub use models::{AiConfig, AiMode, AiStatus, AiStreamEvent, ChatMessage};
pub use service::AiService;
