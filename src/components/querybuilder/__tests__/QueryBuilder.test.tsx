import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryBuilder } from "../QueryBuilder";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    executeQuery: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
  },
}));

vi.mock("../../../hooks/useSchemaCache", () => ({
  useSchemaCache: vi.fn(),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(),
  },
}));

import { api } from "../../../lib/tauri-api";
import { useSchemaCache } from "../../../hooks/useSchemaCache";
import { useEditorStore } from "../../../stores/editorStore";

const mockTables = ["users", "orders", "products"];
const mockColumns = [
  { name: "id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: true, default_value: undefined, extra: "", comment: "" },
  { name: "name", data_type: "varchar", column_type: "VARCHAR(255)", nullable: false, is_primary_key: false, default_value: undefined, extra: "", comment: "" },
  { name: "email", data_type: "varchar", column_type: "VARCHAR(255)", nullable: true, is_primary_key: false, default_value: undefined, extra: "", comment: "" },
];

describe("QueryBuilder", () => {
  const mockFetchTables = vi.fn();
  const mockFetchColumns = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useSchemaCache).mockImplementation((selector) => {
      const state = {
        fetchTables: mockFetchTables,
        fetchColumns: mockFetchColumns,
        tables: new Map([["testdb", mockTables]]),
      };
      if (typeof selector === "function") {
        return selector(state);
      }
      return state;
    });

    vi.mocked(useEditorStore.getState).mockReturnValue({
      addTab: vi.fn(() => "new-tab"),
      updateTabContent: vi.fn(),
      tabs: [],
      activeTabId: null,
      connectionId: undefined,
      database: undefined,
    });

    mockFetchColumns.mockResolvedValue(mockColumns);
  });

  it("renders the query builder with table list", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(screen.getByPlaceholderText("Filter tables...")).toBeDefined();
    expect(screen.getByText("users")).toBeDefined();
    expect(screen.getByText("orders")).toBeDefined();
    expect(screen.getByText("products")).toBeDefined();
  });

  it("shows empty canvas message initially", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(
      screen.getByText("Click a table from the left panel to add it to the canvas"),
    ).toBeDefined();
  });

  it("shows SQL Preview section with placeholder", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(screen.getByText("SQL Preview")).toBeDefined();
  });

  it("shows WHERE, ORDER BY, GROUP BY, HAVING tabs", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(screen.getByText("WHERE")).toBeDefined();
    expect(screen.getByText("ORDER BY")).toBeDefined();
    expect(screen.getByText("GROUP BY")).toBeDefined();
    expect(screen.getByText("HAVING")).toBeDefined();
  });

  it("adds a table to canvas when clicked", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);

    render(<QueryBuilder connectionId="conn-1" database="testdb" />);

    await act(async () => {
      const tableButtons = screen.getAllByText("users");
      fireEvent.click(tableButtons[0]);
    });

    expect(mockFetchColumns).toHaveBeenCalledWith("conn-1", "testdb", "users");
  });

  it("filters tables by search", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    const searchInput = screen.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "user" } });
    expect(screen.getByText("users")).toBeDefined();
    expect(screen.queryByText("orders")).toBeNull();
    expect(screen.queryByText("products")).toBeNull();
  });

  it("shows 'No tables found' when filter matches nothing", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    const searchInput = screen.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "zzzzz" } });
    expect(screen.getByText("No tables found")).toBeDefined();
  });

  it("switches to WHERE tab and shows empty conditions", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    fireEvent.click(screen.getByText("WHERE"));
    expect(screen.getByText("WHERE Conditions")).toBeDefined();
    expect(screen.getByText('No conditions. Click "Add" to create one.')).toBeDefined();
  });

  it("switches to ORDER BY tab and shows empty order clause", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    fireEvent.click(screen.getByText("ORDER BY"));
    expect(screen.getByText('No ordering. Click "Add" to create one.')).toBeDefined();
  });

  it("switches to GROUP BY tab and shows empty group clause", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    fireEvent.click(screen.getByText("GROUP BY"));
    expect(screen.getByText('No grouping. Click "Add" to create one.')).toBeDefined();
  });

  it("switches to HAVING tab", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    fireEvent.click(screen.getByText("HAVING"));
    expect(screen.getByText("HAVING Conditions")).toBeDefined();
  });

  it("has Execute and Copy to Editor buttons", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(screen.getByText("Execute")).toBeDefined();
    expect(screen.getByText("Copy to Editor")).toBeDefined();
  });

  it("has LIMIT input", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(screen.getByText("LIMIT")).toBeDefined();
  });

  it("uses cached tables when available", () => {
    vi.mocked(useSchemaCache).mockImplementation((selector) => {
      const state = {
        fetchTables: mockFetchTables,
        fetchColumns: mockFetchColumns,
        tables: new Map([["testdb", mockTables]]),
      };
      if (typeof selector === "function") return selector(state);
      return state;
    });

    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    expect(screen.getByText("users")).toBeDefined();
  });

  it("Execute and Copy to Editor are disabled when no SQL generated", () => {
    render(<QueryBuilder connectionId="conn-1" database="testdb" />);
    const executeBtn = screen.getByText("Execute");
    const copyBtn = screen.getByText("Copy to Editor");
    expect(executeBtn.closest("button")?.disabled).toBe(true);
    expect(copyBtn.closest("button")?.disabled).toBe(true);
  });

  describe("table added to canvas", () => {
    it("renders table card with table name after adding", async () => {
      mockFetchColumns.mockResolvedValue(mockColumns);

      render(<QueryBuilder connectionId="conn-1" database="testdb" />);

      await act(async () => {
        const btns = screen.getAllByText("users");
        fireEvent.click(btns[0]);
      });

      await waitFor(() => {
        const card = document.querySelector(".absolute.select-none");
        expect(card).toBeTruthy();
      });
    });
  });

  describe("copy to editor", () => {
    it("copies SQL to editor when Copy to Editor is clicked", async () => {
      const mockAddTab = vi.fn(() => "new-tab");
      const mockUpdateTabContent = vi.fn();
      vi.mocked(useEditorStore.getState).mockReturnValue({
        addTab: mockAddTab,
        updateTabContent: mockUpdateTabContent,
        tabs: [],
        activeTabId: null,
      });

      mockFetchColumns.mockResolvedValue(mockColumns);

      render(<QueryBuilder connectionId="conn-1" database="testdb" />);

      await act(async () => {
        const btns = screen.getAllByText("users");
        fireEvent.click(btns[0]);
      });

      await waitFor(() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        expect(checkboxes.length).toBeGreaterThan(0);
      });

      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      if (checkboxes.length > 0) {
        fireEvent.click(checkboxes[0]);
      }

      await act(async () => {
        fireEvent.click(screen.getByText("Copy to Editor"));
      });

      expect(mockAddTab).toHaveBeenCalled();
      expect(mockUpdateTabContent).toHaveBeenCalled();
    });
  });
});
