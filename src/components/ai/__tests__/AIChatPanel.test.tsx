import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { AIChatPanel } from "../AIChatPanel";

// Mock navigator.clipboard
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock Tauri API
vi.mock("../../../lib/tauri-api", () => ({
  api: {
    aiGetStatus: vi.fn().mockResolvedValue({ provider: "openai", available: true, model: "gpt-4" }),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: vi.fn(() => ({ editorInstance: null, tabs: [], activeTabId: null })),
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: vi.fn(() => ({
    executeQuery: vi.fn(),
    isExecuting: false,
    results: [],
    activeResultIndex: 0,
    error: null,
  })),
}));

vi.mock("../../../lib/utils", () => ({
  cn: (...args: (string | boolean | undefined | null)[]) => args.filter(Boolean).join(" "),
}));

describe("AIChatPanel", () => {
  const mockSendMessage = vi.fn().mockResolvedValue(undefined);
  const mockCancelChat = vi.fn();
  const mockNewConversation = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    useAiStore.setState({
      status: { provider: "openai", available: true, model: "gpt-4" },
      isStreaming: false,
      conversations: [],
      activeConversationId: null,
      streamSegments: [],
      mode: "ask",
      pendingPermission: null,
      aiEnabled: true,
      sendMessage: mockSendMessage,
      cancelChat: mockCancelChat,
      newConversation: mockNewConversation,
      setMode: vi.fn(),
      checkStatus: vi.fn().mockResolvedValue(undefined),
      approvePermission: vi.fn(),
    } as any);

    useConnectionStore.setState({
      selectedConnectionId: "conn-1",
      activeConnections: [
        {
          id: "conn-1",
          profile_id: "prof-1",
          name: "Test DB",
          host: "localhost",
          port: 3306,
          database: "testdb",
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
      ],
      profiles: [],
      loading: false,
      error: null,
    } as any);
  });

  it("renders the panel header with 'Copilot' title", () => {
    render(<AIChatPanel onClose={vi.fn()} />);
    expect(screen.getByText("Copilot")).toBeInTheDocument();
  });

  it("renders the mode selector", () => {
    render(<AIChatPanel onClose={vi.fn()} />);
    expect(screen.getByText("Ask")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("shows empty state message when there are no messages", () => {
    render(<AIChatPanel onClose={vi.fn()} />);
    expect(
      screen.getByText("Ask questions about your database — read-only mode."),
    ).toBeInTheDocument();
  });

  it("shows connection prompt when no connection is selected", () => {
    useConnectionStore.setState({
      selectedConnectionId: null,
      activeConnections: [],
      profiles: [],
    } as any);

    render(<AIChatPanel onClose={vi.fn()} />);
    expect(
      screen.getByText("Connect to a database for full capabilities"),
    ).toBeInTheDocument();
  });

  it("renders messages when conversation has messages", () => {
    useAiStore.setState({
      activeConversationId: "conv-1",
      conversations: [
        {
          id: "conv-1",
          title: "Chat 1",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
          ],
          createdAt: "2024-01-01T00:00:00Z",
        },
      ],
    } as any);

    render(<AIChatPanel onClose={vi.fn()} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("shows activity name when connected", () => {
    render(<AIChatPanel onClose={vi.fn()} />);
    expect(screen.getByText(/Test DB/)).toBeInTheDocument();
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(<AIChatPanel onClose={onClose} />);

    const closeBtn = screen.getByTitle("Close AI Panel");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls sendMessage when type something and click send", async () => {
    render(<AIChatPanel onClose={vi.fn()} />);

    const textarea = screen.getByPlaceholderText("Ask about your database...");
    fireEvent.change(textarea, { target: { value: "Show me tables" } });

    const sendBtn = screen.getByTitle("Send (Enter)");
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      "Show me tables",
      "conn-1",
      "testdb",
    );
  });

  it("shows Send button as disabled when input is empty", () => {
    render(<AIChatPanel onClose={vi.fn()} />);

    const sendBtn = screen.getByTitle("Send (Enter)");
    expect(sendBtn).toBeDisabled();
  });

  it("calls newConversation when New Chat button is clicked", () => {
    render(<AIChatPanel onClose={vi.fn()} />);

    const newChatBtn = screen.getByTitle("New Chat");
    fireEvent.click(newChatBtn);
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
  });

  it("renders pending permission UI when present", async () => {
    useAiStore.setState({
      isStreaming: true,
      streamSegments: [],
      pendingPermission: {
        requestId: "req-1",
        toolName: "run_query",
        description: "Run a SELECT query to get user data",
      },
      conversations: [
        {
          id: "conv-1",
          title: "Chat 1",
          messages: [
            { role: "user", content: "Query" },
            { role: "assistant", content: "OK" },
          ],
          createdAt: "2024-01-01T00:00:00Z",
        },
      ],
      activeConversationId: "conv-1",
    } as any);

    render(<AIChatPanel onClose={vi.fn()} />);

    expect(await screen.findByText("Permission Required")).toBeInTheDocument();
    expect(
      screen.getByText("Run a SELECT query to get user data"),
    ).toBeInTheDocument();
    expect(screen.getByText("Allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("handles Enter key to send message", async () => {
    render(<AIChatPanel onClose={vi.fn()} />);

    const textarea = screen.getByPlaceholderText("Ask about your database...");
    fireEvent.change(textarea, { target: { value: "Show tables" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledWith(
      "Show tables",
      "conn-1",
      "testdb",
    );
  });

  it("does not send on Shift+Enter", () => {
    render(<AIChatPanel onClose={vi.fn()} />);

    const textarea = screen.getByPlaceholderText("Ask about your database...");
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("shows cancel button when streaming", () => {
    useAiStore.setState({
      isStreaming: true,
    } as any);

    render(<AIChatPanel onClose={vi.fn()} />);

    const cancelBtn = screen.getByTitle("Cancel");
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.click(cancelBtn);
    expect(mockCancelChat).toHaveBeenCalledTimes(1);
  });
});
