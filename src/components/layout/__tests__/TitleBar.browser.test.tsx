import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockToggleMaximize,
  mockMinimize,
  mockMaximize,
  mockUnmaximize,
  mockClose,
  mockStartDragging,
  mockIsMaximized,
} = vi.hoisted(() => ({
  mockToggleMaximize: vi.fn(),
  mockMinimize: vi.fn(),
  mockMaximize: vi.fn(),
  mockUnmaximize: vi.fn(),
  mockClose: vi.fn(),
  mockStartDragging: vi.fn(),
  mockIsMaximized: vi.fn().mockResolvedValue(false),
}));

let onResizedCallback: (() => void) | null = null;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    toggleMaximize: mockToggleMaximize,
    minimize: mockMinimize,
    maximize: mockMaximize,
    unmaximize: mockUnmaximize,
    close: mockClose,
    startDragging: mockStartDragging,
    onResized: vi.fn((cb: () => void) => {
      onResizedCallback = cb;
      return Promise.resolve(() => { onResizedCallback = null; });
    }),
    isMaximized: mockIsMaximized,
    setTitle: vi.fn(),
  })),
}));

vi.mock("clsx", () => ({
  clsx: (...args: (string | boolean | undefined | null)[]) => args.filter(Boolean).join(" "),
}));

const mockAddAdminTab = vi.fn();
const mockAddCompareTab = vi.fn();
const mockAddQueryBuilderTab = vi.fn();

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        addAdminTab: mockAddAdminTab,
        addCompareTab: mockAddCompareTab,
        addQueryBuilderTab: mockAddQueryBuilderTab,
      })),
    },
  ),
}));

vi.mock("../MenuBar", () => ({
  MenuBar: () => <div data-testid="menu-bar">MenuBar</div>,
}));

let connState = {
  selectedConnectionId: null as string | null,
  activeConnections: [] as { id: string; name: string; host: string; port: number; database?: string; server_version: string; connected_at: string }[],
};

let themeState: { theme: "dark" | "light" | "system"; effectiveTheme: "dark" | "light" } = {
  theme: "dark",
  effectiveTheme: "dark",
};
const mockSetTheme = vi.fn();

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector: (s: typeof connState) => unknown) => selector(connState)),
    { getState: vi.fn(() => connState) },
  ),
}));

vi.mock("../../stores/themeStore", () => ({
  useThemeStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector({ ...themeState, setTheme: mockSetTheme })),
    {
      getState: vi.fn(() => themeState),
      setState: vi.fn((partial: Record<string, unknown>) => {
        Object.assign(themeState, partial);
      }),
    },
  ),
}));

import { TitleBar } from "../TitleBar";

beforeEach(() => {
  vi.clearAllMocks();
  onResizedCallback = null;
  mockIsMaximized.mockResolvedValue(false);
  connState = {
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
  };
  themeState = { theme: "dark", effectiveTheme: "dark" };
  mockSetTheme.mockClear();
  mockAddAdminTab.mockClear();
  mockAddCompareTab.mockClear();
  mockAddQueryBuilderTab.mockClear();
});

describe("TitleBar", () => {
  it("renders the MenuBar", () => {
    render(<TitleBar />);
    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
  });

  it("renders app icon as drag handle", () => {
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

  it("renders all toolbar buttons", () => {
    render(<TitleBar aiEnabled={true} onToggleAI={vi.fn()} />);
    expect(screen.getByText("Visual Builder")).toBeInTheDocument();
    expect(screen.getByText("Compare")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.getByText("Restore")).toBeInTheDocument();
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("renders window control buttons: minimize, maximize, close", () => {
    render(<TitleBar />);
    expect(screen.getByTitle("Minimize")).toBeInTheDocument();
    expect(screen.getByTitle("Maximize")).toBeInTheDocument();
    expect(screen.getByTitle("Close")).toBeInTheDocument();
  });

  it("calls minimize on window button click", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByTitle("Minimize"));
    expect(mockMinimize).toHaveBeenCalledTimes(1);
  });

  it("calls toggleMaximize on maximize button click", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByTitle("Maximize"));
    expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("calls close on close button click", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByTitle("Close"));
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("shows RestoreIcon and Restore title when window is maximized", async () => {
    mockIsMaximized.mockResolvedValue(true);
    render(<TitleBar />);
    await waitFor(() => {
      expect(screen.getByTitle("Restore")).toBeInTheDocument();
    });
    expect(screen.queryByTitle("Maximize")).not.toBeInTheDocument();
  });

  it("calls toggleMaximize on Restore button click when maximized", async () => {
    mockIsMaximized.mockResolvedValue(true);
    render(<TitleBar />);
    await waitFor(() => {
      expect(screen.getByTitle("Restore")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle("Restore"));
    expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("detects maximized state via onResized callback", async () => {
    mockIsMaximized.mockResolvedValue(true);
    render(<TitleBar />);

    // Trigger onResized callback
    if (onResizedCallback) onResizedCallback();

    await waitFor(() => {
      expect(mockIsMaximized).toHaveBeenCalled();
    });
  });

  it("shows system context menu on right-click title bar", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Restore")).toBeInTheDocument();
    expect(screen.getByText("Move")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("Minimize")).toBeInTheDocument();
    expect(screen.getByText("Maximize")).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();
    expect(screen.getByText("Alt+F4")).toBeInTheDocument();
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
    const compareBtn = screen.getByText("Compare");
    fireEvent.contextMenu(compareBtn);
    // The context menu should NOT appear because propagation is stopped
    expect(screen.queryByText("Alt+F4")).not.toBeInTheDocument();
  });

  it("system menu does NOT open when right-clicking window controls", () => {
    render(<TitleBar />);
    const minimizeBtn = screen.getByTitle("Minimize");
    fireEvent.contextMenu(minimizeBtn);
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
    mockIsMaximized.mockResolvedValue(false);
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Maximize"));
    expect(mockMaximize).toHaveBeenCalled();
  });

  it("system menu Maximize is disabled when already maximized", () => {
    mockIsMaximized.mockResolvedValue(true);
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    const maximizeBtn = screen.getByText("Maximize");
    expect(maximizeBtn.closest("button")).toBeDisabled();
  });

  it("system menu Restore action calls appWindow.unmaximize when maximized", () => {
    mockIsMaximized.mockResolvedValue(true);
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Restore"));
    expect(mockUnmaximize).toHaveBeenCalled();
  });

  it("system menu Restore is disabled when not maximized", () => {
    mockIsMaximized.mockResolvedValue(false);
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    const restoreBtn = screen.getByText("Restore");
    expect(restoreBtn.closest("button")).toBeDisabled();
  });

  it("system menu Move and Size are always disabled", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Move").closest("button")).toBeDisabled();
    expect(screen.getByText("Size").closest("button")).toBeDisabled();
  });

  it("cycles theme from dark to light", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    const themeBtn = screen.getByTitle(/Theme:/);
    await user.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("cycles theme from light to system", async () => {
    themeState = { theme: "light", effectiveTheme: "light" };
    const user = userEvent.setup();
    render(<TitleBar />);
    const themeBtn = screen.getByTitle(/Theme: Light/);
    await user.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("system");
  });

  it("cycles theme from system to dark", async () => {
    themeState = { theme: "system", effectiveTheme: "dark" };
    const user = userEvent.setup();
    render(<TitleBar />);
    const themeBtn = screen.getByTitle(/Theme: System/);
    await user.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("disables connection-dependent buttons when no connection selected", () => {
    connState.selectedConnectionId = null;
    connState.activeConnections = [];
    render(<TitleBar />);

    expect(screen.getByText("Visual Builder").closest("button")).toBeDisabled();
    expect(screen.getByText("Admin").closest("button")).toBeDisabled();
    expect(screen.getByText("Import").closest("button")).toBeDisabled();
    expect(screen.getByText("Backup").closest("button")).toBeDisabled();
    expect(screen.getByText("Restore").closest("button")).toBeDisabled();
  });

  it("Compare button is always enabled (no connection required)", () => {
    connState.selectedConnectionId = null;
    connState.activeConnections = [];
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

  it("does not call addAdminTab when Admin clicked with no connection", () => {
    connState.selectedConnectionId = null;
    connState.activeConnections = [];
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Admin"));
    expect(mockAddAdminTab).not.toHaveBeenCalled();
  });

  it("calls addQueryBuilderTab when Visual Builder is clicked", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByText("Visual Builder"));
    expect(mockAddQueryBuilderTab).toHaveBeenCalledWith("conn-1", "testdb");
  });

  it("does not call addQueryBuilderTab when no connection selected", () => {
    connState.selectedConnectionId = null;
    connState.activeConnections = [];
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

  it("calls onToggleAI when AI button is clicked", async () => {
    const user = userEvent.setup();
    const onToggleAI = vi.fn();
    render(<TitleBar aiEnabled={true} onToggleAI={onToggleAI} />);
    await user.click(screen.getByText("AI"));
    expect(onToggleAI).toHaveBeenCalled();
  });

  it("spacer drag starts dragging on left mouse button", () => {
    const { container } = render(<TitleBar />);
    // The spacer div has flex-1 class
    const spacer = container.querySelector(".flex-1.h-full.cursor-default")!;
    fireEvent.mouseDown(spacer, { button: 0 });
    expect(mockStartDragging).toHaveBeenCalled();
  });

  it("spacer double-click toggles maximize", async () => {
    const { container } = render(<TitleBar />);
    const spacer = container.querySelector(".flex-1.h-full.cursor-default")!;
    fireEvent.mouseDown(spacer, { button: 0 });
    // Second click within 400ms triggers toggleMaximize
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

  it("window controls container has correct structure", () => {
    const { container } = render(<TitleBar />);
    const winControls = container.querySelector(".flex.h-full")!;
    expect(winControls).toBeInTheDocument();
  });

  it("close button has red hover styling", () => {
    const { container } = render(<TitleBar />);
    const closeBtn = screen.getByTitle("Close");
    expect(closeBtn.className).toContain("hover:bg-red-600");
  });

  it("renders theme button with icon", () => {
    render(<TitleBar />);
    const themeBtn = screen.getByTitle(/Theme:/);
    expect(themeBtn).toBeInTheDocument();
  });

  it("connection-dependent button styling changes when disabled", () => {
    connState.selectedConnectionId = null;
    render(<TitleBar />);
    const importBtn = screen.getByText("Import").closest("button")!;
    expect(importBtn.className).toContain("opacity-40");
    expect(importBtn.className).toContain("cursor-not-allowed");
  });
});
