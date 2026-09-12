import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import { ConnectionTabs } from "../ConnectionTabs";

const mockLoadProfiles = vi.fn();
// Hoisted, because the mock factory below runs before ordinary top-level
// consts are initialised.
const { setStateSpy } = vi.hoisted(() => ({ setStateSpy: vi.fn() }));

/** Overridden per test to render tabs for specific profiles. */
let storeState: Record<string, unknown> = {};
/** What the health checker last said, by connection id. */
let healthState: Record<string, unknown> = {};

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

/** Captures the items a right-click would offer, so they can be invoked. */
const { menuItems, showContextMenu } = vi.hoisted(() => {
  const menuItems: { label?: string; onClick?: () => void; disabled?: boolean }[] = [];
  return {
    menuItems,
    showContextMenu: vi.fn((_e: unknown, items: typeof menuItems) => {
      menuItems.length = 0;
      menuItems.push(...items);
    }),
  };
});

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu })),
}));

vi.mock("../../../stores/connectionHealthStore", () => ({
  useConnectionHealthStore: vi.fn((s: (v: unknown) => unknown) => s({ health: healthState })),
}));

vi.mock("../../connection/ConnectionDialog", () => ({
  ConnectionDialog: vi.fn(({ editProfile, duplicateOf }: {
    editProfile?: { name: string };
    duplicateOf?: { name: string };
  }) => (
    <div
      data-testid="connection-dialog"
      data-editing={editProfile?.name ?? ""}
      data-duplicating={duplicateOf?.name ?? ""}
    >
      ConnectionDialog
    </div>
  )),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {};
  healthState = {};
  menuItems.length = 0;
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

describe("connection state on the tab (FR-1.3.2)", () => {
  const conn = { id: "c1", profile_id: "p1", name: "prod", database: "app" };
  const profiles = [{ id: "p1", name: "prod", host: "db" }];

  it("is green while the server answers", () => {
    storeState = { profiles, activeConnections: [conn] };
    render(<ConnectionTabs />);
    // `className` on an SVG element is an SVGAnimatedString, not a string.
    expect(screen.getByLabelText("Connected").getAttribute("class")).toContain("green");
  });

  it("is red once the health checker says the server has gone", () => {
    // It was green whatever was true, so a dead connection looked live.
    healthState = { c1: { connectionId: "c1", healthy: false, consecutiveFailures: 2 } };
    storeState = { profiles, activeConnections: [conn] };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Disconnected").getAttribute("class")).toContain("red");
  });

  it("is amber while a connect is in flight", () => {
    storeState = { profiles, activeConnections: [conn], loading: true };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Connecting").getAttribute("class")).toContain("amber");
  });

  it("shows a lost connection as lost even while another is connecting", () => {
    healthState = { c1: { connectionId: "c1", healthy: false, consecutiveFailures: 1 } };
    storeState = { profiles, activeConnections: [conn], loading: true };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Disconnected")).toBeInTheDocument();
  });
});

describe("duplicating a profile (FR-1.1.4)", () => {
  const conn = { id: "c1", profile_id: "p1", name: "prod", database: "app" };
  const profiles = [{ id: "p1", name: "prod-eu", host: "db" }];

  const rightClickTab = () => {
    storeState = { profiles, activeConnections: [conn] };
    render(<ConnectionTabs />);
    fireEvent.contextMenu(screen.getByText("prod-eu"));
  };

  it("offers it on the tab menu", () => {
    // A second profile against the same server — another database, a
    // read-only user — was a matter of retyping every field.
    rightClickTab();
    expect(menuItems.map((i) => i.label)).toContain("Duplicate Profile");
  });

  it("opens the dialog as a copy rather than as an edit", () => {
    rightClickTab();
    // Outside an event handler, so React needs telling to flush the state
    // change the menu item makes.
    act(() => menuItems.find((i) => i.label === "Duplicate Profile")!.onClick!());

    const dialog = screen.getByTestId("connection-dialog");
    expect(dialog).toHaveAttribute("data-duplicating", "prod-eu");
    expect(dialog).toHaveAttribute("data-editing", "");
  });

  it("opens an edit as an edit, not as a copy", () => {
    rightClickTab();
    act(() => menuItems.find((i) => i.label === "Edit Connection")!.onClick!());

    const dialog = screen.getByTestId("connection-dialog");
    expect(dialog).toHaveAttribute("data-editing", "prod-eu");
    expect(dialog).toHaveAttribute("data-duplicating", "");
  });
});
