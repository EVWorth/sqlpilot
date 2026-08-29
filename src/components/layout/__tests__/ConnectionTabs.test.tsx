import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionTabs } from "../ConnectionTabs";

const mockLoadProfiles = vi.fn();

/** Overridden per test to render tabs for specific profiles. */
let storeState: Record<string, unknown> = {};

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn((s: (v: unknown) => unknown) =>
    s({
      profiles: [],
      activeConnections: [],
      ...storeState,
      selectedConnectionId: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      deleteProfile: vi.fn(),
      setSelectedConnection: vi.fn(),
      loadProfiles: mockLoadProfiles,
    })
  ),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(() => ({ tabs: [], activeTabId: null, addTab: vi.fn(), setTabConnection: vi.fn() })),
  },
}));

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu: vi.fn() })),
}));

vi.mock("../../connection/ConnectionDialog", () => ({
  ConnectionDialog: vi.fn(() => <div data-testid="connection-dialog">ConnectionDialog</div>),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {};
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

describe("read-only connections (#277)", () => {
  const conn = { id: "c1", profile_id: "p1", name: "prod", database: "app" };

  it("marks a read-only connection in its tab", () => {
    // The executor refuses writes on a read-only connection, but a guard the
    // user cannot see is one they only meet after running something.
    storeState = {
      profiles: [{ id: "p1", name: "prod", host: "db", read_only: true }],
      activeConnections: [conn],
    };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Read-only connection")).toBeDefined();
  });

  it("leaves a writable connection unmarked", () => {
    storeState = {
      profiles: [{ id: "p1", name: "prod", host: "db", read_only: false }],
      activeConnections: [conn],
    };
    render(<ConnectionTabs />);
    expect(screen.queryByLabelText("Read-only connection")).toBeNull();
  });
});
