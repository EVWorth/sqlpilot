import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import { ConnectionTabs } from "../ConnectionTabs";

const mockLoadProfiles = vi.fn();
// Hoisted, because the mock factory below runs before ordinary top-level
// consts are initialised.
const { setStateSpy } = vi.hoisted(() => ({ setStateSpy: vi.fn() }));

/** Overridden per test to render tabs for specific profiles. */
let storeState: Record<string, unknown> = {};

function currentState() {
  return {
    profiles: [],
    activeConnections: [],
    selectedConnectionId: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    deleteProfile: vi.fn(),
    setSelectedConnection: vi.fn(),
    loadProfiles: mockLoadProfiles,
    ...storeState,
  };
}

vi.mock("../../../stores/connectionStore", () => {
  const hook = vi.fn((s: (v: unknown) => unknown) => s(currentState())) as unknown as {
    (s: (v: unknown) => unknown): unknown;
    getState: () => unknown;
    setState: typeof setStateSpy;
  };
  hook.getState = () => currentState();
  hook.setState = setStateSpy;
  return { useConnectionStore: hook };
});

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
  setStateSpy.mockClear();
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

describe("startup reconnect (#276)", () => {
  it("says which servers it could not reconnect to", async () => {
    // The failure used to be an empty catch. The tab looked normal and the
    // first query failed with "Connection not found", which describes neither
    // what happened nor when.
    const connect = vi.fn().mockRejectedValue(new Error("connection refused"));
    storeState = {
      profiles: [{ id: "p1", name: "prod-eu", host: "db" }],
      connect,
    };
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [{ id: "t1", profileId: "p1" }],
      activeTabId: "t1",
      addTab: vi.fn(),
      setTabConnection: vi.fn(),
    } as never);

    render(<ConnectionTabs />);

    await vi.waitFor(() => {
      expect(setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("prod-eu") }),
      );
    });
  });
});
