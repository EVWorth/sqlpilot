import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      return Promise.resolve(() => {
        onResizedCallback = null;
      });
    }),
    isMaximized: mockIsMaximized,
  })),
}));

vi.mock("../../../lib/tauri-api", () => ({ api: {} }));

vi.mock("clsx", () => ({
  clsx: (...args: (string | boolean | undefined | null)[]) => args.filter(Boolean).join(" "),
}));

const mockAddAdminTab = vi.fn();
const mockAddCompareTab = vi.fn();

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        addAdminTab: mockAddAdminTab,
        addCompareTab: mockAddCompareTab,
      })),
    },
  ),
}));

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: vi.fn(() => ({ aiEnabled: false })),
}));

vi.mock("../MenuBar", () => ({
  MenuBar: () => <div data-testid="menu-bar">MenuBar</div>,
}));

let _connState = {
  selectedConnectionId: null as string | null,
  activeConnections: [] as any[],
};

let _themeState: any = { theme: "dark", effectiveTheme: "dark" };
const mockSetTheme = vi.fn();

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector: (s: any) => any) => selector(_connState)),
    { getState: vi.fn(() => _connState) },
  ),
}));

vi.mock("../../../stores/themeStore", () => ({
  useThemeStore: Object.assign(
    vi.fn((selector: (s: any) => any) => selector({ ..._themeState, setTheme: mockSetTheme })),
    {
      getState: vi.fn(() => _themeState),
      setState: vi.fn((partial: any) => {
        Object.assign(_themeState, partial);
      }),
    },
  ),
}));

import { TitleBar } from "../TitleBar";

describe("TitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onResizedCallback = null;
    _connState = {
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
    _themeState = { theme: "dark", effectiveTheme: "dark" };
    mockSetTheme.mockClear();
  });

  it("renders the MenuBar", () => {
    render(<TitleBar />);
    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
  });

  it("renders the minimize, maximize, and close buttons", () => {
    render(<TitleBar />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it("renders toolbar buttons (Compare, Admin, etc.)", () => {
    render(<TitleBar />);
    expect(screen.getByText("Compare")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("renders Import, Backup, Restore buttons", () => {
    render(
      <TitleBar
        onShowImport={vi.fn()}
        onShowBackup={vi.fn()}
        onShowRestore={vi.fn()}
      />,
    );
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.getByText("Restore")).toBeInTheDocument();
  });

  it("calls minimize on window button click", () => {
    render(<TitleBar />);
    const minimizeBtn = screen.getByTitle("Minimize");
    fireEvent.click(minimizeBtn);
    expect(mockMinimize).toHaveBeenCalledTimes(1);
  });

  it("calls toggleMaximize on window button click", () => {
    render(<TitleBar />);
    const maximizeBtn = screen.getByTitle("Maximize");
    fireEvent.click(maximizeBtn);
    expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("calls close on window button click", () => {
    render(<TitleBar />);
    const closeBtn = screen.getByTitle("Close");
    fireEvent.click(closeBtn);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("calls startDragging on icon mousedown", () => {
    const { container } = render(<TitleBar />);
    const img = container.querySelector("img[alt='SQLPilot']")!;
    fireEvent.mouseDown(img, { button: 0 });
    expect(mockStartDragging).toHaveBeenCalledTimes(1);
  });

  it("renders AI button when aiEnabled is true", () => {
    render(<TitleBar aiEnabled={true} onToggleAI={vi.fn()} />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("does not render AI button when aiEnabled is false", () => {
    render(<TitleBar aiEnabled={false} />);
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("highlights AI button when aiPanelOpen is true", () => {
    render(<TitleBar aiEnabled={true} aiPanelOpen={true} onToggleAI={vi.fn()} />);
    const aiBtn = screen.getByText("AI").closest("button")!;
    expect(aiBtn.className).toContain("bg-brand-600/20");
  });

  it("cycles theme when theme button is clicked", () => {
    render(<TitleBar />);
    const themeBtn = screen.getByTitle(/Theme:/);
    fireEvent.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("shows system context menu on right click", () => {
    const { container } = render(<TitleBar />);
    const titleBarDiv = container.firstElementChild!;
    fireEvent.contextMenu(titleBarDiv);
    expect(screen.getByText("Close")).toBeInTheDocument();
    expect(screen.getByText("Minimize")).toBeInTheDocument();
  });

  it("closes system menu on Escape", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Close")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Close")).toBeNull();
  });

  it("closes system menu on outside mousedown", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByText("Close")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Close")).toBeNull();
  });

  it("disables toolbar buttons when no connection is selected", () => {
    _connState.selectedConnectionId = null;
    _connState.activeConnections = [];

    render(<TitleBar />);

    expect(screen.getByText("Admin").closest("button")).toBeDisabled();
    expect(screen.getByText("Import").closest("button")).toBeDisabled();
    expect(screen.getByText("Backup").closest("button")).toBeDisabled();
    expect(screen.getByText("Restore").closest("button")).toBeDisabled();
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

  it("calls onToggleAI when AI button is clicked", () => {
    const onToggleAI = vi.fn();
    render(<TitleBar aiEnabled={true} onToggleAI={onToggleAI} />);
    fireEvent.click(screen.getByText("AI"));
    expect(onToggleAI).toHaveBeenCalled();
  });

  it("system menu callbacks fire correct window actions", () => {
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Minimize"));
    expect(mockMinimize).toHaveBeenCalled();
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Close"));
    expect(mockClose).toHaveBeenCalled();
  });
});
