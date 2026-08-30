import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUpdate, resolveEditTarget } from "../../../lib/sql-generator";
import { api } from "../../../lib/tauri-api";
import { ResultsGrid } from "../ResultsGrid";

const state = {
  results: [] as any[],
  activeResultIndex: 0,
  isExecuting: false,
  error: null as string | null,
};

vi.mock("../../../stores/resultStore", () => {
  const storeFn = function(selector: (v: unknown) => unknown) {
    return selector({
      ...state,
      setActiveResult: vi.fn(),
      executeQuery: vi.fn(),
      executeExplain: vi.fn(),
    });
  } as any;
  storeFn.getState = () => ({
    ...state,
    setActiveResult: vi.fn(),
    executeQuery: vi.fn(),
    executeExplain: vi.fn(),
  });
  return { useResultStore: storeFn };
});

let editorTabs: any[] = [];
let editorActiveTabId: string | null = null;

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const s = { tabs: editorTabs, activeTabId: editorActiveTabId };
      return selector ? selector(s) : s;
    }),
    { getState: vi.fn(() => ({ tabs: editorTabs, activeTabId: editorActiveTabId })) },
  ),
}));

let connSelectedId: string | null = null;

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const s = { selectedConnectionId: connSelectedId };
      return selector ? selector(s) : s;
    }),
    { getState: vi.fn(() => ({ selectedConnectionId: connSelectedId })) },
  ),
}));

let aiMockSend = vi.fn();
let aiMockEnabled = false;

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: Object.assign(
    vi.fn((s: (v: unknown) => unknown) => s({ aiEnabled: aiMockEnabled, sendMessage: aiMockSend })),
    { getState: vi.fn(() => ({ aiEnabled: aiMockEnabled, sendMessage: aiMockSend })) },
  ),
}));

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu: vi.fn() })),
}));

const mockGridEditing = {
  editMode: false,
  toggleEditMode: vi.fn(),
  pendingCount: 0,
  hasChanges: false,
  addRow: vi.fn(),
  discardAll: vi.fn(),
  inserts: [] as any[],
  updates: new Map(),
  deletes: [] as number[],
  getCellValue: vi.fn((_r: number, _c: string, o: unknown) => o),
  isCellEdited: vi.fn(() => false),
  isRowEdited: vi.fn(() => false),
  isRowDeleted: vi.fn(() => false),
  editCell: vi.fn(),
  deleteRow: vi.fn(),
  editInsertCell: vi.fn(),
};

vi.mock("../../../hooks/useGridEditing", () => ({
  useGridEditing: vi.fn(() => mockGridEditing),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: { exportResults: vi.fn(), executeQuery: vi.fn(), getColumns: vi.fn() },
}));
vi.mock("../../../lib/sql-generator", () => ({
  columnTypesOf: vi.fn(() => ({})),
  generateUpdate: vi.fn(() => "UPDATE ..."),
  generateInsert: vi.fn(() => "INSERT ..."),
  generateDelete: vi.fn(() => "DELETE ..."),
  extractTableName: vi.fn(() => "users"),
  resolveEditTarget: vi.fn(() => ({ editable: true, table: "users" })),
  getWhereColumns: vi.fn(() => ({ columns: ["id"], hasPrimaryKey: true })),
}));
vi.mock("../EditableCell", () => ({ EditableCell: vi.fn(() => <div data-testid="editable-cell">EditableCell</div>) }));
vi.mock("../EditToolbar", () => ({
  EditToolbar: vi.fn(({ editMode, onSave }: { editMode: boolean; onSave?: () => void }) => (
    <div data-testid="edit-toolbar" data-edit-mode={editMode}>
      EditToolbar
      <button
        type="button"
        data-testid="save-button"
        onClick={() =>
          onSave?.()}
      >
        Save
      </button>
    </div>
  )),
}));
vi.mock("../TruncatedCell", () => ({
  TruncatedCell: vi.fn(({ value }: { value: unknown }) => <div data-testid="truncated-cell">{String(value)}</div>),
}));
vi.mock("../CellViewerModal", () => ({
  CellViewerModal: vi.fn((
    { isOpen, columnName, content }: { isOpen: boolean; columnName: string; content: string | null },
  ) => (
    <div data-testid="cell-viewer-modal" data-open={isOpen} data-column={columnName} data-content={content}>
      CellViewerModal
    </div>
  )),
}));

let tableRows: any[] = [];
let tableHeaders: any[] = [];

vi.mock("@tanstack/react-table", () => ({
  useTable: vi.fn(() => ({
    getRowModel: () => ({ rows: tableRows }),
    getFlatHeaders: () => tableHeaders,
    setColumnSizing: vi.fn(),
    getState: () => ({ sorting: [], columnSizing: {} }),
  })),
  // v9: features are declared up front; tableFeatures() just returns the
  // registry object, so an identity mock is enough here.
  tableFeatures: vi.fn((f: Record<string, unknown>) => f),
  createSortedRowModel: vi.fn(() => ({})),
  rowSortingFeature: {},
  columnSizingFeature: {},
  columnResizingFeature: {},
  columnVisibilityFeature: {},
  flexRender: vi.fn((def: any, ctx: any) => {
    if (def.header) return def.header;
    return null;
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(() => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
  })),
}));

const baseResult = {
  query_id: "q1",
  statement_index: 0,
  columns: [{ name: "id", data_type: "int", nullable: false, is_primary_key: true }],
  rows: [[1]],
  rows_affected: 0,
  execution_time_ms: 10,
  warnings: [],
  rows_truncated: false,
};

describe("ResultsGrid", () => {
  beforeEach(() => {
    state.results = [{ ...baseResult }];
    state.activeResultIndex = 0;
    state.isExecuting = false;
    state.error = null;
    tableRows = [];
    tableHeaders = [];
    editorTabs = [];
    editorActiveTabId = null;
    connSelectedId = null;
    aiMockEnabled = false;
    aiMockSend = vi.fn();
    mockGridEditing.editMode = false;
    mockGridEditing.inserts = [];
    mockGridEditing.hasChanges = false;
    mockGridEditing.pendingCount = 0;
  });

  it("renders without crashing", () => {
    const { container } = render(<ResultsGrid />);
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("shows executing state when query is running", () => {
    state.isExecuting = true;
    render(<ResultsGrid />);
    expect(screen.getByText("Executing query...")).toBeInTheDocument();
  });

  it("shows error message when error exists", () => {
    state.error = "Syntax error near 'SELEC'";
    render(<ResultsGrid />);
    expect(screen.getByText("Query Error")).toBeInTheDocument();
    expect(screen.getByText("Syntax error near 'SELEC'")).toBeInTheDocument();
  });

  it("shows empty state when no active result", () => {
    state.results = [];
    render(<ResultsGrid />);
    expect(screen.getByText("Execute a query to see results")).toBeInTheDocument();
  });

  it("shows empty state when result has no columns", () => {
    state.results = [{ ...baseResult, columns: [], rows_affected: -1 }];
    render(<ResultsGrid />);
    expect(screen.getByText("Execute a query to see results")).toBeInTheDocument();
  });

  it("shows rows affected info for non-SELECT queries", () => {
    state.results = [{ ...baseResult, columns: [], rows_affected: 42, execution_time_ms: 25 }];
    render(<ResultsGrid />);
    expect(screen.getByText(/42 row\(s\) affected/)).toBeInTheDocument();
    expect(screen.getByText(/25ms/)).toBeInTheDocument();
  });

  it("shows result tabs when multiple results exist", () => {
    state.results = [
      {
        ...baseResult,
        query_id: "q1",
        statement_index: 0,
        columns: [{ name: "a", data_type: "int", nullable: true, is_primary_key: false }],
        rows: [[1]],
      },
      {
        ...baseResult,
        query_id: "q2",
        statement_index: 1,
        columns: [{ name: "b", data_type: "int", nullable: true, is_primary_key: false }],
        rows: [[2]],
      },
    ];
    render(<ResultsGrid />);
    expect(screen.getByText("Result 1")).toBeInTheDocument();
    expect(screen.getByText("Result 2")).toBeInTheDocument();
  });

  it("does not show tabs when only one result", () => {
    state.results = [{ ...baseResult }];
    render(<ResultsGrid />);
    expect(screen.queryByText("Result 1")).toBeNull();
  });

  it("shows footer with row count and execution time", () => {
    render(<ResultsGrid />);
    expect(screen.getByText(/1 row\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/10ms/)).toBeInTheDocument();
  });

  it("shows truncation warning banner when rows_truncated is true", () => {
    state.results = [{ ...baseResult, rows_truncated: true, rows: [] }];
    render(<ResultsGrid />);
    expect(screen.getByText(/Results truncated/)).toBeInTheDocument();
  });

  it("shows warning banners from result warnings", () => {
    state.results = [{ ...baseResult, warnings: ["High memory usage detected"] }];
    render(<ResultsGrid />);
    expect(screen.getByText("High memory usage detected")).toBeInTheDocument();
  });

  it("renders EditToolbar", () => {
    render(<ResultsGrid />);
    expect(screen.getByTestId("edit-toolbar")).toBeInTheDocument();
  });

  it("renders export buttons in footer", () => {
    render(<ResultsGrid />);
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.getByText("CSV")).toBeInTheDocument();
    expect(screen.getByText("JSON")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
    expect(screen.getByText("MD")).toBeInTheDocument();
  });

  it("renders CellViewerModal when no cell selected (closed)", () => {
    render(<ResultsGrid />);
    const modal = screen.getByTestId("cell-viewer-modal");
    expect(modal.getAttribute("data-open")).toBe("false");
  });

  it("shows rows-affected message with execution time", () => {
    state.results = [{ ...baseResult, columns: [], rows_affected: 5, execution_time_ms: 42 }];
    render(<ResultsGrid />);
    expect(screen.getByText(/5 row\(s\) affected/)).toBeInTheDocument();
    expect(screen.getByText(/42ms/)).toBeInTheDocument();
  });

  it("does not show 'Fix with AI' button when AI is disabled", () => {
    state.error = "Some error";
    render(<ResultsGrid />);
    expect(screen.queryByText("Fix with AI")).not.toBeInTheDocument();
  });

  it("shows 'Fix with AI' button when AI is enabled and error exists", () => {
    aiMockEnabled = true;
    state.error = "Syntax error";
    render(<ResultsGrid />);
    expect(screen.getByText("Fix with AI")).toBeInTheDocument();
  });

  it("renders table structure when data exists", () => {
    render(<ResultsGrid />);
    const gridContainer = document.querySelector(".flex.h-full.flex-col.min-h-0");
    expect(gridContainer).toBeTruthy();
  });

  it("clicking Fix with AI sends message", () => {
    aiMockEnabled = true;
    state.error = "Syntax error";
    editorTabs = [{ id: "tab-0", content: "SELEC * FROM users", connectionId: "conn-1" }];
    editorActiveTabId = "tab-0";

    render(<ResultsGrid />);
    fireEvent.click(screen.getByText("Fix with AI"));

    expect(aiMockSend).toHaveBeenCalledWith(
      expect.stringContaining("Fix this SQL query"),
    );
  });

  it("EditToolbar shows editMode flag to EditToolbar component", () => {
    mockGridEditing.editMode = true;
    render(<ResultsGrid />);
    const toolbar = screen.getByTestId("edit-toolbar");
    expect(toolbar.getAttribute("data-edit-mode")).toBe("true");
  });

  it("EditToolbar shows non-edit mode by default", () => {
    render(<ResultsGrid />);
    const toolbar = screen.getByTestId("edit-toolbar");
    expect(toolbar.getAttribute("data-edit-mode")).toBe("false");
  });

  it("does not show Fix with AI when AI disabled and no editor content", () => {
    aiMockEnabled = false;
    state.error = "Some error";
    render(<ResultsGrid />);
    expect(screen.queryByText("Fix with AI")).not.toBeInTheDocument();
  });

  it("shows empty state with rows_affected >= 0 but no columns", () => {
    state.results = [{ ...baseResult, columns: [], rows_affected: 3, execution_time_ms: 15 }];
    render(<ResultsGrid />);
    expect(screen.getByText(/3 row\(s\) affected/)).toBeInTheDocument();
  });

  it("does not show tabs or result set when no active result", () => {
    state.results = [];
    render(<ResultsGrid />);
    expect(screen.getByText("Execute a query to see results")).toBeInTheDocument();
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
  });
});

describe("ResultsGrid tab switching", () => {
  it("clicking Result 2 sets active tab", () => {
    state.results = [
      {
        ...baseResult,
        query_id: "q1",
        columns: [{ name: "a", data_type: "int", nullable: true, is_primary_key: false }],
        rows: [[1]],
      },
      {
        ...baseResult,
        query_id: "q2",
        columns: [{ name: "b", data_type: "int", nullable: true, is_primary_key: false }],
        rows: [[2]],
      },
    ];
    state.activeResultIndex = 0;
    render(<ResultsGrid />);
    fireEvent.click(screen.getByText("Result 2"));
  });
});

describe("saving edits safely", () => {
  beforeEach(() => {
    // Call counts leak between tests in this block otherwise — the outer
    // describe's clearAllMocks does not reach here.
    vi.clearAllMocks();
    // This describe sits outside the one whose beforeEach seeds the store, so
    // the grid would otherwise render "Execute a query to see results".
    state.results = [{ ...baseResult }];
    state.activeResultIndex = 0;
    state.isExecuting = false;
    state.error = null;
    editorTabs = [{
      id: "tab-0",
      content: "SELECT * FROM users",
      connectionId: "conn-1",
      database: "app",
    }];
    editorActiveTabId = "tab-0";
    connSelectedId = "conn-1";
    mockGridEditing.updates = new Map([[0, [{ column: "name", newValue: "x" }]]]);
    mockGridEditing.hasChanges = true;
    mockGridEditing.pendingCount = 1;
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "id", is_primary_key: true },
      { name: "name", is_primary_key: false },
    ] as never);
    vi.mocked(api.executeQuery).mockResolvedValue([{ rows_affected: 1 }] as never);
    vi.mocked(resolveEditTarget).mockReturnValue({ editable: true, table: "users" });
  });

  afterEach(() => {
    mockGridEditing.updates = new Map();
    mockGridEditing.hasChanges = false;
    mockGridEditing.pendingCount = 0;
  });

  it("refuses to write when the query cannot be attributed to one table", async () => {
    // A join used to resolve to whichever table came first in the FROM clause,
    // so an edit to the other table's column was written to the wrong place
    // (#399).
    vi.mocked(resolveEditTarget).mockReturnValue({
      editable: false,
      reason: "the query joins tables, so an edited column cannot be attributed to one of them",
    });

    render(<ResultsGrid />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-button"));
    });

    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(await screen.findByText(/joins tables/)).toBeDefined();
  });

  it("addresses rows by the real primary key, not every column", async () => {
    // Result-set metadata reports is_primary_key false for everything, so the
    // WHERE clause matched on all columns (#387). The schema knows better.
    render(<ResultsGrid />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-button"));
    });

    expect(api.getColumns).toHaveBeenCalledWith("conn-1", "app", "users");
    expect(vi.mocked(generateUpdate).mock.calls[0][1]).toEqual(["id"]);
  });

  it("refuses when the primary key is not among the selected columns", async () => {
    // Without the key on screen there is no way to address the row.
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "hidden_id", is_primary_key: true },
    ] as never);

    render(<ResultsGrid />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-button"));
    });

    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(await screen.findByText(/primary key/)).toBeDefined();
  });

  it("says so when a change matched no row", async () => {
    // The statement runs and affects zero rows, which is not an error — so the
    // save reported success whatever happened (#419).
    vi.mocked(api.executeQuery).mockResolvedValue([{ rows_affected: 0 }] as never);

    render(<ResultsGrid />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-button"));
    });

    expect(await screen.findByText(/matched a row/)).toBeDefined();
  });
});
