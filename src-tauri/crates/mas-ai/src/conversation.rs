use std::collections::HashMap;

use crate::models::ChatMessage;

const MAX_MESSAGES: usize = 50;

pub struct ConversationManager {
    conversations: HashMap<String, Vec<ChatMessage>>,
}

impl ConversationManager {
    pub fn new() -> Self {
        Self {
            conversations: HashMap::new(),
        }
    }

    pub fn add_message(&mut self, conversation_id: &str, role: &str, content: &str) {
        let messages = self
            .conversations
            .entry(conversation_id.to_string())
            .or_default();

        messages.push(ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        });

        self.truncate(conversation_id);
    }

    pub fn get_messages(&self, conversation_id: &str) -> Vec<ChatMessage> {
        self.conversations
            .get(conversation_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn clear(&mut self, conversation_id: &str) {
        self.conversations.remove(conversation_id);
    }

    /// Keep system prompt (first message if role=system) + last N messages.
    fn truncate(&mut self, conversation_id: &str) {
        if let Some(messages) = self.conversations.get_mut(conversation_id) {
            if messages.len() <= MAX_MESSAGES {
                return;
            }

            let has_system = messages
                .first()
                .map(|m| m.role == "system")
                .unwrap_or(false);

            if has_system {
                let system = messages[0].clone();
                let keep_from = messages.len().saturating_sub(MAX_MESSAGES - 1);
                let recent: Vec<ChatMessage> = messages[keep_from..].to_vec();
                *messages = std::iter::once(system).chain(recent).collect();
            } else {
                let keep_from = messages.len().saturating_sub(MAX_MESSAGES);
                *messages = messages[keep_from..].to_vec();
            }
        }
    }
}

impl Default for ConversationManager {
    fn default() -> Self {
        Self::new()
    }
}
