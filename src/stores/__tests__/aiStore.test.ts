import { describe, it, expect, beforeEach, vi } from "vitest";

const { aiChatMock, aiGetStatusMock, aiSetConfigMock, aiCancelMock, aiApprovePermissionMock } =
  vi.hoisted(() => ({
    aiChatMock: vi.fn().mockResolvedValue("response"),
    aiGetStatusMock: vi.fn().mockResolvedValue({ provider: "test", available: true }),
    aiSetConfigMock: vi.fn().mockResolvedValue(undefined),
    aiCancelMock: vi.fn().mockResolvedValue(undefined),
    aiApprovePermissionMock: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("../../lib/tauri-api", () => ({
  api: {
    aiChat: aiChatMock,
    aiGetStatus: aiGetStatusMock,
    aiSetConfig: aiSetConfigMock,
    aiCancel: aiCancelMock,
    aiApprovePermission: aiApprovePermissionMock,
  },
}));

vi.mock("@tauri-apps/api/event", () => {
  let capturedHandler: ((event: any) => void) | null = null;
  const mockListen: any = vi.fn((_event: string, handler: (event: any) => void) => {
    capturedHandler = handler;
    return Promise.resolve(vi.fn());
  });
  mockListen.__fireEvent = (event: any) => {
    if (capturedHandler) capturedHandler(event);
  };
  mockListen.__resetHandler = () => {
    capturedHandler = null;
  };
  return { listen: mockListen, __fireEvent: mockListen.__fireEvent };
});

import * as eventModule from "@tauri-apps/api/event";
import { useAiStore } from "../aiStore";

/**
 * Shortcut to fire an event through the captured handler.
 */
function fireEvent(payload: unknown) {
  const m = eventModule.listen as any;
  m.__fireEvent({ payload });
}

/**
 * Creates a deferred promise and exposes the resolve function so tests can
 * control when the API call settles.
 */
function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("aiStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (eventModule.listen as any).__resetHandler();
    useAiStore.setState({
      aiEnabled: false,
      status: null,
      isStreaming: false,
      mode: "ask",
      conversations: [],
      activeConversationId: null,
      streamSegments: [],
      currentIntent: null,
      pendingPermission: null,
    });
    aiChatMock.mockResolvedValue("response");
    aiGetStatusMock.mockResolvedValue({ provider: "test", available: true });
    aiApprovePermissionMock.mockResolvedValue(undefined);
    aiCancelMock.mockResolvedValue(undefined);
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
      useAiStore.getState().newConversation();
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
      expect(state.conversations[0].messages).toHaveLength(1);
      expect(state.conversations[0].messages[0].content).toBe("orphan message");
    });
  });

  describe("checkStatus", () => {
    it("sets aiEnabled=true on success", async () => {
      aiGetStatusMock.mockResolvedValue({ provider: "openai", available: true });

      await useAiStore.getState().checkStatus();

      expect(useAiStore.getState().aiEnabled).toBe(true);
      expect(useAiStore.getState().status).toEqual({ provider: "openai", available: true });
    });

    it("sets aiEnabled=false and fallback status on error", async () => {
      aiGetStatusMock.mockRejectedValue(new Error("network error"));

      await useAiStore.getState().checkStatus();

      expect(useAiStore.getState().aiEnabled).toBe(false);
      expect(useAiStore.getState().status).toEqual({ provider: "none", available: false });
    });
  });

  describe("setConfig", () => {
    it("calls api.aiSetConfig then checkStatus", async () => {
      aiGetStatusMock.mockResolvedValue({ provider: "openai", available: true });

      await useAiStore.getState().setConfig({ model: "gpt-4" });

      expect(aiSetConfigMock).toHaveBeenCalledWith({ model: "gpt-4" });
      expect(useAiStore.getState().aiEnabled).toBe(true);
      expect(useAiStore.getState().status).toEqual({ provider: "openai", available: true });
    });
  });

  // ---------------------------------------------------------------------------
  // sendMessage – basic / non-streaming paths
  // ---------------------------------------------------------------------------
  describe("sendMessage", () => {
    it("does nothing when aiEnabled is false", async () => {
      useAiStore.setState({ aiEnabled: false });

      await useAiStore.getState().sendMessage("hello");

      expect(aiChatMock).not.toHaveBeenCalled();
    });

    it("creates conversation when none active", async () => {
      useAiStore.setState({ aiEnabled: true, conversations: [], activeConversationId: null });
      aiChatMock.mockResolvedValue("Hello!");

      await useAiStore.getState().sendMessage("hello");

      expect(useAiStore.getState().conversations).toHaveLength(1);
      expect(useAiStore.getState().activeConversationId).toBeDefined();
      expect(aiChatMock).toHaveBeenCalled();
    });

    it("adds user message and sets isStreaming", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });

      await useAiStore.getState().sendMessage("hello");

      const conv = useAiStore.getState().conversations[0];
      const userMsg = conv.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("hello");
    });

    it("sets conversation title from first message (<= 40 chars)", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });

      await useAiStore.getState().sendMessage("Short message");

      const conv = useAiStore.getState().conversations[0];
      expect(conv.title).toBe("Short message");
    });

    it("truncates title at 40 chars", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });

      await useAiStore.getState().sendMessage(
        "This is a very long message that exceeds forty characters",
      );

      const conv = useAiStore.getState().conversations[0];
      expect(conv.title).toBe("This is a very long message that exceeds…");
      expect(conv.title.length).toBe(41); // 40 chars + "…"
    });

    it("does not override title on subsequent messages", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });

      const store = useAiStore.getState();
      await store.sendMessage("First message to set the title");
      const conv1 = useAiStore.getState().conversations[0];
      const firstTitle = conv1.title;

      await useAiStore.getState().sendMessage("Second message");

      const conv2 = useAiStore.getState().conversations[0];
      expect(conv2.title).toBe(firstTitle);
    });

    it("handles error by adding error assistant message", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });
      aiChatMock.mockRejectedValue(new Error("API down"));

      await useAiStore.getState().sendMessage("hello");

      const conv = useAiStore.getState().conversations[0];
      const lastMsg = conv.messages[conv.messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      expect(lastMsg.content).toContain("Error: Error: API down");
      expect(useAiStore.getState().isStreaming).toBe(false);
    });

    it("passes connectionId and database to api.aiChat", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });

      await useAiStore.getState().sendMessage("optimize this", "conn-abc", "mydb");

      expect(aiChatMock).toHaveBeenCalledWith(
        "optimize this",
        expect.any(String),
        "ask",
        "conn-abc",
        "mydb",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // sendMessage – streaming event handling
  // ---------------------------------------------------------------------------
  describe("sendMessage streaming events", () => {
    const CONV_ID = "conv-stream-1";

    function startStreaming(msg = "hello") {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: CONV_ID,
        conversations: [
          { id: CONV_ID, messages: [], title: "Stream Test", createdAt: new Date().toISOString() },
        ],
      });
      const d = deferred();
      aiChatMock.mockReturnValue(d.promise);
      const sendPromise = useAiStore.getState().sendMessage(msg);
      return { sendPromise, d };
    }

    it("text_delta creates a new text segment on first delta", () => {
      const { d } = startStreaming();
      fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: "Hello" });

      const segs = useAiStore.getState().streamSegments;
      expect(segs).toHaveLength(1);
      expect(segs[0]).toEqual({ type: "text", content: "Hello" });

      d.resolve("ok");
    });

    it("text_delta appends to existing text segment on second delta", () => {
      const { d } = startStreaming();
      fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: "Hello" });
      fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: " World" });

      const segs = useAiStore.getState().streamSegments;
      expect(segs).toHaveLength(1);
      expect(segs[0]).toEqual({ type: "text", content: "Hello World" });

      d.resolve("ok");
    });

    it("text_delta is ignored for non-matching conversation_id", () => {
      const { d } = startStreaming();
      fireEvent({ type: "text_delta", conversation_id: "other-conv", content: "ignored" });

      expect(useAiStore.getState().streamSegments).toHaveLength(0);

      d.resolve("ok");
    });

    it("intent creates an intent segment and sets currentIntent", () => {
      const { d } = startStreaming();
      fireEvent({ type: "intent", conversation_id: CONV_ID, intent: "query_builder" });

      const segs = useAiStore.getState().streamSegments;
      expect(segs).toHaveLength(1);
      expect(segs[0]).toEqual({ type: "intent", intent: "query_builder" });
      expect(useAiStore.getState().currentIntent).toBe("query_builder");

      d.resolve("ok");
    });

    it("tool_start creates a tool segment with running status", () => {
      const { d } = startStreaming();
      fireEvent({
        type: "tool_start",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-1",
        arguments: { path: "/tmp/test" },
      });

      const segs = useAiStore.getState().streamSegments;
      expect(segs).toHaveLength(1);
      expect(segs[0]).toEqual({
        type: "tool",
        tool: {
          id: "tc-1",
          name: "read_file",
          arguments: { path: "/tmp/test" },
          status: "running",
        },
      });

      d.resolve("ok");
    });

    it.each(["bash", "view", "edit", "glob", "web_search", "task_complete"])(
      "tool_start with hidden tool %s is ignored",
      (toolName) => {
        const { d } = startStreaming();
        fireEvent({
          type: "tool_start",
          conversation_id: CONV_ID,
          tool_name: toolName,
          tool_call_id: "tc-hidden",
        });

        expect(useAiStore.getState().streamSegments).toHaveLength(0);

        d.resolve("ok");
      },
    );

    it("tool_complete updates matching tool segment to done status with result", () => {
      const { d } = startStreaming();
      // create the tool segment first
      fireEvent({
        type: "tool_start",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-1",
      });
      // complete it
      fireEvent({
        type: "tool_complete",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-1",
        result: "found 3 matches",
        success: true,
      });

      const segs = useAiStore.getState().streamSegments;
      expect(segs).toHaveLength(1);
      expect((segs[0] as any).tool.status).toBe("done");
      expect((segs[0] as any).tool.result).toBe("found 3 matches");

      d.resolve("ok");
    });

    it("tool_complete updates to error status when success is false", () => {
      const { d } = startStreaming();
      fireEvent({
        type: "tool_start",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-1",
      });
      fireEvent({
        type: "tool_complete",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-1",
        result: "command failed",
        success: false,
      });

      const segs = useAiStore.getState().streamSegments;
      expect((segs[0] as any).tool.status).toBe("error");
      expect((segs[0] as any).tool.result).toBe("command failed");

      d.resolve("ok");
    });

    it("tool_complete with non-matching tool_call_id leaves segment unchanged", () => {
      const { d } = startStreaming();
      fireEvent({
        type: "tool_start",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-1",
      });
      fireEvent({
        type: "tool_complete",
        conversation_id: CONV_ID,
        tool_name: "read_file",
        tool_call_id: "tc-2", // different id
        result: "should not apply",
        success: true,
      });

      const segs = useAiStore.getState().streamSegments;
      expect((segs[0] as any).tool.status).toBe("running");
      expect((segs[0] as any).tool.result).toBeUndefined();

      d.resolve("ok");
    });

    it("permission_request sets pendingPermission", () => {
      const { d } = startStreaming();
      fireEvent({
        type: "permission_request",
        conversation_id: CONV_ID,
        tool_name: "bash",
        description: "rm -rf /",
        request_id: "req-1",
      });

      expect(useAiStore.getState().pendingPermission).toEqual({
        requestId: "req-1",
        toolName: "bash",
        description: "rm -rf /",
      });

      d.resolve("ok");
    });

    describe("idle event", () => {
      it("finalizes with text segments and resets streaming state", async () => {
        const { sendPromise, d } = startStreaming();

        fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: "Hello" });
        // Fire idle — the event handler creates the assistant message in-place
        fireEvent({ type: "idle", conversation_id: CONV_ID });

        // Resolve so the function body continues (fallback skipped because isStreaming is false)
        d.resolve("full-response");

        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistantMsgs = conv.messages.filter((m) => m.role === "assistant");
        expect(assistantMsgs).toHaveLength(1);
        expect(assistantMsgs[0].content).toBe("Hello");
        expect(assistantMsgs[0].segments).toEqual([{ type: "text", content: "Hello" }]);

        // Streaming state should be reset
        expect(useAiStore.getState().isStreaming).toBe(false);
        expect(useAiStore.getState().streamSegments).toEqual([]);
        expect(useAiStore.getState().currentIntent).toBeNull();
        expect(useAiStore.getState().pendingPermission).toBeNull();
      });

      it("finalizes with mixed segments (text + intent + tool)", async () => {
        const { sendPromise, d } = startStreaming();

        fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: "Let me search." });
        fireEvent({ type: "intent", conversation_id: CONV_ID, intent: "db_metadata" });
        fireEvent({
          type: "tool_start",
          conversation_id: CONV_ID,
          tool_name: "read_file",
          tool_call_id: "tc-search",
        });
        fireEvent({
          type: "tool_complete",
          conversation_id: CONV_ID,
          tool_name: "read_file",
          tool_call_id: "tc-search",
          result: "5 results",
          success: true,
        });
        fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: "Done." });
        fireEvent({ type: "idle", conversation_id: CONV_ID });

        d.resolve("full-response");
        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistant = conv.messages.filter((m) => m.role === "assistant")[0];
        expect(assistant.content).toBe("Let me search.Done.");
        expect(assistant.segments).toHaveLength(4); // text, intent, tool, text
        expect(assistant.segments![0]).toEqual({ type: "text", content: "Let me search." });
        expect(assistant.segments![1]).toEqual({ type: "intent", intent: "db_metadata" });
        expect((assistant.segments![2] as any).type).toBe("tool");
        expect((assistant.segments![3] as any).type).toBe("text");
      });

      it("idle with empty segments creates message without segments field", async () => {
        const { sendPromise, d } = startStreaming();

        fireEvent({ type: "idle", conversation_id: CONV_ID });
        d.resolve("full-response");
        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistant = conv.messages.filter((m) => m.role === "assistant")[0];
        expect(assistant.content).toBe("");
        expect(assistant.segments).toBeUndefined();
      });
    });

    describe("error event", () => {
      it("adds error assistant message and resets streaming state", async () => {
        const { sendPromise, d } = startStreaming();

        fireEvent({ type: "error", conversation_id: CONV_ID, message: "Something went wrong" });
        d.resolve("should-be-ignored");
        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistantMsgs = conv.messages.filter((m) => m.role === "assistant");
        expect(assistantMsgs).toHaveLength(1);
        expect(assistantMsgs[0].content).toBe("Error: Something went wrong");
        expect(assistantMsgs[0].segments).toBeUndefined();

        expect(useAiStore.getState().isStreaming).toBe(false);
        expect(useAiStore.getState().streamSegments).toEqual([]);
      });

      it("error with non-matching conversation_id is ignored", async () => {
        const { sendPromise, d } = startStreaming();

        fireEvent({ type: "error", conversation_id: "other-conv", message: "Ignored error" });
        // The handler ignores it, so isStreaming stays true — fallback will run
        d.resolve("falling back");
        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistant = conv.messages.filter((m) => m.role === "assistant")[0];
        expect(assistant.content).toBe("falling back"); // fallback used fullResponse
      });
    });

    describe("fallback when idle never fires", () => {
      const makeConv = () => ({
        id: CONV_ID,
        messages: [] as any[],
        title: "Fallback Test",
        createdAt: new Date().toISOString(),
      });

      it("uses text segments when available", async () => {
        useAiStore.setState({
          aiEnabled: true,
          activeConversationId: CONV_ID,
          conversations: [makeConv()],
        });

        const d = deferred();
        aiChatMock.mockReturnValue(d.promise);

        const sendPromise = useAiStore.getState().sendMessage("query");

        // Fire text_deltas before the promise resolves
        fireEvent({ type: "text_delta", conversation_id: CONV_ID, content: "streamed" });

        d.resolve("fallback response");
        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistant = conv.messages.filter((m) => m.role === "assistant")[0];
        expect(assistant.content).toBe("streamed");
        expect(assistant.segments).toEqual([{ type: "text", content: "streamed" }]);
        expect(useAiStore.getState().isStreaming).toBe(false);
      });

      it("falls back to fullResponse when no segments are present", async () => {
        useAiStore.setState({
          aiEnabled: true,
          activeConversationId: CONV_ID,
          conversations: [makeConv()],
        });

        const d = deferred();
        aiChatMock.mockReturnValue(d.promise);

        const sendPromise = useAiStore.getState().sendMessage("query");

        // No events fired — aiChat resolves directly
        d.resolve("non-streamed answer");
        await sendPromise;

        const conv = useAiStore.getState().conversations.find((c) => c.id === CONV_ID)!;
        const assistant = conv.messages.filter((m) => m.role === "assistant")[0];
        expect(assistant.content).toBe("non-streamed answer");
        expect(assistant.segments).toBeUndefined();
        expect(useAiStore.getState().isStreaming).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // approvePermission
  // ---------------------------------------------------------------------------
  describe("approvePermission", () => {
    it("does nothing when aiEnabled is false", async () => {
      useAiStore.setState({ aiEnabled: false });

      await useAiStore.getState().approvePermission(true);

      expect(aiApprovePermissionMock).not.toHaveBeenCalled();
    });

    it("does nothing when no conversationId", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: null,
        pendingPermission: { requestId: "req1", toolName: "bash", description: "run cmd" },
      });

      await useAiStore.getState().approvePermission(true);

      expect(aiApprovePermissionMock).not.toHaveBeenCalled();
    });

    it("does nothing when no pending permission", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: "conv-1",
        pendingPermission: null,
      });

      await useAiStore.getState().approvePermission(true);

      expect(aiApprovePermissionMock).not.toHaveBeenCalled();
    });

    it("calls api.aiApprovePermission on success path", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: "conv-1",
        pendingPermission: { requestId: "req1", toolName: "bash", description: "run cmd" },
      });

      await useAiStore.getState().approvePermission(true);

      expect(aiApprovePermissionMock).toHaveBeenCalledWith("conv-1", "req1", true);
      expect(useAiStore.getState().pendingPermission).toBeNull();
    });

    it("calls api.aiApprovePermission with approved=false and clears pending", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: "conv-2",
        pendingPermission: { requestId: "req2", toolName: "write", description: "write file" },
      });

      await useAiStore.getState().approvePermission(false);

      expect(aiApprovePermissionMock).toHaveBeenCalledWith("conv-2", "req2", false);
      expect(useAiStore.getState().pendingPermission).toBeNull();
    });

    it("ignores api errors", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: "conv-1",
        pendingPermission: { requestId: "req1", toolName: "bash", description: "run cmd" },
      });
      aiApprovePermissionMock.mockRejectedValue(new Error("approval failed"));

      await useAiStore.getState().approvePermission(true);

      expect(useAiStore.getState().pendingPermission).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // cancelChat
  // ---------------------------------------------------------------------------
  describe("cancelChat", () => {
    it("does nothing when aiEnabled is false", async () => {
      useAiStore.setState({ aiEnabled: false });

      await useAiStore.getState().cancelChat();

      expect(aiCancelMock).not.toHaveBeenCalled();
    });

    it("does nothing when no activeConversationId", async () => {
      useAiStore.setState({ aiEnabled: true, activeConversationId: null });

      await useAiStore.getState().cancelChat();

      expect(aiCancelMock).not.toHaveBeenCalled();
    });

    it("calls api.aiCancel and resets streaming state", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: "conv-1",
        isStreaming: true,
        streamSegments: [{ type: "text", content: "partial..." }],
        currentIntent: "query",
        pendingPermission: { requestId: "r1", toolName: "bash", description: "run" },
      });

      await useAiStore.getState().cancelChat();

      expect(aiCancelMock).toHaveBeenCalledWith("conv-1");
      const state = useAiStore.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.streamSegments).toEqual([]);
      expect(state.currentIntent).toBeNull();
      expect(state.pendingPermission).toBeNull();
    });

    it("ignores api cancel errors", async () => {
      useAiStore.setState({
        aiEnabled: true,
        activeConversationId: "conv-1",
        isStreaming: true,
      });
      aiCancelMock.mockRejectedValue(new Error("cancel failed"));

      await useAiStore.getState().cancelChat();

      expect(useAiStore.getState().isStreaming).toBe(false);
    });
  });
});
