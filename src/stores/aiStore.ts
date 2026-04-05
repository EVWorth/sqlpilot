import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import type {
  ChatMessage,
  Conversation,
  AiStatus,
  AiConfig,
  AiStreamChunk,
} from "../types";

interface AiState {
  // Status
  status: AiStatus | null;
  isStreaming: boolean;

  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;
  streamingContent: string;

  // Actions
  checkStatus: () => Promise<void>;
  setConfig: (config: AiConfig) => Promise<void>;

  // Chat
  sendMessage: (
    message: string,
    connectionId?: string,
    database?: string,
  ) => Promise<void>;
  newConversation: () => string;
  setActiveConversation: (id: string | null) => void;
  clearConversation: (id: string) => void;

  // Quick actions (non-chat)
  generateSql: (
    prompt: string,
    connectionId?: string,
    database?: string,
  ) => Promise<string>;
  explainQuery: (sql: string) => Promise<string>;
  optimizeQuery: (
    sql: string,
    connectionId?: string,
    database?: string,
  ) => Promise<string>;
  fixError: (sql: string, errorMessage: string) => Promise<string>;

  // Add result to active conversation as an assistant message
  addAssistantMessage: (content: string) => void;
}

function generateId(): string {
  return crypto.randomUUID();
}

export const useAiStore = create<AiState>((set, get) => ({
  status: null,
  isStreaming: false,
  conversations: [],
  activeConversationId: null,
  streamingContent: "",

  checkStatus: async () => {
    try {
      const status = await api.aiGetStatus();
      set({ status });
    } catch {
      set({
        status: { provider: "none", available: false },
      });
    }
  },

  setConfig: async (config: AiConfig) => {
    await api.aiSetConfig(config);
    await get().checkStatus();
  },

  newConversation: () => {
    const id = generateId();
    const conversation: Conversation = {
      id,
      messages: [],
      title: "New Chat",
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      conversations: [...state.conversations, conversation],
      activeConversationId: id,
    }));
    return id;
  },

  setActiveConversation: (id) => set({ activeConversationId: id }),

  clearConversation: (id) => {
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeConversationId:
        state.activeConversationId === id
          ? null
          : state.activeConversationId,
    }));
  },

  sendMessage: async (message, connectionId, database) => {
    let conversationId = get().activeConversationId;
    if (!conversationId) {
      conversationId = get().newConversation();
    }

    const userMessage: ChatMessage = { role: "user", content: message };

    // Add user message to conversation
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: [...c.messages, userMessage],
              title:
                c.messages.length === 0
                  ? message.slice(0, 40) + (message.length > 40 ? "…" : "")
                  : c.title,
            }
          : c,
      ),
      isStreaming: true,
      streamingContent: "",
    }));

    let unlisten: UnlistenFn | null = null;

    try {
      // Listen for streaming chunks
      unlisten = await listen<AiStreamChunk>("ai:chunk", (event) => {
        const chunk = event.payload;
        if (chunk.conversation_id !== conversationId) return;

        if (chunk.done) {
          // Finalize: add accumulated content as assistant message
          const finalContent = get().streamingContent + chunk.delta;
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    messages: [
                      ...c.messages,
                      { role: "assistant" as const, content: finalContent },
                    ],
                  }
                : c,
            ),
            isStreaming: false,
            streamingContent: "",
          }));
        } else {
          set((state) => ({
            streamingContent: state.streamingContent + chunk.delta,
          }));
        }
      });

      // Call the backend - it returns the full response when streaming is done
      const fullResponse = await api.aiChat(
        message,
        conversationId,
        connectionId,
        database,
      );

      // If streaming events didn't fire (backend returned directly without events),
      // add the response as an assistant message
      const state = get();
      const conv = state.conversations.find((c) => c.id === conversationId);
      const lastMsg = conv?.messages[conv.messages.length - 1];
      if (lastMsg?.role !== "assistant" || state.isStreaming) {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [
                    ...c.messages,
                    { role: "assistant" as const, content: fullResponse },
                  ],
                }
              : c,
          ),
          isStreaming: false,
          streamingContent: "",
        }));
      }
    } catch (e) {
      // Add error as assistant message
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    role: "assistant" as const,
                    content: `Error: ${String(e)}`,
                  },
                ],
              }
            : c,
        ),
        isStreaming: false,
        streamingContent: "",
      }));
    } finally {
      unlisten?.();
    }
  },

  addAssistantMessage: (content: string) => {
    let conversationId = get().activeConversationId;
    if (!conversationId) {
      conversationId = get().newConversation();
    }
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: [
                ...c.messages,
                { role: "assistant" as const, content },
              ],
            }
          : c,
      ),
    }));
  },

  generateSql: async (prompt, connectionId, database) => {
    try {
      return await api.aiGenerateSql(prompt, connectionId, database);
    } catch (e) {
      throw new Error(`Failed to generate SQL: ${String(e)}`);
    }
  },

  explainQuery: async (sql) => {
    try {
      return await api.aiExplainQuery(sql);
    } catch (e) {
      throw new Error(`Failed to explain query: ${String(e)}`);
    }
  },

  optimizeQuery: async (sql, connectionId, database) => {
    try {
      return await api.aiOptimizeQuery(sql, connectionId, database);
    } catch (e) {
      throw new Error(`Failed to optimize query: ${String(e)}`);
    }
  },

  fixError: async (sql, errorMessage) => {
    try {
      return await api.aiFixError(sql, errorMessage);
    } catch (e) {
      throw new Error(`Failed to fix error: ${String(e)}`);
    }
  },
}));
