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
  },
}));

vi.mock("../../../hooks/useClickHandler", () => ({
  // Mock the click handler factory: when called with (key, single, double),
  // returns a function that fires the single-click handler synchronously.
  // (We're not testing the double-click path here.)
  useClickHandler: () => (_key: string, single: () => void, _double: () => void) => () => single(),
}));

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: () => ({
    contextMenu: null,
    showContextMenu: vi.fn(),
  }),
}));

import { api } from "../../../lib/tauri-api";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";
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
      // orders matches; users does not.
      expect(screen.getByText("orders")).toBeInTheDocument();
      expect(screen.queryByText("users")).toBeNull();
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
