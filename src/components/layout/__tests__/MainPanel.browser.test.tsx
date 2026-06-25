import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  Group: ({ children }: { children: React.ReactNode }) => <div data-testid="panel-group">{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div data-testid="panel">{children}</div>,
  Separator: () => <div data-testid="panel-separator" />,
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: vi.fn(),
}));
vi.mock("../../../stores/resultStore", () => ({
  useResultStore: vi.fn(),
}));

import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";
import { MainPanel } from "../MainPanel";

function mockEditorState(state: {
  tabs: {
    id: string;
    type?: string;
    title?: string;
    content?: string;
    connectionId?: string;
    database?: string;
    tableName?: string;
    routineName?: string;
    routineType?: string;
    isDirty?: boolean;
  }[];
  activeTabId: string | null;
}) {
  vi.mocked(useEditorStore).mockImplementation((s: (v: unknown) => unknown) => s(state));
}

function mockResultState(state: {
  showExplain?: boolean;
  explainResult?: unknown;
  setShowExplain?: () => void;
  results?: unknown[];
}) {
  vi.mocked(useResultStore).mockImplementation((s: (v: unknown) => unknown) =>
    s({
      showExplain: false,
      explainResult: null,
      setShowExplain: vi.fn(),
      results: [],
      ...state,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEditorState({
    tabs: [{ id: "tab-0", title: "Untitled", content: "SELECT 1", type: "query", isDirty: false }],
    activeTabId: "tab-0",
  });
  mockResultState({});
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
    mockEditorState({
      tabs: [{ id: "tab-1", title: "Admin", content: "", type: "admin", connectionId: "conn-1", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("admin-panel")).toBeInTheDocument();
  });

  it("does not render AdminPanel when admin tab has no connectionId", () => {
    mockEditorState({
      tabs: [{ id: "tab-1", title: "Admin", content: "", type: "admin", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("admin-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("renders SchemaCompare when active tab type is compare", () => {
    mockEditorState({
      tabs: [{ id: "tab-1", title: "Compare", content: "", type: "compare", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("schema-compare")).toBeInTheDocument();
  });

  it("renders TableDesigner when active tab type is designer", () => {
    mockEditorState({
      tabs: [{
        id: "tab-1",
        title: "Designer",
        content: "",
        type: "designer",
        connectionId: "conn-1",
        database: "testdb",
        isDirty: false,
      }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("table-designer")).toBeInTheDocument();
  });

  it("falls back to default view when designer tab is missing database", () => {
    mockEditorState({
      tabs: [{ id: "tab-1", title: "Designer", content: "", type: "designer", connectionId: "conn-1", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("table-designer")).not.toBeInTheDocument();
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("renders QueryBuilder when active tab type is querybuilder", () => {
    mockEditorState({
      tabs: [{
        id: "tab-1",
        title: "QB",
        content: "",
        type: "querybuilder",
        connectionId: "conn-1",
        database: "testdb",
        isDirty: false,
      }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();
  });

  it("renders RoutineViewer when active tab type is routine", () => {
    mockEditorState({
      tabs: [{
        id: "tab-1",
        title: "Routine",
        content: "",
        type: "routine",
        connectionId: "conn-1",
        database: "testdb",
        routineName: "my_proc",
        routineType: "PROCEDURE",
        isDirty: false,
      }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("routine-viewer")).toBeInTheDocument();
  });

  it("falls back to default view when routine tab is missing required fields", () => {
    mockEditorState({
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
    mockResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
    });
    render(<MainPanel />);
    expect(screen.getByTestId("explain-panel")).toBeInTheDocument();
  });

  it("renders ResultsGrid when showExplain is false (default)", () => {
    mockResultState({ showExplain: false, explainResult: null });
    render(<MainPanel />);
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("explain-panel")).not.toBeInTheDocument();
  });

  it("renders explain tab bar when explain is available", () => {
    mockResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
    });
    render(<MainPanel />);
    expect(screen.getByText("Results")).toBeInTheDocument();
    expect(screen.getByText(/Explain/)).toBeInTheDocument();
  });

  it("switches between explain and results tabs", () => {
    mockResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
    });
    render(<MainPanel />);

    expect(screen.getByTestId("explain-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Results"));
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Explain/));
    expect(screen.getByTestId("explain-panel")).toBeInTheDocument();
  });

  it("close explain button calls setShowExplain", () => {
    const mockSetShowExplain = vi.fn();
    mockResultState({
      showExplain: true,
      explainResult: { columns: [], rows: [] },
      setShowExplain: mockSetShowExplain,
    });
    render(<MainPanel />);

    fireEvent.click(screen.getByTitle("Close Explain"));
    expect(mockSetShowExplain).toHaveBeenCalledWith(false);
  });

  it("has full height flex column container", () => {
    const { container } = render(<MainPanel />);
    const root = container.firstElementChild!;
    expect(root.className).toContain("h-full");
    expect(root.className).toContain("flex-col");
  });

  it("activeTab is undefined renders default view", () => {
    mockEditorState({ tabs: [], activeTabId: null });
    render(<MainPanel />);
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("handles unknown tab type gracefully by showing default view", () => {
    mockEditorState({
      tabs: [{ id: "tab-1", title: "Unknown", content: "", type: "unknown", isDirty: false }],
      activeTabId: "tab-1",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
  });
});
