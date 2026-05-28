import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSchemaCache } from "../useSchemaCache";

vi.mock("../../lib/tauri-api", () => ({
  api: {
    getDatabases: vi.fn(),
    getTables: vi.fn(),
    getViews: vi.fn(),
    getRoutines: vi.fn(),
    getTriggers: vi.fn(),
    getColumns: vi.fn(),
  },
}));

import type { ColumnInfo } from "../../types";
import { api } from "../../lib/tauri-api";

const mockGetDatabases = api.getDatabases as ReturnType<typeof vi.fn>;
const mockGetTables = api.getTables as ReturnType<typeof vi.fn>;
const mockGetViews = api.getViews as ReturnType<typeof vi.fn>;
const mockGetRoutines = api.getRoutines as ReturnType<typeof vi.fn>;
const mockGetTriggers = api.getTriggers as ReturnType<typeof vi.fn>;
const mockGetColumns = api.getColumns as ReturnType<typeof vi.fn>;

function doReset() {
  useSchemaCache.setState({
    connectionId: null,
    databases: [],
    tables: new Map(),
    views: new Map(),
    routines: new Map(),
    triggers: new Map(),
    columns: new Map(),
    loading: false,
  });
}

// Helper to wait for pending async work triggered by the store
const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  doReset();
});

describe("useSchemaCache", () => {
  describe("setConnection", () => {
    it("clears all caches when setting a new connection", () => {
      useSchemaCache.setState({
        databases: ["db1"],
        tables: new Map([["db1", ["table1"]]]),
      });

      useSchemaCache.getState().setConnection("conn-2");

      const state = useSchemaCache.getState();
      expect(state.connectionId).toBe("conn-2");
      expect(state.databases).toEqual([]);
      expect(state.tables.size).toBe(0);
      expect(state.views.size).toBe(0);
      expect(state.routines.size).toBe(0);
      expect(state.triggers.size).toBe(0);
      expect(state.columns.size).toBe(0);
    });

    it("does nothing when setting the same connection", () => {
      useSchemaCache.setState({
        connectionId: "conn-1",
        databases: ["db1", "db2"],
      });

      useSchemaCache.getState().setConnection("conn-1");

      const state = useSchemaCache.getState();
      expect(state.databases).toEqual(["db1", "db2"]);
    });

    it("triggers fetchDatabases when connectionId is set", async () => {
      mockGetDatabases.mockResolvedValue([
        { name: "mydb" },
        { name: "testdb" },
      ]);
      mockGetTables.mockResolvedValue([{ name: "users" }]);

      useSchemaCache.getState().setConnection("conn-1");

      await flushPromises();

      expect(mockGetDatabases).toHaveBeenCalledWith("conn-1");
      expect(useSchemaCache.getState().databases).toEqual([
        "mydb",
        "testdb",
      ]);
    });

    it("clears caches when connection is set to null", () => {
      useSchemaCache.setState({
        connectionId: "conn-1",
        databases: ["db1"],
        tables: new Map([["db1", ["t1"]]]),
      });

      useSchemaCache.getState().setConnection(null);

      const state = useSchemaCache.getState();
      expect(state.connectionId).toBeNull();
      expect(state.databases).toEqual([]);
      expect(state.tables.size).toBe(0);
    });
  });

  describe("fetchDatabases", () => {
    it("returns cached databases if available and connectionId matches", async () => {
      useSchemaCache.setState({
        connectionId: "conn-1",
        databases: ["cached_db"],
      });

      const result = await useSchemaCache
        .getState()
        .fetchDatabases("conn-1");

      expect(result).toEqual(["cached_db"]);
      expect(mockGetDatabases).not.toHaveBeenCalled();
    });

    it("fetches from API when cache is empty", async () => {
      mockGetDatabases.mockResolvedValue([
        { name: "db1" },
        { name: "db2" },
      ]);
      mockGetTables.mockResolvedValue([]);

      useSchemaCache.setState({ connectionId: "conn-1" });

      const result = await useSchemaCache
        .getState()
        .fetchDatabases("conn-1");

      expect(mockGetDatabases).toHaveBeenCalledWith("conn-1");
      expect(result).toEqual(["db1", "db2"]);
      expect(useSchemaCache.getState().databases).toEqual([
        "db1",
        "db2",
      ]);
    });

    it("sets loading true while fetching and false after", async () => {
      mockGetDatabases.mockResolvedValue([{ name: "db1" }]);
      mockGetTables.mockResolvedValue([]);

      useSchemaCache.setState({ connectionId: "conn-1" });

      const promise = useSchemaCache.getState().fetchDatabases("conn-1");
      expect(useSchemaCache.getState().loading).toBe(true);

      await promise;
      expect(useSchemaCache.getState().loading).toBe(false);
    });

    it("pre-fetches tables for all databases", async () => {
      mockGetDatabases.mockResolvedValue([
        { name: "db1" },
        { name: "db2" },
      ]);
      mockGetTables.mockResolvedValue([{ name: "users" }]);

      useSchemaCache.setState({ connectionId: "conn-1" });

      await useSchemaCache.getState().fetchDatabases("conn-1");

      expect(mockGetTables).toHaveBeenCalledWith("conn-1", "db1");
      expect(mockGetTables).toHaveBeenCalledWith("conn-1", "db2");
    });

    it("returns empty array and sets loading false on error", async () => {
      mockGetDatabases.mockRejectedValue(new Error("Network error"));

      useSchemaCache.setState({ connectionId: "conn-1" });

      const result = await useSchemaCache
        .getState()
        .fetchDatabases("conn-1");

      expect(result).toEqual([]);
      expect(useSchemaCache.getState().loading).toBe(false);
    });
  });

  describe("fetchTables", () => {
    it("returns cached tables if available", async () => {
      useSchemaCache.setState({
        tables: new Map([["mydb", ["users", "orders"]]]),
      });

      const result = await useSchemaCache
        .getState()
        .fetchTables("conn-1", "mydb");

      expect(result).toEqual(["users", "orders"]);
      expect(mockGetTables).not.toHaveBeenCalled();
    });

    it("fetches from API when not cached", async () => {
      mockGetTables.mockResolvedValue([
        { name: "users" },
        { name: "orders" },
      ]);

      const result = await useSchemaCache
        .getState()
        .fetchTables("conn-1", "mydb");

      expect(mockGetTables).toHaveBeenCalledWith("conn-1", "mydb");
      expect(result).toEqual(["users", "orders"]);
      expect(useSchemaCache.getState().tables.get("mydb")).toEqual([
        "users",
        "orders",
      ]);
    });

    it("returns empty array on error", async () => {
      mockGetTables.mockRejectedValue(new Error("DB error"));

      const result = await useSchemaCache
        .getState()
        .fetchTables("conn-1", "mydb");

      expect(result).toEqual([]);
      expect(useSchemaCache.getState().loading).toBe(false);
    });
  });

  describe("fetchViews", () => {
    it("returns cached views if available", async () => {
      useSchemaCache.setState({
        views: new Map([["mydb", ["user_view"]]]),
      });

      const result = await useSchemaCache
        .getState()
        .fetchViews("conn-1", "mydb");

      expect(result).toEqual(["user_view"]);
      expect(mockGetViews).not.toHaveBeenCalled();
    });

    it("fetches from API when not cached", async () => {
      mockGetViews.mockResolvedValue([{ name: "v1" }, { name: "v2" }]);

      const result = await useSchemaCache
        .getState()
        .fetchViews("conn-1", "mydb");

      expect(mockGetViews).toHaveBeenCalledWith("conn-1", "mydb");
      expect(result).toEqual(["v1", "v2"]);
      expect(useSchemaCache.getState().views.get("mydb")).toEqual([
        "v1",
        "v2",
      ]);
    });

    it("returns empty array on error", async () => {
      mockGetViews.mockRejectedValue(new Error("DB error"));

      const result = await useSchemaCache
        .getState()
        .fetchViews("conn-1", "mydb");

      expect(result).toEqual([]);
    });
  });

  describe("fetchRoutines", () => {
    it("returns cached routines if available", async () => {
      useSchemaCache.setState({
        routines: new Map([["mydb", ["proc1", "func1"]]]),
      });

      const result = await useSchemaCache
        .getState()
        .fetchRoutines("conn-1", "mydb");

      expect(result).toEqual(["proc1", "func1"]);
      expect(mockGetRoutines).not.toHaveBeenCalled();
    });

    it("fetches from API when not cached", async () => {
      mockGetRoutines.mockResolvedValue([
        { name: "my_proc" },
        { name: "my_func" },
      ]);

      const result = await useSchemaCache
        .getState()
        .fetchRoutines("conn-1", "mydb");

      expect(mockGetRoutines).toHaveBeenCalledWith("conn-1", "mydb");
      expect(result).toEqual(["my_proc", "my_func"]);
      expect(
        useSchemaCache.getState().routines.get("mydb"),
      ).toEqual(["my_proc", "my_func"]);
    });

    it("returns empty array on error", async () => {
      mockGetRoutines.mockRejectedValue(new Error("DB error"));

      const result = await useSchemaCache
        .getState()
        .fetchRoutines("conn-1", "mydb");

      expect(result).toEqual([]);
    });
  });

  describe("fetchTriggers", () => {
    it("returns cached triggers if available", async () => {
      useSchemaCache.setState({
        triggers: new Map([["mydb", ["trg1"]]]),
      });

      const result = await useSchemaCache
        .getState()
        .fetchTriggers("conn-1", "mydb");

      expect(result).toEqual(["trg1"]);
      expect(mockGetTriggers).not.toHaveBeenCalled();
    });

    it("fetches from API when not cached", async () => {
      mockGetTriggers.mockResolvedValue([
        { name: "trg_before_insert" },
      ]);

      const result = await useSchemaCache
        .getState()
        .fetchTriggers("conn-1", "mydb");

      expect(mockGetTriggers).toHaveBeenCalledWith("conn-1", "mydb");
      expect(result).toEqual(["trg_before_insert"]);
      expect(
        useSchemaCache.getState().triggers.get("mydb"),
      ).toEqual(["trg_before_insert"]);
    });

    it("returns empty array on error", async () => {
      mockGetTriggers.mockRejectedValue(new Error("DB error"));

      const result = await useSchemaCache
        .getState()
        .fetchTriggers("conn-1", "mydb");

      expect(result).toEqual([]);
    });
  });

  describe("fetchColumns", () => {
    it("returns cached columns if available", async () => {
      const colInfo = [
        { name: "id", dataType: "int", nullable: false },
      ] as ColumnInfo[];
      useSchemaCache.setState({
        columns: new Map([["mydb.users", colInfo]]),
      });

      const result = await useSchemaCache
        .getState()
        .fetchColumns("conn-1", "mydb", "users");

      expect(result).toEqual(colInfo);
      expect(mockGetColumns).not.toHaveBeenCalled();
    });

    it("fetches from API when not cached", async () => {
      const colInfo = [
        { name: "id", dataType: "int", nullable: false },
      ] as ColumnInfo[];
      mockGetColumns.mockResolvedValue(colInfo);

      const result = await useSchemaCache
        .getState()
        .fetchColumns("conn-1", "mydb", "users");

      expect(mockGetColumns).toHaveBeenCalledWith("conn-1", "mydb", "users");
      expect(result).toEqual(colInfo);
      expect(
        useSchemaCache.getState().columns.get("mydb.users"),
      ).toEqual(colInfo);
    });

    it("returns empty array on error", async () => {
      mockGetColumns.mockRejectedValue(new Error("DB error"));

      const result = await useSchemaCache
        .getState()
        .fetchColumns("conn-1", "mydb", "users");

      expect(result).toEqual([]);
    });
  });

  describe("refreshSchema", () => {
    it("clears all caches and refetches databases", async () => {
      mockGetDatabases.mockResolvedValue([
        { name: "new_db" },
      ]);
      mockGetTables.mockResolvedValue([]);

      useSchemaCache.setState({
        connectionId: "conn-1",
        databases: ["old_db"],
        tables: new Map([["old_db", ["old_table"]]]),
        views: new Map([["old_db", ["old_view"]]]),
        routines: new Map([["old_db", ["old_routine"]]]),
        triggers: new Map([["old_db", ["old_trigger"]]]),
        columns: new Map([["old_db.old_table", []]]),
      });

      await useSchemaCache.getState().refreshSchema();

      const state = useSchemaCache.getState();
      expect(state.databases).toEqual(["new_db"]);
      // After refresh, fetchDatabases eagerly fetches tables for all new databases,
      // so tables Map has an entry for "new_db" (even if empty result).
      expect(state.tables.get("new_db")).toEqual([]);
      expect(state.views.size).toBe(0);
      expect(state.routines.size).toBe(0);
      expect(state.triggers.size).toBe(0);
      expect(state.columns.size).toBe(0);
      expect(mockGetDatabases).toHaveBeenCalledWith("conn-1");
    });

    it("does nothing when connectionId is null", async () => {
      useSchemaCache.setState({ connectionId: null });

      await useSchemaCache.getState().refreshSchema();

      expect(mockGetDatabases).not.toHaveBeenCalled();
    });
  });
});
