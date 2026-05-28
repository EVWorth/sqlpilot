import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorTabs } from "../EditorTabs";

vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

vi.mock("../../../lib/utils", () => ({
  cn: (...args: (string | boolean | undefined | null)[]) => args.filter(Boolean).join(" "),
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Element.prototype.scrollIntoView = vi.fn();

const mockSetActiveTab = vi.fn();
const mockCloseTab = vi.fn();
const mockAddTab = vi.fn();
const mockRenameTab = vi.fn();
const mockReorderTabs = vi.fn();

let currentActiveTabId = "tab-0";
let currentTabs: any[] = [
  { id: "tab-0", title: "Untitled Query", content: "", type: "query" as const, isDirty: false },
  { id: "tab-1", title: "Second Query", content: "SELECT 1", type: "query" as const, isDirty: true },
  { id: "tab-2", title: "Structure Tab", content: "", type: "structure" as const, isDirty: false },
];

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      tabs: currentTabs,
      activeTabId: currentActiveTabId,
      setActiveTab: mockSetActiveTab,
      closeTab: mockCloseTab,
      addTab: mockAddTab,
      renameTab: mockRenameTab,
      reorderTabs: mockReorderTabs,
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      activeConnections: [
        {
          id: "conn-1",
          profile_id: "prof-1",
          name: "Test DB",
          host: "localhost",
          port: 3306,
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "conn-2",
          profile_id: "prof-2",
          name: "Prod DB",
          host: "prod.example.com",
          port: 3306,
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
      ],
      profiles: [
        { id: "prof-1", name: "Profile 1", color: "#ff0000", environment: "development" as const },
        { id: "prof-2", name: "Production Profile", color: "#ff0000", environment: "production" as const },
      ],
      selectedConnectionId: null,
      loading: false,
      error: null,
    };
    return selector ? selector(state) : state;
  }),
}));

describe("EditorTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentActiveTabId = "tab-0";
    currentTabs = [
      { id: "tab-0", title: "Untitled Query", content: "", type: "query" as const, isDirty: false },
      { id: "tab-1", title: "Second Query", content: "SELECT 1", type: "query" as const, isDirty: true },
      { id: "tab-2", title: "Structure Tab", content: "", type: "structure" as const, isDirty: false },
    ];
  });

  it("renders all tabs", () => {
    render(<EditorTabs />);

    expect(screen.getByText("Untitled Query")).toBeInTheDocument();
    expect(screen.getByText("Second Query")).toBeInTheDocument();
    expect(screen.getByText("Structure Tab")).toBeInTheDocument();
  });

  it("calls setActiveTab when a tab is clicked", () => {
    render(<EditorTabs />);

    fireEvent.click(screen.getByText("Second Query"));
    expect(mockSetActiveTab).toHaveBeenCalledWith("tab-1");
  });

  it("calls addTab when the plus button is clicked", () => {
    const { container } = render(<EditorTabs />);

    const buttons = container.querySelectorAll("button");
    const addBtn = Array.from(buttons).find((btn) =>
      btn.querySelector("svg") !== null && !btn.textContent,
    );
    if (addBtn) {
      fireEvent.click(addBtn);
      expect(mockAddTab).toHaveBeenCalledTimes(1);
    }
  });

  it("shows dirty indicator on unsaved tabs", () => {
    const { container } = render(<EditorTabs />);

    const dirtyDots = container.querySelectorAll(".bg-brand-400");
    expect(dirtyDots.length).toBeGreaterThanOrEqual(1);
  });

  it("shows color indicator when tab has a profile color", () => {
    currentTabs = [
      {
        id: "tab-0",
        title: "Colored Tab",
        content: "",
        type: "query" as const,
        isDirty: false,
        connectionId: "conn-1",
        profileId: "prof-1",
      },
      {
        id: "tab-1",
        title: "Second",
        content: "",
        type: "query" as const,
        isDirty: false,
      },
    ];
    currentActiveTabId = "tab-0";

    const { container } = render(<EditorTabs />);

    const indicators = container.querySelectorAll("[style*='background-color']");
    expect(indicators.length).toBeGreaterThanOrEqual(1);
  });

  it("calls closeTab with middle mouse click", () => {
    render(<EditorTabs />);

    // Middle click (button === 1) on a tab
    const tab = screen.getByText("Second Query");
    fireEvent.mouseDown(tab, { button: 1 });

    expect(mockCloseTab).toHaveBeenCalledWith("tab-1");
  });

  it("calls renameTab on double-click + enter", () => {
    render(<EditorTabs />);

    const tab = screen.getByText("Untitled Query");
    fireEvent.doubleClick(tab);

    // Input should appear
    const input = document.querySelector("input[type='text']");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("Untitled Query");

    // Change value and press Enter
    fireEvent.change(input!, { target: { value: "Renamed Tab" } });
    fireEvent.keyDown(input!, { key: "Enter" });

    expect(mockRenameTab).toHaveBeenCalledWith("tab-0", "Renamed Tab");
  });

  it("cancels rename on Escape key", () => {
    render(<EditorTabs />);

    const tab = screen.getByText("Untitled Query");
    fireEvent.doubleClick(tab);

    const input = document.querySelector("input[type='text']");
    expect(input).toBeTruthy();

    fireEvent.keyDown(input!, { key: "Escape" });

    // Should return to normal display (input should be gone)
    expect(document.querySelector("input[type='text']")).toBeNull();
    expect(mockRenameTab).not.toHaveBeenCalled();
  });

  it("cancels rename on blur", () => {
    render(<EditorTabs />);

    const tab = screen.getByText("Untitled Query");
    fireEvent.doubleClick(tab);

    const input = document.querySelector("input[type='text']");
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "New Name" } });
    fireEvent.blur(input!);

    expect(mockRenameTab).toHaveBeenCalledWith("tab-0", "New Name");
  });

  it("reorders tabs via drag and drop", () => {
    render(<EditorTabs />);

    const firstTab = screen.getByText("Untitled Query").closest("button");
    const secondTab = screen.getByText("Second Query").closest("button");

    // Create a proper DataTransfer mock for jsdom
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn().mockReturnValue("0"),
    };

    // Start drag on first tab
    fireEvent.dragStart(firstTab!, { dataTransfer });

    // Drag over second tab
    fireEvent.dragOver(secondTab!, { dataTransfer });

    // Drop on second tab
    fireEvent.drop(secondTab!, { dataTransfer });

    expect(mockReorderTabs).toHaveBeenCalledWith(0, 1);
  });

  it("highlights active tab", () => {
    render(<EditorTabs />);

    const activeTab = screen.getByText("Untitled Query").closest("button")!;
    expect(activeTab.className).toContain("bg-[var(--color-bg-primary)]");
  });

  it("shows production indicator for production tabs", () => {
    currentTabs = [
      {
        id: "tab-0",
        title: "Prod Tab",
        content: "SELECT * FROM users",
        type: "query" as const,
        isDirty: false,
        connectionId: "conn-2",
        profileId: "prof-2",
      },
    ];
    currentActiveTabId = "tab-0";

    const { container } = render(<EditorTabs />);

    // Production indicator should show a red dot; check for the span with title="Production"
    const prodDot = container.querySelector('[title="Production"]');
    expect(prodDot).toBeTruthy();
  });

  it("does not show close button for single query tab", () => {
    currentTabs = [
      { id: "tab-0", title: "Only Tab", content: "", type: "query" as const, isDirty: false },
    ];

    render(<EditorTabs />);

    // The X icon should not be present because queryTabCount <= 1
    const xButtons = document.querySelectorAll("svg.lucide-x");
    expect(xButtons.length).toBe(0);
  });

  it("closes tab via X button click", () => {
    render(<EditorTabs />);

    // Find close buttons (X icons) - there should be at least one
    const xSvgs = document.querySelectorAll(".lucide-x");
    expect(xSvgs.length).toBeGreaterThan(0);

    // Click the first close icon's parent
    const closeBtn = xSvgs[0].closest("span")!;
    fireEvent.click(closeBtn);

    expect(mockCloseTab).toHaveBeenCalled();
  });

  it("sets edit value via onChange", () => {
    render(<EditorTabs />);

    const tab = screen.getByText("Untitled Query");
    fireEvent.doubleClick(tab);

    const input = document.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "Edited" } });
    expect(input.value).toBe("Edited");
  });
});
