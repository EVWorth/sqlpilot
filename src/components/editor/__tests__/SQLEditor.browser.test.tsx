import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const capturedActions: Array<{ id: string; run: Function }> = [];
  const capturedEditor: { current: Record<string, unknown> | null } = { current: null };
  let editorMounted = false;

  const mockSetValue = vi.fn();
  const mockUpdateTabContent = vi.fn();
  const mockSetEditorInstance = vi.fn();
  const mockExecuteQuery = vi.fn();
  const mockExecuteExplain = vi.fn();
  const mockExecuteExplainAnalyze = vi.fn();
  const mockTrigger = vi.fn();
  const mockRefreshSchema = vi.fn();

  const mockMonaco = {
    languages: {
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };

  return {
    capturedActions,
    capturedEditor,
    get editorMounted() {
      return editorMounted;
    },
    set editorMounted(v: boolean) {
      editorMounted = v;
    },
    mockSetValue,
    mockUpdateTabContent,
    mockSetEditorInstance,
    mockExecuteQuery,
    mockExecuteExplain,
    mockExecuteExplainAnalyze,
    mockTrigger,
    mockRefreshSchema,
    mockMonaco,
  };
});

vi.mock("../../lib/sql-post-process", () => ({
  postProcessSQL: vi.fn((sql: string) => sql),
}));

vi.mock("../../lib/schema-completion-provider", () => ({
  createCompletionProvider: vi.fn(() => ({ provideCompletionItems: vi.fn() })),
}));

vi.mock("../../lib/tauri-api", () => ({ api: {} }));

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
          getValue: vi.fn(() => "SELECT 1"),
          getValueInRange: vi.fn(() => "SELECT 1 FROM users"),
          setValue: m.mockSetValue,
        })),
        getSelection: vi.fn(() => ({
          isEmpty: vi.fn(() => false),
        })),
        addAction: vi.fn((action: { id: string; run: Function }) => {
          m.capturedActions.push(action);
          return action.id;
        }),
        trigger: m.mockTrigger,
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
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value)}
      />
    );
  },
}));

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector?: (s: object) => unknown) => {
      const state = {
        activeTabId: "tab-1",
        tabs: [{
          id: "tab-1",
          title: "Query 1",
          content: "SELECT 1",
          connectionId: "conn-1",
          type: "query",
          isDirty: false,
        }],
        updateTabContent: m.mockUpdateTabContent,
        setEditorInstance: m.mockSetEditorInstance,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({
        activeTabId: "tab-1",
        tabs: [{
          id: "tab-1",
          title: "Query 1",
          content: "SELECT 1",
          connectionId: "conn-1",
          type: "query",
          isDirty: false,
        }],
        updateTabContent: m.mockUpdateTabContent,
        setEditorInstance: m.mockSetEditorInstance,
      })),
    },
  ),
}));

vi.mock("../../stores/resultStore", () => ({
  useResultStore: Object.assign(
    vi.fn((selector?: (s: object) => unknown) => {
      const state = {
        executeQuery: m.mockExecuteQuery,
        executeExplain: m.mockExecuteExplain,
        executeExplainAnalyze: m.mockExecuteExplainAnalyze,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({
        executeQuery: m.mockExecuteQuery,
        executeExplain: m.mockExecuteExplain,
        executeExplainAnalyze: m.mockExecuteExplainAnalyze,
      })),
    },
  ),
}));

vi.mock("../../hooks/useSchemaCache", () => ({
  useSchemaCache: vi.fn(() => ({
    connectionId: "conn-1",
    databases: [],
    tables: [],
    views: [],
    columns: new Map(),
    fetchTables: vi.fn(),
    fetchViews: vi.fn(),
    fetchColumns: vi.fn(),
    setConnection: vi.fn(),
    refreshSchema: m.mockRefreshSchema,
  })),
}));

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector?: (s: object) => unknown) => {
      const state = { selectedConnectionId: "conn-1" };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({
        selectedConnectionId: "conn-1",
      })),
    },
  ),
}));

vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: vi.fn((selector?: (s: object) => unknown) => {
    const state = {
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
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../../stores/themeStore", () => ({
  useThemeStore: vi.fn((selector?: (s: { effectiveTheme: string }) => unknown) => {
    const state = { effectiveTheme: "dark" as const };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../../hooks/useSchemaCache", () => ({
  useSchemaCache: vi.fn((selector?: (s: object) => unknown) => {
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
  }),
}));

import { SQLEditor } from "../SQLEditor";

describe("SQLEditor (browser)", () => {
  beforeEach(() => {
    m.capturedActions.length = 0;
    m.capturedEditor.current = null;
    m.editorMounted = false;
    vi.clearAllMocks();
  });

  it("renders Editor with SQL language and dark theme", () => {
    render(<SQLEditor />);
    const editor = screen.getByTestId("sql-editor-textarea");
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveAttribute("data-language", "sql");
    expect(editor).toHaveAttribute("data-theme", "vs-dark");
  });

  it("registers execute-query action on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "execute-query")).toBe(true);
    });
  });

  it("registers format-sql action on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "format-sql")).toBe(true);
    });
  });

  it("registers explain-query action on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "explain-query")).toBe(true);
    });
  });

  it("registers explain-analyze action on mount (fixes advertised-but-missing Ctrl+Shift+A)", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "explain-analyze")).toBe(true);
    });
  });

  it("registers refresh-schema action on mount (industry-standard F5)", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "refresh-schema")).toBe(true);
    });
  });

  it("registers lowercase-selected action (Ctrl+Shift+L)", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "lowercase-selected")).toBe(true);
    });
  });

  it("registers uppercase-selected action (Ctrl+Shift+U)", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "uppercase-selected")).toBe(true);
    });
  });

  it("explain-analyze.run calls executeExplainAnalyze with connectionId", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "explain-analyze")).toBe(true);
    });
    const action = m.capturedActions.find((a) => a.id === "explain-analyze")!;
    await action.run();
    expect(m.mockExecuteExplainAnalyze).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined);
  });

  it("refresh-schema.run calls useSchemaCache.refreshSchema", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "refresh-schema")).toBe(true);
    });
    const action = m.capturedActions.find((a) => a.id === "refresh-schema")!;
    await action.run();
    expect(m.mockRefreshSchema).toHaveBeenCalled();
  });

  it("lowercase-selected.run delegates to Monaco's editor.action.transformToLowercase", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "lowercase-selected")).toBe(true);
    });
    const action = m.capturedActions.find((a) => a.id === "lowercase-selected")!;
    await action.run();
    expect(m.mockTrigger).toHaveBeenCalledWith("keyboard", "editor.action.transformToLowercase", null);
  });

  it("uppercase-selected.run delegates to Monaco's editor.action.transformToUppercase", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedActions.some((a) => a.id === "uppercase-selected")).toBe(true);
    });
    const action = m.capturedActions.find((a) => a.id === "uppercase-selected")!;
    await action.run();
    expect(m.mockTrigger).toHaveBeenCalledWith("keyboard", "editor.action.transformToUppercase", null);
  });

  it("registers completion provider when monaco is available", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.mockMonaco.languages.registerCompletionItemProvider).toHaveBeenCalledWith("sql", expect.any(Object));
    });
  });

  it("sets editor instance on mount", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedEditor.current).not.toBeNull();
    });
  });

  it("captured editor has addAction method", async () => {
    render(<SQLEditor />);
    await waitFor(() => {
      expect(m.capturedEditor.current).not.toBeNull();
    });
    expect(typeof m.capturedEditor.current!.addAction).toBe("function");
  });
});
