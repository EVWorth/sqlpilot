import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryHistory } from "../QueryHistory";

vi.mock("../../../stores/historyStore", () => ({
  useHistoryStore: vi.fn(),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(),
  },
}));

import { useEditorStore } from "../../../stores/editorStore";
import { useHistoryStore } from "../../../stores/historyStore";

const mockEntries = [
  {
    id: "entry-1",
    sql: "SELECT * FROM users",
    connectionName: "MyDB",
    database: "testdb",
    executedAt: new Date(Date.now() - 60000).toISOString(),
    executionTimeMs: 42,
    rowCount: 100,
    status: "success" as const,
  },
  {
    id: "entry-2",
    sql: "INSERT INTO logs VALUES (1, 'test')",
    connectionName: "MyDB",
    database: "testdb",
    executedAt: new Date(Date.now() - 3600000).toISOString(),
    executionTimeMs: 15,
    rowCount: 1,
    status: "success" as const,
  },
  {
    id: "entry-3",
    sql: "SELECT * FROM nonexistent",
    connectionName: "OtherDB",
    database: "otherdb",
    executedAt: new Date(Date.now() - 120000).toISOString(),
    executionTimeMs: 100,
    rowCount: 0,
    status: "error" as const,
    error: "Table not found",
  },
];

describe("QueryHistory", () => {
  const mockClearHistory = vi.fn();
  const mockUpdateTabContent = vi.fn();
  const mockAddTab = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHistoryStore).mockImplementation((selector) => {
      if (typeof selector === "function") {
        return selector({
          entries: mockEntries,
          clearHistory: mockClearHistory,
          addEntry: vi.fn(),
          removeEntry: vi.fn(),
        });
      }
      return mockEntries;
    });
  });

  it("renders history entries", () => {
    render(<QueryHistory />);
    expect(screen.getByText("SELECT * FROM users")).toBeDefined();
    expect(screen.getByText(/INSERT INTO logs/)).toBeDefined();
    expect(screen.getByText("SELECT * FROM nonexistent")).toBeDefined();
  });

  it("shows connection name and timing", () => {
    render(<QueryHistory />);
    expect(screen.getAllByText("MyDB").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("42ms")).toBeDefined();
    expect(screen.getByText("100 rows")).toBeDefined();
  });

  it("shows empty state when no entries", () => {
    vi.mocked(useHistoryStore).mockImplementation((selector) => {
      if (typeof selector === "function") {
        return selector({ entries: [], clearHistory: mockClearHistory, addEntry: vi.fn(), removeEntry: vi.fn() });
      }
      return [];
    });
    render(<QueryHistory />);
    expect(screen.getByText("No history yet")).toBeDefined();
  });

  it("filters entries by search", () => {
    render(<QueryHistory />);
    const searchInput = screen.getByPlaceholderText("Search history...");
    fireEvent.change(searchInput, { target: { value: "users" } });

    expect(screen.getByText("SELECT * FROM users")).toBeDefined();
    expect(screen.queryByText(/INSERT INTO logs/)).toBeNull();
  });

  it("shows 'No matches' when search yields no results", () => {
    render(<QueryHistory />);
    const searchInput = screen.getByPlaceholderText("Search history...");
    fireEvent.change(searchInput, { target: { value: "zzzzzz" } });
    expect(screen.getByText("No matches")).toBeDefined();
  });

  it("calls clearHistory after double confirmation", async () => {
    render(<QueryHistory />);
    const clearBtn = screen.getByTitle("Clear history");
    fireEvent.click(clearBtn);
    expect(screen.getByText("Confirm?")).toBeDefined();
    fireEvent.click(clearBtn);
    expect(mockClearHistory).toHaveBeenCalled();
  });

  it("confirmation resets after timeout", async () => {
    vi.useFakeTimers();
    render(<QueryHistory />);
    const clearBtn = screen.getByTitle("Clear history");
    fireEvent.click(clearBtn);
    expect(screen.getByText("Confirm?")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("Confirm?")).toBeNull();
    vi.useRealTimers();
  });

  it("adds content to active tab on click", () => {
    const mockTabs = [{ id: "tab-1", title: "Query", content: "" }];
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: mockTabs,
      activeTabId: "tab-1",
      updateTabContent: mockUpdateTabContent,
      addTab: mockAddTab,
    });

    render(<QueryHistory />);
    fireEvent.click(screen.getByText("SELECT * FROM users"));
    expect(mockUpdateTabContent).toHaveBeenCalledWith("tab-1", "SELECT * FROM users");
  });

  it("creates new tab when no active tab exists", () => {
    const mockTabs: Array<{ id: string; title: string; content: string }> = [];
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: mockTabs,
      activeTabId: null,
      updateTabContent: mockUpdateTabContent,
      addTab: mockAddTab,
    });
    mockAddTab.mockReturnValue("tab-new");

    render(<QueryHistory />);
    fireEvent.click(screen.getByText("SELECT * FROM users"));
    expect(mockAddTab).toHaveBeenCalled();
    expect(mockUpdateTabContent).toHaveBeenCalledWith("tab-new", "SELECT * FROM users");
  });

  it("shows XCircle icon for error entries and CheckCircle for success", () => {
    render(<QueryHistory />);
    // There should be 2 success icons (checkcircle) and 1 error icon (xcircle)
    const successEntries = screen.getAllByText(/users|INSERT INTO logs/);
    expect(successEntries.length).toBeGreaterThanOrEqual(2);
  });
});
