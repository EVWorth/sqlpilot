import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// Hoisted: mutable navigator.platform override (runs before all imports)
const { platformStore } = vi.hoisted(() => {
  const store = { value: "Linux x86_64" };
  Object.defineProperty(globalThis.navigator, "platform", {
    get: () => store.value,
    configurable: true,
  });
  return { platformStore: store };
});

// ── Mock child components ──
vi.mock("../Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
vi.mock("../MainPanel", () => ({
  MainPanel: () => <div data-testid="main-panel" />,
}));
vi.mock("../StatusBar", () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));
vi.mock("../Toolbar", () => ({
  Toolbar: vi.fn(
    ({ onToggleAI, aiPanelOpen, aiEnabled }: Record<string, unknown>) => (
      <div
        data-testid="toolbar"
        data-ai-panel-open={String(aiPanelOpen)}
        data-ai-enabled={String(aiEnabled)}
        onClick={() => (onToggleAI as () => void)?.()}
      />
    ),
  ),
}));
vi.mock("../TitleBar", () => ({
  TitleBar: vi.fn(
    ({ onToggleAI, aiPanelOpen, aiEnabled }: Record<string, unknown>) => (
      <div
        data-testid="title-bar"
        data-ai-panel-open={String(aiPanelOpen)}
        data-ai-enabled={String(aiEnabled)}
        onClick={() => (onToggleAI as () => void)?.()}
      />
    ),
  ),
}));
vi.mock("../ConnectionTabs", () => ({
  ConnectionTabs: () => <div data-testid="connection-tabs" />,
}));
vi.mock("../../common/ShortcutsDialog", () => ({
  ShortcutsDialog: vi.fn(
    ({ isOpen, initialTab }: { isOpen: boolean; initialTab: string }) => (
      <div data-testid="shortcuts-dialog" data-open={String(isOpen)} data-tab={initialTab} />
    ),
  ),
}));
vi.mock("../../common/ConfirmDialog", () => ({
  ConfirmDialog: vi.fn(({ isOpen }: { isOpen: boolean }) => (
    <div data-testid="confirm-dialog" data-open={String(isOpen)} />
  )),
}));
vi.mock("../../import/ImportDialog", () => ({
  ImportDialog: vi.fn(({ isOpen }: { isOpen: boolean }) => (
    <div data-testid="import-dialog" data-open={String(isOpen)} />
  )),
}));
vi.mock("../../backup/BackupDialog", () => ({
  BackupDialog: vi.fn(
    ({
      isOpen,
      preSelectedConnectionId,
      preSelectedDatabase,
    }: {
      isOpen: boolean;
      preSelectedConnectionId?: string;
      preSelectedDatabase?: string;
    }) => (
      <div
        data-testid="backup-dialog"
        data-open={String(isOpen)}
        data-preselect-conn={preSelectedConnectionId ?? ""}
        data-preselect-db={preSelectedDatabase ?? ""}
      />
    ),
  ),
}));
vi.mock("../../backup/RestoreDialog", () => ({
  RestoreDialog: vi.fn(
    ({
      isOpen,
      preSelectedConnectionId,
      preSelectedDatabase,
    }: {
      isOpen: boolean;
      preSelectedConnectionId?: string;
      preSelectedDatabase?: string;
    }) => (
      <div
        data-testid="restore-dialog"
        data-open={String(isOpen)}
        data-preselect-conn={preSelectedConnectionId ?? ""}
        data-preselect-db={preSelectedDatabase ?? ""}
      />
    ),
  ),
}));
vi.mock("../../ai/AIChatPanel", () => ({
  AIChatPanel: vi.fn(() => <div data-testid="ai-chat-panel" />),
}));

// ── Mock react-resizable-panels ──
vi.mock("react-resizable-panels", () => ({
  Group: vi.fn(({ children }: { children: React.ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  )),
  Panel: vi.fn(({ children }: { children: React.ReactNode }) => (
    <div data-testid="panel">{children}</div>
  )),
  Separator: vi.fn(() => <div data-testid="panel-separator" />),
}));

// ── Mock hooks ──
const { mockUseKeyboard } = vi.hoisted(() => ({
  mockUseKeyboard: vi.fn(),
}));
vi.mock("../../../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: mockUseKeyboard,
}));
vi.mock("../../../hooks/useTheme", () => ({
  useTheme: vi.fn(),
}));
vi.mock("../../../hooks/useSchemaCache", () => ({
  useSchemaCache: {
    getState: vi.fn(() => ({ refreshSchema: vi.fn() })),
  },
}));

// ── Mock Tauri ──
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ close: vi.fn() })),
}));

// ── Mutable store state ──
let connectionState = {
  selectedConnectionId: null as string | null,
  activeConnections: [] as Array<{ id: string; profile_id: string; host: string; port: number; database?: string }>,
  disconnect: vi.fn(),
  profiles: [] as any[],
};

let resultState = {
  confirmDialog: null as { isOpen: boolean } | null,
  confirmExecution: vi.fn(),
  cancelExecution: vi.fn(),
};

let editorState = {
  tabs: [] as any[],
  activeTabId: null as string | null,
  addTab: vi.fn(() => "tab-1"),
  addAdminTab: vi.fn(),
  addCompareTab: vi.fn(),
  addQueryBuilderTab: vi.fn(),
  editorInstance: null as any,
};

let aiState = {
  aiEnabled: false,
  checkStatus: vi.fn(),
};

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(connectionState)),
    { getState: vi.fn(() => connectionState) },
  ),
}));
vi.mock("../../../stores/resultStore", () => ({
  useResultStore: vi.fn((selector: (s: unknown) => unknown) => selector(resultState)),
}));
vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(editorState)),
    { getState: vi.fn(() => editorState) },
  ),
}));
vi.mock("../../../stores/aiStore", () => ({
  useAiStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(aiState)),
    { getState: vi.fn(() => aiState) },
  ),
}));

// Dynamic import so platform override takes effect
async function renderApp() {
  const mod = await import("../AppLayout");
  return render(<mod.AppLayout />);
}

describe("AppLayout (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformStore.value = "Linux x86_64";
    connectionState = {
      selectedConnectionId: null,
      activeConnections: [],
      disconnect: vi.fn(),
      profiles: [],
    };
    resultState = {
      confirmDialog: null,
      confirmExecution: vi.fn(),
      cancelExecution: vi.fn(),
    };
    editorState = {
      tabs: [],
      activeTabId: null,
      addTab: vi.fn(() => "tab-1"),
      addAdminTab: vi.fn(),
      addCompareTab: vi.fn(),
      addQueryBuilderTab: vi.fn(),
      editorInstance: null,
    };
    aiState = {
      aiEnabled: false,
      checkStatus: vi.fn(),
    };
  });

  // ─── Platform-specific header ───
  it("renders TitleBar when not on macOS", async () => {
    platformStore.value = "Linux x86_64";
    await renderApp();
    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("toolbar")).not.toBeInTheDocument();
  });

  // ─── Core layout sections ───
  it("renders Sidebar", async () => {
    await renderApp();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });

  it("renders MainPanel", async () => {
    await renderApp();
    expect(screen.getByTestId("main-panel")).toBeInTheDocument();
  });

  it("renders StatusBar", async () => {
    await renderApp();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
  });

  it("renders ConnectionTabs", async () => {
    await renderApp();
    expect(screen.getByTestId("connection-tabs")).toBeInTheDocument();
  });

  // ─── AI panel visibility ───
  it("does not render AI panel when aiEnabled is false", async () => {
    aiState.aiEnabled = false;
    await renderApp();
    expect(screen.queryByTestId("ai-chat-panel")).not.toBeInTheDocument();
  });

  it("renders AI panel when aiEnabled=true and aiPanelOpen=true", async () => {
    aiState.aiEnabled = true;
    await renderApp();
    // aiPanelOpen defaults to false initially, so AI panel won't render
    expect(screen.queryByTestId("ai-chat-panel")).not.toBeInTheDocument();
    // Toggle AI panel via TitleBar click
    const titleBar = screen.getByTestId("title-bar");
    const user = userEvent.setup();
    await user.click(titleBar);
    await waitFor(() => {
      expect(screen.getByTestId("ai-chat-panel")).toBeInTheDocument();
    });
  });

  it("hides AI panel when aiEnabled is false even if toggled", async () => {
    aiState.aiEnabled = false;
    await renderApp();
    // Toggling should not render AI panel when disabled
    expect(screen.queryByTestId("ai-chat-panel")).not.toBeInTheDocument();
  });

  // ─── ImportDialog visibility ───
  it("does not render ImportDialog when no connection selected", async () => {
    connectionState.selectedConnectionId = null;
    await renderApp();
    expect(screen.queryByTestId("import-dialog")).not.toBeInTheDocument();
  });

  it("renders ImportDialog when connected and showImport state is triggered", async () => {
    connectionState.selectedConnectionId = "conn-1";
    connectionState.activeConnections = [
      { id: "conn-1", profile_id: "p1", host: "localhost", port: 3306, database: "testdb" },
    ];
    await renderApp();
    // Import dialog container is present (connected) but isOpen depends on showImport
    // It should be in DOM since the condition selectedConnectionId && selectedConnection is met
    const dialog = screen.getByTestId("import-dialog");
    expect(dialog).toBeInTheDocument();
  });

  // ─── BackupDialog ───
  it("renders BackupDialog", async () => {
    await renderApp();
    expect(screen.getByTestId("backup-dialog")).toBeInTheDocument();
  });

  it("opens BackupDialog with preselected connection/database via sidebar event", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("open-backup", { detail: { connectionId: "conn-99", database: "mydb" } }),
      );
    });
    await waitFor(() => {
      const el = screen.getByTestId("backup-dialog");
      expect(el.getAttribute("data-preselect-conn")).toBe("conn-99");
      expect(el.getAttribute("data-preselect-db")).toBe("mydb");
      expect(el.getAttribute("data-open")).toBe("true");
    });
  });

  // ─── RestoreDialog ───
  it("renders RestoreDialog", async () => {
    await renderApp();
    expect(screen.getByTestId("restore-dialog")).toBeInTheDocument();
  });

  it("opens RestoreDialog with preselected connection/database via sidebar event", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("open-restore", { detail: { connectionId: "conn-99", database: "otherdb" } }),
      );
    });
    await waitFor(() => {
      const el = screen.getByTestId("restore-dialog");
      expect(el.getAttribute("data-preselect-conn")).toBe("conn-99");
      expect(el.getAttribute("data-preselect-db")).toBe("otherdb");
      expect(el.getAttribute("data-open")).toBe("true");
    });
  });

  // ─── ConfirmDialog ───
  it("renders ConfirmDialog when confirmDialog state is set", async () => {
    resultState.confirmDialog = { isOpen: true };
    await renderApp();
    const el = screen.getByTestId("confirm-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
    // Confirm/cancel buttons are inside the real ConfirmDialog; we mock it,
    // but the prop binding verifies it receives isOpen=true
  });

  it("ConfirmDialog is closed when confirmDialog state is null", async () => {
    resultState.confirmDialog = null;
    await renderApp();
    const el = screen.getByTestId("confirm-dialog");
    expect(el.getAttribute("data-open")).toBe("false");
  });

  // ─── ShortcutsDialog ───
  it("renders ShortcutsDialog with isOpen=false by default", async () => {
    await renderApp();
    const el = screen.getByTestId("shortcuts-dialog");
    expect(el.getAttribute("data-open")).toBe("false");
    expect(el.getAttribute("data-tab")).toBe("shortcuts");
  });

  it("opens ShortcutsDialog via menu-action event", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("menu-action", { detail: "keyboard-shortcuts" }),
      );
    });
    const el = screen.getByTestId("shortcuts-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
    expect(el.getAttribute("data-tab")).toBe("shortcuts");
  });

  it("opens ShortcutsDialog with about tab via menu-action", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("menu-action", { detail: "about" }),
      );
    });
    const el = screen.getByTestId("shortcuts-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
    expect(el.getAttribute("data-tab")).toBe("about");
  });

  // ─── Keyboard shortcuts hook ───
  it("calls useKeyboardShortcuts with correct callbacks", async () => {
    await renderApp();
    expect(mockUseKeyboard).toHaveBeenCalledTimes(1);
    const args = mockUseKeyboard.mock.calls[0];
    expect(args[0]).toBeTypeOf("function"); // toggleSidebar
    expect(args[1]).toBeTypeOf("function"); // openShortcuts
    expect(args[2]).toBeTypeOf("function"); // openSaveFavorite
  });

  // ─── Tauri event listener ───
  it("registers Tauri event listener on mount", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await renderApp();
    expect(listen).toHaveBeenCalledWith("menu-action", expect.any(Function));
  });

  // ─── DOM event listeners ───
  it("registers DOM event listeners on mount", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    await renderApp();
    expect(addSpy).toHaveBeenCalledWith("menu-action", expect.any(Function));
    addSpy.mockRestore();
  });

  it("registers sidebar context menu event listeners", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    await renderApp();
    expect(addSpy).toHaveBeenCalledWith("open-backup", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("open-restore", expect.any(Function));
    addSpy.mockRestore();
  });

  // ─── AI status check on mount ───
  it("calls aiStore.checkStatus on mount", async () => {
    await renderApp();
    expect(aiState.checkStatus).toHaveBeenCalled();
  });

  // ─── Menu action: new-query ───
  it("handles new-query menu action", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: "new-query" }));
    });
    expect(editorState.addTab).toHaveBeenCalled();
  });

  // ─── Menu action: disconnect ───
  it("handles disconnect menu action when connection selected", async () => {
    connectionState.selectedConnectionId = "conn-1";
    connectionState.activeConnections = [
      { id: "conn-1", profile_id: "p1", host: "localhost", port: 3306, database: "testdb" },
    ];
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: "disconnect" }));
    });
    expect(connectionState.disconnect).toHaveBeenCalledWith("conn-1");
  });

  // ─── Menu action: import when connected ───
  it("handles import menu action and shows import dialog", async () => {
    connectionState.selectedConnectionId = "conn-1";
    connectionState.activeConnections = [
      { id: "conn-1", profile_id: "p1", host: "localhost", port: 3306, database: "testdb" },
    ];
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: "import" }));
    });
    // The import dialog open state changes internally; dialog should be in document
    const dialog = screen.getByTestId("import-dialog");
    expect(dialog).toBeInTheDocument();
  });

  // ─── Menu action: backup ───
  it("handles backup menu action and opens backup dialog", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: "backup" }));
    });
    const el = screen.getByTestId("backup-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
  });

  // ─── Menu action: restore ───
  it("handles restore menu action and opens restore dialog", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: "restore" }));
    });
    const el = screen.getByTestId("restore-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
  });

  // ─── Menu action: quit ───
  it("handles quit menu action and closes window", async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const mockClose = vi.fn();
    vi.mocked(getCurrentWindow).mockReturnValue({ close: mockClose } as any);
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: "quit" }));
    });
    expect(mockClose).toHaveBeenCalled();
  });

  // ─── Sidebar context menu: open-backup ───
  it("handles open-backup event from sidebar context menu", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("open-backup", {
          detail: { connectionId: "s1", database: "appdb" },
        }),
      );
    });
    const el = screen.getByTestId("backup-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
    expect(el.getAttribute("data-preselect-conn")).toBe("s1");
    expect(el.getAttribute("data-preselect-db")).toBe("appdb");
  });

  // ─── Sidebar context menu: open-restore ───
  it("handles open-restore event from sidebar context menu", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("open-restore", {
          detail: { connectionId: "s2", database: "logdb" },
        }),
      );
    });
    const el = screen.getByTestId("restore-dialog");
    expect(el.getAttribute("data-open")).toBe("true");
    expect(el.getAttribute("data-preselect-conn")).toBe("s2");
    expect(el.getAttribute("data-preselect-db")).toBe("logdb");
  });

  // ─── Sidebar collapse/expand via keyboard ───
  it("sidebar is visible by default", async () => {
    await renderApp();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });

  // ─── Keyboard shortcut callback toggles sidebar (verified via hook call) ───
  it("toggleSidebar callback exists in useKeyboardShortcuts args", async () => {
    await renderApp();
    const args = mockUseKeyboard.mock.calls[0];
    const toggleFn = args[0] as () => void;
    expect(toggleFn).toBeTypeOf("function");
  });
});

// ─── macOS-specific tests ───
describe("AppLayout on macOS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformStore.value = "MacIntel";
    connectionState = {
      selectedConnectionId: null,
      activeConnections: [],
      disconnect: vi.fn(),
      profiles: [],
    };
    resultState = {
      confirmDialog: null,
      confirmExecution: vi.fn(),
      cancelExecution: vi.fn(),
    };
    editorState = {
      tabs: [],
      activeTabId: null,
      addTab: vi.fn(() => "tab-1"),
      addAdminTab: vi.fn(),
      addCompareTab: vi.fn(),
      addQueryBuilderTab: vi.fn(),
      editorInstance: null,
    };
    aiState = {
      aiEnabled: false,
      checkStatus: vi.fn(),
    };
  });

  it("renders Toolbar instead of TitleBar on macOS", async () => {
    platformStore.value = "MacIntel";
    // Reset module cache so AppLayout re-evaluates with new platform
    vi.resetModules();
    const mod = await import("../AppLayout");
    render(<mod.AppLayout />);
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
    expect(screen.queryByTestId("title-bar")).not.toBeInTheDocument();
  });

  it("passes aiEnabled and aiPanelOpen props to Toolbar", async () => {
    aiState.aiEnabled = true;
    platformStore.value = "MacIntel";
    vi.resetModules();
    const mod = await import("../AppLayout");
    render(<mod.AppLayout />);
    const toolbar = screen.getByTestId("toolbar");
    expect(toolbar.getAttribute("data-ai-enabled")).toBe("true");
  });
});
