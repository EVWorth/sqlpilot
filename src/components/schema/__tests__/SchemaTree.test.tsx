import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaTree } from "../SchemaTree";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getDatabases: vi.fn(),
    getTables: vi.fn(),
    getViews: vi.fn(),
    getRoutines: vi.fn(),
    getTriggers: vi.fn(),
    getEvents: vi.fn(),
  },
}));

vi.mock("../../../hooks/useClickHandler", () => ({
  // Mock the click handler factory: when called with (key, single, double),
  // returns a function that fires the single-click handler synchronously.
  // (We're not testing the double-click path here.)
  useClickHandler: () => (_key: string, single: () => void, _double: () => void) => () => single(),
}));

const shownMenus: { label?: string; disabled?: boolean; onClick?: () => void }[][] = [];

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: () => ({
    contextMenu: null,
    showContextMenu: (_e: unknown, items: (typeof shownMenus)[number]) => {
      shownMenus.push(items);
    },
  }),
}));

vi.mock("../../../lib/run-statement", () => ({
  runStatement: vi.fn(async () => []),
}));

vi.mock("../../../stores/productionGuardStore", () => ({
  confirmDestructive: vi.fn(async () => true),
}));

import { runStatement } from "../../../lib/run-statement";
import { api } from "../../../lib/tauri-api";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import { confirmDestructive } from "../../../stores/productionGuardStore";
import { useResultStore } from "../../../stores/resultStore";
import { useSchemaStore } from "../../../stores/schemaStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { DatabaseInfo, RoutineInfo, TableInfo, TriggerInfo, ViewInfo } from "../../../types";

const dbs: DatabaseInfo[] = [
  { name: "app_db", character_set: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
  { name: "logs", character_set: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
];

const tablesForApp: TableInfo[] = [
  { name: "users", table_type: "BASE TABLE", row_count: 100, sql: "CREATE TABLE users (...)" },
  { name: "orders", table_type: "BASE TABLE", row_count: 50, sql: "CREATE TABLE orders (...)" },
];

const viewsForApp: ViewInfo[] = [
  { name: "active_users", sql: "CREATE VIEW active_users AS SELECT * FROM users WHERE active = true" },
];

const routinesForApp: RoutineInfo[] = [
  { name: "do_cleanup", routine_type: "PROCEDURE", sql: "CREATE PROCEDURE do_cleanup(...)" },
  { name: "compute_total", routine_type: "FUNCTION", sql: "CREATE FUNCTION compute_total(...)" },
];

const triggersForApp: TriggerInfo[] = [
  {
    name: "users_audit",
    timing: "AFTER",
    event: "INSERT",
    sql: "CREATE TRIGGER users_audit AFTER INSERT ON users FOR EACH ROW ...",
  },
];

const tablesForLogs: TableInfo[] = [
  { name: "events", table_type: "BASE TABLE", row_count: 1000, sql: "CREATE TABLE events (...)" },
];

function setupStores(overrides: Partial<{
  activeTabId: string | null;
  database: string | null;
}> = {}) {
  useEditorStore.setState({
    tabs: overrides.activeTabId
      ? [{
        id: overrides.activeTabId,
        title: "Query",
        content: "",
        type: "query",
        isDirty: false,
        database: overrides.database ?? null,
      }]
      : [],
    activeTabId: overrides.activeTabId ?? null,
    editorInstance: null,
  } as any);
  useConnectionStore.setState({
    activeConnections: [{
      id: "conn-1",
      profile_id: "prof-1",
      name: "Test",
      host: "localhost",
      port: 3306,
      server_version: "8.0.0",
      connected_at: "2024-01-01T00:00:00Z",
    }],
    selectedConnectionId: "conn-1",
  } as any);
  useResultStore.setState({ isExecuting: false, results: [], activeResultIndex: 0, error: null } as any);
  useSettingsStore.setState({ querySettings: { maxResultRows: 1000, limitEnabled: true } } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The schema cache is a store now, so it outlives a render. Without this,
  // a test asserting a fetch happened sees the previous test's cache (#288).
  useSchemaStore.setState({ byConnection: {} });
  setupStores();
  vi.mocked(api.getDatabases).mockResolvedValue(dbs);
  // Per-DB data so filter test doesn't see duplicate "orders" from both DBs.
  vi.mocked(api.getTables).mockImplementation((_cid: string, db: string) =>
    Promise.resolve(db === "app_db" ? tablesForApp : tablesForLogs)
  );
  vi.mocked(api.getViews).mockImplementation((_cid: string, db: string) =>
    Promise.resolve(db === "app_db" ? viewsForApp : [])
  );
  vi.mocked(api.getRoutines).mockImplementation((_cid: string, db: string) =>
    Promise.resolve(db === "app_db" ? routinesForApp : [])
  );
  vi.mocked(api.getEvents).mockResolvedValue([]);
  vi.mocked(api.getTriggers).mockImplementation((_cid: string, db: string) =>
    Promise.resolve(db === "app_db" ? triggersForApp : [])
  );
});

describe("SchemaTree", () => {
  describe("initial render", () => {
    it("renders nothing while databases are loading", () => {
      vi.mocked(api.getDatabases).mockReturnValue(new Promise(() => {}));
      render(<SchemaTree connectionId="conn-1" />);
      expect(screen.getByPlaceholderText(/Filter/)).toBeInTheDocument();
      expect(screen.queryByText("app_db")).toBeNull();
    });

    it("renders databases once getDatabases resolves", async () => {
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => {
        expect(screen.getByText("app_db")).toBeInTheDocument();
        expect(screen.getByText("logs")).toBeInTheDocument();
      });
    });

    it("does not show tables until database is expanded", async () => {
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      expect(screen.queryByText("users")).toBeNull();
      expect(api.getTables).not.toHaveBeenCalled();
    });

    it("renders the filter input with a Ctrl+Shift hint in placeholder", () => {
      render(<SchemaTree connectionId="conn-1" />);
      const input = screen.getByPlaceholderText(/Filter/);
      expect(input).toBeInTheDocument();
      expect(input.getAttribute("placeholder")).toMatch(/Ctrl\+Shift/);
    });
  });

  describe("expand / collapse", () => {
    it("expanding a database fetches tables for it", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));

      await user.click(screen.getByText("app_db"));

      await waitFor(() => {
        expect(api.getTables).toHaveBeenCalledWith("conn-1", "app_db");
      });
      // Tables folder is shown but not auto-expanded; expand it.
      await user.click(screen.getByText("Tables"));
      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
        expect(screen.getByText("orders")).toBeInTheDocument();
      });
    });

    it("collapsing a database hides its tables (data stays cached)", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await user.click(screen.getByText("Tables"));
      await waitFor(() => screen.getByText("users"));
      await user.click(screen.getByText("app_db"));
      expect(screen.queryByText("users")).toBeNull();
      expect(api.getTables).toHaveBeenCalledTimes(1);
    });

    it("expanding the Views folder fetches views", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await user.click(screen.getByText("Views"));
      await waitFor(() => {
        expect(api.getViews).toHaveBeenCalledWith("conn-1", "app_db");
        expect(screen.getByText("active_users")).toBeInTheDocument();
      });
    });
  });

  describe("selection", () => {
    it("marks the active tab's database with the accent dot when matching", async () => {
      setupStores({ activeTabId: "tab-1", database: "app_db" });
      const { container } = render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      expect(container.textContent).toContain("●");
    });

    it("does not show the accent dot when no active tab database matches", async () => {
      setupStores({ activeTabId: "tab-1", database: "other_db" });
      const { container } = render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      expect(container.textContent).not.toContain("●");
    });
  });

  describe("filter", () => {
    it("auto-expands matching tables when filter is active", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await user.click(screen.getByText("Tables"));
      await waitFor(() => screen.getByText("users"));

      const input = screen.getByPlaceholderText(/Filter/) as HTMLInputElement;
      await user.type(input, "ord");
      // orders matches; users does not. The name is split around the
      // highlight, so it is matched across elements (#296).
      const named = (name: string) =>
        screen.queryAllByText((_t, node) => node?.textContent === name && node.tagName === "SPAN");
      expect(named("orders").length).toBeGreaterThan(0);
      expect(named("users")).toHaveLength(0);
    });

    it("Escape key clears the filter input", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      const input = screen.getByPlaceholderText(/Filter/) as HTMLInputElement;
      await user.type(input, "users");
      expect(input.value).toBe("users");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input.value).toBe("");
    });
  });

  describe("error handling", () => {
    it("does not throw when getDatabases fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(api.getDatabases).mockRejectedValue(new Error("boom"));
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Filter/)).toBeInTheDocument();
      });
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("does not throw when getTables fails on expansion", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(api.getTables).mockRejectedValue(new Error("boom"));
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      consoleError.mockRestore();
    });
  });

  describe("loading state", () => {
    it("shows Loading... indicator when getTables is in flight", async () => {
      const tablesDeferred = new Promise<TableInfo[]>(() => {});
      vi.mocked(api.getTables).mockReturnValue(tablesDeferred as Promise<TableInfo[]>);
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await waitFor(() => expect(screen.getByText(/Loading/)).toBeInTheDocument());
    });
  });

  describe("table interactions", () => {
    it("renders a clickable button for each table in the expanded tree", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await user.click(screen.getByText("Tables"));
      await waitFor(() => screen.getByText("users"));

      const usersButton = screen.getByText("users").closest("button");
      expect(usersButton).toBeInTheDocument();
    });

    it("renders trigger entry with timing + event metadata", async () => {
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));
      await user.click(screen.getByText("app_db"));
      await user.click(screen.getByText("Triggers"));
      await waitFor(() => {
        expect(screen.getByText("users_audit")).toBeInTheDocument();
      });
      expect(screen.getByText(/AFTER/)).toBeInTheDocument();
      expect(screen.getByText(/INSERT/)).toBeInTheDocument();
    });
  });
});

describe("SchemaTree across connections (#288, #289)", () => {
  /** Two servers, each with an `app_db` holding a different table. */
  const twoServers = () => {
    vi.mocked(api.getDatabases).mockResolvedValue(dbs);
    vi.mocked(api.getTables).mockImplementation((cid: string) =>
      Promise.resolve(
        cid === "conn-1" ? tablesForApp : [
          { name: "only_on_b", table_type: "BASE TABLE", engine: "InnoDB", row_count: 0, data_size: 0, comment: "" },
        ] as never,
      )
    );
  };

  beforeEach(() => {
    useSchemaStore.setState({ byConnection: {} });
    twoServers();
  });

  it("does not show one server's tables under the other's database of the same name", async () => {
    // `app_db` exists on both, which is the ordinary case — `mysql` and
    // `information_schema` are on every server.
    const user = userEvent.setup({ applyAccept: false });
    const { rerender } = render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
    await user.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());

    rerender(<SchemaTree connectionId="conn-2" />);

    await waitFor(() => expect(screen.queryByText("users")).toBeNull());
  });

  it("keeps each connection's expansion to itself", async () => {
    // A node expanded on one server says nothing about the same-named node on
    // another: switching used to arrive with folders already open, showing
    // whatever the previous server had put in them.
    const user = userEvent.setup({ applyAccept: false });
    const { rerender } = render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
    await waitFor(() => expect(screen.getByText("Tables")).toBeInTheDocument());

    rerender(<SchemaTree connectionId="conn-2" />);

    // conn-2's `app_db` has never been opened, so it is closed.
    await waitFor(() => expect(screen.getByText("app_db")).toBeInTheDocument());
    expect(screen.queryByText("Tables")).toBeNull();
  });

  it("puts a connection back the way it was left", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { rerender } = render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
    await user.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    const fetches = vi.mocked(api.getTables).mock.calls.length;

    rerender(<SchemaTree connectionId="conn-2" />);
    rerender(<SchemaTree connectionId="conn-1" />);

    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    expect(vi.mocked(api.getTables).mock.calls.length).toBe(fetches);
  });

  it("drops a response that lands after the connection changed", async () => {
    // This is what repopulated the new tree with the old server's objects.
    let landLate!: (tables: unknown[]) => void;
    vi.mocked(api.getTables).mockImplementation(() =>
      new Promise((resolve) => {
        landLate = resolve as (t: unknown[]) => void;
      })
    );
    const user = userEvent.setup({ applyAccept: false });
    const { rerender } = render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));

    rerender(<SchemaTree connectionId="conn-2" />);
    landLate(tablesForApp);

    await waitFor(() => expect(screen.getByText("app_db")).toBeInTheDocument());
    expect(screen.queryByText("users")).toBeNull();
  });
});

describe("SchemaTree events, system databases and drag (#291)", () => {
  const events = [
    { name: "nightly", event_type: "RECURRING", status: "ENABLED", definer: "root@%", interval: "1 DAY", comment: "" },
    { name: "paused", event_type: "RECURRING", status: "DISABLED", definer: "root@%", interval: "1 HOUR", comment: "" },
  ];

  beforeEach(() => {
    useSchemaStore.setState({ byConnection: {} });
    useSettingsStore.setState({
      querySettings: { maxResultRows: 1000, limitEnabled: true, showSystemDatabases: false },
    } as never);
    vi.mocked(api.getEvents).mockResolvedValue(events as never);
  });

  const openDb = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
  };

  describe("events folder (FR-4.1.1)", () => {
    it("lists a database's scheduled events", async () => {
      const user = userEvent.setup({ applyAccept: false });
      await openDb(user);

      await user.click(screen.getByText("Events"));

      await waitFor(() => expect(screen.getByText("nightly")).toBeInTheDocument());
      expect(api.getEvents).toHaveBeenCalledWith("conn-1", "app_db");
    });

    it("says how often an enabled event runs, and that a disabled one does not", async () => {
      // "off" is the usual answer to why an event did not fire, and a
      // schedule shown beside a disabled event would be misleading.
      const user = userEvent.setup({ applyAccept: false });
      await openDb(user);

      await user.click(screen.getByText("Events"));

      await waitFor(() => expect(screen.getByText("1 DAY")).toBeInTheDocument());
      expect(screen.getByText("off")).toBeInTheDocument();
      expect(screen.queryByText("1 HOUR")).toBeNull();
    });
  });

  describe("system databases (FR-4.1.6)", () => {
    const withSystem = [
      ...dbs.map((d) => ({ ...d, is_system: false })),
      { name: "mysql", character_set: "utf8mb4", collation: "utf8mb4_0900_ai_ci", is_system: true },
    ];

    it("hides them by default", async () => {
      vi.mocked(api.getDatabases).mockResolvedValue(withSystem as never);
      render(<SchemaTree connectionId="conn-1" />);

      await waitFor(() => expect(screen.getByText("app_db")).toBeInTheDocument());
      expect(screen.queryByText("mysql")).toBeNull();
    });

    it("shows them when asked", async () => {
      // They were filtered out in the query, so they were unreachable at any
      // price — wrong for a tool whose users administer the server.
      vi.mocked(api.getDatabases).mockResolvedValue(withSystem as never);
      const user = userEvent.setup({ applyAccept: false });
      render(<SchemaTree connectionId="conn-1" />);
      await waitFor(() => screen.getByText("app_db"));

      await user.click(screen.getByLabelText("Show system databases"));

      await waitFor(() => expect(screen.getByText("mysql")).toBeInTheDocument());
    });

    it("offers no toggle when the server has none", async () => {
      // SQLite has one schema and it is the user's.
      vi.mocked(api.getDatabases).mockResolvedValue(
        dbs.map((d) => ({ ...d, is_system: false })) as never,
      );
      render(<SchemaTree connectionId="conn-1" />);

      await waitFor(() => expect(screen.getByText("app_db")).toBeInTheDocument());
      expect(screen.queryByLabelText("Show system databases")).toBeNull();
    });
  });

  describe("drag to the editor (FR-4.1.4)", () => {
    it("carries a qualified name a query can use", async () => {
      // Double-click already inserted a name at the cursor, for tables and
      // views only. Dragging is how you put one somewhere specific.
      const user = userEvent.setup({ applyAccept: false });
      await openDb(user);
      await user.click(screen.getByText("Tables"));
      await waitFor(() => screen.getByText("users"));

      const setData = vi.fn();
      fireEvent.dragStart(screen.getByText("users").closest("button")!, {
        dataTransfer: { setData, effectAllowed: "" },
      });

      expect(setData).toHaveBeenCalledWith("text/plain", "`app_db`.`users`");
    });

    it("is offered on every object type, not only tables", async () => {
      const user = userEvent.setup({ applyAccept: false });
      await openDb(user);
      await user.click(screen.getByText("Tables"));
      await user.click(screen.getByText("Views"));
      await waitFor(() => screen.getByText("active_users"));

      for (const name of ["users", "active_users"]) {
        expect(screen.getByText(name).closest("button")?.getAttribute("draggable")).toBe("true");
      }
    });
  });
});

describe("SchemaTree menus (#293)", () => {
  const openTableMenu = async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
    await user.click(screen.getByText("Tables"));
    await waitFor(() => screen.getByText("users"));
    shownMenus.length = 0;
    fireEvent.contextMenu(screen.getByText("users"));
    return shownMenus.at(-1)!;
  };

  const openDatabaseMenu = async () => {
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    shownMenus.length = 0;
    fireEvent.contextMenu(screen.getByText("app_db"));
    return shownMenus.at(-1)!;
  };

  const item = (menu: Awaited<ReturnType<typeof openTableMenu>>, label: string) => menu.find((i) => i.label === label);

  beforeEach(() => {
    shownMenus.length = 0;
    useSchemaStore.setState({ byConnection: {} });
    useSettingsStore.setState({
      querySettings: { maxResultRows: 1000, limitEnabled: true, showSystemDatabases: false },
    } as never);
    vi.mocked(runStatement).mockClear();
    vi.mocked(confirmDestructive).mockClear();
    vi.mocked(confirmDestructive).mockResolvedValue(true);
  });

  it("names the Select item for the limit it uses", async () => {
    // It said "Select Top 100 Rows" while using maxResultRows, which defaults
    // to 1000 — wrong out of the box, and wrong again for anyone who changed
    // it.
    const menu = await openTableMenu();
    expect(item(menu, "Select Top 1,000 Rows")).toBeDefined();
    expect(item(menu, "Select Top 100 Rows")).toBeUndefined();
  });

  it.each([
    "INSERT Template",
    "Rename Table…",
    "Duplicate Structure…",
    "Truncate Table",
    "Drop Table",
  ])("offers %s on a table", async (label) => {
    expect(item(await openTableMenu(), label)).toBeDefined();
  });

  it.each([
    "Create Database…",
    "Drop Database",
    "Set as Default",
    "Statistics",
  ])("offers %s on a database", async (label) => {
    expect(item(await openDatabaseMenu(), label)).toBeDefined();
  });

  describe("destructive operations", () => {
    it("asks before truncating, and says it cannot be undone", async () => {
      const menu = await openTableMenu();

      item(menu, "Truncate Table")!.onClick!();
      await waitFor(() => expect(confirmDestructive).toHaveBeenCalled());

      const asked = vi.mocked(confirmDestructive).mock.calls[0][0];
      expect(asked.sql).toBe("TRUNCATE TABLE `app_db`.`users`");
      expect(asked.action).toContain("cannot be rolled back");
    });

    it("runs nothing when the confirmation is declined", async () => {
      vi.mocked(confirmDestructive).mockResolvedValue(false);
      const menu = await openTableMenu();

      item(menu, "Drop Table")!.onClick!();
      await waitFor(() => expect(confirmDestructive).toHaveBeenCalled());

      expect(runStatement).not.toHaveBeenCalled();
    });

    it("waits for the answer before refreshing", async () => {
      // The old path called executeQuery, which returns as soon as it opens
      // the production dialog — so the refresh ran against unchanged data and
      // nothing refreshed when the user did confirm.
      const menu = await openTableMenu();
      vi.mocked(api.getTables).mockClear();

      item(menu, "Drop Table")!.onClick!();

      await waitFor(() => expect(runStatement).toHaveBeenCalled());
      await waitFor(() => expect(api.getTables).toHaveBeenCalled());
    });

    it("requires the database name to be typed before dropping one", async () => {
      // A misplaced click should not be able to take every table in a
      // database with it.
      const prompt = vi.spyOn(window, "prompt").mockReturnValue("wrong");
      const menu = await openDatabaseMenu();

      item(menu, "Drop Database")!.onClick!();

      expect(prompt).toHaveBeenCalled();
      expect(confirmDestructive).not.toHaveBeenCalled();
      prompt.mockRestore();
    });

    it("proceeds once the name matches", async () => {
      const prompt = vi.spyOn(window, "prompt").mockReturnValue("app_db");
      const menu = await openDatabaseMenu();

      item(menu, "Drop Database")!.onClick!();

      await waitFor(() => expect(confirmDestructive).toHaveBeenCalled());
      expect(vi.mocked(confirmDestructive).mock.calls[0][0].sql).toBe("DROP DATABASE `app_db`");
      prompt.mockRestore();
    });
  });

  describe("naming", () => {
    it("refuses a name that is not usable, without running anything", async () => {
      const prompt = vi.spyOn(window, "prompt").mockReturnValue("   ");
      const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
      const menu = await openTableMenu();

      item(menu, "Rename Table…")!.onClick!();

      expect(alert).toHaveBeenCalled();
      expect(confirmDestructive).not.toHaveBeenCalled();
      prompt.mockRestore();
      alert.mockRestore();
    });

    it("does nothing when the rename would not change the name", async () => {
      const prompt = vi.spyOn(window, "prompt").mockReturnValue("users");
      const menu = await openTableMenu();

      item(menu, "Rename Table…")!.onClick!();

      expect(confirmDestructive).not.toHaveBeenCalled();
      prompt.mockRestore();
    });

    it("renames to the name that was given", async () => {
      const prompt = vi.spyOn(window, "prompt").mockReturnValue("people");
      const menu = await openTableMenu();

      item(menu, "Rename Table…")!.onClick!();

      await waitFor(() => expect(confirmDestructive).toHaveBeenCalled());
      expect(vi.mocked(confirmDestructive).mock.calls[0][0].sql)
        .toBe("RENAME TABLE `app_db`.`users` TO `app_db`.`people`");
      prompt.mockRestore();
    });
  });

  it("marks Set as Default disabled for the database already in use", async () => {
    useEditorStore.setState({
      tabs: [{
        id: "t1",
        title: "Query",
        content: "",
        type: "query",
        isDirty: false,
        database: "app_db",
        connectionId: "conn-1",
      }],
      activeTabId: "t1",
    } as never);

    const menu = await openDatabaseMenu();

    expect(item(menu, "Already the default")?.disabled).toBe(true);
  });
});

describe("SchemaTree filter highlight (#296)", () => {
  beforeEach(() => {
    useSchemaStore.setState({ byConnection: {} });
  });

  it("picks out where the filter matched in each name", async () => {
    // FR-4.1.3. The filter narrowed the list and left you to find the match
    // yourself.
    const user = userEvent.setup({ applyAccept: false });
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
    await user.click(screen.getByText("Tables"));
    await waitFor(() => screen.getByText("users"));

    await user.type(screen.getByPlaceholderText(/Filter/), "ser");

    const marks = screen.getAllByRole("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => m.textContent === "ser")).toBe(true);
  });

  it("marks nothing when nothing is being filtered", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    await user.click(screen.getByText("app_db"));
    await user.click(screen.getByText("Tables"));
    await waitFor(() => screen.getByText("users"));

    expect(screen.queryAllByRole("mark")).toHaveLength(0);
  });
});

describe("SchemaTree accessibility (F3.11 of #299)", () => {
  beforeEach(() => {
    useSchemaStore.setState({ byConnection: {} });
  });

  it("is a tree, not a list of unrelated buttons", async () => {
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));

    expect(screen.getByRole("tree", { name: "Schema" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "app_db" })).toBeInTheDocument();
  });

  it("says whether a node is open", async () => {
    // Without aria-expanded there is no way to tell an open folder from a
    // closed one.
    const user = userEvent.setup({ applyAccept: false });
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    const node = screen.getByRole("treeitem", { name: "app_db" });
    expect(node.getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByText("app_db"));

    expect(node.getAttribute("aria-expanded")).toBe("true");
  });

  it("groups a node's children", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));

    await user.click(screen.getByText("app_db"));

    expect(screen.getAllByRole("group").length).toBeGreaterThan(0);
  });

  it("opens and closes with the arrow keys", async () => {
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    const button = screen.getByText("app_db").closest("button")!;
    const node = screen.getByRole("treeitem", { name: "app_db" });

    fireEvent.keyDown(button, { key: "ArrowRight" });
    await waitFor(() => expect(node.getAttribute("aria-expanded")).toBe("true"));

    fireEvent.keyDown(button, { key: "ArrowLeft" });
    await waitFor(() => expect(node.getAttribute("aria-expanded")).toBe("false"));
  });

  it("does not collapse on Right, or expand on Left", async () => {
    // Right on an open node moves inwards in a real tree; it must never close
    // what it is on.
    render(<SchemaTree connectionId="conn-1" />);
    await waitFor(() => screen.getByText("app_db"));
    const button = screen.getByText("app_db").closest("button")!;
    const node = screen.getByRole("treeitem", { name: "app_db" });

    fireEvent.keyDown(button, { key: "ArrowLeft" });
    expect(node.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(button, { key: "ArrowRight" });
    await waitFor(() => expect(node.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(node.getAttribute("aria-expanded")).toBe("true");
  });
});
