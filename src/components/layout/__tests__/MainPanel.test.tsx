import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MainPanel } from "../MainPanel";

vi.mock("../../editor/SQLEditor", () => ({ SQLEditor: vi.fn(() => <div data-testid="sql-editor">SQLEditor</div>) }));
vi.mock("../../editor/EditorTabs", () => ({ EditorTabs: vi.fn(() => <div data-testid="editor-tabs">EditorTabs</div>) }));
vi.mock("../../editor/QueryToolbar", () => ({ QueryToolbar: vi.fn(() => <div data-testid="query-toolbar">QueryToolbar</div>) }));
vi.mock("../../grid/ResultsGrid", () => ({ ResultsGrid: vi.fn(() => <div data-testid="results-grid">ResultsGrid</div>) }));
vi.mock("../../explain/ExplainPanel", () => ({ ExplainPanel: vi.fn(() => <div data-testid="explain-panel">ExplainPanel</div>) }));
vi.mock("../../admin/AdminPanel", () => ({ AdminPanel: vi.fn(() => <div data-testid="admin-panel">AdminPanel</div>) }));
vi.mock("../../compare/SchemaCompare", () => ({ SchemaCompare: vi.fn(() => <div data-testid="schema-compare">SchemaCompare</div>) }));
vi.mock("../../routine/RoutineViewer", () => ({ RoutineViewer: vi.fn(() => <div data-testid="routine-viewer">RoutineViewer</div>) }));
vi.mock("../../designer/TableDesigner", () => ({ TableDesigner: vi.fn(() => <div data-testid="table-designer">TableDesigner</div>) }));
vi.mock("../../querybuilder/QueryBuilder", () => ({ QueryBuilder: vi.fn(() => <div data-testid="query-builder">QueryBuilder</div>) }));

vi.mock("react-resizable-panels", () => ({
  Group: vi.fn(({ children }: { children: React.ReactNode }) => <div data-testid="panel-group">{children}</div>),
  Panel: vi.fn(({ children }: { children: React.ReactNode }) => <div data-testid="panel">{children}</div>),
  Separator: vi.fn(() => <div data-testid="panel-separator" />),
}));

(globalThis as any).__mainPanelEditorState = { tabs: [{ id: "tab1", type: "query", content: "SELECT 1" }], activeTabId: "tab1" };

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: vi.fn((s: (v: unknown) => unknown) => s((globalThis as any).__mainPanelEditorState)),
}));

vi.mock("../../stores/resultStore", () => ({
  useResultStore: vi.fn((s: (v: unknown) => unknown) => s({ showExplain: false, explainResult: null, setShowExplain: vi.fn(), results: [] })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__mainPanelEditorState = { tabs: [{ id: "tab1", type: "query", content: "SELECT 1" }], activeTabId: "tab1" };
});

describe("MainPanel", () => {
  it("renders EditorTabs", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("editor-tabs")).toBeInTheDocument();
  });

  it("renders QueryToolbar for query type tab", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("query-toolbar")).toBeInTheDocument();
  });

  it("renders SQLEditor for query type tab", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("sql-editor")).toBeInTheDocument();
  });

  it("renders ResultsGrid for query type tab", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("results-grid")).toBeInTheDocument();
  });

  it("renders panel group separator", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("panel-separator")).toBeInTheDocument();
  });

  it("has full height container", () => {
    const { container } = render(<MainPanel />);
    expect(container.firstElementChild).toHaveClass("h-full", "flex-col");
  });
});
