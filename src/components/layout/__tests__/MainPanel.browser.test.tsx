import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MainPanel } from "../MainPanel";

vi.mock("../../editor/SQLEditor", () => ({
  SQLEditor: () => <div data-testid="sql-editor" />,
}));
vi.mock("../../editor/EditorTabs", () => ({
  EditorTabs: () => <div data-testid="editor-tabs" />,
}));
vi.mock("../../editor/QueryToolbar", () => ({
  QueryToolbar: () => <div data-testid="query-toolbar" />,
}));
vi.mock("../../grid/ResultsGrid", () => ({
  ResultsGrid: () => <div data-testid="results-grid" />,
}));
vi.mock("../../explain/ExplainPanel", () => ({
  ExplainPanel: () => <div data-testid="explain-panel" />,
}));
vi.mock("../../admin/AdminPanel", () => ({
  AdminPanel: () => <div data-testid="admin-panel" />,
}));
vi.mock("../../compare/SchemaCompare", () => ({
  SchemaCompare: () => <div data-testid="schema-compare" />,
}));
vi.mock("../../designer/TableDesigner", () => ({
  TableDesigner: () => <div data-testid="table-designer" />,
}));
vi.mock("../../querybuilder/QueryBuilder", () => ({
  QueryBuilder: () => <div data-testid="query-builder" />,
}));
vi.mock("../../routine/RoutineViewer", () => ({
  RoutineViewer: () => <div data-testid="routine-viewer" />,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  ),
  Panel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="panel">{children}</div>
  ),
  Separator: () => <div data-testid="panel-separator" />,
}));

type EditorTab = {
  id: string;
  title: string;
  content: string;
  type?: string;
  connectionId?: string;
  database?: string;
  tableName?: string;
  routineName?: string;
  routineType?: string;
  isDirty: boolean;
};

let editorState: { tabs: EditorTab[]; activeTabId: string | null } = {
  tabs: [{ id: "tab-0", title: "Untitled", content: "SELECT 1", type: "query", isDirty: false }],
  activeTabId: "tab-0",
};

let resultState = {
  showExplain: false,
  explainResult: null as unknown,
  setShowExplain: vi.fn(),
  results: [] as unknown[],
};

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((s: (v: unknown) => unknown) => s(editorState)),
    { getState: vi.fn() },
  ),
}));

vi.mock("../../stores/resultStore", () => ({
  useResultStore: Object.assign(
    vi.fn((s: (v: unknown) => unknown) => s(resultState)),
    { getState: vi.fn() },
  ),
}));

function setEditorState(state: Partial<typeof editorState>) {
  Object.assign(editorState, state);
}

function setResultState(state: Partial<typeof resultState>) {
  Object.assign(resultState, state);
  if (state.setShowExplain) resultState.setShowExplain = state.setShowExplain;
}

beforeEach(() => {
  vi.clearAllMocks();
  editorState = {
    tabs: [{ id: "tab-0", title: "Untitled", content: "SELECT 1", type: "query", isDirty: false }],
    activeTabId: "tab-0",
  };
  resultState = {
    showExplain: false,
    explainResult: null,
    setShowExplain: vi.fn(),
    results: [],
  };
});

describe("MainPanel", () => {
  it("renders EditorTabs", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("editor-tabs")).toBeInTheDocument();
  });

  it("renders default query view with QueryToolbar, SQLEditor, and ResultsGrid", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("sql-editor")).toBeInTheDocument();
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
  });

  it("renders AdminPanel when active tab type is admin", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Admin", content: "", type: "admin", connectionId: "conn-1", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("admin-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("query-toolbar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sql-editor")).not.toBeInTheDocument();
  });

  it("does not render AdminPanel when admin tab has no connectionId", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Admin", content: "", type: "admin", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("admin-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("renders SchemaCompare when active tab type is compare", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Compare", content: "", type: "compare", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("schema-compare")).toBeInTheDocument();
  });

  it("renders TableDesigner when active tab type is designer", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Designer", content: "", type: "designer", connectionId: "conn-1", database: "testdb", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("table-designer")).toBeInTheDocument();
  });

  it("renders TableDesigner with tableName", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Designer", content: "", type: "designer", connectionId: "conn-1", database: "testdb", tableName: "users", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("table-designer")).toBeInTheDocument();
  });

  it("falls back to default view when designer tab is missing database", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Designer", content: "", type: "designer", connectionId: "conn-1", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("table-designer")).not.toBeInTheDocument();
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("renders QueryBuilder when active tab type is querybuilder", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "QB", content: "", type: "querybuilder", connectionId: "conn-1", database: "testdb", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();
  });

  it("renders RoutineViewer when active tab type is routine", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Routine", content: "", type: "routine", connectionId: "conn-1", database: "testdb", routineName: "my_proc", routineType: "PROCEDURE", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("routine-viewer")).toBeInTheDocument();
  });

  it("renders RoutineViewer with FUNCTION type", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Routine", content: "", type: "routine", connectionId: "conn-1", database: "testdb", routineName: "my_func", routineType: "FUNCTION", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("routine-viewer")).toBeInTheDocument();
  });

  it("falls back to default view when routine tab is missing required fields", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Routine", content: "", type: "routine", connectionId: "conn-1", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("routine-viewer")).not.toBeInTheDocument();
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("renders panel group and separator for default view", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("panel-group")).toBeInTheDocument();
    expect(screen.getByTestId("panel-separator")).toBeInTheDocument();
    expect(screen.getAllByTestId("panel").length).toBe(2);
  });

  it("renders ExplainPanel when showExplain is true and explainResult is set", () => {
    setResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
    });
    render(<MainPanel />);
    expect(screen.getByTestId("explain-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("results-grid")).not.toBeInTheDocument();
  });

  it("renders ResultsGrid when showExplain is false", () => {
    setResultState({ showExplain: false, explainResult: null });
    render(<MainPanel />);
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("explain-panel")).not.toBeInTheDocument();
  });

  it("renders explain tab bar when explain is available", () => {
    setResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
    });
    render(<MainPanel />);
    expect(screen.getByText("Results")).toBeInTheDocument();
    expect(screen.getByText(/Explain/)).toBeInTheDocument();
  });

  it("switches between explain and results tabs", async () => {
    setResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
    });
    render(<MainPanel />);

    // Starts on Explain tab (auto-switched by useEffect)
    expect(screen.getByTestId("explain-panel")).toBeInTheDocument();

    // Click Results tab
    fireEvent.click(screen.getByText("Results"));
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("explain-panel")).not.toBeInTheDocument();

    // Click Explain tab
    fireEvent.click(screen.getByText(/Explain/));
    expect(screen.getByTestId("explain-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("results-grid")).not.toBeInTheDocument();
  });

  it("close explain button hides explain and shows results", () => {
    const setShowExplain = vi.fn();
    setResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
      setShowExplain,
    });
    render(<MainPanel />);

    const closeBtn = screen.getByTitle("Close Explain");
    fireEvent.click(closeBtn);
    expect(setShowExplain).toHaveBeenCalledWith(false);
  });

  it("has full height flex column container", () => {
    const { container } = render(<MainPanel />);
    const root = container.firstElementChild!;
    expect(root.className).toContain("h-full");
    expect(root.className).toContain("flex-col");
  });

  it("activeTab is undefined renders default view", () => {
    setEditorState({
      tabs: [],
      activeTabId: null,
    });
    render(<MainPanel />);
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("handles unknown tab type gracefully by showing default view", () => {
    setEditorState({
      tabs: [{ id: "tab-1", title: "Unknown", content: "", type: "unknown", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
  });
});
