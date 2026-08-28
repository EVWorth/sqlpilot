import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeQueryMock, explainQueryMock, cancelQueryMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn().mockResolvedValue([]),
  explainQueryMock: vi.fn(),
  cancelQueryMock: vi.fn().mockResolvedValue(undefined),
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
  api: {
    executeQuery: executeQueryMock,
    explainQuery: explainQueryMock,
    cancelQuery: cancelQueryMock,
  },
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

function makeExplainResponse(overrides: Partial<any> = {}) {
  return {
    result: makeQueryResult({ query_id: "explain1" }),
    analyzed: false,
    refusal: null,
    tabular: true,
    ...overrides,
  };
}

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
      explainTabular: false,
      explainNotice: null,
      showExplain: false,
      confirmDialog: null,
    });
    explainQueryMock.mockResolvedValue(makeExplainResponse());
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
        kind: "query",
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
        kind: "query",
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
    it("asks the backend to plan without analyzing", async () => {
      const response = makeExplainResponse();
      explainQueryMock.mockResolvedValue(response);

      await useResultStore.getState().executeExplain("conn-1", "SELECT 1");

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", false, undefined);
      const state = useResultStore.getState();
      expect(state.explainResult).toEqual(response.result);
      expect(state.explainAnalyze).toBe(false);
      expect(state.showExplain).toBe(true);
      expect(state.isExecuting).toBe(false);
    });

    it("passes the raw editor text through — the backend normalizes it", async () => {
      // Trailing semicolons and multi-statement rejection are the backend's
      // job now, so the store must not pre-chew the SQL (#418).
      await useResultStore.getState().executeExplain("conn-1", "SELECT 1;", "mydb");

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1;", false, "mydb");
    });

    it("surfaces a backend rejection as an error", async () => {
      explainQueryMock.mockRejectedValue(new Error("EXPLAIN supports a single statement"));

      await useResultStore.getState().executeExplain("conn-1", "SELECT 1; SELECT 2;");

      expect(useResultStore.getState().error).toContain("single statement");
      expect(useResultStore.getState().isExecuting).toBe(false);
    });

    it("records whether the plan is tabular", async () => {
      explainQueryMock.mockResolvedValue(makeExplainResponse({ tabular: false }));

      await useResultStore.getState().executeExplain("conn-1", "SELECT 1");

      expect(useResultStore.getState().explainTabular).toBe(false);
    });
  });

  describe("executeExplainAnalyze", () => {
    it("asks the backend to analyze", async () => {
      explainQueryMock.mockResolvedValue(makeExplainResponse({ analyzed: true }));

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", true, undefined);
      const state = useResultStore.getState();
      expect(state.explainAnalyze).toBe(true);
      expect(state.explainNotice).toBeNull();
      expect(state.showExplain).toBe(true);
    });

    it("explains why a write was planned instead of analyzed", async () => {
      explainQueryMock.mockResolvedValue(
        makeExplainResponse({ analyzed: false, refusal: "would_mutate" }),
      );

      await useResultStore.getState().executeExplainAnalyze("conn-1", "DELETE FROM users");

      const state = useResultStore.getState();
      expect(state.explainAnalyze).toBe(false);
      expect(state.explainNotice).toContain("executes the statement");
      expect(state.showExplain).toBe(true);
    });

    it("explains a refusal on a read-only connection", async () => {
      explainQueryMock.mockResolvedValue(
        makeExplainResponse({ analyzed: false, refusal: "read_only_connection" }),
      );

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(useResultStore.getState().explainNotice).toContain("read-only");
    });

    it("clears a stale notice on the next run", async () => {
      useResultStore.setState({ explainNotice: "old news" });
      explainQueryMock.mockResolvedValue(makeExplainResponse({ analyzed: true }));

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(useResultStore.getState().explainNotice).toBeNull();
    });

    it("confirms before analyzing on a production connection", async () => {
      connectionStoreState.activeConnections = [{ id: "conn-1", profile_id: "p1" }];
      connectionStoreState.profiles = [{ id: "p1", environment: "production" }];

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      // ANALYZE runs the query for real, so production is gated even for a read.
      expect(explainQueryMock).not.toHaveBeenCalled();
      expect(useResultStore.getState().confirmDialog).toMatchObject({
        isOpen: true,
        kind: "explain-analyze",
        connectionId: "conn-1",
        sql: "SELECT 1",
      });
    });

    it("analyzes once the production confirmation is accepted", async () => {
      connectionStoreState.activeConnections = [{ id: "conn-1", profile_id: "p1" }];
      connectionStoreState.profiles = [{ id: "p1", environment: "production" }];
      explainQueryMock.mockResolvedValue(makeExplainResponse({ analyzed: true }));

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");
      await useResultStore.getState().confirmExecution();

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", true, undefined);
      expect(useResultStore.getState().confirmDialog).toBeNull();
      expect(useResultStore.getState().explainAnalyze).toBe(true);
    });

    it("runs nothing when the production confirmation is declined", async () => {
      connectionStoreState.activeConnections = [{ id: "conn-1", profile_id: "p1" }];
      connectionStoreState.profiles = [{ id: "p1", environment: "production" }];

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");
      useResultStore.getState().cancelExecution();

      expect(explainQueryMock).not.toHaveBeenCalled();
      expect(executeQueryMock).not.toHaveBeenCalled();
      expect(useResultStore.getState().confirmDialog).toBeNull();
    });

    it("handles ANALYZE error", async () => {
      explainQueryMock.mockRejectedValue(new Error("analyze failed"));

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1");

      expect(useResultStore.getState().error).toContain("analyze failed");
      expect(useResultStore.getState().isExecuting).toBe(false);
    });
  });

  describe("cancelActiveQuery", () => {
    it("sets isExecuting to false", async () => {
      useResultStore.setState({ isExecuting: true });

      await useResultStore.getState().cancelActiveQuery();

      expect(useResultStore.getState().isExecuting).toBe(false);
    });

    it("sets error message", async () => {
      await useResultStore.getState().cancelActiveQuery();

      expect(useResultStore.getState().error).toBe("Query cancelled by user");
    });

    it("tells the server to stop the statement it is running", async () => {
      let resolveQuery: (value: any) => void;
      executeQueryMock.mockReturnValue(
        new Promise((r) => {
          resolveQuery = r;
        }),
      );

      const pending = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(60)");
      await useResultStore.getState().cancelActiveQuery();

      // Dropping the promise alone would leave SLEEP(60) running server-side.
      expect(cancelQueryMock).toHaveBeenCalledWith("conn-1");

      resolveQuery!([]);
      await pending;
    });

    it("cancels the connection an EXPLAIN ANALYZE is running on", async () => {
      let resolveExplain: (value: any) => void;
      explainQueryMock.mockReturnValue(
        new Promise((r) => {
          resolveExplain = r;
        }),
      );

      const pending = useResultStore.getState().executeExplainAnalyze("conn-9", "SELECT SLEEP(60)");
      await useResultStore.getState().cancelActiveQuery();

      expect(cancelQueryMock).toHaveBeenCalledWith("conn-9");

      resolveExplain!(makeExplainResponse());
      await pending;
    });

    it("does not call the server when nothing is in flight", async () => {
      await useResultStore.getState().cancelActiveQuery();

      expect(cancelQueryMock).not.toHaveBeenCalled();
    });

    it("reports a cancel the server would not confirm", async () => {
      cancelQueryMock.mockRejectedValue(new Error("connection lost"));
      let resolveQuery: (value: any) => void;
      executeQueryMock.mockReturnValue(
        new Promise((r) => {
          resolveQuery = r;
        }),
      );

      const pending = useResultStore.getState().executeQuery("conn-1", "SELECT 1");
      await useResultStore.getState().cancelActiveQuery();

      expect(useResultStore.getState().error).toContain("did not confirm");

      resolveQuery!([]);
      await pending;
    });

    it("does not apply results after cancellation", async () => {
      const results = [makeQueryResult()];
      let resolveQuery: (value: any) => void;
      const deferred = new Promise<any>((resolve) => {
        resolveQuery = resolve;
      });
      executeQueryMock.mockReturnValue(deferred);

      useResultStore.setState({
        activeConnections: [
          {
            id: "conn-1",
            name: "Test",
            server_version: "8.0",
            database: "testdb",
          },
        ],
      });

      const queryPromise = useResultStore.getState().executeQuery("conn-1", "SELECT 1");
      useResultStore.getState().cancelActiveQuery();

      resolveQuery!(results);
      await queryPromise;

      // Results should be empty since the query was cancelled
      expect(useResultStore.getState().results).toEqual([]);
    });
  });
});
