import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import type {
  ChatMessage,
  Conversation,
  AiStatus,
  AiConfig,
  AiMode,
  AiStreamEvent,
  MessageSegment,
  PendingPermission,
} from "../types";

// Internal SDK tools that should not appear in the UI
const HIDDEN_TOOLS = new Set(["report_intent"]);

interface AiState {
  // Status
  status: AiStatus | null;
  isStreaming: boolean;
  mode: AiMode;

  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;
  streamSegments: MessageSegment[];
  currentIntent: string | null;
  pendingPermission: PendingPermission | null;

  // Actions
  checkStatus: () => Promise<void>;
  setConfig: (config: AiConfig) => Promise<void>;
  setMode: (mode: AiMode) => void;

  // Chat
  sendMessage: (
    message: string,
    connectionId?: string,
    database?: string,
  ) => Promise<void>;
  cancelChat: () => Promise<void>;
  approvePermission: (approved: boolean) => Promise<void>;
  newConversation: () => string;
  setActiveConversation: (id: string | null) => void;
  clearConversation: (id: string) => void;

  // Add result to active conversation as an assistant message
  addAssistantMessage: (content: string) => void;
}

function generateId(): string {
  return crypto.randomUUID();
}

export const useAiStore = create<AiState>((set, get) => ({
  status: null,
  isStreaming: false,
  mode: "ask",
  conversations: [],
  activeConversationId: null,
  streamSegments: [],
  currentIntent: null,
  pendingPermission: null,

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

  setMode: (mode: AiMode) => set({ mode }),

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
    const mode = get().mode;

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
      streamSegments: [],
      currentIntent: null,
      pendingPermission: null,
    }));

    let unlisten: UnlistenFn | null = null;

    try {
      // Listen for structured AI events — build an ordered timeline
      unlisten = await listen<AiStreamEvent>("ai:event", (event) => {
        const ev = event.payload;
        if (ev.conversation_id !== conversationId) return;

        switch (ev.type) {
          case "text_delta": {
            // Append to last text segment, or create a new one
            set((state) => {
              const segs = [...state.streamSegments];
              const last = segs[segs.length - 1];
              if (last?.type === "text") {
                segs[segs.length - 1] = { type: "text", content: last.content + ev.content };
              } else {
                segs.push({ type: "text", content: ev.content });
              }
              return { streamSegments: segs };
            });
            break;
          }

          case "intent": {
            set((state) => {
              const segs = [...state.streamSegments];
              segs.push({ type: "intent", intent: ev.intent });
              return { streamSegments: segs, currentIntent: ev.intent };
            });
            break;
          }

          case "tool_start": {
            if (HIDDEN_TOOLS.has(ev.tool_name)) break;
            set((state) => {
              const segs = [...state.streamSegments];
              segs.push({
                type: "tool",
                tool: {
                  id: ev.tool_call_id,
                  name: ev.tool_name,
                  arguments: ev.arguments,
                  status: "running",
                },
              });
              return { streamSegments: segs };
            });
            break;
          }

          case "tool_complete": {
            set((state) => {
              const segs = state.streamSegments.map((seg) => {
                if (seg.type === "tool" && seg.tool.id === ev.tool_call_id) {
                  return {
                    ...seg,
                    tool: {
                      ...seg.tool,
                      status: (ev.success ? "done" : "error") as "done" | "error",
                      result: ev.result,
                    },
                  };
                }
                return seg;
              });
              return { streamSegments: segs };
            });
            break;
          }

          case "permission_request": {
            set({
              pendingPermission: {
                requestId: ev.request_id,
                toolName: ev.tool_name,
                description: ev.description,
              },
            });
            break;
          }

          case "idle": {
            // Finalize: save ordered segments into the message
            const segments = get().streamSegments;
            const fullContent = segments
              .filter((s): s is { type: "text"; content: string } => s.type === "text")
              .map((s) => s.content)
              .join("");

            set((state) => ({
              conversations: state.conversations.map((c) =>
                c.id === conversationId
                  ? {
                      ...c,
                      messages: [
                        ...c.messages,
                        {
                          role: "assistant" as const,
                          content: fullContent,
                          segments: segments.length > 0 ? segments : undefined,
                        },
                      ],
                    }
                  : c,
              ),
              isStreaming: false,
              streamSegments: [],
              currentIntent: null,
              pendingPermission: null,
            }));
            break;
          }

          case "error": {
            set((state) => ({
              conversations: state.conversations.map((c) =>
                c.id === conversationId
                  ? {
                      ...c,
                      messages: [
                        ...c.messages,
                        {
                          role: "assistant" as const,
                          content: `Error: ${ev.message}`,
                        },
                      ],
                    }
                  : c,
              ),
              isStreaming: false,
              streamSegments: [],
              currentIntent: null,
              pendingPermission: null,
            }));
            break;
          }
        }
      });

      // Call the backend — returns the full response when done
      const fullResponse = await api.aiChat(
        message,
        conversationId,
        mode,
        connectionId,
        database,
      );

      // If streaming events didn't fire (or idle didn't fire), finalize
      const state = get();
      if (state.isStreaming) {
        const segments = state.streamSegments;
        const textContent = segments
          .filter((s): s is { type: "text"; content: string } => s.type === "text")
          .map((s) => s.content)
          .join("");
        const content = textContent || fullResponse;

        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [
                    ...c.messages,
                    {
                      role: "assistant" as const,
                      content,
                      segments: segments.length > 0 ? segments : undefined,
                    },
                  ],
                }
              : c,
          ),
          isStreaming: false,
          streamSegments: [],
          currentIntent: null,
          pendingPermission: null,
        }));
      }
    } catch (e) {
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
        streamSegments: [],
        currentIntent: null,
        pendingPermission: null,
      }));
    } finally {
      unlisten?.();
    }
  },

  approvePermission: async (approved: boolean) => {
    const conversationId = get().activeConversationId;
    const permission = get().pendingPermission;
    if (!conversationId || !permission) return;
    try {
      await api.aiApprovePermission(conversationId, permission.requestId, approved);
    } catch {
      // ignore approval errors
    }
    set({ pendingPermission: null });
  },

  cancelChat: async () => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    try {
      await api.aiCancel(conversationId);
    } catch {
      // ignore cancel errors
    }
    set({ isStreaming: false, streamSegments: [], currentIntent: null, pendingPermission: null });
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
}));
