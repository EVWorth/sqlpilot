import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const {
  mockToggleMaximize,
  mockMinimize,
  mockMaximize,
  mockUnmaximize,
  mockClose,
  mockStartDragging,
} = vi.hoisted(() => ({
  mockToggleMaximize: vi.fn(),
  mockMinimize: vi.fn(),
  mockMaximize: vi.fn(),
  mockUnmaximize: vi.fn(),
  mockClose: vi.fn(),
  mockStartDragging: vi.fn(),
}));

let onResizedCb: (() => void) | null = null;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    toggleMaximize: mockToggleMaximize,
    minimize: mockMinimize,
    maximize: mockMaximize,
    unmaximize: mockUnmaximize,
    close: mockClose,
    startDragging: mockStartDragging,
    onResized: vi.fn((cb: () => void) => {
      onResizedCb = cb;
      return Promise.resolve(() => { onResizedCb = null; });
    }),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    setTitle: vi.fn(),
  })),
}));

vi.mock("clsx", () => ({
  clsx: (...args: (string | boolean | undefined | null)[]) => args.filter(Boolean).join(" "),
}));

vi.mock("../MenuBar", () => ({
  MenuBar: () => <div data-testid="menu-bar">MenuBar</div>,
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: vi.fn(),
}));
vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));
vi.mock("../../../stores/themeStore", () => ({
  useThemeStore: vi.fn(),
}));

import { TitleBar } from "../TitleBar";
import { useEditorStore } from "../../../stores/editorStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useThemeStore } from "../../../stores/themeStore";

const mockAddAdminTab = vi.fn();
const mockAddCompareTab = vi.fn();
const mockAddQueryBuilderTab = vi.fn();

function mockEditorStore() {
  const getStateMock = vi.fn(() => ({
    addAdminTab: mockAddAdminTab,
    addCompareTab: mockAddCompareTab,
    addQueryBuilderTab: mockAddQueryBuilderTab,
  }));
  (useEditorStore as any).getState = getStateMock;
  vi.mocked(useEditorStore).mockReturnValue({} as any);
}

function mockConnectionStore(connState: {
  selectedConnectionId: string | null;
  activeConnections: { id: string; name: string; host: string; port: number; database?: string; server_version: string; connected_at: string }[];
}) {
  vi.mocked(useConnectionStore).mockImplementation((s: (v: unknown) => unknown) => s(connState));
  (useConnectionStore as any).getState = vi.fn(() => connState);
}

type ThemeMode = "dark" | "light" | "system";

function mockThemeStore(theme: ThemeMode) {
  const setThemeMock = vi.fn();
  const state = theme === "system" ? { theme: "system" as const, effectiveTheme: "dark" as const } : { theme, effectiveTheme: theme as "dark" | "light" };
  vi.mocked(useThemeStore).mockImplementation((s: (v: unknown) => unknown) =>
    s({
      ...state,
      setTheme: setThemeMock,
    })
  );
  (useThemeStore as any).getState = vi.fn(() => ({ ...state }));
  return setThemeMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  onResizedCb = null;
  mockEditorStore();
  mockConnectionStore({
    selectedConnectionId: "conn-1",
    activeConnections: [
      {
        id: "conn-1",
        name: "Test DB",
        host: "localhost",
        port: 3306,
        database: "testdb",
        server_version: "8.0.33",
        connected_at: "2024-01-01T00:00:00Z",
      },
    ],
  });
  mockThemeStore("dark");
});

describe("TitleBar", () => {
  it("renders the MenuBar", () => {
    render(<TitleBar />);
    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
  });

  it("renders app icon", () => {
    const { container } = render(<TitleBar />);
    const img = container.querySelector("img[alt='SQLPilot']");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/icon.svg");
  });

  it("starts drag on icon mousedown", () => {
    const { container } = render(<TitleBar />);
    const img = container.querySelector("img[alt='SQLPilot']")!;
    fireEvent.mouseDown(img, { button: 0 });
    expect(mockStartDragging).toHaveBeenCalledTimes(1);
  });

  it("renders all toolbar buttons when connected", () => {
    render(<TitleBar aiEnabled={true} onToggleAI={vi.fn()} />);
    expect(screen.getByText("Visual Builder")).toBeInTheDocument();
    expect(screen.getByText("Compare")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.getByText("Restore")).toBeInTheDocument();
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("renders window control buttons", () => {
    render(<TitleBar />);
    expect(screen.getByTitle("Minimize")).toBeInTheDocument();
    expect(screen.getByTitle("Maximize")).toBeInTheDocument();
    expect(screen.getByTitle("Close")).toBeInTheDocument();
  });

  it("calls minimize on window button click", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle("Minimize"));
    expect(mockMinimize).toHaveBeenCalledTimes(1);
  });

  it("calls toggleMaximize on maximize button click", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle("Maximize"));
    expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("calls close on close button click", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle("Close"));
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("shows system context menu on right-click", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Minimize")).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();
    expect(screen.getByText("Alt+F4")).toBeInTheDocument();
  });

  it("system context menu shows all items", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getAllByText("Restore").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Move")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("Maximize")).toBeInTheDocument();
  });

  it("closes system menu on Escape key", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Close")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  it("closes system menu on click outside", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Close")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  it("system menu does NOT open when right-clicking toolbar buttons", () => {
    render(<TitleBar />);
    fireEvent.contextMenu(screen.getByText("Compare"));
    expect(screen.queryByText("Alt+F4")).not.toBeInTheDocument();
  });

  it("system menu does NOT open when right-clicking window controls", () => {
    render(<TitleBar />);
    fireEvent.contextMenu(screen.getByTitle("Minimize"));
    expect(screen.queryByText("Alt+F4")).not.toBeInTheDocument();
  });

  it("system menu Minimize action calls appWindow.minimize", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Minimize"));
    expect(mockMinimize).toHaveBeenCalled();
  });

  it("system menu Close action calls appWindow.close", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Close"));
    expect(mockClose).toHaveBeenCalled();
  });

  it("system menu Maximize action calls appWindow.maximize when not maximized", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Maximize"));
    expect(mockMaximize).toHaveBeenCalled();
  });

  it("system menu Move and Size are always disabled", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Move").closest("button")).toBeDisabled();
    expect(screen.getByText("Size").closest("button")).toBeDisabled();
  });

  it("cycles theme from dark to light", () => {
    const setThemeMock = mockThemeStore("dark");
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle(/Theme:/));
    expect(setThemeMock).toHaveBeenCalledWith("light");
  });

  it("cycles theme from light to system", () => {
    const setThemeMock = mockThemeStore("light");
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle(/Theme: Light/));
    expect(setThemeMock).toHaveBeenCalledWith("system");
  });

  it("cycles theme from system to dark", () => {
    const setThemeMock = mockThemeStore("system");
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle(/Theme: System/));
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });

  it("disables connection-dependent buttons when no connection", () => {
    mockConnectionStore({ selectedConnectionId: null, activeConnections: [] });
    render(<TitleBar />);
    expect(screen.getByText("Visual Builder").closest("button")).toBeDisabled();
    expect(screen.getByText("Admin").closest("button")).toBeDisabled();
    expect(screen.getByText("Import").closest("button")).toBeDisabled();
    expect(screen.getByText("Backup").closest("button")).toBeDisabled();
    expect(screen.getByText("Restore").closest("button")).toBeDisabled();
  });

  it("Compare button is always enabled", () => {
    mockConnectionStore({ selectedConnectionId: null, activeConnections: [] });
    render(<TitleBar />);
    expect(screen.getByText("Compare").closest("button")).not.toBeDisabled();
  });

  it("calls addCompareTab when Compare button is clicked", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Compare"));
    expect(mockAddCompareTab).toHaveBeenCalled();
  });

  it("calls addAdminTab when Admin button is clicked", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Admin"));
    expect(mockAddAdminTab).toHaveBeenCalledWith("conn-1");
  });

  it("does not call addAdminTab when no connection selected", () => {
    mockConnectionStore({ selectedConnectionId: null, activeConnections: [] });
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Admin"));
    expect(mockAddAdminTab).not.toHaveBeenCalled();
  });

  it("calls addQueryBuilderTab when Visual Builder is clicked", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Visual Builder"));
    expect(mockAddQueryBuilderTab).toHaveBeenCalledWith("conn-1", "testdb");
  });

  it("does not call addQueryBuilderTab when no connection", () => {
    mockConnectionStore({ selectedConnectionId: null, activeConnections: [] });
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Visual Builder"));
    expect(mockAddQueryBuilderTab).not.toHaveBeenCalled();
  });

  it("calls onShowImport when Import button is clicked", () => {
    const onShowImport = vi.fn();
    render(<TitleBar onShowImport={onShowImport} />);
    fireEvent.click(screen.getByText("Import"));
    expect(onShowImport).toHaveBeenCalled();
  });

  it("calls onShowBackup when Backup button is clicked", () => {
    const onShowBackup = vi.fn();
    render(<TitleBar onShowBackup={onShowBackup} />);
    fireEvent.click(screen.getByText("Backup"));
    expect(onShowBackup).toHaveBeenCalled();
  });

  it("calls onShowRestore when Restore button is clicked", () => {
    const onShowRestore = vi.fn();
    render(<TitleBar onShowRestore={onShowRestore} />);
    fireEvent.click(screen.getByText("Restore"));
    expect(onShowRestore).toHaveBeenCalled();
  });

  it("renders AI button when aiEnabled is true", () => {
    render(<TitleBar aiEnabled={true} onToggleAI={vi.fn()} />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("does not render AI button when aiEnabled is false", () => {
    render(<TitleBar aiEnabled={false} />);
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("does not render AI button when aiEnabled is undefined", () => {
    render(<TitleBar />);
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("highlights AI button when aiPanelOpen is true", () => {
    render(<TitleBar aiEnabled={true} aiPanelOpen={true} onToggleAI={vi.fn()} />);
    const aiBtn = screen.getByText("AI").closest("button")!;
    expect(aiBtn.className).toContain("bg-brand-600/20");
  });

  it("does not highlight AI button when aiPanelOpen is false", () => {
    render(<TitleBar aiEnabled={true} aiPanelOpen={false} onToggleAI={vi.fn()} />);
    const aiBtn = screen.getByText("AI").closest("button")!;
    expect(aiBtn.className).not.toContain("bg-brand-600/20");
  });

  it("calls onToggleAI when AI button is clicked", () => {
    const onToggleAI = vi.fn();
    render(<TitleBar aiEnabled={true} onToggleAI={onToggleAI} />);
    fireEvent.click(screen.getByText("AI"));
    expect(onToggleAI).toHaveBeenCalled();
  });

  it("spacer starts dragging on left mousedown", () => {
    const { container } = render(<TitleBar />);
    const spacer = container.querySelector(".flex-1.h-full.cursor-default")!;
    fireEvent.mouseDown(spacer, { button: 0 });
    expect(mockStartDragging).toHaveBeenCalled();
  });

  it("spacer double-click toggles maximize", () => {
    const { container } = render(<TitleBar />);
    const spacer = container.querySelector(".flex-1.h-full.cursor-default")!;
    fireEvent.mouseDown(spacer, { button: 0 });
    fireEvent.mouseDown(spacer, { button: 0 });
    expect(mockToggleMaximize).toHaveBeenCalled();
  });

  it("spacer ignores non-left mouse button", () => {
    const { container } = render(<TitleBar />);
    const spacer = container.querySelector(".flex-1.h-full.cursor-default")!;
    fireEvent.mouseDown(spacer, { button: 2 });
    expect(mockStartDragging).not.toHaveBeenCalled();
    expect(mockToggleMaximize).not.toHaveBeenCalled();
  });

  it("system menu dismisses itself after action", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Close")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  it("close button has red hover styling", () => {
    render(<TitleBar />);
    const closeBtn = screen.getByTitle("Close");
    expect(closeBtn.className).toContain("hover:bg-red-600");
  });

  it("renders theme button with icon", () => {
    render(<TitleBar />);
    expect(screen.getByTitle(/Theme:/)).toBeInTheDocument();
  });

  it("connection-dependent button has disabled styling when no connection", () => {
    mockConnectionStore({ selectedConnectionId: null, activeConnections: [] });
    render(<TitleBar />);
    const importBtn = screen.getByText("Import").closest("button")!;
    expect(importBtn.className).toContain("opacity-40");
    expect(importBtn.className).toContain("cursor-not-allowed");
  });
});
