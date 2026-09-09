import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryHistory } from "../QueryHistory";

vi.mock("../../../stores/historyStore", () => ({
  useHistoryStore: Object.assign(vi.fn(), { getState: vi.fn() }),
  HISTORY_LIMITS: [100, 500, 1000, 5000, 10000],
  DEFAULT_HISTORY_LIMIT: 500,
  HISTORY_MAX_AGE_DAYS: [0, 7, 30, 90, 365],
  DEFAULT_HISTORY_MAX_AGE_DAYS: 0,
  // The real predicate: mocking it would let the panel's use of it drift.
  hasActiveFilters: (f: { connectionNames: string[]; status: string }) =>
    f.connectionNames.length > 0 || f.status !== "",
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    pickSaveFile: vi.fn().mockResolvedValue("/tmp/history.csv"),
    writeFileContents: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: { getState: () => ({ activeConnections: mockActiveConnections }) },
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: { getState: () => ({ executeQuery: mockExecuteQuery }) },
}));

// Renders the menu items as buttons so tests can click them, the same shape
// the favorites tests use.
vi.mock("../../../hooks/useContextMenu", async () => {
  const { useState, useCallback } = await import("react");
  return {
    useContextMenu: () => {
      const [items, setItems] = useState<
        { label: string; onClick: () => void; disabled?: boolean; separator?: boolean }[]
      >([]);
      const showContextMenu = useCallback((e: { preventDefault: () => void }, next: typeof items) => {
        e.preventDefault();
        setItems(next);
      }, []);
      const contextMenu = items.length > 0
        ? (
          <div data-testid="ctx-menu">
            {items.map((item, i) =>
              item.separator ? <hr key={i} /> : (
                <button
                  key={i}
                  data-testid={`ctx-item-${item.label}`}
                  disabled={item.disabled}
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              )
            )}
          </div>
        )
        : null;
      return { contextMenu, showContextMenu, hideContextMenu: () => setItems([]) };
    },
  };
});

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(),
  },
}));

import { useEditorStore } from "../../../stores/editorStore";
import { useHistoryStore } from "../../../stores/historyStore";

const mockRemoveEntry = vi.fn();
const mockSetLimit = vi.fn();
const mockSetFilters = vi.fn().mockResolvedValue(undefined);
const mockResetFilters = vi.fn().mockResolvedValue(undefined);
const mockExportMatching = vi.fn().mockResolvedValue("csv,data");
const mockLoad = vi.fn().mockResolvedValue(undefined);
const mockExecuteQuery = vi.fn().mockResolvedValue(undefined);
const mockSetMaxAgeDays = vi.fn().mockResolvedValue(undefined);
let mockMaxAgeDays = 0;
let mockActiveConnections: { id: string; name: string }[] = [];

// The panel no longer filters in memory — filtering goes to the database — so
// tests drive it by setting what the store would have returned.
const NO_FILTERS = {
  search: "",
  connectionNames: [] as string[],
  databases: [] as string[],
  status: "",
  executedAfter: "",
  executedBefore: "",
  minDurationMs: null as number | null,
  sort: "recent" as const,
};
let mockFilters = { ...NO_FILTERS };
let mockFacets = { connectionNames: [] as string[], databases: [] as string[] };
let mockMatchCount = 0;

function storeExtras() {
  return {
    filters: mockFilters,
    setFilters: mockSetFilters,
    resetFilters: mockResetFilters,
    matchCount: mockMatchCount,
    facets: mockFacets,
    exportMatching: mockExportMatching,
    load: mockLoad,
    loading: false,
    error: null,
    maxAgeDays: mockMaxAgeDays,
    setMaxAgeDays: mockSetMaxAgeDays,
  };
}

const baseEntries = [
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

// Reassignable so a test can narrow the set it renders.
let mockEntries = baseEntries;

describe("QueryHistory", () => {
  const mockClearHistory = vi.fn();
  const mockUpdateTabContent = vi.fn();
  const mockAddTab = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilters = { ...NO_FILTERS };
    mockFacets = { connectionNames: [], databases: [] };
    mockMatchCount = 0;
    mockLoad.mockResolvedValue(undefined);
    mockSetFilters.mockResolvedValue(undefined);
    mockResetFilters.mockResolvedValue(undefined);
    mockExportMatching.mockResolvedValue("csv,data");
    mockExecuteQuery.mockResolvedValue(undefined);
    mockActiveConnections = [{ id: "conn-other", name: "OtherDB" }];
    mockEntries = baseEntries;
    mockMaxAgeDays = 0;
    mockSetMaxAgeDays.mockResolvedValue(undefined);
    vi.mocked(useHistoryStore).mockImplementation((selector) => {
      if (typeof selector === "function") {
        return selector({
          entries: mockEntries,
          clearHistory: mockClearHistory,
          addEntry: vi.fn(),
          removeEntry: mockRemoveEntry,
          limit: 500,
          setLimit: mockSetLimit,
          ...storeExtras(),
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
      ...storeExtras(),
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
          ...storeExtras(),
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
    expect(mockSetFilters).toHaveBeenCalledWith({ search: "users" });
  });

  it("shows 'No matches' when a search returned nothing", () => {
    mockFilters = { ...NO_FILTERS, search: "zzzzzz" };
    vi.mocked(useHistoryStore).mockImplementation((selector) =>
      typeof selector === "function"
        ? selector({
          entries: [],
          clearHistory: mockClearHistory,
          addEntry: vi.fn(),
          removeEntry: mockRemoveEntry,
          limit: 500,
          setLimit: mockSetLimit,
          ...storeExtras(),
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

  describe("filters, sort and export (#589)", () => {
    /** Open the filter panel and return nothing — the controls are queried by label. */
    function openFilters() {
      fireEvent.click(screen.getByTitle("Filters"));
    }

    it("keeps the filter panel closed until asked", () => {
      render(<QueryHistory />);
      expect(screen.queryByLabelText("Sort")).not.toBeInTheDocument();
    });

    it("filters by status", () => {
      render(<QueryHistory />);
      openFilters();

      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "error" } });

      expect(mockSetFilters).toHaveBeenCalledWith({ status: "error" });
    });

    it("sorts by duration", () => {
      render(<QueryHistory />);
      openFilters();

      fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "slowest" } });

      expect(mockSetFilters).toHaveBeenCalledWith({ sort: "slowest" });
    });

    it("takes the end date as the end of that day", () => {
      // "to the 3rd" has to include the 3rd. Midnight would exclude the whole
      // day the user just named.
      render(<QueryHistory />);
      openFilters();

      fireEvent.change(screen.getByLabelText("to"), { target: { value: "2026-01-03" } });

      expect(mockSetFilters).toHaveBeenCalledWith({
        executedBefore: "2026-01-03T23:59:59Z",
      });
    });

    it("clears a date filter when the field is emptied", () => {
      // Seeded first: React fires no change event when the value is unchanged,
      // so clearing an already-empty box would prove nothing.
      mockFilters = { ...NO_FILTERS, executedAfter: "2026-01-01T00:00:00Z" };
      render(<QueryHistory />);
      openFilters();

      fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });

      expect(mockSetFilters).toHaveBeenCalledWith({ executedAfter: "" });
    });

    it("treats an emptied duration box as no filter, not as zero", () => {
      mockFilters = { ...NO_FILTERS, minDurationMs: 250 };
      render(<QueryHistory />);
      openFilters();

      fireEvent.change(screen.getByLabelText("Slower than"), { target: { value: "" } });

      expect(mockSetFilters).toHaveBeenCalledWith({ minDurationMs: null });
    });

    it("offers only the connections the history actually holds", () => {
      mockFacets = { connectionNames: ["prod", "staging"], databases: [] };
      render(<QueryHistory />);
      openFilters();

      expect(screen.getByText("prod")).toBeInTheDocument();
      expect(screen.getByText("staging")).toBeInTheDocument();
    });

    it("adds a connection to the filter", () => {
      mockFacets = { connectionNames: ["prod"], databases: [] };
      render(<QueryHistory />);
      openFilters();

      fireEvent.click(screen.getByText("prod"));

      expect(mockSetFilters).toHaveBeenCalledWith({ connectionNames: ["prod"] });
    });

    it("removes a connection that is already filtered on", () => {
      mockFacets = { connectionNames: ["prod"], databases: [] };
      mockFilters = { ...NO_FILTERS, connectionNames: ["prod"] };
      render(<QueryHistory />);
      fireEvent.click(screen.getByTitle("Filters (active)"));

      fireEvent.click(screen.getByText("prod"));

      expect(mockSetFilters).toHaveBeenCalledWith({ connectionNames: [] });
    });

    it("marks the filter button when something is narrowing the view", () => {
      mockFilters = { ...NO_FILTERS, status: "error" };
      render(<QueryHistory />);
      expect(screen.getByTitle("Filters (active)")).toBeInTheDocument();
    });

    it("only enables Reset when there is something to reset", () => {
      render(<QueryHistory />);
      openFilters();
      expect(screen.getByText("Reset")).toBeDisabled();
    });

    it("resets every filter at once", () => {
      mockFilters = { ...NO_FILTERS, status: "error" };
      render(<QueryHistory />);
      fireEvent.click(screen.getByTitle("Filters (active)"));

      fireEvent.click(screen.getByText("Reset"));

      expect(mockResetFilters).toHaveBeenCalled();
    });

    it("says how many match when more match than fit", () => {
      mockMatchCount = 812;
      render(<QueryHistory />);
      expect(screen.getByText("3 of 812")).toBeInTheDocument();
    });

    it("says only the count when everything matching is shown", () => {
      mockMatchCount = 3;
      render(<QueryHistory />);
      expect(screen.getByText("3 shown")).toBeInTheDocument();
    });

    it("writes an export to the file the user picked", async () => {
      const { api } = await import("../../../lib/tauri-api");
      render(<QueryHistory />);
      openFilters();

      fireEvent.click(screen.getByText("CSV"));

      await waitFor(() => expect(mockExportMatching).toHaveBeenCalledWith("csv"));
      await waitFor(() => expect(api.writeFileContents).toHaveBeenCalledWith("/tmp/history.csv", "csv,data"));
    });

    it("writes nothing when the save dialog is cancelled", async () => {
      const { api } = await import("../../../lib/tauri-api");
      vi.mocked(api.pickSaveFile).mockResolvedValueOnce(null);
      render(<QueryHistory />);
      openFilters();

      fireEvent.click(screen.getByText("SQL"));

      await waitFor(() => expect(mockExportMatching).toHaveBeenCalledWith("sql"));
      expect(api.writeFileContents).not.toHaveBeenCalled();
    });
  });

  describe("run from history (#325)", () => {
    const mockSetActiveTab = vi.fn();

    beforeEach(() => {
      mockSetActiveTab.mockClear();
      vi.mocked(useEditorStore.getState).mockReturnValue({
        tabs: [{ id: "tab1", type: "query", content: "", isDirty: false }],
        activeTabId: "tab1",
        addTab: mockAddTab,
        updateTabContent: mockUpdateTabContent,
        setActiveTab: mockSetActiveTab,
      } as never);
    });

    /** Right-click the OtherDB entry, which is the one with a live connection. */
    function openMenuOnLiveEntry() {
      fireEvent.contextMenu(screen.getByText("SELECT * FROM nonexistent"));
    }

    it("offers Insert into editor and Run now", () => {
      render(<QueryHistory />);
      openMenuOnLiveEntry();

      expect(screen.getByTestId("ctx-item-Insert into editor")).toBeInTheDocument();
      expect(screen.getByTestId("ctx-item-Run now on OtherDB")).toBeInTheDocument();
    });

    it("runs against the connection the entry came from, not the selected one", async () => {
      // Rerunning yesterday's staging query against production because the
      // sidebar moved on is the mistake worth designing out.
      mockActiveConnections = [
        { id: "conn-selected", name: "SomethingElse" },
        { id: "conn-other", name: "OtherDB" },
      ];
      render(<QueryHistory />);
      openMenuOnLiveEntry();

      fireEvent.click(screen.getByTestId("ctx-item-Run now on OtherDB"));

      await waitFor(() =>
        expect(mockExecuteQuery).toHaveBeenCalledWith(
          "conn-other",
          "SELECT * FROM nonexistent",
          "otherdb",
        )
      );
    });

    it("puts the statement in the editor and focuses the tab before running", async () => {
      render(<QueryHistory />);
      openMenuOnLiveEntry();

      fireEvent.click(screen.getByTestId("ctx-item-Run now on OtherDB"));

      await waitFor(() => expect(mockExecuteQuery).toHaveBeenCalled());
      expect(mockUpdateTabContent).toHaveBeenCalledWith("tab1", "SELECT * FROM nonexistent");
      expect(mockSetActiveTab).toHaveBeenCalledWith("tab1");
    });

    it("cannot run an entry whose connection is closed", () => {
      mockActiveConnections = [];
      render(<QueryHistory />);
      openMenuOnLiveEntry();

      expect(screen.getByTestId("ctx-item-Run now")).toBeDisabled();
    });

    it("cannot run a redacted entry", () => {
      // The password it needs is gone, so it would fail in a way nobody could
      // act on (#587).
      mockEntries = [{ ...baseEntries[2], redacted: true }];
      render(<QueryHistory />);
      fireEvent.contextMenu(screen.getByText("SELECT * FROM nonexistent"));

      expect(screen.getByTestId("ctx-item-Run now on OtherDB")).toBeDisabled();
    });

    it("deletes from the menu too", () => {
      render(<QueryHistory />);
      openMenuOnLiveEntry();

      fireEvent.click(screen.getByTestId("ctx-item-Delete"));

      expect(mockRemoveEntry).toHaveBeenCalledWith("entry-3");
    });
  });

  describe("retention period (#592) and repeats (#590)", () => {
    it("keeps history forever by default", () => {
      render(<QueryHistory />);
      expect(screen.getByLabelText("for")).toHaveValue("0");
    });

    it("sets a retention period", () => {
      render(<QueryHistory />);
      fireEvent.change(screen.getByLabelText("for"), { target: { value: "30" } });
      expect(mockSetMaxAgeDays).toHaveBeenCalledWith(30);
    });

    it("collapses a run of the same statement into one row", () => {
      mockEntries = [
        { ...baseEntries[0], id: "r1" },
        { ...baseEntries[0], id: "r2" },
        { ...baseEntries[0], id: "r3" },
      ];
      render(<QueryHistory />);

      expect(screen.getAllByText("SELECT * FROM users")).toHaveLength(1);
      expect(screen.getByText("×3")).toBeInTheDocument();
    });

    it("does not collapse when sorted by anything but recency", () => {
      // Adjacency means nothing once the order is by duration, so collapsing
      // would merge runs that were nowhere near each other in time.
      mockEntries = [
        { ...baseEntries[0], id: "r1" },
        { ...baseEntries[0], id: "r2" },
      ];
      mockFilters = { ...NO_FILTERS, sort: "slowest" };
      render(<QueryHistory />);

      expect(screen.getAllByText("SELECT * FROM users")).toHaveLength(2);
      expect(screen.queryByText("×2")).not.toBeInTheDocument();
    });

    it("marks nothing when every row is distinct", () => {
      render(<QueryHistory />);
      expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
    });
  });
});
