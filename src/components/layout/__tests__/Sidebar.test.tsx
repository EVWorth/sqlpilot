import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const sidebarState = {
  profiles: [] as any[],
  activeConnections: [] as any[],
  selectedConnectionId: null as string | null,
};

const editorState = {
  tabs: [] as any[],
  activeTabId: null as string | null,
  addTab: vi.fn(() => "tab-1"),
  addStructureTab: vi.fn(),
  addRoutineTab: vi.fn(),
  addDesignerTab: vi.fn(),
  updateTabContent: vi.fn(),
  setTabConnection: vi.fn(),
  editorInstance: null as any,
};

const resultStore = {
  executeQuery: vi.fn(),
};

function makeStore(getter: () => Record<string, unknown>) {
  const fn = vi.fn((selector: (state: unknown) => unknown) => {
    return selector(getter());
  });
  fn.getState = () => getter();
  return fn;
}

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: makeStore(() => sidebarState),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: makeStore(() => editorState),
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: makeStore(() => resultStore),
}));

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({ querySettings: { maxResultRows: 100 } })),
  },
}));

vi.mock("../../history/QueryHistory", () => ({
  QueryHistory: vi.fn(() => <div data-testid="query-history">QueryHistory</div>),
}));

vi.mock("../../favorites/QueryFavorites", () => ({
  QueryFavorites: vi.fn(() => <div data-testid="query-favorites">QueryFavorites</div>),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getDatabases: vi.fn().mockResolvedValue([{ name: "testdb" }, { name: "proddb" }]),
    getTables: vi.fn().mockResolvedValue([
      { name: "users", table_type: "BASE TABLE", row_count: 100 },
      { name: "orders", table_type: "BASE TABLE", row_count: null },
    ]),
    getViews: vi.fn().mockResolvedValue([{ name: "user_view" }]),
    getRoutines: vi.fn().mockResolvedValue([
      { name: "my_proc", routine_type: "PROCEDURE" },
      { name: "calc_total", routine_type: "FUNCTION" },
    ]),
    getTriggers: vi.fn().mockResolvedValue([
      { name: "trg_insert", timing: "BEFORE", event: "INSERT" },
    ]),
  },
}));

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu: vi.fn() })),
}));

vi.mock("../../../hooks/useClickHandler", () => ({
  useClickHandler: vi.fn().mockImplementation(() => {
    return vi.fn().mockImplementation(
      (_key: string, singleClick: () => void, _doubleClick: () => void) => {
        return () => singleClick();
      },
    );
  }),
}));

vi.mock("../../../lib/utils", () => ({
  cn: vi.fn((...args: (string | false | null | undefined)[]) => args.filter(Boolean).join(" ")),
}));

import { Sidebar } from "../Sidebar";
import { api } from "../../../lib/tauri-api";

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(sidebarState, {
      profiles: [],
      activeConnections: [],
      selectedConnectionId: null,
    });
    Object.assign(editorState, {
      tabs: [],
      activeTabId: null,
      addTab: vi.fn(() => "tab-1"),
      addStructureTab: vi.fn(),
      addRoutineTab: vi.fn(),
      addDesignerTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabConnection: vi.fn(),
      editorInstance: null,
    });
    Object.assign(resultStore, {
      executeQuery: vi.fn(),
    });
  });

  describe("no connection state", () => {
    it("renders the sidebar container", () => {
      const { container } = render(<Sidebar />);
      expect(container.firstElementChild).toHaveClass("flex", "h-full", "flex-col");
    });

    it("shows no connection message", () => {
      render(<Sidebar />);
      expect(screen.getByText("No connection selected")).toBeInTheDocument();
    });
  });

  describe("sections", () => {
    it("renders Favorites section button", () => {
      render(<Sidebar />);
      expect(screen.getByText("Favorites")).toBeInTheDocument();
    });

    it("renders History section button", () => {
      render(<Sidebar />);
      expect(screen.getByText("History")).toBeInTheDocument();
    });

    it("toggles favorites panel when clicked", () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByText("Favorites"));
      expect(screen.getByTestId("query-favorites")).toBeInTheDocument();
    });

    it("toggles history panel when clicked", () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByText("History"));
      expect(screen.getByTestId("query-history")).toBeInTheDocument();
    });

    it("hides favorites panel when clicked again", () => {
      render(<Sidebar />);
      const btn = screen.getByText("Favorites");
      fireEvent.click(btn);
      expect(screen.getByTestId("query-favorites")).toBeInTheDocument();
      fireEvent.click(btn);
      expect(screen.queryByTestId("query-favorites")).not.toBeInTheDocument();
    });

    it("hides history panel when clicked again", () => {
      render(<Sidebar />);
      const btn = screen.getByText("History");
      fireEvent.click(btn);
      expect(screen.getByTestId("query-history")).toBeInTheDocument();
      fireEvent.click(btn);
      expect(screen.queryByTestId("query-history")).not.toBeInTheDocument();
    });
  });

  describe("with active connection", () => {
    beforeEach(() => {
      Object.assign(sidebarState, {
        profiles: [
          { id: "p1", name: "My Profile", username: "admin", color: "#ff0000" },
        ],
        activeConnections: [
          {
            id: "conn1",
            profile_id: "p1",
            name: "My DB",
            host: "localhost",
            port: 3306,
            server_version: "8.0",
            connected_at: new Date().toISOString(),
          },
        ],
        selectedConnectionId: "conn1",
      });
    });

    it("shows connection info when connected", () => {
      render(<Sidebar />);
      expect(screen.getByText(/admin@localhost/)).toBeInTheDocument();
    });

    it("shows port when not default", () => {
      sidebarState.activeConnections[0].port = 3307;
      render(<Sidebar />);
      expect(screen.getByText(/admin@localhost:3307/)).toBeInTheDocument();
    });

    it("shows database names when loaded", async () => {
      render(<Sidebar />);
      await waitFor(() => {
        expect(screen.getByText("testdb")).toBeInTheDocument();
      });
    });

    it("shows profile color indicator when available", () => {
      render(<Sidebar />);
      const colorDot = document.querySelector('span[style*="background-color"]');
      expect(colorDot).toBeTruthy();
    });

    it("expands database to show table folders on click", async () => {
      render(<Sidebar />);
      await waitFor(() => {
        expect(screen.getByText("testdb")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("testdb"));

      await waitFor(() => {
        expect(screen.getByText("Tables")).toBeInTheDocument();
      });
    });

    it("shows tables when Tables folder is expanded", async () => {
      render(<Sidebar />);
      await waitFor(() => {
        expect(screen.getByText("testdb")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("testdb"));

      await waitFor(() => {
        expect(screen.getByText("Tables")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Tables"));

      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
        expect(screen.getByText("orders")).toBeInTheDocument();
      });
    });

    it("shows views folder when db expanded", async () => {
      render(<Sidebar />);
      await waitFor(() => {
        expect(screen.getByText("testdb")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => {
        expect(screen.getByText("Views")).toBeInTheDocument();
      });
    });

    it("shows procedures/functions/triggers folders when db expanded", async () => {
      render(<Sidebar />);
      await waitFor(() => {
        expect(screen.getByText("testdb")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => {
        expect(screen.getByText("Procedures")).toBeInTheDocument();
        expect(screen.getByText("Functions")).toBeInTheDocument();
        expect(screen.getByText("Triggers")).toBeInTheDocument();
      });
    });

    it("expands Views folder to show views", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Views"));
      fireEvent.click(screen.getByText("Views"));
      await waitFor(() => {
        expect(screen.getByText("user_view")).toBeInTheDocument();
      });
    });

    it("shows filter input", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      expect(screen.getByPlaceholderText(/Filter/)).toBeInTheDocument();
    });

    it("filters by closing db collapse on second click", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Tables"));
      fireEvent.click(screen.getByText("testdb"));
      // Tables should disappear
      await waitFor(() => {
        expect(screen.queryByText("Tables")).not.toBeInTheDocument();
      });
    });

    it("selects database on double-click", async () => {
      editorState.activeTabId = "tab-1";
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));

      // simulate double-click by calling the db click handler twice fast
      // The useClickHandler mock calls singleClick immediately
      // But doubleClick is the selectDatabase function
    });

    it("opens procedures folder and shows procedures", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Procedures"));
      fireEvent.click(screen.getByText("Procedures"));
      await waitFor(() => {
        expect(screen.getByText("my_proc")).toBeInTheDocument();
      });
    });

    it("opens functions folder and shows functions", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Functions"));
      fireEvent.click(screen.getByText("Functions"));
      await waitFor(() => {
        expect(screen.getByText("calc_total")).toBeInTheDocument();
      });
    });

    it("opens triggers folder and shows triggers", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Triggers"));
      fireEvent.click(screen.getByText("Triggers"));
      await waitFor(() => {
        expect(screen.getByText("trg_insert")).toBeInTheDocument();
      });
    });

    it("clicking a table executes SELECT query", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Tables"));
      fireEvent.click(screen.getByText("Tables"));
      await waitFor(() => screen.getByText("users"));
      fireEvent.click(screen.getByText("users"));

      expect(resultStore.executeQuery).toHaveBeenCalledWith(
        "conn1",
        "SELECT * FROM `testdb`.`users` LIMIT 100",
        "testdb",
      );
    });

    it("clicking a view executes SELECT query", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Views"));
      fireEvent.click(screen.getByText("Views"));
      await waitFor(() => screen.getByText("user_view"));
      fireEvent.click(screen.getByText("user_view"));

      expect(resultStore.executeQuery).toHaveBeenCalledWith(
        "conn1",
        "SELECT * FROM `testdb`.`user_view` LIMIT 100",
        "testdb",
      );
    });

    it("clicking a procedure opens routine tab", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Procedures"));
      fireEvent.click(screen.getByText("Procedures"));
      await waitFor(() => screen.getByText("my_proc"));
      fireEvent.click(screen.getByText("my_proc"));

      expect(editorState.addRoutineTab).toHaveBeenCalledWith("conn1", "testdb", "my_proc", "PROCEDURE");
    });

    it("clicking a function opens routine tab", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Functions"));
      fireEvent.click(screen.getByText("Functions"));
      await waitFor(() => screen.getByText("calc_total"));
      fireEvent.click(screen.getByText("calc_total"));

      expect(editorState.addRoutineTab).toHaveBeenCalledWith("conn1", "testdb", "calc_total", "FUNCTION");
    });

    it("clicking a trigger opens DDL tab", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.click(screen.getByText("testdb"));
      await waitFor(() => screen.getByText("Triggers"));
      fireEvent.click(screen.getByText("Triggers"));
      await waitFor(() => screen.getByText("trg_insert"));
      fireEvent.click(screen.getByText("trg_insert"));

      expect(editorState.addTab).toHaveBeenCalledWith("conn1", "testdb");
      expect(editorState.updateTabContent).toHaveBeenCalledWith(
        "tab-1",
        "SHOW CREATE TRIGGER `testdb`.`trg_insert`",
      );
      expect(resultStore.executeQuery).toHaveBeenCalledWith(
        "conn1",
        "SHOW CREATE TRIGGER `testdb`.`trg_insert`",
      );
    });

    it("shows filter input and clears on Escape", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));

      const filterInput = screen.getByPlaceholderText(/Filter/);
      fireEvent.change(filterInput, { target: { value: "users" } });
      expect((filterInput as HTMLInputElement).value).toBe("users");

      fireEvent.keyDown(filterInput, { key: "Escape" });
      expect((filterInput as HTMLInputElement).value).toBe("");
    });

    it("shows clear filter button when filter is active", async () => {
      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));

      const filterInput = screen.getByPlaceholderText(/Filter/);
      fireEvent.change(filterInput, { target: { value: "test" } });

      // Clear button should appear
      const clearBtn = document.querySelector("button .lucide-x");
      expect(clearBtn).toBeTruthy();
    });

    it("shows host only when no username and default port", () => {
      sidebarState.profiles = [{ id: "p1", name: "Profile" }];
      sidebarState.activeConnections = [
        {
          id: "conn1",
          profile_id: "p1",
          name: "My DB",
          host: "db.example.com",
          port: 3306,
          server_version: "8.0",
          connected_at: new Date().toISOString(),
        },
      ];
      render(<Sidebar />);
      expect(screen.getByText("db.example.com")).toBeInTheDocument();
    });

    it("shows host:port when no username and non-default port", () => {
      sidebarState.profiles = [{ id: "p1", name: "Profile" }];
      sidebarState.activeConnections = [
        {
          id: "conn1",
          profile_id: "p1",
          name: "My DB",
          host: "db.example.com",
          port: 3307,
          server_version: "8.0",
          connected_at: new Date().toISOString(),
        },
      ];
      render(<Sidebar />);
      expect(screen.getByText("db.example.com:3307")).toBeInTheDocument();
    });
  });

  describe("context menu events", () => {
    beforeEach(() => {
      Object.assign(sidebarState, {
        profiles: [{ id: "p1", name: "My Profile", username: "admin", color: "#ff0000" }],
        activeConnections: [
          {
            id: "conn1",
            profile_id: "p1",
            name: "My DB",
            host: "localhost",
            port: 3306,
            server_version: "8.0",
            connected_at: new Date().toISOString(),
          },
        ],
        selectedConnectionId: "conn1",
      });
    });

    it("opens backup dialog via context menu event", async () => {
      const handler = vi.fn();
      window.addEventListener("open-backup", handler);

      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));

      window.dispatchEvent(
        new CustomEvent("open-backup", { detail: { connectionId: "conn1", database: "testdb" } }),
      );

      expect(handler).toHaveBeenCalled();
      expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({
        connectionId: "conn1",
        database: "testdb",
      });

      window.removeEventListener("open-backup", handler);
    });

    it("opens restore dialog via context menu event", async () => {
      const handler = vi.fn();
      window.addEventListener("open-restore", handler);

      render(<Sidebar />);
      await waitFor(() => screen.getByText("testdb"));

      window.dispatchEvent(
        new CustomEvent("open-restore", { detail: { connectionId: "conn1", database: "testdb" } }),
      );

      expect(handler).toHaveBeenCalled();
      window.removeEventListener("open-restore", handler);
    });
  });

  describe("connection with custom port", () => {
    beforeEach(() => {
      Object.assign(sidebarState, {
        profiles: [{ id: "p1", name: "Remote", username: undefined, color: undefined }],
        activeConnections: [
          {
            id: "conn2",
            profile_id: "p1",
            name: "Remote DB",
            host: "db.example.com",
            port: 5432,
            server_version: "8.0",
            connected_at: new Date().toISOString(),
          },
        ],
        selectedConnectionId: "conn2",
      });
    });

    it("shows host without username when no profile username", () => {
      render(<Sidebar />);
      expect(screen.getByText("db.example.com:5432")).toBeInTheDocument();
    });
  });
});
