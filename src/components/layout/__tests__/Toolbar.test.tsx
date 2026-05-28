import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockAddAdminTab = vi.fn();
const mockAddCompareTab = vi.fn();
const mockAddQueryBuilderTab = vi.fn();

vi.mock("../../../stores/editorStore", () => ({
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

vi.mock("../../../lib/tauri-api", () => ({ api: {} }));

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

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: vi.fn(() => ({ aiEnabled: false })),
}));

import { Toolbar } from "../Toolbar";

describe("Toolbar", () => {
  const mockOnShowImport = vi.fn();
  const mockOnShowBackup = vi.fn();
  const mockOnShowRestore = vi.fn();
  const mockOnToggleAI = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("renders Visual Builder button", () => {
    render(<Toolbar />);
    expect(screen.getByText("Visual Builder")).toBeInTheDocument();
  });

  it("renders Compare button", () => {
    render(<Toolbar />);
    expect(screen.getByText("Compare")).toBeInTheDocument();
  });

  it("renders Admin button", () => {
    render(<Toolbar />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("renders Import button", () => {
    render(<Toolbar onShowImport={mockOnShowImport} />);
    expect(screen.getByText("Import")).toBeInTheDocument();
  });

  it("renders Backup button", () => {
    render(<Toolbar onShowBackup={mockOnShowBackup} />);
    expect(screen.getByText("Backup")).toBeInTheDocument();
  });

  it("renders Restore button", () => {
    render(<Toolbar onShowRestore={mockOnShowRestore} />);
    expect(screen.getByText("Restore")).toBeInTheDocument();
  });

  it("calls onShowImport when Import is clicked", () => {
    render(<Toolbar onShowImport={mockOnShowImport} />);
    fireEvent.click(screen.getByText("Import"));
    expect(mockOnShowImport).toHaveBeenCalledTimes(1);
  });

  it("calls onShowBackup when Backup is clicked", () => {
    render(<Toolbar onShowBackup={mockOnShowBackup} />);
    fireEvent.click(screen.getByText("Backup"));
    expect(mockOnShowBackup).toHaveBeenCalledTimes(1);
  });

  it("calls onShowRestore when Restore is clicked", () => {
    render(<Toolbar onShowRestore={mockOnShowRestore} />);
    fireEvent.click(screen.getByText("Restore"));
    expect(mockOnShowRestore).toHaveBeenCalledTimes(1);
  });

  it("renders AI button when aiEnabled is true", () => {
    render(<Toolbar aiEnabled={true} onToggleAI={mockOnToggleAI} />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("does not render AI button when aiEnabled is false", () => {
    render(<Toolbar aiEnabled={false} onToggleAI={mockOnToggleAI} />);
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("highlights AI button when aiPanelOpen is true", () => {
    render(<Toolbar aiEnabled={true} aiPanelOpen={true} onToggleAI={mockOnToggleAI} />);

    const aiBtn = screen.getByText("AI").closest("button")!;
    expect(aiBtn.className).toContain("bg-brand-600/20");
  });

  it("calls onToggleAI when AI button is clicked", () => {
    render(<Toolbar aiEnabled={true} onToggleAI={mockOnToggleAI} />);
    fireEvent.click(screen.getByText("AI"));
    expect(mockOnToggleAI).toHaveBeenCalledTimes(1);
  });

  it("cycles theme from dark to light", () => {
    render(<Toolbar />);
    const themeBtn = screen.getByTitle(/Theme:/);
    fireEvent.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("cycles theme from light to system", () => {
    _themeState = { theme: "light", effectiveTheme: "light" };
    render(<Toolbar />);
    const themeBtn = screen.getByTitle(/Theme:/);
    fireEvent.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("system");
  });

  it("cycles theme from system to dark", () => {
    _themeState = { theme: "system", effectiveTheme: "system" };
    render(<Toolbar />);
    const themeBtn = screen.getByTitle(/Theme:/);
    fireEvent.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("calls addAdminTab when Admin is clicked", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByText("Admin"));
    expect(mockAddAdminTab).toHaveBeenCalledWith("conn-1");
  });

  it("calls addCompareTab when Compare is clicked", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByText("Compare"));
    expect(mockAddCompareTab).toHaveBeenCalled();
  });

  it("calls addQueryBuilderTab when Visual Builder is clicked", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByText("Visual Builder"));
    expect(mockAddQueryBuilderTab).toHaveBeenCalledWith("conn-1", "testdb");
  });

  it("disables buttons that require connection when no connection is selected", () => {
    _connState.selectedConnectionId = null;
    _connState.activeConnections = [];

    render(<Toolbar />);

    expect(screen.getByText("Visual Builder").closest("button")).toBeDisabled();
    expect(screen.getByText("Admin").closest("button")).toBeDisabled();
    expect(screen.getByText("Import").closest("button")).toBeDisabled();
    expect(screen.getByText("Backup").closest("button")).toBeDisabled();
    expect(screen.getByText("Restore").closest("button")).toBeDisabled();
  });

  it("Compare button is always enabled (no connection required)", () => {
    _connState.selectedConnectionId = null;
    _connState.activeConnections = [];

    render(<Toolbar />);
    const compareBtn = screen.getByText("Compare").closest("button");
    expect(compareBtn).not.toBeDisabled();
  });

  it("does not highlight AI button when panel is closed", () => {
    render(<Toolbar aiEnabled={true} aiPanelOpen={false} onToggleAI={mockOnToggleAI} />);
    const aiBtn = screen.getByText("AI").closest("button")!;
    expect(aiBtn.className).not.toContain("bg-brand-600/20");
  });
});
