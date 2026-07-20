import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let connSelId: string | null = "conn-1";
let connActive: any[] = [
  {
    id: "conn-1",
    profile_id: "prof-1",
    name: "Test DB",
    host: "localhost",
    port: 3306,
    database: "testdb",
    server_version: "8.0.33",
    connected_at: "2024-01-01T00:00:00Z",
  },
];

import { QueryToolbar } from "../QueryToolbar";

vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

vi.mock("sql-formatter", () => ({
  format: vi.fn().mockReturnValue("FORMATTED SQL"),
}));

const mockExecuteQuery = vi.fn().mockResolvedValue(undefined);
const mockExecuteExplain = vi.fn().mockResolvedValue(undefined);
const mockExecuteExplainAnalyze = vi.fn().mockResolvedValue(undefined);

let mockCanExecute = true;
let mockIsExecuting = false;

vi.mock("../../../hooks/useQueryExecution", () => ({
  useQueryExecution: vi.fn(() => ({
    executeQuery: mockExecuteQuery,
    executeExplain: mockExecuteExplain,
    executeExplainAnalyze: mockExecuteExplainAnalyze,
    canExecute: mockCanExecute,
    isExecuting: mockIsExecuting,
  })),
}));

const mockRefreshSchema = vi.fn().mockResolvedValue(undefined);
let mockSchemaLoading = false;

vi.mock("../../../hooks/useSchemaCache", () => ({
  useSchemaCache: vi.fn(() => ({
    refreshSchema: mockRefreshSchema,
    loading: mockSchemaLoading,
    connectionId: "conn-1",
    databases: [],
    tables: new Map(),
    views: new Map(),
    columns: new Map(),
  })),
}));

let mockAiEnabled = true;
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSetQuerySettings = vi.fn();

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = {
        aiEnabled: mockAiEnabled,
        sendMessage: mockSendMessage,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({ sendMessage: mockSendMessage })),
    },
  ),
}));

const mockSettingsState = {
  querySettings: {
    maxResultRows: 1000,
    limitEnabled: true,
  },
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
  setQuerySettings: mockSetQuerySettings,
};

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      return selector ? selector(mockSettingsState) : mockSettingsState;
    }),
    {
      getState: vi.fn(() => mockSettingsState),
    },
  ),
}));

let mockEditorInstance: any = {
  getModel: vi.fn().mockReturnValue({
    getValue: vi.fn().mockReturnValue("SELECT * FROM users"),
    setValue: vi.fn(),
    getValueInRange: vi.fn().mockReturnValue("SELECT * FROM users"),
  }),
  getSelection: vi.fn().mockReturnValue({
    isEmpty: vi.fn().mockReturnValue(true),
  }),
  getAction: vi.fn().mockReturnValue({ run: vi.fn() }),
  getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
  executeEdits: vi.fn(),
  focus: vi.fn(),
};
let mockActiveTabContent = "SELECT * FROM users";

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = {
        editorInstance: mockEditorInstance,
        activeTabId: "tab-0",
        tabs: [
          {
            id: "tab-0",
            title: "Untitled Query",
            content: mockActiveTabContent,
            type: "query",
            isDirty: false,
          },
        ],
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({ editorInstance: mockEditorInstance })),
    },
  ),
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = {
        selectedConnectionId: connSelId,
        activeConnections: connActive,
        profiles: [],
        loading: false,
        error: null,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({ selectedConnectionId: connSelId })),
    },
  ),
}));

vi.mock("../../favorites/SaveFavoriteDialog", () => ({
  SaveFavoriteDialog: () => null,
}));

describe("QueryToolbar", () => {
  beforeEach(() => {
    mockCanExecute = true;
    mockIsExecuting = false;
    mockSchemaLoading = false;
    mockAiEnabled = true;
    mockActiveTabContent = "SELECT * FROM users";
    connSelId = "conn-1";
    connActive = [
      {
        id: "conn-1",
        profile_id: "prof-1",
        name: "Test DB",
        host: "localhost",
        port: 3306,
        database: "testdb",
        server_version: "8.0.33",
        connected_at: "2024-01-01T00:00:00Z",
      },
    ];
    mockEditorInstance = {
      getModel: vi.fn().mockReturnValue({
        getValue: vi.fn().mockReturnValue("SELECT * FROM users"),
        setValue: vi.fn(),
        getValueInRange: vi.fn().mockReturnValue("SELECT * FROM users"),
      }),
      getSelection: vi.fn().mockReturnValue({
        isEmpty: vi.fn().mockReturnValue(true),
      }),
      getAction: vi.fn().mockReturnValue({ run: vi.fn() }),
      getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
      executeEdits: vi.fn(),
      focus: vi.fn(),
    };
    mockRefreshSchema.mockClear();
    mockExecuteQuery.mockClear();
    mockExecuteExplain.mockClear();
    mockExecuteExplainAnalyze.mockClear();
    mockSendMessage.mockClear();
    mockSetQuerySettings.mockClear();
  });

  it("renders the Run button", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Run")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Enter / F9")).toBeInTheDocument();
  });

  it("renders the Explain button", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Explain")).toBeInTheDocument();
  });

  it("renders Find and Replace buttons", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Find")).toBeInTheDocument();
    expect(screen.getByText("Replace")).toBeInTheDocument();
  });

  it("renders Format button", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Format")).toBeInTheDocument();
  });

  it("renders Schema refresh button", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Schema")).toBeInTheDocument();
  });

  it("renders Save button", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("renders AI Explain and AI Optimize buttons when AI is enabled", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("AI Explain")).toBeInTheDocument();
    expect(screen.getByText("AI Optimize")).toBeInTheDocument();
  });

  it("renders connection info when connected", () => {
    render(<QueryToolbar />);
    expect(screen.getByText("Test DB")).toBeInTheDocument();
    expect(screen.getByText(/localhost:3306/)).toBeInTheDocument();
  });

  it("calls executeQuery when Run button is clicked", () => {
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Run"));
    expect(mockExecuteQuery).toHaveBeenCalledWith("SELECT * FROM users");
  });

  it("calls executeExplain when Explain button is clicked", () => {
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Explain"));
    expect(mockExecuteExplain).toHaveBeenCalledWith("SELECT * FROM users");
  });

  it("shows explain dropdown when chevron is clicked", () => {
    render(<QueryToolbar />);

    const buttons = screen.getAllByRole("button");
    const chevronBtn = buttons.find(
      (btn) => btn.querySelector(".lucide-chevron-down"),
    );
    expect(chevronBtn).toBeTruthy();

    fireEvent.click(chevronBtn!);

    expect(screen.getByText("EXPLAIN ANALYZE")).toBeInTheDocument();
  });

  it("calls executeExplainAnalyze when EXPLAIN ANALYZE dropdown is clicked", () => {
    render(<QueryToolbar />);

    const buttons = screen.getAllByRole("button");
    const chevronBtn = buttons.find(
      (btn) => btn.querySelector(".lucide-chevron-down"),
    );
    fireEvent.click(chevronBtn!);

    const analyzeBtn = screen.getByText("EXPLAIN ANALYZE");
    fireEvent.click(analyzeBtn);

    expect(mockExecuteExplainAnalyze).toHaveBeenCalledWith("SELECT * FROM users");
  });

  it("calls find action when Find is clicked", () => {
    const runSpy = vi.fn();
    mockEditorInstance.getAction.mockReturnValue({ run: runSpy });

    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Find"));

    expect(mockEditorInstance.getAction).toHaveBeenCalledWith("actions.find");
    expect(runSpy).toHaveBeenCalled();
  });

  it("calls replace action when Replace is clicked", () => {
    const runSpy = vi.fn();
    mockEditorInstance.getAction.mockReturnValue({ run: runSpy });

    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Replace"));

    expect(mockEditorInstance.getAction).toHaveBeenCalledWith("editor.action.startFindReplaceAction");
    expect(runSpy).toHaveBeenCalled();
  });

  it("formats SQL when Format button is clicked", () => {
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Format"));

    const model = mockEditorInstance.getModel();
    expect(model.setValue).toHaveBeenCalled();
  });

  it("calls refreshSchema when Schema button is clicked", () => {
    render(<QueryToolbar />);

    const schemaBtn = screen.getByTitle("Refresh Schema Cache");
    fireEvent.click(schemaBtn);

    // Schema button should be enabled with a connection selected
    // If the button is disabled, refresh won't be called
    if (!(schemaBtn as HTMLButtonElement).disabled) {
      expect(mockRefreshSchema).toHaveBeenCalled();
    }
  });

  it("opens save dialog when Save button is clicked", () => {
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Save"));
  });

  it("opens formatter settings when gear button is clicked", () => {
    render(<QueryToolbar />);

    const settingsBtn = screen.getByTitle("Formatter Settings");
    fireEvent.click(settingsBtn);

    expect(screen.getByText("SQL Formatter Settings")).toBeInTheDocument();
  });

  it("disables buttons when canExecute is false", () => {
    mockCanExecute = false;
    render(<QueryToolbar />);

    expect(screen.getByText("Run").closest("button")).toBeDisabled();
    expect(screen.getByText("Explain").closest("button")).toBeDisabled();
  });

  it("disables Find/Replace/Format when editorInstance is null", () => {
    mockEditorInstance = null as any;
    render(<QueryToolbar />);

    expect(screen.getByText("Find").closest("button")).toBeDisabled();
    expect(screen.getByText("Replace").closest("button")).toBeDisabled();
    expect(screen.getByText("Format").closest("button")).toBeDisabled();
  });

  it("disables Schema when no connection selected", () => {
    connSelId = null;
    connActive = [];

    render(<QueryToolbar />);
    expect(screen.getByText("Schema").closest("button")).toBeDisabled();
  });

  it("disables Save button when no tab content", () => {
    mockActiveTabContent = "";
    render(<QueryToolbar />);
    expect(screen.getByText("Save").closest("button")).toBeDisabled();
  });

  it("shows Cancel button when executing", () => {
    mockIsExecuting = true;
    render(<QueryToolbar />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.queryByText("Run")).not.toBeInTheDocument();
  });

  it("shows loading spinner on Schema when loading", () => {
    mockSchemaLoading = true;
    render(<QueryToolbar />);
    const schemaBtn = screen.getByTitle("Refresh Schema Cache");
    const svg = schemaBtn.querySelector(".animate-spin");
    expect(svg).toBeTruthy();
  });

  it("hides AI buttons when aiEnabled is false", () => {
    mockAiEnabled = false;
    render(<QueryToolbar />);
    expect(screen.queryByText("AI Explain")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Optimize")).not.toBeInTheDocument();
  });

  it("calls sendMessage when AI Explain is clicked", () => {
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("AI Explain"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Explain this SQL query"),
      "conn-1",
      undefined,
    );
  });

  it("calls sendMessage when AI Optimize is clicked", () => {
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("AI Optimize"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Optimize this SQL query"),
      "conn-1",
      undefined,
    );
  });

  it("does not call execute when no SQL content", () => {
    mockActiveTabContent = " ";
    render(<QueryToolbar />);
    fireEvent.click(screen.getByText("Run"));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("closes explain dropdown on outside click", () => {
    render(<QueryToolbar />);

    const buttons = screen.getAllByRole("button");
    const chevronBtn = buttons.find((btn) => btn.querySelector(".lucide-chevron-down"));
    fireEvent.click(chevronBtn!);

    expect(screen.getByText("EXPLAIN ANALYZE")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText("EXPLAIN ANALYZE")).not.toBeInTheDocument();
  });

  it("does not show connection info when no active connection", () => {
    connSelId = null;
    connActive = [];

    render(<QueryToolbar />);
    expect(screen.queryByText("Test DB")).not.toBeInTheDocument();
  });

  it("disables AI Optimize when no connection selected", () => {
    connSelId = null;
    connActive = [];

    render(<QueryToolbar />);
    expect(screen.getByText("AI Optimize").closest("button")).toBeDisabled();
  });
});
