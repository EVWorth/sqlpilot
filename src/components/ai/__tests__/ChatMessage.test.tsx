import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ChatMessageComponent } from "../ChatMessage";
import type { ToolExecution, MessageSegment } from "../../../types";

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = {
        editorInstance: {
          getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
          executeEdits: vi.fn(),
          focus: vi.fn(),
          getSelection: vi.fn().mockReturnValue({ isEmpty: vi.fn().mockReturnValue(true) }),
          getModel: vi.fn().mockReturnValue({ getValue: vi.fn().mockReturnValue("") }),
        },
      };
      return selector ? selector(state) : state;
    }),
    { getState: vi.fn().mockReturnValue({ editorInstance: null }) },
  ),
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = { executeQuery: vi.fn() };
      return selector ? selector(state) : state;
    }),
    { getState: vi.fn().mockReturnValue({ executeQuery: vi.fn() }) },
  ),
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = { selectedConnectionId: "conn-1" };
      return selector ? selector(state) : state;
    }),
    { getState: vi.fn().mockReturnValue({ selectedConnectionId: "conn-1" }) },
  ),
}));

// Mock clipboard API
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});

const makeTool = (overrides: Partial<ToolExecution> = {}): ToolExecution => ({
  id: "tool-1",
  name: "list_tables",
  status: "done",
  arguments: { database: "testdb" },
  result: "table1, table2",
  ...overrides,
});

describe("ChatMessageComponent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders user message aligned to the right", () => {
    const { container } = render(
      <ChatMessageComponent role="user" content="Hello, AI!" />,
    );

    expect(screen.getByText("Hello, AI!")).toBeInTheDocument();
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("justify-end");
  });

  it("renders assistant message aligned to the left", () => {
    const { container } = render(
      <ChatMessageComponent role="assistant" content="Hello, user!" />,
    );

    expect(screen.getByText("Hello, user!")).toBeInTheDocument();
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("justify-start");
  });

  it("parses and renders SQL code blocks", () => {
    const content = "Here is a query:\n```sql\nSELECT * FROM users;\n```\nThat was a query.";
    render(<ChatMessageComponent role="assistant" content={content} />);

    expect(screen.getByText("Here is a query:")).toBeInTheDocument();
    expect(screen.getByText("SELECT * FROM users;")).toBeInTheDocument();
    expect(screen.getByText("That was a query.")).toBeInTheDocument();
  });

  it("parses and renders non-SQL code blocks", () => {
    const content = '```json\n{"key": "value"}\n```';
    render(<ChatMessageComponent role="assistant" content={content} />);

    expect(screen.getByText('{"key": "value"}')).toBeInTheDocument();
  });

  it("treats mysql language as SQL code block", () => {
    const content = "```mysql\nSELECT 1;\n```";
    render(<ChatMessageComponent role="assistant" content={content} />);

    expect(screen.getByText("SELECT 1;")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
  });

  it("renders tool calls in legacy mode", () => {
    const toolCalls: ToolExecution[] = [makeTool()];
    render(
      <ChatMessageComponent
        role="assistant"
        content="Checking database..."
        toolCalls={toolCalls}
      />,
    );

    expect(screen.getByText(/Listing tables/)).toBeInTheDocument();
    expect(screen.getByText("Checking database...")).toBeInTheDocument();
  });

  it("renders segments with intent, tool, and text types", () => {
    const segments: MessageSegment[] = [
      { type: "intent", intent: "Retrieving table schema" },
      { type: "text", content: "Here are the tables:" },
      { type: "tool", tool: makeTool() },
    ];

    render(
      <ChatMessageComponent role="assistant" content="" segments={segments} />,
    );

    expect(screen.getByText("Retrieving table schema")).toBeInTheDocument();
    expect(screen.getByText("Here are the tables:")).toBeInTheDocument();
    expect(screen.getByText(/Listing tables/)).toBeInTheDocument();
  });

  it("handles text segment with SQL code blocks", () => {
    const segments: MessageSegment[] = [
      {
        type: "text",
        content: "Run this:\n```sql\nSELECT 1;\n```",
      },
    ];

    render(
      <ChatMessageComponent role="assistant" content="" segments={segments} />,
    );

    expect(screen.getByText("Run this:")).toBeInTheDocument();
    expect(screen.getByText("SELECT 1;")).toBeInTheDocument();
  });

  it("renders plain text content when no markdown blocks", () => {
    render(
      <ChatMessageComponent
        role="assistant"
        content="Just a simple message."
      />,
    );

    expect(screen.getByText("Just a simple message.")).toBeInTheDocument();
  });

  it("renders empty content gracefully", () => {
    const { container } = render(
      <ChatMessageComponent role="assistant" content="" />,
    );
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("renders SQL code block with Run button when connection is available", () => {
    const content = "```sql\nSELECT 1;\n```";
    render(<ChatMessageComponent role="assistant" content={content} />);

    const runBtn = screen.getByTitle("Run query");
    expect(runBtn).toBeInTheDocument();
  });

  it("copies SQL code to clipboard when Copy button is clicked", async () => {
    const content = "```sql\nSELECT * FROM users;\n```";
    render(<ChatMessageComponent role="assistant" content={content} />);

    const copyBtn = screen.getByTitle("Copy");
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("SELECT * FROM users;");

    // After copy, the check icon should appear
    expect(screen.getByTitle("Copy").querySelector("svg")).toBeTruthy();

    // After 2 seconds, the copy icon should return
    act(() => {
      vi.advanceTimersByTime(2000);
    });
  });

  it("renders segment with code (non-SQL) block", () => {
    const segments: MessageSegment[] = [
      {
        type: "text",
        content: "```json\n{\"a\":1}\n```",
      },
    ];

    render(
      <ChatMessageComponent role="assistant" content="" segments={segments} />,
    );

    expect(screen.getByText('{"a":1}')).toBeInTheDocument();
  });

  it("renders multiple segments with mixed content", () => {
    const segments: MessageSegment[] = [
      { type: "intent", intent: "Finding data" },
      { type: "text", content: "Query:\n```sql\nSELECT 1;\n```\nDone." },
      { type: "tool", tool: makeTool({ name: "run_query", status: "done", result: "1" }) },
    ];

    render(
      <ChatMessageComponent role="assistant" content="" segments={segments} />,
    );

    expect(screen.getByText("Finding data")).toBeInTheDocument();
    expect(screen.getByText("Query:")).toBeInTheDocument();
    expect(screen.getByText("SELECT 1;")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.getByText(/Executing query/)).toBeInTheDocument();
  });

  it("renders running tool status correctly", () => {
    const segments: MessageSegment[] = [
      { type: "tool", tool: makeTool({ status: "running", result: undefined }) },
    ];

    render(
      <ChatMessageComponent role="assistant" content="" segments={segments} />,
    );

    // Running tool should show a spinner
    const svg = document.querySelector(".animate-spin");
    expect(svg).toBeTruthy();
  });

  it("handles segments with only text (no code blocks)", () => {
    const segments: MessageSegment[] = [
      { type: "text", content: "Just some plain text, nothing fancy." },
    ];

    render(
      <ChatMessageComponent role="assistant" content="" segments={segments} />,
    );

    expect(screen.getByText("Just some plain text, nothing fancy.")).toBeInTheDocument();
  });

  it("handles parseContent with empty code block between text", () => {
    const content = "Before\n```sql\n\n```\nAfter";
    render(<ChatMessageComponent role="assistant" content={content} />);

    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });
});
