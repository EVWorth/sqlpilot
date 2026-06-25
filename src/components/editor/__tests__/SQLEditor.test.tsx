import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQLEditor } from "../SQLEditor";

// Mock @monaco-editor/react
const mockEditorOnMountFn = vi.fn();

vi.mock("@monaco-editor/react", () => ({
  default: ({ height, language, theme, value, onMount }: any) => {
    if (onMount) {
      const mockEditor = {
        getModel: vi.fn().mockReturnValue({
          getValue: vi.fn().mockReturnValue("SELECT * FROM users"),
          setValue: vi.fn(),
          getValueInRange: vi.fn().mockReturnValue("SELECT * FROM users"),
        }),
        getSelection: vi.fn().mockReturnValue({ isEmpty: vi.fn().mockReturnValue(true) }),
        getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
        executeEdits: vi.fn(),
        focus: vi.fn(),
        addAction: vi.fn().mockReturnValue(undefined),
        onDidChangeModelContent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        getAction: vi.fn().mockReturnValue({ run: vi.fn() }),
        trigger: vi.fn(),
      };
      mockEditorOnMountFn.mockImplementation(() => {
        setTimeout(() => onMount(mockEditor, {}), 0);
      });
      mockEditorOnMountFn();
    }
    return (
      <div data-testid="monaco-editor" data-language={language} data-theme={theme} data-height={height}>
        <pre>{value}</pre>
      </div>
    );
  },
  useMonaco: vi.fn(() => null),
}));

vi.mock("sql-formatter", () => ({
  format: vi.fn().mockReturnValue("FORMATTED SQL"),
}));

vi.mock("../../../lib/sql-post-process", () => ({
  postProcessSQL: vi.fn((sql: string) => sql),
}));

vi.mock("../../../lib/schema-completion-provider", () => ({
  createCompletionProvider: vi.fn().mockReturnValue({ provideCompletionItems: vi.fn() }),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

// Mock editor store
const mockSetEditorInstance = vi.fn();
const mockUpdateTabContent = vi.fn();
let editorStoreActiveTabId: string | null = "tab-0";
let editorStoreTabs: any[] = [
  {
    id: "tab-0",
    title: "Untitled Query",
    content: "SELECT * FROM users",
    type: "query",
    isDirty: false,
  },
];

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = {
        activeTabId: editorStoreActiveTabId,
        tabs: editorStoreTabs,
        updateTabContent: mockUpdateTabContent,
        setEditorInstance: mockSetEditorInstance,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({
        tabs: editorStoreTabs,
        activeTabId: editorStoreActiveTabId,
      })),
    },
  ),
}));

// Mock result store
const mockExecuteQuery = vi.fn();
const mockExecuteExplain = vi.fn();
vi.mock("../../../stores/resultStore", () => ({
  useResultStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = { executeQuery: mockExecuteQuery, executeExplain: mockExecuteExplain };
      return selector ? selector(state) : state;
    }),
    { getState: vi.fn(() => ({ executeQuery: mockExecuteQuery, executeExplain: mockExecuteExplain })) },
  ),
}));

// Mock connection store
vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = { selectedConnectionId: "conn-1", activeConnections: [] };
      return selector ? selector(state) : state;
    }),
    { getState: vi.fn(() => ({ selectedConnectionId: "conn-1" })) },
  ),
}));

// Mock settings store
vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: vi.fn(() => ({
    formatterSettings: {
      keywordCase: "upper",
      identifierCase: "preserve",
      dataTypeCase: "upper",
      functionCase: "preserve",
      indentStyle: "standard",
      tabWidth: 2,
      useTabs: false,
      logicalOperatorNewline: "before",
      newlineBeforeSemicolon: false,
      expressionWidth: 50,
      linesBetweenQueries: 1,
      denseOperators: false,
    },
  })),
}));

// Mock schema cache store
vi.mock("../../../hooks/useSchemaCache", () => ({
  useSchemaCache: vi.fn((selector?: (s: any) => any) => {
    const state = {
      connectionId: null,
      databases: [],
      tables: new Map(),
      views: new Map(),
      columns: new Map(),
      routines: new Map(),
      triggers: new Map(),
      loading: false,
      setConnection: vi.fn(),
      fetchDatabases: vi.fn(),
      fetchTables: vi.fn(),
      fetchViews: vi.fn(),
      fetchRoutines: vi.fn(),
      fetchTriggers: vi.fn(),
      fetchColumns: vi.fn(),
      refreshSchema: vi.fn(),
    };
    return selector ? selector(state) : state;
  }),
}));

// Provide theme store state
const themeStoreState = { effectiveTheme: "dark" as string };
vi.mock("../../../stores/themeStore", () => ({
  useThemeStore: vi.fn((selector?: (s: any) => any) => {
    return selector ? selector(themeStoreState) : themeStoreState;
  }),
}));

describe("SQLEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    themeStoreState.effectiveTheme = "dark";
    editorStoreActiveTabId = "tab-0";
    editorStoreTabs = [
      {
        id: "tab-0",
        title: "Untitled Query",
        content: "SELECT * FROM users",
        type: "query",
        isDirty: false,
      },
    ];
  });

  it("renders the Monaco editor with SQL content", () => {
    render(<SQLEditor />);

    const editor = screen.getByTestId("monaco-editor");
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveAttribute("data-language", "sql");
    expect(screen.getByText("SELECT * FROM users")).toBeInTheDocument();
  });

  it("shows empty state message when there is no active tab", () => {
    editorStoreActiveTabId = null;
    editorStoreTabs = [];

    render(<SQLEditor />);

    expect(screen.getByText("Open a new tab to start writing SQL")).toBeInTheDocument();
  });

  it("uses dark theme when effectiveTheme is dark", () => {
    themeStoreState.effectiveTheme = "dark";
    render(<SQLEditor />);

    const editor = screen.getByTestId("monaco-editor");
    expect(editor).toHaveAttribute("data-theme", "vs-dark");
  });

  it("uses light theme when effectiveTheme is light", () => {
    themeStoreState.effectiveTheme = "light";
    render(<SQLEditor />);

    const editor = screen.getByTestId("monaco-editor");
    expect(editor).toHaveAttribute("data-theme", "vs");
  });

  it("sets 100% height on the editor", () => {
    render(<SQLEditor />);

    const editor = screen.getByTestId("monaco-editor");
    expect(editor).toHaveAttribute("data-height", "100%");
  });

  it("calls setEditorInstance on mount", async () => {
    render(<SQLEditor />);

    await waitFor(() => {
      expect(mockSetEditorInstance).toHaveBeenCalled();
    });
  });

  it("has correct SQL language attribute", () => {
    render(<SQLEditor />);
    const editor = screen.getByTestId("monaco-editor");
    expect(editor).toHaveAttribute("data-language", "sql");
  });
});
