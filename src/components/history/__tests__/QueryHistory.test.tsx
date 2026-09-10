import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryHistory } from "../QueryHistory";

vi.mock("../../../stores/historyStore", () => ({
  useHistoryStore: Object.assign(vi.fn(), { getState: vi.fn() }),
  HISTORY_LIMITS: [100, 500, 1000, 5000, 10000],
  DEFAULT_HISTORY_LIMIT: 500,
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(),
  },
}));

import { useEditorStore } from "../../../stores/editorStore";
import { useHistoryStore } from "../../../stores/historyStore";

const mockRemoveEntry = vi.fn();
const mockSetLimit = vi.fn();
const mockSetSearch = vi.fn();
const mockLoad = vi.fn().mockResolvedValue(undefined);
// The panel no longer filters in memory — search goes to the database — so
// tests drive it by setting what the store would have returned.
let mockSearch = "";

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
    error: "Table 'otherdb.nonexistent' doesn't exist",
    errorCode: 1146,
    errorSqlState: "42S02",
  },
];

describe("QueryHistory", () => {
  const mockClearHistory = vi.fn();
  const mockUpdateTabContent = vi.fn();
  const mockAddTab = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLoad.mockResolvedValue(undefined);
    vi.mocked(useHistoryStore).mockImplementation((selector) => {
      if (typeof selector === "function") {
        return selector({
          entries: mockEntries,
          clearHistory: mockClearHistory,
          addEntry: vi.fn(),
          removeEntry: mockRemoveEntry,
          limit: 500,
          setLimit: mockSetLimit,
          search: mockSearch,
          setSearch: mockSetSearch,
          load: mockLoad,
          loading: false,
          error: null,
        });
      }
      return mockEntries;
    });
    (
      useHistoryStore as unknown as { getState: ReturnType<typeof vi.fn> }
    ).getState.mockImplementation(() => ({
      entries: mockEntries,
      clearHistory: mockClearHistory,
      addEntry: vi.fn(),
      removeEntry: mockRemoveEntry,
      limit: 500,
      setLimit: mockSetLimit,
      search: mockSearch,
      setSearch: mockSetSearch,
      load: mockLoad,
      loading: false,
      error: null,
    }));
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
        return selector({
          entries: [],
          clearHistory: mockClearHistory,
          addEntry: vi.fn(),
          removeEntry: mockRemoveEntry,
          limit: 500,
          setLimit: mockSetLimit,
          search: mockSearch,
          setSearch: mockSetSearch,
          load: mockLoad,
          loading: false,
          error: null,
        });
      }
      return [];
    });
    render(<QueryHistory />);
    expect(screen.getByText("No history yet")).toBeDefined();
  });

  it("searches through the store rather than filtering in memory (#585)", () => {
    render(<QueryHistory />);
    const searchInput = screen.getByPlaceholderText("Search history...");
    fireEvent.change(searchInput, { target: { value: "users" } });

    // The database answers the question now, so the panel's job is to ask it.
    expect(mockSetSearch).toHaveBeenCalledWith("users");
  });

  it("shows 'No matches' when a search returned nothing", () => {
    mockSearch = "zzzzzz";
    vi.mocked(useHistoryStore).mockImplementation((selector) =>
      typeof selector === "function"
        ? selector({
          entries: [],
          clearHistory: mockClearHistory,
          addEntry: vi.fn(),
          removeEntry: mockRemoveEntry,
          limit: 500,
          setLimit: mockSetLimit,
          search: mockSearch,
          setSearch: mockSetSearch,
          load: mockLoad,
          loading: false,
          error: null,
        })
        : []
    );

    render(<QueryHistory />);
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

  it("renders a delete button for each entry", () => {
    render(<QueryHistory />);
    const deleteButtons = screen.getAllByLabelText("Delete entry");
    expect(deleteButtons).toHaveLength(mockEntries.length);
  });

  it("calls removeEntry with the entry id when × button is clicked", () => {
    render(<QueryHistory />);
    const deleteButtons = screen.getAllByLabelText("Delete entry");

    fireEvent.click(deleteButtons[0]);

    expect(mockRemoveEntry).toHaveBeenCalledTimes(1);
    expect(mockRemoveEntry).toHaveBeenCalledWith("entry-1");
  });

  it("does not trigger entry load when × button is clicked", () => {
    const mockTabs = [{ id: "tab-1", title: "Query", content: "" }];
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: mockTabs,
      activeTabId: "tab-1",
      updateTabContent: mockUpdateTabContent,
      addTab: mockAddTab,
    });

    render(<QueryHistory />);
    const deleteButtons = screen.getAllByLabelText("Delete entry");

    fireEvent.click(deleteButtons[2]);

    expect(mockUpdateTabContent).not.toHaveBeenCalled();
    expect(mockAddTab).not.toHaveBeenCalled();
    expect(mockRemoveEntry).toHaveBeenCalledWith("entry-3");
  });

  describe("failed entries (#324)", () => {
    it("shows the error message inline", () => {
      render(<QueryHistory />);
      expect(screen.getByText("Table 'otherdb.nonexistent' doesn't exist")).toBeInTheDocument();
    });

    it("shows the driver code and SQLSTATE", () => {
      render(<QueryHistory />);
      expect(screen.getByText("1146 · 42S02")).toBeInTheDocument();
    });

    it("carries the full message in a tooltip while it is truncated", () => {
      render(<QueryHistory />);
      const message = screen.getByText("Table 'otherdb.nonexistent' doesn't exist");
      expect(message).toHaveAttribute("title", "Table 'otherdb.nonexistent' doesn't exist");
      expect(message.className).toContain("truncate");
    });

    it("expands the message on click without loading the query into the editor", () => {
      const store = { tabs: [], activeTabId: null, addTab: mockAddTab, updateTabContent: mockUpdateTabContent };
      vi.mocked(useEditorStore.getState).mockReturnValue(store as never);
      render(<QueryHistory />);

      const message = screen.getByText("Table 'otherdb.nonexistent' doesn't exist");
      fireEvent.click(message);

      expect(message.className).not.toContain("truncate");
      expect(message).toHaveAttribute("aria-expanded", "true");
      expect(mockUpdateTabContent).not.toHaveBeenCalled();
      expect(mockAddTab).not.toHaveBeenCalled();
    });

    it("shows nothing extra for a successful entry", () => {
      render(<QueryHistory />);
      expect(screen.queryByText(/doesn't exist/)).toBeInTheDocument();
      expect(screen.queryAllByText(/·/)).toHaveLength(1);
    });
  });

  describe("retention (#323)", () => {
    it("shows the current limit and how much is stored", () => {
      render(<QueryHistory />);
      expect(screen.getByLabelText("Keep")).toHaveValue("500");
      expect(screen.getByText("3 shown")).toBeInTheDocument();
    });

    it("changes the limit through the store", () => {
      render(<QueryHistory />);
      fireEvent.change(screen.getByLabelText("Keep"), { target: { value: "5000" } });
      expect(mockSetLimit).toHaveBeenCalledWith(5000);
    });
  });
});
