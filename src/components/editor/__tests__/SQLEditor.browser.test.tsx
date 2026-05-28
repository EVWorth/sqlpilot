import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// ── ALL vars that vi.mock factories reference go in vi.hoisted() ──
const m = vi.hoisted(() => {
  const state = {
    modelValue: "SELECT 1",
    selectionValue: "SELECT 1 FROM users",
    selectionIsEmpty: false,
  };

  const capturedActions: Array<{ id: string; run: Function }> = [];
  const capturedEditor: { current: Record<string, unknown> | null } = {
    current: null,
  };
  let editorMounted = false;

  const mockSetValue = vi.fn();
  const mockFormat = vi.fn(() => "FORMATTED SQL");
  const mockPostProcessSQL = vi.fn((sql: string) => sql);

  const mockMonaco = {
    languages: {
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };

  // Store mocks
  const useEditorStore = vi.fn() as ReturnType<typeof vi.fn> & {
    getState: ReturnType<typeof vi.fn>;
  };
  const editorStoreGetState = vi.fn();
  Object.assign(useEditorStore, { getState: editorStoreGetState });

  const useResultStore = vi.fn() as ReturnType<typeof vi.fn> & {
    getState: ReturnType<typeof vi.fn>;
  };
  const resultStoreGetState = vi.fn();
  Object.assign(useResultStore, { getState: resultStoreGetState });

  const useConnectionStore = vi.fn() as ReturnType<typeof vi.fn> & {
    getState: ReturnType<typeof vi.fn>;
  };
  const connectionStoreGetState = vi.fn();
  Object.assign(useConnectionStore, { getState: connectionStoreGetState });

  const useSettingsStore = vi.fn() as ReturnType<typeof vi.fn> & {
    getState: ReturnType<typeof vi.fn>;
  };
  const settingsStoreGetState = vi.fn();
  Object.assign(useSettingsStore, { getState: settingsStoreGetState });

  const useThemeStore = vi.fn();
  const useSchemaCache = vi.fn();

  return {
    state,
    capturedActions,
    capturedEditor,
    get editorMounted() {
      return editorMounted;
    },
    set editorMounted(v: boolean) {
      editorMounted = v;
    },
    mockSetValue,
    mockFormat,
    mockPostProcessSQL,
    mockMonaco,
    useEditorStore,
    editorStoreGetState,
    useResultStore,
    resultStoreGetState,
    useConnectionStore,
    connectionStoreGetState,
    useSettingsStore,
    settingsStoreGetState,
    useThemeStore,
    useSchemaCache,
  };
});

// ── Mock sql-formatter ──
vi.mock("sql-formatter", () => ({ format: m.mockFormat }));

// ── Mock sql-post-process ──
vi.mock("../../lib/sql-post-process", () => ({
  postProcessSQL: m.mockPostProcessSQL,
}));

// ── Mock schema-completion-provider ──
vi.mock("../../lib/schema-completion-provider", () => ({
  createCompletionProvider: vi.fn(() => ({ provideCompletionItems: vi.fn() })),
}));

// ── Mock @monaco-editor/react ──
vi.mock("@monaco-editor/react", () => ({
  useMonaco: () => m.mockMonaco,
  default: ({
    value,
    onMount,
    onChange,
    language,
    theme,
  }: {
    value?: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
    onChange?: (value: string) => void;
    language?: string;
    theme?: string;
  }) => {
    if (onMount && !m.editorMounted) {
      m.editorMounted = true;
      const mockEditor = {
        getModel: vi.fn(() => ({
          getValue: vi.fn(() => m.state.modelValue),
          getValueInRange: vi.fn(() => m.state.selectionValue),
          setValue: m.mockSetValue,
        })),
        getSelection: vi.fn(() => ({
          isEmpty: vi.fn(() => m.state.selectionIsEmpty),
        })),
        addAction: vi.fn((action: { id: string; run: Function }) => {
          m.capturedActions.push(action);
          return action.id;
        }),
        layout: vi.fn(),
      };
      m.capturedEditor.current = mockEditor;
      setTimeout(() => onMount(mockEditor, m.mockMonaco), 0);
    }
    return (
      <textarea
        data-testid="sql-editor-textarea"
        data-language={language}
        data-theme={theme}
        defaultValue={value}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange?.(e.target.value)
        }
      />
    );
  },
}));

// ── Mock stores ──
vi.mock("../../stores/editorStore", () => ({
  useEditorStore: m.useEditorStore,
}));
vi.mock("../../stores/resultStore", () => ({
  useResultStore: m.useResultStore,
}));
vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: m.useConnectionStore,
}));
vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: m.useSettingsStore,
}));
vi.mock("../../stores/themeStore", () => ({
  useThemeStore: m.useThemeStore,
}));
vi.mock("../../hooks/useSchemaCache", () => ({
  useSchemaCache: m.useSchemaCache,
}));
vi.mock("../../lib/tauri-api", () => ({ api: {} }));

// ── Import component ──
import { SQLEditor } from "../SQLEditor";

describe("SQLEditor (browser)", () => {
  let execQuery: ReturnType<typeof vi.fn>;
  let execExplain: ReturnType<typeof vi.fn>;
  let updContent: ReturnType<typeof vi.fn>;
  let setEditorInst: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    m.capturedActions.length = 0;
    m.capturedEditor.current = null;
    m.editorMounted = false;
    m.state.modelValue = "SELECT 1";
    m.state.selectionValue = "SELECT 1 FROM users";
    m.state.selectionIsEmpty = false;

    execQuery = vi.fn();
    execExplain = vi.fn();
    updContent = vi.fn();
    setEditorInst = vi.fn();

    // ── Store implementations ──
    m.useEditorStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "Query 1",
              content: m.state.modelValue,
              connectionId: "conn-1",
              type: "query" as const,
              isDirty: false,
            },
          ],
          updateTabContent: updContent,
          setEditorInstance: setEditorInst,
        };
        return selector ? selector(state) : state;
      },
    );
    m.editorStoreGetState.mockReturnValue({
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "Query 1",
          content: m.state.modelValue,
          connectionId: "conn-1",
          type: "query",
          isDirty: false,
        },
      ],
      updateTabContent: updContent,
      setEditorInstance: setEditorInst,
    });

    m.useResultStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = { executeQuery: execQuery, executeExplain: execExplain };
        return selector ? selector(state) : state;
      },
    );
    m.resultStoreGetState.mockReturnValue({
      executeQuery: execQuery,
      executeExplain: execExplain,
    });

    m.useConnectionStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = { selectedConnectionId: "conn-1" };
        return selector ? selector(state) : state;
      },
    );
    m.connectionStoreGetState.mockReturnValue({
      selectedConnectionId: "conn-1",
    });

    m.useSettingsStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = {
          formatterSettings: {
            keywordCase: "upper" as const,
            identifierCase: "preserve" as const,
            dataTypeCase: "upper" as const,
            functionCase: "preserve" as const,
            indentStyle: "standard" as const,
            tabWidth: 2,
            useTabs: false,
            logicalOperatorNewline: "before" as const,
            newlineBeforeSemicolon: false,
            expressionWidth: 50,
            linesBetweenQueries: 1,
            denseOperators: false,
          },
        };
        return selector ? selector(state) : state;
      },
    );
    m.settingsStoreGetState.mockReturnValue({
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
    });

    m.useThemeStore.mockImplementation(
      (selector?: (s: { effectiveTheme: string }) => unknown) => {
        const state = { effectiveTheme: "dark" as const };
        return selector ? selector(state) : state;
      },
    );

    m.useSchemaCache.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = {
          connectionId: null,
          databases: [],
          tables: new Map(),
          views: new Map(),
          columns: new Map(),
          fetchTables: vi.fn(),
          fetchViews: vi.fn(),
          fetchColumns: vi.fn(),
          setConnection: vi.fn(),
        };
        return selector ? selector(state) : state;
      },
    );
  });

  // ── Rendering ──
  it("renders Editor with SQL language and dark theme", () => {
    render(<SQLEditor />);
    const editor = screen.getByTestId("sql-editor-textarea");
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveAttribute("data-language", "sql");
    expect(editor).toHaveAttribute("data-theme", "vs-dark");
  });

  it('renders "Open a new tab" message when no active tab', () => {
    m.useEditorStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = {
          activeTabId: null,
          tabs: [],
          updateTabContent: updContent,
          setEditorInstance: setEditorInst,
        };
        return selector ? selector(state) : state;
      },
    );
    render(<SQLEditor />);
    expect(
      screen.getByText("Open a new tab to start writing SQL"),
    ).toBeInTheDocument();
  });

  it("calls updateTabContent onChange", () => {
    render(<SQLEditor />);
    const textarea = screen.getByTestId("sql-editor-textarea");
    fireEvent.change(textarea, { target: { value: "SELECT 2" } });
    expect(updContent).toHaveBeenCalledWith("tab-1", "SELECT 2");
  });

  it("calls setEditorInstance on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(setEditorInst).toHaveBeenCalled();
    });
  });

  // ── execute-query ──
  it("registers execute-query action on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(
        m.capturedActions.some((a) => a.id === "execute-query"),
      ).toBe(true);
    });
  });

  it("execute-query calls executeQuery with selected SQL", async () => {
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "execute-query"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "execute-query",
    )!;
    action.run();
    expect(execQuery).toHaveBeenCalledWith("conn-1", "SELECT 1 FROM users");
  });

  it("execute-query does nothing when no connection", async () => {
    m.connectionStoreGetState.mockReturnValue({ selectedConnectionId: null });
    m.useConnectionStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = { selectedConnectionId: null };
        return selector ? selector(state) : state;
      },
    );
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "execute-query"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "execute-query",
    )!;
    action.run();
    expect(execQuery).not.toHaveBeenCalled();
  });

  it("execute-query uses full model value when selection empty", async () => {
    m.state.selectionIsEmpty = true;
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "execute-query"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "execute-query",
    )!;
    action.run();
    expect(execQuery).toHaveBeenCalledWith("conn-1", "SELECT 1");
  });

  it("execute-query does nothing when SQL empty", async () => {
    m.state.selectionIsEmpty = true;
    m.state.modelValue = "   ";
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "execute-query"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "execute-query",
    )!;
    action.run();
    expect(execQuery).not.toHaveBeenCalled();
  });

  // ── format-sql ──
  it("registers format-sql action on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(
        m.capturedActions.some((a) => a.id === "format-sql"),
      ).toBe(true);
    });
  });

  it("format-sql formats SQL and calls setValue", async () => {
    m.state.modelValue = "select 1";
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "format-sql"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "format-sql",
    )!;
    action.run(m.capturedEditor.current);
    expect(m.mockFormat).toHaveBeenCalledWith(
      "select 1",
      expect.objectContaining({ language: "mysql" }),
    );
    expect(m.mockPostProcessSQL).toHaveBeenCalledWith("FORMATTED SQL");
    expect(m.mockSetValue).toHaveBeenCalledWith("FORMATTED SQL");
  });

  it("format-sql does nothing when model empty", async () => {
    m.state.modelValue = "   ";
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "format-sql"),
    );
    m.mockFormat.mockClear();
    const action = m.capturedActions.find(
      (a) => a.id === "format-sql",
    )!;
    action.run(m.capturedEditor.current);
    expect(m.mockFormat).not.toHaveBeenCalled();
  });

  it("format-sql catches formatting errors gracefully", async () => {
    m.mockFormat.mockImplementation(() => {
      throw new Error("Parse error");
    });
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "format-sql"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "format-sql",
    )!;
    expect(() => action.run(m.capturedEditor.current)).not.toThrow();
  });

  // ── explain-query ──
  it("registers explain-query action on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(
        m.capturedActions.some((a) => a.id === "explain-query"),
      ).toBe(true);
    });
  });

  it("explain-query calls executeExplain when connection set", async () => {
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "explain-query"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "explain-query",
    )!;
    action.run(m.capturedEditor.current);
    expect(execExplain).toHaveBeenCalledWith(
      "conn-1",
      "SELECT 1 FROM users",
    );
  });

  it("explain-query does nothing when no connection", async () => {
    m.connectionStoreGetState.mockReturnValue({ selectedConnectionId: null });
    m.useConnectionStore.mockImplementation(
      (selector?: (s: object) => unknown) => {
        const state = { selectedConnectionId: null };
        return selector ? selector(state) : state;
      },
    );
    render(<SQLEditor />);
    await waitFor(() =>
      m.capturedActions.some((a) => a.id === "explain-query"),
    );
    const action = m.capturedActions.find(
      (a) => a.id === "explain-query",
    )!;
    action.run(m.capturedEditor.current);
    expect(execExplain).not.toHaveBeenCalled();
  });

  // ── Completion provider ──
  it("registers completion provider when monaco is available", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(
        m.mockMonaco.languages.registerCompletionItemProvider,
      ).toHaveBeenCalledWith("sql", expect.any(Object));
    });
  });
});
