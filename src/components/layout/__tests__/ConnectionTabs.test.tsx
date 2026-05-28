import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionTabs } from "../ConnectionTabs";

const mockLoadProfiles = vi.fn();

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn((s: (v: unknown) => unknown) =>
    s({
      profiles: [],
      activeConnections: [],
      selectedConnectionId: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      deleteProfile: vi.fn(),
      setSelectedConnection: vi.fn(),
      loadProfiles: mockLoadProfiles,
    }),
  ),
}));

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: { getState: vi.fn(() => ({ tabs: [], activeTabId: null, addTab: vi.fn(), setTabConnection: vi.fn() })) },
}));

vi.mock("../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu: vi.fn() })),
}));

vi.mock("../../connection/ConnectionDialog", () => ({
  ConnectionDialog: vi.fn(() => <div data-testid="connection-dialog">ConnectionDialog</div>),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadProfiles.mockResolvedValue(undefined);
});

describe("ConnectionTabs", () => {
  it("renders the tab bar container", () => {
    const { container } = render(<ConnectionTabs />);
    expect(container.firstElementChild).toHaveClass("flex", "h-9");
  });

  it("renders the add/connect button", () => {
    render(<ConnectionTabs />);
    expect(screen.getByTitle("Connect to a server")).toBeInTheDocument();
  });

  it("shows new connection popover when add button clicked", () => {
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByTitle("Connect to a server"));
    expect(screen.getByText("New Connection…")).toBeInTheDocument();
  });

  it("renders ConnectionDialog component", () => {
    render(<ConnectionTabs />);
    expect(screen.getByTestId("connection-dialog")).toBeInTheDocument();
  });
});
