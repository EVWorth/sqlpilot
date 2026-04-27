import { describe, it, expect, beforeEach } from "vitest";
import { useAiStore } from "../aiStore";

describe("aiStore - synchronous methods", () => {
  beforeEach(() => {
    // Reset store state
    useAiStore.setState({
      status: null,
      isStreaming: false,
      mode: "ask",
      conversations: [],
      activeConversationId: null,
      streamSegments: [],
      currentIntent: null,
      pendingPermission: null,
    });
  });

  describe("setMode", () => {
    it("sets mode to agent", () => {
      useAiStore.getState().setMode("agent");
      expect(useAiStore.getState().mode).toBe("agent");
    });

    it("sets mode to ask", () => {
      useAiStore.getState().setMode("ask");
      expect(useAiStore.getState().mode).toBe("ask");
    });
  });

  describe("newConversation", () => {
    it("creates a new conversation and returns its id", () => {
      const id = useAiStore.getState().newConversation();
      const state = useAiStore.getState();
      expect(id).toBeDefined();
      expect(state.conversations).toHaveLength(1);
      expect(state.conversations[0].id).toBe(id);
      expect(state.conversations[0].title).toBe("New Chat");
      expect(state.activeConversationId).toBe(id);
    });

    it("creates multiple conversations", () => {
      const id1 = useAiStore.getState().newConversation();
      const id2 = useAiStore.getState().newConversation();
      const state = useAiStore.getState();
      expect(state.conversations).toHaveLength(2);
      expect(id1).not.toBe(id2);
      expect(state.activeConversationId).toBe(id2);
    });
  });

  describe("setActiveConversation", () => {
    it("sets the active conversation id", () => {
      const id1 = useAiStore.getState().newConversation();
      const id2 = useAiStore.getState().newConversation();
      useAiStore.getState().setActiveConversation(id1);
      expect(useAiStore.getState().activeConversationId).toBe(id1);
    });

    it("clears active conversation when set to null", () => {
      useAiStore.getState().newConversation();
      useAiStore.getState().setActiveConversation(null);
      expect(useAiStore.getState().activeConversationId).toBeNull();
    });
  });

  describe("clearConversation", () => {
    it("removes a conversation", () => {
      const id1 = useAiStore.getState().newConversation();
      useAiStore.getState().newConversation();
      useAiStore.getState().clearConversation(id1);
      const state = useAiStore.getState();
      expect(state.conversations).toHaveLength(1);
      expect(state.conversations[0].id).not.toBe(id1);
    });

    it("clears active id when clearing active conversation", () => {
      const id = useAiStore.getState().newConversation();
      useAiStore.getState().clearConversation(id);
      expect(useAiStore.getState().activeConversationId).toBeNull();
    });

    it("preserves active id when clearing other conversation", () => {
      const id1 = useAiStore.getState().newConversation();
      const id2 = useAiStore.getState().newConversation();
      useAiStore.getState().setActiveConversation(id1);
      useAiStore.getState().clearConversation(id2);
      expect(useAiStore.getState().activeConversationId).toBe(id1);
    });
  });

  describe("addAssistantMessage", () => {
    it("adds assistant message to active conversation", () => {
      const id = useAiStore.getState().newConversation();
      useAiStore.getState().addAssistantMessage("Hello from AI");
      const state = useAiStore.getState();
      const conv = state.conversations.find((c) => c.id === id);
      expect(conv!.messages).toHaveLength(1);
      expect(conv!.messages[0].role).toBe("assistant");
      expect(conv!.messages[0].content).toBe("Hello from AI");
    });

    it("creates conversation if none active", () => {
      useAiStore.getState().addAssistantMessage("orphan message");
      const state = useAiStore.getState();
      expect(state.conversations).toHaveLength(1);
      expect(state.activeConversationId).toBeDefined();
    });
  });
});
