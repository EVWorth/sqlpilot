import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import { ConnectionTabs } from "../ConnectionTabs";

const mockLoadProfiles = vi.fn();
const mockCancelConnect = vi.fn();
const mockClearError = vi.fn();
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
    connecting: [],
    connect: vi.fn(),
    disconnect: vi.fn(),
    cancelConnect: mockCancelConnect,
    clearError: mockClearError,
    error: null,
    failedProfileId: null,
    deleteProfile: vi.fn(),
    setSelectedConnection: vi.fn(),
    loadProfiles: mockLoadProfiles,
    staleConnections: [],
    markStale: vi.fn(),
    reconnect: vi.fn(),
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

vi.mock("../../../stores/editorStore", () => {
  const state = () => ({ tabs: [], activeTabId: null, addTab: vi.fn(), setTabConnection: vi.fn() });
  const hook = vi.fn((s: (v: unknown) => unknown) => s(state())) as unknown as {
    (s: (v: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  hook.getState = vi.fn(state);
  return { useEditorStore: hook };
});

/** Captures the items a right-click would offer, so they can be invoked. */
const { menuItems, showContextMenu, showContextMenuAt } = vi.hoisted(() => {
  const menuItems: { label?: string; onClick?: () => void; disabled?: boolean }[] = [];
  const capture = (items: typeof menuItems) => {
    menuItems.length = 0;
    menuItems.push(...items);
  };
  return {
    menuItems,
    showContextMenu: vi.fn((_e: unknown, items: typeof menuItems) => capture(items)),
    showContextMenuAt: vi.fn((_x: number, _y: number, items: typeof menuItems) => capture(items)),
  };
});

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu, showContextMenuAt })),
}));

vi.mock("../../../stores/connectionHealthStore", () => ({
  useConnectionHealthStore: vi.fn((s: (v: unknown) => unknown) => s({ health: healthState })),
}));

/** The dialog's last `onSaved`, so a test can play a save. */
const dialogProps = vi.hoisted(() => ({ onSaved: undefined as ((saved: unknown) => void) | undefined }));

vi.mock("../../connection/ConnectionDialog", () => ({
  ConnectionDialog: vi.fn(({ editProfile, duplicateOf, onSaved }: {
    editProfile?: { name: string };
    duplicateOf?: { name: string };
    onSaved?: (saved: unknown) => void;
  }) => {
    dialogProps.onSaved = onSaved;
    return (
      <div
        data-testid="connection-dialog"
        data-editing={editProfile?.name ?? ""}
        data-duplicating={duplicateOf?.name ?? ""}
      >
        ConnectionDialog
      </div>
    );
  }),
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

const staging = { id: "p2", name: "Staging", host: "stg" };

describe("connection state on the tab (FR-1.3.2)", () => {
  const conn = { id: "c1", profile_id: "p1", name: "prod", database: "app" };
  const profiles = [{ id: "p1", name: "prod", host: "db" }];

  it("is green while the server answers", () => {
    storeState = { profiles, activeConnections: [conn] };
    render(<ConnectionTabs />);
    // `className` on an SVG element is an SVGAnimatedString, not a string.
    expect(screen.getByLabelText("Connected").getAttribute("class")).toContain("--color-success");
  });

  it("is red once the health checker says the server has gone", () => {
    // It was green whatever was true, so a dead connection looked live.
    healthState = { c1: { connectionId: "c1", healthy: false, consecutiveFailures: 2 } };
    storeState = { profiles, activeConnections: [conn] };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Disconnected").getAttribute("class")).toContain("--color-error");
  });

  it("shows a lost connection as lost even while another is connecting", () => {
    healthState = { c1: { connectionId: "c1", healthy: false, consecutiveFailures: 1 } };
    storeState = { profiles: [...profiles, staging], activeConnections: [conn], connecting: ["p2"] };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Disconnected")).toBeInTheDocument();
  });
});

describe("a connect in flight (#799)", () => {
  const conn = { id: "c1", profile_id: "p1", name: "prod", database: "app" };
  const profiles = [{ id: "p1", name: "prod-eu", host: "db" }, staging];

  it("gets a placeholder tab, named, from the moment it starts", () => {
    // Nothing changed for the whole wait: a tab existed only once the
    // connect had succeeded.
    storeState = { profiles, activeConnections: [], connecting: ["p2"] };
    render(<ConnectionTabs />);
    const tab = screen.getByTestId("connecting-tab");
    expect(tab).toHaveTextContent("Staging");
    expect(screen.getByLabelText("Connecting").getAttribute("class")).toContain("--color-warning");
  });

  it("leaves the tabs that already work green", () => {
    // The shared loading flag pulsed every existing tab amber.
    storeState = { profiles, activeConnections: [conn], connecting: ["p2"], loading: true };
    render(<ConnectionTabs />);
    expect(screen.getByLabelText("Connected")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Connecting")).toHaveLength(1);
  });

  it("does not show a profile saving or loading as connecting", () => {
    storeState = { profiles, activeConnections: [conn], loading: true };
    render(<ConnectionTabs />);
    expect(screen.queryByLabelText("Connecting")).toBeNull();
  });

  it("can be cancelled from its placeholder", () => {
    storeState = { profiles, activeConnections: [], connecting: ["p2"] };
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByLabelText("Cancel connecting to Staging"));
    expect(mockCancelConnect).toHaveBeenCalledWith("p2");
  });

  it("is not offered again in the connect menu while it is opening", () => {
    storeState = { profiles, activeConnections: [], connecting: ["p2"] };
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByTitle("Connect to a server"));
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(screen.getAllByText("Staging")).toHaveLength(1);
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

describe("deleting a profile (FR-1.1.3, #795)", () => {
  const conn = { id: "c1", profile_id: "p1", name: "prod", database: "app" };
  const profiles = [
    { id: "p1", name: "prod-eu", host: "db" },
    { id: "p2", name: "sandbox", host: "nowhere" },
  ];

  const setup = ({ disconnectFails = false } = {}) => {
    // Like the store: a disconnect that works takes the connection out of
    // activeConnections; one that fails reports it and leaves it there.
    const disconnect = vi.fn(async (id: string) => {
      if (disconnectFails) return;
      storeState = {
        ...storeState,
        activeConnections: (storeState.activeConnections as { id: string }[]).filter((c) => c.id !== id),
      };
    });
    const deleteProfile = vi.fn().mockResolvedValue(undefined);
    storeState = { profiles, activeConnections: [conn], disconnect, deleteProfile };
    render(<ConnectionTabs />);
    return { disconnect, deleteProfile };
  };

  const choose = (label: string) => act(() => menuItems.find((i) => i.label === label)!.onClick!());

  it("asks before deleting a connected profile, naming it", () => {
    const { disconnect, deleteProfile } = setup();
    fireEvent.contextMenu(screen.getByText("prod-eu"));
    choose("Delete Profile");

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("prod-eu");
    expect(dialog.textContent).toContain("disconnected");
    expect(disconnect).not.toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", () => {
    const { disconnect, deleteProfile } = setup();
    fireEvent.contextMenu(screen.getByText("prod-eu"));
    choose("Delete Profile");
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("disconnects and deletes once confirmed", async () => {
    const { disconnect, deleteProfile } = setup();
    fireEvent.contextMenu(screen.getByText("prod-eu"));
    choose("Delete Profile");
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });

    expect(disconnect).toHaveBeenCalledWith("c1");
    expect(deleteProfile).toHaveBeenCalledWith("p1");
  });

  it("keeps the profile when its connection fails to close", async () => {
    const { disconnect, deleteProfile } = setup({ disconnectFails: true });
    fireEvent.contextMenu(screen.getByText("prod-eu"));
    choose("Delete Profile");
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });

    expect(disconnect).toHaveBeenCalledWith("c1");
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("offers delete and duplicate for a profile that is not connected", async () => {
    const { disconnect, deleteProfile } = setup();
    fireEvent.click(screen.getByTitle("Connect to a server"));
    fireEvent.contextMenu(screen.getByText("sandbox"));

    expect(menuItems.map((i) => i.label)).toEqual(
      expect.arrayContaining(["Edit Connection", "Duplicate Profile", "Delete Profile"]),
    );

    choose("Delete Profile");
    expect(screen.getByRole("dialog").textContent).toContain("sandbox");
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });

    expect(disconnect).not.toHaveBeenCalled();
    expect(deleteProfile).toHaveBeenCalledWith("p2");
  });
});

describe("a failed connect (#804)", () => {
  const profiles = [{ id: "p2", name: "MariaDB sandbox", host: "localhost" }];
  const message = "Connection error: Could not connect \"MariaDB sandbox\". Nothing is listening on "
    + "localhost:3307. The server is stopped, or it is listening on a different port.";

  it("shows the whole message under the tabs", () => {
    storeState = { profiles, error: message, failedProfileId: "p2" };
    render(<ConnectionTabs />);
    const panel = screen.getByTestId("connect-failure");
    expect(panel).toHaveTextContent("Could not connect to MariaDB sandbox");
    expect(panel).toHaveTextContent(message);
  });

  it("retries the same profile", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("still refused"));
    storeState = { profiles, error: message, failedProfileId: "p2", connect };
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByText("Retry"));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith("p2"));
  });

  it("opens the profile for editing", () => {
    storeState = { profiles, error: message, failedProfileId: "p2" };
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByText("Edit connection"));
    expect(screen.getByTestId("connection-dialog")).toHaveAttribute("data-editing", "MariaDB sandbox");
    expect(mockClearError).toHaveBeenCalled();
  });

  it("can be dismissed", () => {
    storeState = { profiles, error: message, failedProfileId: "p2" };
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByLabelText("Dismiss connection failure"));
    expect(mockClearError).toHaveBeenCalled();
  });

  it("is not shown for an error that no connect produced", () => {
    storeState = { profiles, error: "Delete failed", failedProfileId: null };
    render(<ConnectionTabs />);
    expect(screen.queryByTestId("connect-failure")).toBeNull();
  });
});

describe("connecting from elsewhere (#817)", () => {
  it("labels the connect button with a word, not only a +", () => {
    render(<ConnectionTabs />);
    expect(screen.getByTitle("Connect to a server")).toHaveTextContent("Connect");
  });

  it("connects when the menu bar, palette or sidebar asks", async () => {
    const connect = vi.fn().mockResolvedValue({ id: "c2", profile_id: "p2", database: null });
    storeState = { profiles: [{ id: "p2", name: "Staging", host: "stg" }], connect };
    render(<ConnectionTabs />);

    act(() => {
      window.dispatchEvent(new CustomEvent("connect-profile", { detail: "p2" }));
    });

    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith("p2"));
  });

  it("does not connect a profile a second time while it is opening", async () => {
    const connect = vi.fn().mockResolvedValue({ id: "c2", profile_id: "p2", database: null });
    storeState = { profiles: [{ id: "p2", name: "Staging", host: "stg" }], connecting: ["p2"], connect };
    render(<ConnectionTabs />);

    act(() => {
      window.dispatchEvent(new CustomEvent("connect-profile", { detail: "p2" }));
    });

    await Promise.resolve();
    expect(connect).not.toHaveBeenCalledWith("p2");
  });

  it("selects a profile that is already open instead of connecting it again", async () => {
    const connect = vi.fn().mockResolvedValue({ id: "c3", profile_id: "p2", database: null });
    const setSelectedConnection = vi.fn();
    storeState = {
      profiles: [{ id: "p2", name: "Staging", host: "stg" }],
      activeConnections: [{ id: "c2", profile_id: "p2", database: null }],
      connect,
      setSelectedConnection,
    };
    render(<ConnectionTabs />);

    act(() => {
      window.dispatchEvent(new CustomEvent("connect-profile", { detail: "p2" }));
    });

    await vi.waitFor(() => expect(setSelectedConnection).toHaveBeenCalledWith("c2"));
    expect(connect).not.toHaveBeenCalledWith("p2");
  });
});

describe("by keyboard (#827)", () => {
  const profiles = [
    { id: "p1", name: "prod-eu", host: "db" },
    { id: "p2", name: "Staging", host: "stg" },
    { id: "p3", name: "sandbox", host: "nowhere" },
  ];
  const c1 = { id: "c1", profile_id: "p1", name: "prod-eu", host: "db", port: 3306, database: null };
  const c3 = { id: "c3", profile_id: "p3", name: "sandbox", host: "nowhere", port: 3306, database: null };
  const connectButton = () => screen.getByTitle("Connect to a server");
  const key = (k: string, init: Record<string, unknown> = {}) =>
    fireEvent.keyDown(document.activeElement as Element, { key: k, ...init });

  it("moves focus into the connect menu when it opens", () => {
    storeState = { profiles };
    render(<ConnectionTabs />);
    fireEvent.click(connectButton());
    expect(document.activeElement).toHaveTextContent("prod-eu");
  });

  it("arrows through the connect menu and reaches a row's Edit button", () => {
    storeState = { profiles };
    render(<ConnectionTabs />);
    fireEvent.click(connectButton());
    key("ArrowDown");
    expect(document.activeElement).toHaveTextContent("Staging");
    key("End");
    expect(document.activeElement).toHaveTextContent("New Connection…");
    key("ArrowDown");
    expect(document.activeElement).toHaveTextContent("prod-eu");
    key("ArrowRight");
    expect(document.activeElement).toHaveAccessibleName("Edit prod-eu");
    key("ArrowLeft");
    expect(document.activeElement).toHaveTextContent("prod-eu");
  });

  it("closes the connect menu on Escape and gives focus back to the button", () => {
    storeState = { profiles };
    render(<ConnectionTabs />);
    fireEvent.click(connectButton());
    key("Escape");
    expect(screen.queryByRole("menu", { name: "Connect to a server" })).toBeNull();
    expect(document.activeElement).toBe(connectButton());
  });

  it("focuses the new connection's tab after connecting from the menu", async () => {
    const connect = vi.fn(async () => {
      storeState = { ...storeState, activeConnections: [c3] };
      return c3;
    });
    storeState = { profiles, connect };
    render(<ConnectionTabs />);
    fireEvent.click(connectButton());
    key("End");
    key("ArrowUp");
    expect(document.activeElement).toHaveTextContent("sandbox");
    await act(async () => {
      fireEvent.click(document.activeElement as Element);
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /sandbox/ })));
  });

  it("makes connection tabs tabs, with one Tab stop on the selected one", () => {
    storeState = { profiles, activeConnections: [c1, c3], selectedConnectionId: "c3" };
    render(<ConnectionTabs />);
    expect(screen.getByRole("tablist", { name: "Connections" })).toBeInTheDocument();
    const [first, second] = screen.getAllByRole("tab");
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(second).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("aria-selected", "true");
  });

  it("moves between tabs with the arrow keys and selects with Enter", () => {
    const setSelectedConnection = vi.fn();
    storeState = { profiles, activeConnections: [c1, c3], selectedConnectionId: "c1", setSelectedConnection };
    render(<ConnectionTabs />);
    const [first, second] = screen.getAllByRole("tab");
    first.focus();
    key("ArrowRight");
    expect(document.activeElement).toBe(second);
    key("ArrowRight");
    expect(document.activeElement).toBe(first);
    key("End");
    expect(document.activeElement).toBe(second);
    key("Enter");
    expect(setSelectedConnection).toHaveBeenCalledWith("c3");
  });

  it("opens the tab menu with Shift+F10 and with the Menu key", () => {
    storeState = { profiles, activeConnections: [c1] };
    render(<ConnectionTabs />);
    screen.getByRole("tab").focus();
    key("F10", { shiftKey: true });
    expect(menuItems.map((i) => i.label)).toContain("Edit Connection");
    menuItems.length = 0;
    key("ContextMenu");
    expect(menuItems.map((i) => i.label)).toContain("Disconnect");
  });
});

describe("environment and server on the tab (#835)", () => {
  const prod = {
    id: "p1",
    name: "Production (read-only)",
    host: "db.internal",
    port: 3306,
    username: "app",
    environment: "production",
    read_only: true,
  };
  const conn = { id: "c1", profile_id: "p1", name: "Production (read-only)", host: "db.internal", port: 3306 };

  it("shows the environment badge and names the server in the tooltip", () => {
    storeState = { profiles: [prod], activeConnections: [conn] };
    render(<ConnectionTabs />);
    const tab = screen.getByRole("tab");
    expect(tab).toHaveAttribute("title", "Production (read-only) — app@db.internal:3306");
    expect(tab).toContainElement(screen.getByText("PROD"));
  });

  it("shows the badge, read-only lock and server on connect-menu rows", () => {
    storeState = { profiles: [{ ...prod, id: "p2", environment: "staging" }] };
    render(<ConnectionTabs />);
    fireEvent.click(screen.getByTitle("Connect to a server"));
    const row = screen.getByRole("menuitem", { name: /^Production/ });
    expect(row).toHaveTextContent("STG");
    expect(row).toHaveAttribute("title", "app@db.internal:3306");
    expect(row).toContainElement(screen.getByLabelText("Read-only connection"));
  });
});

describe("editing a connected profile (#831)", () => {
  const profile = {
    id: "p1",
    name: "Local dev",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    default_database: null,
    read_only: false,
    charset: "utf8mb4",
    ssl_config: null,
    ssh_config: null,
  };
  const conn = { id: "c1", profile_id: "p1", name: "Local dev", host: "127.0.0.1", port: 3306, database: null };

  const editAndSave = (changes: Record<string, unknown>) => {
    act(() => menuItems.find((i) => i.label === "Edit Connection")!.onClick!());
    act(() => dialogProps.onSaved?.({ ...profile, password: "", ...changes }));
  };

  it("offers a reconnect and marks the tab when the server changed", () => {
    const markStale = vi.fn();
    storeState = { profiles: [profile], activeConnections: [conn], markStale };
    render(<ConnectionTabs />);
    fireEvent.contextMenu(screen.getByText("Local dev"));
    editAndSave({ name: "Local dev RENAMED", host: "10.9.9.9" });

    expect(markStale).toHaveBeenCalledWith("c1");
    const prompt = screen.getByTestId("reconnect-prompt");
    expect(prompt).toHaveTextContent("127.0.0.1:3306");
    expect(document.activeElement).toBe(screen.getByText("Reconnect now").closest("button"));
  });

  it("says nothing when only the name changed", () => {
    const markStale = vi.fn();
    storeState = { profiles: [profile], activeConnections: [conn], markStale };
    render(<ConnectionTabs />);
    fireEvent.contextMenu(screen.getByText("Local dev"));
    editAndSave({ name: "Renamed" });

    expect(markStale).not.toHaveBeenCalled();
    expect(screen.queryByTestId("reconnect-prompt")).toBeNull();
  });

  it("reconnects on Reconnect now and moves the editor tabs to the new connection", async () => {
    const fresh = { ...conn, id: "c2", host: "10.9.9.9" };
    const reconnect = vi.fn().mockResolvedValue(fresh);
    storeState = { profiles: [profile], activeConnections: [conn], reconnect };
    render(<ConnectionTabs />);
    fireEvent.contextMenu(screen.getByText("Local dev"));
    editAndSave({ host: "10.9.9.9" });

    await act(async () => {
      fireEvent.click(screen.getByText("Reconnect now"));
    });
    expect(reconnect).toHaveBeenCalledWith("c1");
    expect(screen.queryByTestId("reconnect-prompt")).toBeNull();
  });

  it("puts the prompt away on Later and leaves the tab marked", () => {
    storeState = { profiles: [profile], activeConnections: [conn], staleConnections: ["c1"] };
    render(<ConnectionTabs />);
    fireEvent.contextMenu(screen.getByText("Local dev"));
    expect(menuItems.map((i) => i.label)).toContain("Reconnect to Apply Changes");
    editAndSave({ host: "10.9.9.9" });
    fireEvent.click(screen.getByText("Later"));

    expect(screen.queryByTestId("reconnect-prompt")).toBeNull();
    expect(screen.getByLabelText("Settings changed — reconnect to apply")).toBeInTheDocument();
  });
});
