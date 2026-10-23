import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorTab } from "../../../types";
import { ResultsGrid } from "../../grid/ResultsGrid";
import { TableStructure } from "../../schema/TableStructure";
import { MainPanel } from "../MainPanel";

vi.mock("../../editor/SQLEditor", () => ({ SQLEditor: vi.fn(() => <div data-testid="sql-editor">SQLEditor</div>) }));
vi.mock(
  "../../editor/EditorTabs",
  () => ({ EditorTabs: vi.fn(() => <div data-testid="editor-tabs">EditorTabs</div>) }),
);
vi.mock(
  "../../editor/QueryToolbar",
  () => ({ QueryToolbar: vi.fn(() => <div data-testid="query-toolbar">QueryToolbar</div>) }),
);
vi.mock(
  "../../grid/ResultsGrid",
  () => ({ ResultsGrid: vi.fn(() => <div data-testid="results-grid">ResultsGrid</div>) }),
);
vi.mock(
  "../../explain/ExplainPanel",
  () => ({ ExplainPanel: vi.fn(() => <div data-testid="explain-panel">ExplainPanel</div>) }),
);
vi.mock("../../admin/AdminPanel", () => ({ AdminPanel: vi.fn(() => <div data-testid="admin-panel">AdminPanel</div>) }));
vi.mock(
  "../../routine/RoutineViewer",
  () => ({ RoutineViewer: vi.fn(() => <div data-testid="routine-viewer">RoutineViewer</div>) }),
);
vi.mock(
  "../../schema/DdlViewer",
  () => ({ DdlViewer: vi.fn(() => <div data-testid="ddl-viewer">DdlViewer</div>) }),
);
vi.mock(
  "../../designer/TableDesigner",
  () => ({ TableDesigner: vi.fn(() => <div data-testid="table-designer">TableDesigner</div>) }),
);

vi.mock(
  "../../schema/TableStructure",
  () => ({ TableStructure: vi.fn(() => <div data-testid="table-structure">TableStructure</div>) }),
);

vi.mock("react-resizable-panels", () => ({
  Group: vi.fn(({ children }: { children: React.ReactNode }) => <div data-testid="panel-group">{children}</div>),
  Panel: vi.fn(({ children }: { children: React.ReactNode }) => <div data-testid="panel">{children}</div>),
  Separator: vi.fn(() => <div data-testid="panel-separator" />),
}));

(globalThis as any).__mainPanelEditorState = {
  tabs: [{ id: "tab1", type: "query", content: "SELECT 1" }],
  activeTabId: "tab1",
};

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: vi.fn((s: (v: unknown) => unknown) => s((globalThis as any).__mainPanelEditorState)),
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: vi.fn((s: (v: unknown) => unknown) =>
    s({
      showExplain: false,
      explainResult: null,
      setShowExplain: vi.fn(),
      results: [],
      showTab: vi.fn(),
      forgetTabs: vi.fn(),
      dropForeignResults: vi.fn(),
    })
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__mainPanelEditorState = {
    tabs: [{ id: "tab1", type: "query", content: "SELECT 1" }],
    activeTabId: "tab1",
  };
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

  it("gives each tab a fresh results grid", () => {
    // #842: the grid's edit state (pending edits, Edit Mode) lives in the
    // component. Kept across a tab switch, tab A's edits were saved against
    // tab B's rows and table.
    let mounts = 0;
    vi.mocked(ResultsGrid).mockImplementation(function CountingGrid() {
      useEffect(() => {
        mounts++;
      }, []);
      return <div data-testid="results-grid">ResultsGrid</div>;
    });
    const query = (id: string): EditorTab => ({ id, title: id, content: "", type: "query", isDirty: false });
    const tabs = [query("tab1"), query("tab2")];
    Object.assign(globalThis, { __mainPanelEditorState: { tabs, activeTabId: "tab1" } });
    const { rerender } = render(<MainPanel />);
    expect(mounts).toBe(1);

    Object.assign(globalThis, { __mainPanelEditorState: { tabs, activeTabId: "tab2" } });
    rerender(<MainPanel />);

    expect(mounts).toBe(2);
  });

  describe("renders the right panel for every tab kind", () => {
    const base = { id: "t", title: "t", content: "", isDirty: false };
    // A Record keyed on the union makes a new tab kind a type error here until
    // it gets a case, so a kind MainPanel forgets to render fails CI (#787).
    const cases: Record<EditorTab["type"], { tab: EditorTab; testId: string }> = {
      query: { tab: { ...base, type: "query" }, testId: "sql-editor" },
      structure: {
        tab: { ...base, type: "structure", connectionId: "c1", database: "shop", tableName: "orders" },
        testId: "table-structure",
      },
      admin: { tab: { ...base, type: "admin", connectionId: "c1" }, testId: "admin-panel" },
      designer: {
        tab: { ...base, type: "designer", connectionId: "c1", database: "shop", tableName: "orders" },
        testId: "table-designer",
      },
      routine: {
        tab: {
          ...base,
          type: "routine",
          connectionId: "c1",
          database: "shop",
          routineName: "p",
          routineType: "PROCEDURE",
        },
        testId: "routine-viewer",
      },
      ddl: {
        tab: {
          ...base,
          type: "ddl",
          connectionId: "c1",
          database: "shop",
          objectName: "orders",
          objectType: "TABLE",
        },
        testId: "ddl-viewer",
      },
    };
    const panelIds = Object.values(cases).map((c) => c.testId);
    const showOnly = (tab: EditorTab) => {
      Object.assign(globalThis, { __mainPanelEditorState: { tabs: [tab], activeTabId: tab.id } });
    };

    it.each(Object.entries(cases))("%s tab", (_kind, { tab, testId }) => {
      showOnly(tab);
      render(<MainPanel />);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      for (const other of panelIds.filter((id) => id !== testId)) {
        expect(screen.queryByTestId(other)).toBeNull();
      }
    });

    it("passes the table to TableStructure", () => {
      showOnly(cases.structure.tab);
      render(<MainPanel />);
      expect(vi.mocked(TableStructure).mock.calls[0][0]).toEqual({
        connectionId: "c1",
        database: "shop",
        tableName: "orders",
      });
    });
  });
});
