import { describe, it, expect, beforeEach, vi } from "vitest";

const { executeQueryMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn().mockResolvedValue([]),
}));

const addEntryMock = vi.hoisted(() => vi.fn());

let connectionStoreState = {
  activeConnections: [] as any[],
  profiles: [] as any[],
};
let settingsStoreState = {
  querySettings: { limitEnabled: true, maxResultRows: 1000 },
};

vi.mock("../../lib/tauri-api", () => ({
  api: { executeQuery: executeQueryMock },
}));

vi.mock("../historyStore", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      addEntry: addEntryMock,
    })),
  },
}));

vi.mock("../connectionStore", () => ({
  useConnectionStore: {
    getState: vi.fn(() => connectionStoreState),
  },
}));

vi.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: vi.fn(() => settingsStoreState),
  },
}));

import { useResultStore } from "../resultStore";

function makeQueryResult(overrides: Partial<any> = {}) {
  return {
    query_id: "q1",
    statement_index: 0,
    columns: [],
    rows: [["row1"]],
    rows_affected: 0,
    execution_time_ms: 10,
    warnings: [],
    rows_truncated: false,
    ...overrides,
  };
}

describe("resultStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useResultStore.setState({
      results: [],
      activeResultIndex: 0,
      isExecuting: false,
      error: null,
      explainResult: null,
      explainAnalyze: false,
      showExplain: false,
      confirmDialog: null,
    });
    executeQueryMock.mockResolvedValue([]);
    connectionStoreState = {
      activeConnections: [],
      profiles: [],
    };
    settingsStoreState = {
      querySettings: { limitEnabled: true, maxResultRows: 1000 },
    };
  });

  describe("setActiveResult", () => {
    it("sets active result index", () => {
      useResultStore.getState().setActiveResult(2);
      expect(useResultStore.getState().activeResultIndex).toBe(2);
    });
  });

  describe("clearResults", () => {
    it("clears results, explain, and showExplain", () => {
      useResultStore.setState({
        results: [makeQueryResult()],
        explainResult: makeQueryResult(),
        showExplain: true,
      });
      useResultStore.getState().clearResults();
      const state = useResultStore.getState();
      expect(state.results).toHaveLength(0);
      expect(state.activeResultIndex).toBe(0);
      expect(state.error).toBeNull();
      expect(state.explainResult).toBeNull();
      expect(state.showExplain).toBe(false);
    });
  });

  describe("clearError", () => {
    it("clears error", () => {
      useResultStore.setState({ error: "some error" });
      useResultStore.getState().clearError();
      expect(useResultStore.getState().error).toBeNull();
    });
  });

  describe("setShowExplain", () => {
    it("sets showExplain to true", () => {
      useResultStore.getState().setShowExplain(true);
      expect(useResultStore.getState().showExplain).toBe(true);
    });

    it("sets showExplain to false", () => {
      useResultStore.setState({ showExplain: true });
      useResultStore.getState().setShowExplain(false);
      expect(useResultStore.getState().showExplain).toBe(false);
    });
  });

  describe("cancelExecution", () => {
    it("clears confirmDialog", () => {
      useResultStore.setState({
        confirmDialog: {
          isOpen: true,
          connectionId: "conn-1",
          sql: "DROP TABLE users",
        },
      });
      useResultStore.getState().cancelExecution();
      expect(useResultStore.getState().confirmDialog).toBeNull();
    });
  });

  describe("executeQuery", () => {
    it("executes query successfully and adds history entry", async () => {
      const result = makeQueryResult();
      executeQueryMock.mockResolvedValue([result]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined, 1000);
      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: "SELECT 1",
          connectionName: "Unknown",
          status: "success",
        }),
      );

      const state = useResultStore.getState();
      expect(state.results).toEqual([result]);
      expect(state.activeResultIndex).toBe(0);
      expect(state.isExecuting).toBe(false);
    });

    it("executes query with database param", async () => {
      const result = makeQueryResult();
      executeQueryMock.mockResolvedValue([result]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1", "mydb");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", "mydb", 1000);
    });

    it("uses connection name and database in history entry", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1", name: "MyDB", database: "defaultdb" },
      ];
      connectionStoreState.profiles = [{ id: "p1", environment: "development" }];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionName: "MyDB",
          database: "defaultdb",
          status: "success",
        }),
      );
    });

    it("uses explicit database over connection default", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1", name: "MyDB", database: "defaultdb" },
      ];
      connectionStoreState.profiles = [{ id: "p1", environment: "development" }];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1", "otherdb");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", "otherdb", 1000);
      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ database: "otherdb" }),
      );
    });

    it("handles query error and adds error history entry", async () => {
      executeQueryMock.mockRejectedValue(new Error("syntax error"));

      await useResultStore.getState().executeQuery("conn-1", "BAD SQL");

      const state = useResultStore.getState();
      expect(state.error).toContain("syntax error");
      expect(state.isExecuting).toBe(false);
      expect(state.results).toEqual([]);

      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: "BAD SQL",
          status: "error",
          error: expect.stringContaining("syntax error"),
          rowCount: 0,
        }),
      );
    });

    it("shows confirm dialog for destructive SQL on production", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [
        { id: "p1", environment: "production" },
      ];

      await useResultStore.getState().executeQuery("conn-1", "DROP TABLE users");

      expect(executeQueryMock).not.toHaveBeenCalled();
      const dialog = useResultStore.getState().confirmDialog;
      expect(dialog).toEqual({
        isOpen: true,
        connectionId: "conn-1",
        sql: "DROP TABLE users",
        database: undefined,
      });
    });

    it("shows confirm dialog for destructive SQL on production with database", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [
        { id: "p1", environment: "production" },
      ];

      await useResultStore.getState().executeQuery("conn-1", "DELETE FROM users", "mydb");

      const dialog = useResultStore.getState().confirmDialog;
      expect(dialog).toEqual({
        isOpen: true,
        connectionId: "conn-1",
        sql: "DELETE FROM users",
        database: "mydb",
      });
    });

    it("shows confirm dialog for TRUNCATE on production", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [
        { id: "p1", environment: "production" },
      ];

      await useResultStore.getState().executeQuery("conn-1", "TRUNCATE TABLE logs");

      expect(executeQueryMock).not.toHaveBeenCalled();
      expect(useResultStore.getState().confirmDialog).not.toBeNull();
    });

    it("shows confirm dialog for ALTER on production", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [
        { id: "p1", environment: "production" },
      ];

      await useResultStore.getState().executeQuery("conn-1", "ALTER TABLE users ADD COLUMN x INT");

      expect(executeQueryMock).not.toHaveBeenCalled();
      expect(useResultStore.getState().confirmDialog).not.toBeNull();
    });

    it("proceeds normally for non-destructive SQL on production", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [
        { id: "p1", environment: "production" },
      ];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalled();
      expect(useResultStore.getState().confirmDialog).toBeNull();
    });

    it("proceeds normally for destructive SQL on development", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [
        { id: "p1", environment: "development" },
      ];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "DROP TABLE users");

      expect(executeQueryMock).toHaveBeenCalled();
      expect(useResultStore.getState().confirmDialog).toBeNull();
    });

    it("proceeds normally for destructive SQL when profile has no environment", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      connectionStoreState.profiles = [{ id: "p1" }];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "DROP TABLE users");

      expect(executeQueryMock).toHaveBeenCalled();
    });

    it("proceeds normally when connection not found", async () => {
      connectionStoreState.activeConnections = [];
      connectionStoreState.profiles = [];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("unknown-conn", "DROP TABLE users");

      expect(executeQueryMock).toHaveBeenCalled();
    });

    it("passes rowLimit from settings when limitEnabled is true", async () => {
      settingsStoreState.querySettings = { limitEnabled: true, maxResultRows: 500 };
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined, 500);
    });

    it("passes undefined rowLimit when limitEnabled is false", async () => {
      settingsStoreState.querySettings = { limitEnabled: false, maxResultRows: 500 };
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined, undefined);
    });
  });

  describe("confirmExecution", () => {
    it("calls doExecuteQuery when dialog exists", async () => {
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      useResultStore.setState({
        confirmDialog: {
          isOpen: true,
          connectionId: "conn-1",
          sql: "DROP TABLE users",
          database: "mydb",
        },
      });

      await useResultStore.getState().confirmExecution();

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "DROP TABLE users", "mydb", 1000);
      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: "DROP TABLE users",
          database: "mydb",
          status: "success",
        }),
      );
      expect(useResultStore.getState().confirmDialog).toBeNull();
    });

    it("does nothing when no dialog", async () => {
      useResultStore.setState({ confirmDialog: null });

      await useResultStore.getState().confirmExecution();

      expect(executeQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("executeExplain", () => {
    it("executes EXPLAIN query successfully", async () => {
      const explainResult = makeQueryResult({ query_id: "explain1" });
      executeQueryMock.mockResolvedValue([explainResult]);

      await useResultStore.getState().executeExplain("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "EXPLAIN SELECT 1", undefined);
      const state = useResultStore.getState();
      expect(state.explainResult).toEqual(explainResult);
      expect(state.explainAnalyze).toBe(false);
      expect(state.showExplain).toBe(true);
      expect(state.isExecuting).toBe(false);
    });

    it("handles EXPLAIN error", async () => {
      executeQueryMock.mockRejectedValue(new Error("explain failed"));

      await useResultStore.getState().executeExplain("conn-1", "SELECT 1");

      expect(useResultStore.getState().error).toContain("explain failed");
      expect(useResultStore.getState().isExecuting).toBe(false);
    });
  });

  describe("executeExplainAnalyze", () => {
    it("uses ANALYZE prefix for MariaDB", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1", server_version: "10.6.5-MariaDB" },
      ];
      const result = makeQueryResult({ query_id: "analyze1" });
      executeQueryMock.mockResolvedValue([result]);

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "ANALYZE SELECT 1", undefined);
      const state = useResultStore.getState();
      expect(state.explainResult).toEqual(result);
      expect(state.explainAnalyze).toBe(true);
      expect(state.showExplain).toBe(true);
      expect(state.isExecuting).toBe(false);
    });

    it("uses EXPLAIN ANALYZE prefix for MySQL", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1", server_version: "8.0.35" },
      ];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "EXPLAIN ANALYZE SELECT 1", undefined);
    });

    it("uses EXPLAIN ANALYZE prefix when server_version is undefined", async () => {
      connectionStoreState.activeConnections = [
        { id: "conn-1", profile_id: "p1" },
      ];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "EXPLAIN ANALYZE SELECT 1", undefined);
    });

    it("uses EXPLAIN ANALYZE when connection not found", async () => {
      connectionStoreState.activeConnections = [];
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "EXPLAIN ANALYZE SELECT 1", undefined);
    });

    it("handles ANALYZE error", async () => {
      executeQueryMock.mockRejectedValue(new Error("analyze failed"));

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(useResultStore.getState().error).toContain("analyze failed");
      expect(useResultStore.getState().isExecuting).toBe(false);
    });
  });
});
