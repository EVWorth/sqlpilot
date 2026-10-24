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
    closeSession: vi.fn().mockResolvedValue(undefined),
  },
  // Stands in for the real class so `instanceof` in the store resolves against
  // the same constructor the tests throw.
  CommandError: class CommandError extends Error {
    code?: number;
    sqlState?: string;
    constructor(message: string, fields?: { code?: number | null; sqlState?: string | null }) {
      super(message);
      // Left as "Error" deliberately: the app shows raw `String(e)` in
      // several places, and renaming would prefix every one of them.
      if (fields?.code != null) this.code = fields.code;
      if (fields?.sqlState != null) this.sqlState = fields.sqlState;
    }
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

import { noteGridEdits, resetGridEdits } from "../../lib/unsaved-grid-edits";
import type { EditorTab, QueryResult } from "../../types";
import { useEditorStore } from "../editorStore";
import { useProductionGuardStore } from "../productionGuardStore";
import { anyTabExecuting, followEditorStore, useResultStore } from "../resultStore";

// The grid's unsaved-edit counts are module state; one test's must not make
// another's run ask first (#865).
beforeEach(() => resetGridEdits());

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
    // The backend reports the statement each result came from (#329).
    sql: "SELECT 1",
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
      cancelledAfterMs: null,
      explainResult: null,
      explainAnalyze: false,
      explainTabular: false,
      explainNotice: null,
      showExplain: false,
      confirmDialog: null,
      viewTabId: null,
      parked: {},
    });
    explainQueryMock.mockResolvedValue(makeExplainResponse());
    executeQueryMock.mockResolvedValue([]);
    // A connection that exists is the ordinary case. Leaving the list empty
    // modelled a state the app should not be in — executing against a
    // connection it does not hold — and #328 turns that into "record nothing",
    // so the default has to be realistic.
    connectionStoreState = {
      activeConnections: [{ id: "conn-1", profile_id: "p1", name: "Test DB" }],
      profiles: [{ id: "p1", environment: "development" }],
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

  describe("result source (#735)", () => {
    // A grid edit to the result on screen is saved on the session it was
    // read on, and the refresh after it reads from there too.
    it("remembers the tab session and database the result was read on", async () => {
      executeQueryMock.mockResolvedValue([makeQueryResult()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM tmp", "shop", "tab-7");

      expect(useResultStore.getState().resultSource).toEqual({
        connectionId: "conn-1",
        database: "shop",
        session: "tab-7",
      });
    });

    it("forgets it when the results go", async () => {
      executeQueryMock.mockResolvedValue([makeQueryResult()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT 1", "shop", "tab-7");

      useResultStore.getState().clearResults();

      expect(useResultStore.getState().resultSource).toBeNull();
    });

    it("forgets it when the statement fails", async () => {
      executeQueryMock.mockResolvedValue([makeQueryResult()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT 1", "shop", "tab-7");
      executeQueryMock.mockRejectedValue(new Error("Table 'shop.nope' doesn't exist"));

      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM nope", "shop", "tab-7");

      expect(useResultStore.getState().resultSource).toBeNull();
    });
  });

  describe("paging (#391)", () => {
    /** A page that came back exactly full, which is how "there may be more" is known. */
    const fullPage = () => makeQueryResult({ rows: Array.from({ length: 1000 }, () => ["x"]) });

    it("offers no paging for a result that fitted inside the limit", async () => {
      // Page controls on a complete answer invite a round trip that fetches
      // nothing.
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(useResultStore.getState().page).toBeNull();
    });

    it("offers paging once a page fills up", async () => {
      executeQueryMock.mockResolvedValue([fullPage()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");

      expect(useResultStore.getState().page).toMatchObject({
        index: 0,
        size: 1000,
        hasMore: true,
      });
    });

    it("skips the rows already shown rather than rewriting the SQL", async () => {
      // Appending LIMIT/OFFSET breaks SHOW, locking clauses and trailing
      // comments; the executor discards rows as it reads instead.
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big", "shop");

      await useResultStore.getState().goToPage(1);

      expect(executeQueryMock).toHaveBeenLastCalledWith(
        "conn-1",
        "SELECT * FROM big",
        "shop",
        1000,
        1000,
        undefined,
      );
      expect(useResultStore.getState().page).toMatchObject({ index: 1 });
    });

    it("reads a later page on the tab session the first page came from", async () => {
      // A temporary table or a session variable the statement uses exists
      // only on that session; a page read anywhere else would not find it
      // (#731).
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM tmp", "shop", "tab-7");

      await useResultStore.getState().goToPage(1);

      expect(executeQueryMock).toHaveBeenLastCalledWith(
        "conn-1",
        "SELECT * FROM tmp",
        "shop",
        1000,
        1000,
        "tab-7",
      );
    });

    it("recognises the last page by it coming back short", async () => {
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");

      executeQueryMock.mockResolvedValue([makeQueryResult({ rows: [["x"]] })]);
      await useResultStore.getState().goToPage(1);

      expect(useResultStore.getState().page).toMatchObject({ index: 1, hasMore: false });
    });

    it("keeps the controls on a short last page so the way back stays", async () => {
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");

      executeQueryMock.mockResolvedValue([makeQueryResult({ rows: [["x"]] })]);
      await useResultStore.getState().goToPage(1);

      expect(useResultStore.getState().page).not.toBeNull();
    });

    it("does not record a history entry for every Next click", async () => {
      // The statement was run once; one row in history is the honest record.
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");
      addEntryMock.mockClear();

      await useResultStore.getState().goToPage(1);

      expect(addEntryMock).not.toHaveBeenCalled();
    });

    it("ignores a page change with nothing to page", async () => {
      executeQueryMock.mockResolvedValue([makeQueryResult()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");
      executeQueryMock.mockClear();

      await useResultStore.getState().goToPage(1);

      expect(executeQueryMock).not.toHaveBeenCalled();
    });

    it("will not page before the first page", async () => {
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");
      executeQueryMock.mockClear();

      await useResultStore.getState().goToPage(-1);

      expect(executeQueryMock).not.toHaveBeenCalled();
    });

    it("forgets the page when a different query runs", async () => {
      executeQueryMock.mockResolvedValue([fullPage()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");

      executeQueryMock.mockResolvedValue([makeQueryResult()]);
      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(useResultStore.getState().page).toBeNull();
    });
  });

  describe("unsaved grid edits (#865)", () => {
    it("asks before a run would discard the tab's unsaved edits, and runs nothing if declined", async () => {
      noteGridEdits("tab-1", 2);
      const outcome = useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "tab-1");

      await vi.waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());
      expect(useProductionGuardStore.getState().pending?.message).toMatch(/2 unsaved change/);
      useProductionGuardStore.getState().answer(false);

      expect(await outcome).toEqual({ status: "cancelled" });
      expect(executeQueryMock).not.toHaveBeenCalled();
    });

    it("runs once the user agrees to discard them", async () => {
      noteGridEdits("tab-1", 1);
      executeQueryMock.mockResolvedValue([makeQueryResult()]);
      const outcome = useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "tab-1");

      await vi.waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());
      useProductionGuardStore.getState().answer(true);

      expect((await outcome).status).toBe("succeeded");
      expect(executeQueryMock).toHaveBeenCalledTimes(1);
    });

    it("does not ask about another tab's edits", async () => {
      noteGridEdits("tab-2", 3);
      await useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "tab-1");

      expect(useProductionGuardStore.getState().pending).toBeNull();
      expect(executeQueryMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("executeQuery", () => {
    it("executes query successfully and adds history entry", async () => {
      const result = makeQueryResult();
      executeQueryMock.mockResolvedValue([result]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined, 1000, undefined, undefined);
      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: "SELECT 1",
          connectionName: "Test DB",
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

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", "mydb", 1000, undefined, undefined);
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

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", "otherdb", 1000, undefined, undefined);
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

    it("records the driver code and SQLSTATE on a failed query (#324)", async () => {
      const { CommandError } = await import("../../lib/tauri-api");
      executeQueryMock.mockRejectedValue(
        new CommandError("Table 'app.user' doesn't exist", { code: 1146, sqlState: "42S02" }),
      );

      await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM user");

      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          error: "Table 'app.user' doesn't exist",
          errorCode: 1146,
          errorSqlState: "42S02",
        }),
      );
    });

    it("leaves the code fields empty when the failure carried none", async () => {
      executeQueryMock.mockRejectedValue(new Error("connection reset"));

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      const entry = addEntryMock.mock.calls.at(-1)?.[0];
      expect(entry.error).toContain("connection reset");
      // null rather than undefined: Rust's Option round-trips as null, and the
      // entry now goes straight to a Tauri command (#585).
      expect(entry.errorCode).toBeNull();
      expect(entry.errorSqlState).toBeNull();
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
      expect(dialog).toMatchObject({
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
      expect(dialog).toMatchObject({
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

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined, 500, undefined, undefined);
    });

    it("passes undefined rowLimit when limitEnabled is false", async () => {
      settingsStoreState.querySettings = { limitEnabled: false, maxResultRows: 500 };
      executeQueryMock.mockResolvedValue([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined, undefined, undefined, undefined);
    });
  });

  describe("confirmExecution", () => {
    it("runs a confirmed statement on the session it was asked for on", async () => {
      // Confirming happens after the fact; the statement still belongs to the
      // tab that ran it, and to that tab's open transaction if it has one.
      executeQueryMock.mockResolvedValue([makeQueryResult({ sql: "DROP TABLE users" })]);
      useResultStore.setState({
        confirmDialog: {
          isOpen: true,
          kind: "query",
          connectionId: "conn-1",
          sql: "DROP TABLE users",
          database: "mydb",
          session: "tab-4",
        },
      });

      await useResultStore.getState().confirmExecution();

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "DROP TABLE users", "mydb", 1000, undefined, "tab-4");
    });

    it("calls doExecuteQuery when dialog exists", async () => {
      // The entry records the statement the *result* names, so the fixture has
      // to agree with what was run (#329).
      executeQueryMock.mockResolvedValue([makeQueryResult({ sql: "DROP TABLE users" })]);

      useResultStore.setState({
        confirmDialog: {
          isOpen: true,
          connectionId: "conn-1",
          sql: "DROP TABLE users",
          database: "mydb",
        },
      });

      await useResultStore.getState().confirmExecution();

      expect(executeQueryMock).toHaveBeenCalledWith("conn-1", "DROP TABLE users", "mydb", 1000, undefined, undefined);
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

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", false, undefined, "classic", undefined);
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

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1;", false, "mydb", "classic", undefined);
    });

    it("plans on the tab's own session", async () => {
      // A plan made anywhere but the tab's session cannot see its temporary
      // tables or session settings (#731).
      explainQueryMock.mockResolvedValue(makeExplainResponse());

      await useResultStore.getState().executeExplain("conn-1", "SELECT 1", "mydb", "classic", "tab-2");

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", false, "mydb", "classic", "tab-2");
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

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", true, undefined, "classic", undefined);
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

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", true, undefined, "classic", undefined);
      expect(useResultStore.getState().confirmDialog).toBeNull();
      expect(useResultStore.getState().explainAnalyze).toBe(true);
    });

    it("analyzes in the format asked for once confirmed", async () => {
      // Read back from the store on approval it was the shown tab's format,
      // and the one passed in was dropped.
      connectionStoreState.activeConnections = [{ id: "conn-1", profile_id: "p1" }];
      connectionStoreState.profiles = [{ id: "p1", environment: "production" }];
      useResultStore.setState({ explainRequestedFormat: "classic" });
      explainQueryMock.mockResolvedValue(makeExplainResponse({ analyzed: true }));

      await useResultStore.getState().executeExplainAnalyze("conn-1", "SELECT 1", "shop", "tree");
      await useResultStore.getState().confirmExecution();

      expect(explainQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 1", true, "shop", "tree", undefined);
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
    // #860: the previous plan stayed up, reading as the cancelled one's.
    it("clears the previous plan when the run cancelled is an Explain", async () => {
      useResultStore.setState({
        explainResult: makeQueryResult({ query_id: "old-plan" }) as QueryResult,
        showExplain: true,
        explainNotice: "old notice",
      });
      explainQueryMock.mockReturnValueOnce(new Promise<never>(() => {}));
      void useResultStore.getState().executeExplain("conn-1", "SELECT * FROM big");

      await useResultStore.getState().cancelActiveQuery();

      const state = useResultStore.getState();
      expect(state.explainResult).toBeNull();
      expect(state.showExplain).toBe(false);
      expect(state.explainNotice).toBeNull();
      expect(state.cancelledAfterMs).not.toBeNull();
    });

    it("keeps the plan when the run cancelled is a query", async () => {
      const plan = makeQueryResult({ query_id: "plan" }) as QueryResult;
      useResultStore.setState({ explainResult: plan, showExplain: true });
      executeQueryMock.mockReturnValueOnce(new Promise<never>(() => {}));
      void useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)");

      await useResultStore.getState().cancelActiveQuery();

      expect(useResultStore.getState().explainResult).toBe(plan);
    });

    it("sets isExecuting to false", async () => {
      useResultStore.setState({ isExecuting: true });

      await useResultStore.getState().cancelActiveQuery();

      expect(useResultStore.getState().isExecuting).toBe(false);
    });

    // #850: the user's own cancel is information, not a "Query Error", and the
    // previous query's rows must not stay on screen as if they were this one's.
    it("records the cancel as a neutral state and clears the stale result", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const slow = new Promise<never>(() => {});
        executeQueryMock.mockReturnValueOnce(slow);
        useResultStore.setState({ results: [makeQueryResult({ rows: [["old"]] })] as QueryResult[] });
        void useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)");
        vi.setSystemTime(11_200);

        await useResultStore.getState().cancelActiveQuery();

        const state = useResultStore.getState();
        expect(state.error).toBeNull();
        expect(state.cancelledAfterMs).toBe(1200);
        expect(state.results).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves an idle tab's results alone", async () => {
      useResultStore.setState({
        isExecuting: false,
        results: [makeQueryResult({ rows: [["kept"]] })] as QueryResult[],
      });

      await useResultStore.getState().cancelActiveQuery();

      const state = useResultStore.getState();
      expect(state.results).toHaveLength(1);
      expect(state.cancelledAfterMs).toBeNull();
    });

    it("clears the cancelled state when the next query starts", async () => {
      useResultStore.setState({ isExecuting: true, executionStartedAt: Date.now() });
      await useResultStore.getState().cancelActiveQuery();
      expect(useResultStore.getState().cancelledAfterMs).not.toBeNull();
      executeQueryMock.mockResolvedValueOnce([makeQueryResult()]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1");

      expect(useResultStore.getState().cancelledAfterMs).toBeNull();
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
      expect(cancelQueryMock).toHaveBeenCalledWith("conn-1", undefined);

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

      expect(cancelQueryMock).toHaveBeenCalledWith("conn-9", undefined);

      resolveExplain!(makeExplainResponse());
      await pending;
    });

    it("does not call the server when nothing is in flight", async () => {
      await useResultStore.getState().cancelActiveQuery();

      expect(cancelQueryMock).not.toHaveBeenCalled();
    });

    it("keeps the cancellation message when the killed query rejects", async () => {
      // KILL QUERY makes the in-flight call reject with the server's interrupt
      // error. Surfacing that would bury the message the user asked for.
      let rejectQuery: (e: unknown) => void;
      executeQueryMock.mockReturnValue(
        new Promise((_, reject) => {
          rejectQuery = reject;
        }),
      );

      const pending = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(60)");
      await useResultStore.getState().cancelActiveQuery();
      rejectQuery!(new Error("Query execution was interrupted"));
      await pending;

      expect(useResultStore.getState().error).toBeNull();
      expect(useResultStore.getState().cancelledAfterMs).not.toBeNull();
      expect(addEntryMock).not.toHaveBeenCalled();
    });

    it("does not log a cancelled query to history as a failure", async () => {
      let rejectQuery: (e: unknown) => void;
      executeQueryMock.mockReturnValue(
        new Promise((_, reject) => {
          rejectQuery = reject;
        }),
      );

      const pending = useResultStore.getState().executeQuery("conn-1", "SELECT 1");
      await useResultStore.getState().cancelActiveQuery();
      rejectQuery!(new Error("Query execution was interrupted"));
      await pending;

      const errorEntries = addEntryMock.mock.calls.filter(([e]) => e.status === "error");
      expect(errorEntries).toHaveLength(0);
    });

    it("still cancels the newer query when an older one finishes first", async () => {
      // The slot is tagged with the generation that opened it, so a slower
      // earlier execution settling must not deregister the current one.
      let resolveFirst: (v: unknown) => void;
      executeQueryMock.mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        }),
      );
      const first = useResultStore.getState().executeQuery("conn-old", "SELECT 1");

      explainQueryMock.mockReturnValue(new Promise(() => {}));
      void useResultStore.getState().executeExplain("conn-new", "SELECT 2");

      // The earlier execution completes after the newer one took the slot.
      resolveFirst!([]);
      await first;

      await useResultStore.getState().cancelActiveQuery();
      expect(cancelQueryMock).toHaveBeenCalledWith("conn-new", undefined);
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

  describe("an execution with no live connection (#328)", () => {
    it("records nothing when the failed query never had a connection", async () => {
      connectionStoreState.activeConnections = [];
      executeQueryMock.mockRejectedValue(new Error("connection not found"));

      await useResultStore.getState().executeQuery("gone", "SELECT 1");

      // Fifty rows saying "Unknown connection" are fifty rows nobody can act
      // on or trace back to anything.
      expect(addEntryMock).not.toHaveBeenCalled();
      expect(useResultStore.getState().error).toContain("connection not found");
    });

    it("still records a query that succeeded, even unattributed", async () => {
      // The statement ran. Dropping the record because the frontend's
      // connection list is out of step would lose a real event.
      connectionStoreState.activeConnections = [];
      executeQueryMock.mockResolvedValue([{ columns: [], rows: [] }]);

      await useResultStore.getState().executeQuery("gone", "SELECT 1");

      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: "success", connectionName: "Unknown connection" }),
      );
    });

    it("records a failure normally when the connection is there", async () => {
      executeQueryMock.mockRejectedValue(new Error("syntax error"));

      await useResultStore.getState().executeQuery("conn-1", "BAD SQL");

      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", connectionName: "Test DB" }),
      );
    });
  });

  describe("multi-statement runs (#329)", () => {
    it("records one entry per statement, not one for the batch", async () => {
      executeQueryMock.mockResolvedValue([
        makeQueryResult({ statement_index: 0, sql: "SELECT 1", rows: [["a"]] }),
        makeQueryResult({ statement_index: 1, sql: "SELECT 2", rows: [["b"], ["c"]] }),
      ]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1; SELECT 2");

      expect(addEntryMock).toHaveBeenCalledTimes(2);
      expect(addEntryMock.mock.calls.map(([e]) => e.sql)).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("attributes each row count to its own statement", async () => {
      executeQueryMock.mockResolvedValue([
        makeQueryResult({ sql: "SELECT 1", rows: [["a"]] }),
        makeQueryResult({ sql: "SELECT 2", rows: [["b"], ["c"]] }),
      ]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1; SELECT 2");

      expect(addEntryMock.mock.calls.map(([e]) => e.rowCount)).toEqual([1, 2]);
    });

    it("falls back to the whole script when a result carries no statement", async () => {
      // A backend that does not report per-statement text should leave the
      // panel showing what ran, which is the pre-#329 behaviour, rather than
      // an empty row.
      executeQueryMock.mockResolvedValue([makeQueryResult({ sql: "" })]);

      await useResultStore.getState().executeQuery("conn-1", "SELECT 1; SELECT 2");

      expect(addEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ sql: "SELECT 1; SELECT 2" }),
      );
    });

    it("records nothing for a run that produced no results", async () => {
      executeQueryMock.mockResolvedValue([]);

      await useResultStore.getState().executeQuery("conn-1", "SET @x = 1");

      expect(addEntryMock).not.toHaveBeenCalled();
    });
  });
});

describe("resultStore cancel generations (#287)", () => {
  /** A promise the test settles when it chooses. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    useResultStore.setState({ results: [], error: null, isExecuting: false });
    cancelQueryMock.mockReset();
    cancelQueryMock.mockResolvedValue(undefined);
    executeQueryMock.mockReset();
  });

  it("keeps a later query's result when an earlier one was cancelled", async () => {
    // The issue's scenario: run, cancel, run again, and the first response
    // lands after the second. The second must survive.
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const first = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(1)");

    await useResultStore.getState().cancelActiveQuery();

    const second = makeQueryResult({ sql: "SELECT 2", rows: [["second"]] });
    executeQueryMock.mockResolvedValueOnce([second]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT 2");

    slow.resolve([makeQueryResult({ sql: "SELECT SLEEP(1)", rows: [["first"]] })]);
    await first;

    expect(useResultStore.getState().results).toEqual([second]);
  });

  it("drops the cancelled query's own late result", async () => {
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const inFlight = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(1)");

    await useResultStore.getState().cancelActiveQuery();
    slow.resolve([makeQueryResult()]);
    await inFlight;

    expect(useResultStore.getState().results).toEqual([]);
    expect(useResultStore.getState().cancelledAfterMs).not.toBeNull();
  });

  it("does not report a failed cancel over a query that started since", async () => {
    // `cancelQuery` rejecting after a new query has begun would otherwise
    // replace that query's state with a message about one already gone.
    const slowCancel = deferred<void>();
    cancelQueryMock.mockReturnValueOnce(slowCancel.promise);
    executeQueryMock.mockReturnValueOnce(deferred<unknown[]>().promise);
    void useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(1)");
    const cancelling = useResultStore.getState().cancelActiveQuery();

    const second = makeQueryResult({ sql: "SELECT 2" });
    executeQueryMock.mockResolvedValueOnce([second]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT 2");

    slowCancel.reject(new Error("server unreachable"));
    await cancelling;

    expect(useResultStore.getState().results).toEqual([second]);
    expect(useResultStore.getState().error).toBeNull();
  });

  it("still reports a failed cancel when nothing has replaced it", async () => {
    const slowCancel = deferred<void>();
    cancelQueryMock.mockReturnValueOnce(slowCancel.promise);
    executeQueryMock.mockReturnValueOnce(deferred<unknown[]>().promise);
    void useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(1)");

    const cancelling = useResultStore.getState().cancelActiveQuery();
    slowCancel.reject(new Error("server unreachable"));
    await cancelling;

    expect(useResultStore.getState().error).toContain("did not confirm");
  });
});

// #842: results and run state belong to the editor tab that ran them.
describe("per-tab results", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useResultStore.setState({
      results: [],
      activeResultIndex: 0,
      isExecuting: false,
      error: null,
      cancelledAfterMs: null,
      page: null,
      resultSource: null,
      confirmDialog: null,
      viewTabId: null,
      runTabId: null,
      parked: {},
      explainResult: null,
      explainRequest: null,
      showExplain: false,
    });
    connectionStoreState = {
      activeConnections: [{ id: "conn-1", profile_id: "p1", name: "Test DB" }],
      profiles: [{ id: "p1", environment: "development" }],
    };
    useResultStore.getState().showTab("tab-1");
  });

  const queryTab = (id: string): EditorTab => ({ id, title: id, content: "", type: "query", isDirty: false });
  const designerTab = (id: string): EditorTab => ({
    id,
    title: id,
    content: "",
    type: "designer",
    connectionId: "conn-1",
    database: "shop",
    tableName: "orders",
    isDirty: false,
  });

  it("shows each tab its own results, and a fresh tab the empty state", async () => {
    const orders = makeQueryResult({ sql: "SELECT * FROM orders", rows: [["o"]] });
    executeQueryMock.mockResolvedValueOnce([orders]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM orders", undefined, "tab-1");

    useResultStore.getState().showTab("tab-2");
    expect(useResultStore.getState().results).toEqual([]);
    expect(useResultStore.getState().resultSource).toBeNull();

    useResultStore.getState().showTab("tab-1");
    expect(useResultStore.getState().results).toEqual([orders]);
  });

  it("does not show another tab's running query as this tab's", async () => {
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const pending = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)", undefined, "tab-1");

    useResultStore.getState().showTab("tab-2");
    expect(useResultStore.getState().isExecuting).toBe(false);

    slow.resolve([]);
    await pending;
  });

  it("keeps a slow result in one tab when another tab runs a query", async () => {
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const first = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)", undefined, "tab-1");

    useResultStore.getState().showTab("tab-2");
    const customers = makeQueryResult({ sql: "SELECT * FROM customers", rows: [["c"]] });
    executeQueryMock.mockResolvedValueOnce([customers]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM customers", undefined, "tab-2");

    const sleep = makeQueryResult({ sql: "SELECT SLEEP(5)", rows: [["0"]] });
    slow.resolve([sleep]);
    await first;

    // Tab 2 still shows its own; tab 1's result arrived and was recorded.
    expect(useResultStore.getState().results).toEqual([customers]);
    expect(addEntryMock).toHaveBeenCalledWith(expect.objectContaining({ sql: "SELECT SLEEP(5)" }));
    useResultStore.getState().showTab("tab-1");
    expect(useResultStore.getState().results).toEqual([sleep]);
    expect(useResultStore.getState().isExecuting).toBe(false);
  });

  it("forgets a closed tab's results", async () => {
    executeQueryMock.mockResolvedValueOnce([makeQueryResult()]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "tab-1");
    useResultStore.getState().showTab("tab-2");

    useResultStore.getState().forgetTabs(["tab-2"]);

    expect(useResultStore.getState().parked).toEqual({});
  });

  it("clears a grid read on another connection when the selection changes", async () => {
    executeQueryMock.mockResolvedValueOnce([makeQueryResult()]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "tab-1");

    useResultStore.getState().dropForeignResults("conn-2");

    expect(useResultStore.getState().results).toEqual([]);
    expect(useResultStore.getState().resultSource).toBeNull();
  });

  it("follows the editor's active tab as soon as it changes", async () => {
    // Show DDL opens a tab and runs in it in one go. Following the tab in an
    // effect after render filed the run under the tab shown before.
    useEditorStore.setState({ tabs: [queryTab("query-a")], activeTabId: "query-a" });
    const ddl = makeQueryResult({ sql: "SHOW CREATE TABLE t" });
    executeQueryMock.mockResolvedValueOnce([ddl]);

    const opened = useEditorStore.getState().addTab();
    await useResultStore.getState().executeQuery("conn-1", "SHOW CREATE TABLE t");

    expect(useResultStore.getState().viewTabId).toBe(opened);
    expect(useResultStore.getState().results).toEqual([ddl]);
    useEditorStore.getState().setActiveTab("query-a");
    expect(useResultStore.getState().results).toEqual([]);
  });

  it("files a run with no session under the last query tab, not a designer tab", async () => {
    // A designer tab has no results pane; what the schema tree or the
    // designer runs belongs in the query tab the user last looked at.
    useEditorStore.setState({ tabs: [queryTab("query-a"), designerTab("designer-d")], activeTabId: "query-a" });
    useEditorStore.getState().setActiveTab("designer-d");
    const rows = makeQueryResult({ sql: "SELECT * FROM orders" });
    executeQueryMock.mockResolvedValueOnce([rows]);

    await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM orders");

    expect(useResultStore.getState().results).toEqual([]);
    useEditorStore.getState().setActiveTab("query-a");
    expect(useResultStore.getState().results).toEqual([rows]);
  });

  it("runs a confirmed statement into the tab it was asked in", async () => {
    connectionStoreState.profiles = [{ id: "p1", environment: "production" }];
    useEditorStore.setState({ tabs: [queryTab("query-a"), queryTab("query-b")], activeTabId: "query-a" });
    await useResultStore.getState().executeQuery("conn-1", "DELETE FROM orders");
    useEditorStore.getState().setActiveTab("query-b");
    const deleted = makeQueryResult({ sql: "DELETE FROM orders", rows: [] });
    executeQueryMock.mockResolvedValueOnce([deleted]);

    await useResultStore.getState().confirmExecution();

    expect(useResultStore.getState().results).toEqual([]);
    useEditorStore.getState().setActiveTab("query-a");
    expect(useResultStore.getState().results).toEqual([deleted]);
  });

  it("returns the run's own outcome, not the shown tab's error", async () => {
    // The designer and the routine viewer read `error` after awaiting; after
    // a tab switch mid-run that was another tab's.
    useEditorStore.setState({ tabs: [queryTab("query-a"), queryTab("query-b")], activeTabId: "query-a" });
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const pending = useResultStore.getState().executeQuery("conn-1", "ALTER TABLE t ADD c INT");
    useEditorStore.getState().setActiveTab("query-b");
    useResultStore.setState({ error: "tab 2's own failure" });

    const ddl = makeQueryResult({ sql: "ALTER TABLE t ADD c INT", rows: [] });
    slow.resolve([ddl]);

    await expect(pending).resolves.toEqual({ status: "succeeded", results: [ddl] });
  });

  it("reports a failure as the outcome even when the tab is not shown", async () => {
    useEditorStore.setState({ tabs: [queryTab("query-a"), queryTab("query-b")], activeTabId: "query-a" });
    executeQueryMock.mockRejectedValueOnce(new Error("Duplicate column name 'c'"));
    const pending = useResultStore.getState().executeQuery("conn-1", "ALTER TABLE t ADD c INT");
    useEditorStore.getState().setActiveTab("query-b");

    await expect(pending).resolves.toEqual({ status: "failed", error: "Error: Duplicate column name 'c'" });
    expect(useResultStore.getState().error).toBeNull();
  });

  it("records a statement whose tab closed while it ran", async () => {
    // It ran, and may have written; dropping it from history because nobody
    // was left to show it to hid that.
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const pending = useResultStore.getState().executeQuery("conn-1", "UPDATE t SET a = 1", undefined, "tab-1");
    useResultStore.getState().showTab("tab-2");
    useResultStore.getState().forgetTabs(["tab-2"]);

    slow.resolve([makeQueryResult({ sql: "UPDATE t SET a = 1", rows: [] })]);
    await pending;

    expect(addEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sql: "UPDATE t SET a = 1", status: "success" }),
    );
    expect(useResultStore.getState().parked).toEqual({});
  });

  it("records a failure whose tab closed while it ran", async () => {
    let reject!: (e: unknown) => void;
    executeQueryMock.mockReturnValueOnce(new Promise((_, rej) => (reject = rej)));
    const pending = useResultStore.getState().executeQuery("conn-1", "UPDATE t SET a = 1", undefined, "tab-1");
    useResultStore.getState().showTab("tab-2");
    useResultStore.getState().forgetTabs(["tab-2"]);

    reject(new Error("Lock wait timeout exceeded"));
    await pending;

    expect(addEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sql: "UPDATE t SET a = 1", status: "error" }),
    );
  });

  it("still keeps a cancelled run's interrupt error out of history", async () => {
    let reject!: (e: unknown) => void;
    executeQueryMock.mockReturnValueOnce(new Promise((_, rej) => (reject = rej)));
    const pending = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)", undefined, "tab-1");
    await useResultStore.getState().cancelActiveQuery();

    reject(new Error("Query execution was interrupted"));

    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(addEntryMock).not.toHaveBeenCalled();
  });

  it("does not let a session-less run take over a tab's own run in flight", async () => {
    // A long SELECT runs in query-a; the user saves in a designer tab, whose
    // ALTER is filed under query-a. The SELECT's response must still land,
    // and Ctrl+. in query-a must still stop the SELECT, not the ALTER.
    useEditorStore.setState({ tabs: [queryTab("query-a"), designerTab("designer-d")], activeTabId: "query-a" });
    connectionStoreState.activeConnections.push({ id: "conn-2", profile_id: "p1", name: "Other" });
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const select = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)", undefined, "query-a");

    useEditorStore.getState().setActiveTab("designer-d");
    const alter = makeQueryResult({ sql: "ALTER TABLE orders ADD c INT", rows: [] });
    const slowAlter = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slowAlter.promise);
    const altering = useResultStore.getState().executeQuery("conn-2", "ALTER TABLE orders ADD c INT");
    useEditorStore.getState().setActiveTab("query-a");

    await useResultStore.getState().cancelActiveQuery();
    expect(cancelQueryMock).toHaveBeenCalledWith("conn-1", "query-a");
    slowAlter.resolve([alter]);
    await expect(altering).resolves.toEqual({ status: "succeeded", results: [alter] });
    slow.resolve([]);
    await select;
  });

  it("shows a tab's own response when a session-less run started after it", async () => {
    useEditorStore.setState({ tabs: [queryTab("query-a"), designerTab("designer-d")], activeTabId: "query-a" });
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const select = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)", undefined, "query-a");

    useEditorStore.getState().setActiveTab("designer-d");
    const alter = makeQueryResult({ sql: "ALTER TABLE orders ADD c INT", rows: [] });
    executeQueryMock.mockResolvedValueOnce([alter]);
    await useResultStore.getState().executeQuery("conn-1", "ALTER TABLE orders ADD c INT");
    useEditorStore.getState().setActiveTab("query-a");
    // The ALTER is shown, as the latest thing run here, but the SELECT is
    // still running.
    expect(useResultStore.getState().results).toEqual([alter]);
    expect(useResultStore.getState().isExecuting).toBe(true);

    const sleep = makeQueryResult({ sql: "SELECT SLEEP(5)", rows: [["0"]] });
    slow.resolve([sleep]);
    await select;

    expect(useResultStore.getState().results).toEqual([sleep]);
    expect(useResultStore.getState().isExecuting).toBe(false);
  });

  it("does not file a session-less response over a newer run of the tab's own", async () => {
    useEditorStore.setState({ tabs: [queryTab("query-a"), designerTab("designer-d")], activeTabId: "designer-d" });
    useResultStore.setState({ runTabId: "query-a" });
    const slowAlter = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slowAlter.promise);
    const altering = useResultStore.getState().executeQuery("conn-1", "ALTER TABLE orders ADD c INT");

    useEditorStore.getState().setActiveTab("query-a");
    const mine = makeQueryResult({ sql: "SELECT 1", rows: [["1"]] });
    executeQueryMock.mockResolvedValueOnce([mine]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "query-a");

    slowAlter.resolve([makeQueryResult({ sql: "ALTER TABLE orders ADD c INT", rows: [] })]);
    await altering;

    expect(useResultStore.getState().results).toEqual([mine]);
    expect(useResultStore.getState().isExecuting).toBe(false);
  });

  it("files a session-less run under the tab the caller names", async () => {
    // A grid refresh after a save: the user may have moved to another query
    // tab while the save was awaited.
    useEditorStore.setState({ tabs: [queryTab("query-a"), queryTab("query-b")], activeTabId: "query-b" });
    const rows = makeQueryResult({ sql: "SELECT * FROM users" });
    executeQueryMock.mockResolvedValueOnce([rows]);

    await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM users", "app", undefined, "query-a");

    expect(useResultStore.getState().results).toEqual([]);
    useEditorStore.getState().setActiveTab("query-a");
    expect(useResultStore.getState().results).toEqual([rows]);
  });

  it("hands a run started with every tab closed to the tab opened next", async () => {
    useEditorStore.setState({ tabs: [queryTab("query-a")], activeTabId: "query-a" });
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const pending = useResultStore.getState().executeQuery("conn-1", "SELECT * FROM orders");
    expect(useResultStore.getState().isExecuting).toBe(true);

    useEditorStore.setState({ tabs: [queryTab("query-b")], activeTabId: "query-b" });
    const rows = makeQueryResult({ sql: "SELECT * FROM orders" });
    slow.resolve([rows]);
    await pending;

    expect(useResultStore.getState().isExecuting).toBe(false);
    expect(useResultStore.getState().results).toEqual([rows]);
    expect(useResultStore.getState().parked).toEqual({});
  });

  it("lets Ctrl+. stop a run handed over from no tab", async () => {
    useEditorStore.setState({ tabs: [queryTab("query-a")], activeTabId: "query-a" });
    useEditorStore.setState({ tabs: [], activeTabId: null });
    executeQueryMock.mockReturnValueOnce(deferred<unknown[]>().promise);
    void useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)");
    useEditorStore.setState({ tabs: [queryTab("query-b")], activeTabId: "query-b" });

    await useResultStore.getState().cancelActiveQuery();

    expect(cancelQueryMock).toHaveBeenCalledWith("conn-1", undefined);
    expect(useResultStore.getState().isExecuting).toBe(false);
  });

  it("keeps a run made with no query tab open for the next query tab", async () => {
    // Only a designer tab is open: what the schema tree runs has no results
    // pane to go to yet, and filing it under the designer hid it for good.
    useEditorStore.setState({ tabs: [queryTab("query-a")], activeTabId: "query-a" });
    useEditorStore.setState({ tabs: [designerTab("designer-d")], activeTabId: "designer-d" });
    const rows = makeQueryResult({ sql: "SELECT * FROM orders" });
    executeQueryMock.mockResolvedValueOnce([rows]);

    await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM orders");
    expect(useResultStore.getState().results).toEqual([]);

    useEditorStore.setState({ tabs: [designerTab("designer-d"), queryTab("query-b")], activeTabId: "query-b" });
    expect(useResultStore.getState().results).toEqual([rows]);
  });

  it("hands a run from before any tab to the first query tab, not a designer", async () => {
    // The first tab shown being a designer took the run and its spinner, and
    // the query tab opened next never saw either.
    useResultStore.setState({ viewTabId: null, runTabId: null });
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const pending = useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");

    useResultStore.getState().showTab("designer-d", false);
    expect(useResultStore.getState().isExecuting).toBe(false);
    useResultStore.getState().showTab("query-b");
    expect(useResultStore.getState().isExecuting).toBe(true);

    const rows = makeQueryResult({ sql: "SELECT * FROM big" });
    slow.resolve([rows]);
    await pending;
    expect(useResultStore.getState().results).toEqual([rows]);
    expect(useResultStore.getState().isExecuting).toBe(false);
  });

  it("gives what ran under no tab to the first query tab after all tabs closed", async () => {
    // Left parked under no tab, it attached to whichever tab opened second.
    useResultStore.setState({ viewTabId: null, runTabId: null });
    useResultStore.getState().showTab("designer-d", false);
    const rows = makeQueryResult({ sql: "SELECT * FROM orders" });
    executeQueryMock.mockResolvedValueOnce([rows]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT * FROM orders");
    useResultStore.getState().showTab(null);
    useResultStore.getState().forgetTabs([]);

    useResultStore.getState().showTab("query-a");
    expect(useResultStore.getState().results).toEqual([rows]);
    useResultStore.getState().showTab("query-b");
    expect(useResultStore.getState().results).toEqual([]);
  });

  it("still counts a closed tab's statement as running until it settles", async () => {
    // An app update restarting now would cut the statement off mid-way.
    const slow = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slow.promise);
    const pending = useResultStore.getState().executeQuery("conn-1", "UPDATE t SET a = 1", undefined, "tab-1");
    useResultStore.getState().showTab("tab-2");
    useResultStore.getState().forgetTabs(["tab-2"]);

    expect(anyTabExecuting(useResultStore.getState())).toBe(true);

    slow.resolve([makeQueryResult({ sql: "UPDATE t SET a = 1", rows: [] })]);
    await pending;
    expect(anyTabExecuting(useResultStore.getState())).toBe(false);
    expect(useResultStore.getState().parked).toEqual({});
  });

  it("cancels only the shown tab's session, leaving another tab's run alone", async () => {
    const slowA = deferred<unknown[]>();
    const slowB = deferred<unknown[]>();
    executeQueryMock.mockReturnValueOnce(slowA.promise).mockReturnValueOnce(slowB.promise);
    useResultStore.getState().showTab("tab-A");
    const runA = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(5)", undefined, "tab-A");
    useResultStore.getState().showTab("tab-B");
    const runB = useResultStore.getState().executeQuery("conn-1", "SELECT SLEEP(6)", undefined, "tab-B");
    useResultStore.getState().showTab("tab-A");

    await useResultStore.getState().cancelActiveQuery();

    expect(cancelQueryMock).toHaveBeenCalledTimes(1);
    expect(cancelQueryMock).toHaveBeenCalledWith("conn-1", "tab-A");
    useResultStore.getState().showTab("tab-B");
    expect(useResultStore.getState().isExecuting).toBe(true);
    const sleep = makeQueryResult({ sql: "SELECT SLEEP(6)", rows: [["0"]] });
    slowB.resolve([sleep]);
    await expect(runB).resolves.toEqual({ status: "succeeded", results: [sleep] });
    expect(useResultStore.getState().results).toEqual([sleep]);
    slowA.resolve([]);
    await expect(runA).resolves.toEqual({ status: "cancelled" });
  });

  it("names no session when cancelling a run on the shared pool", async () => {
    useEditorStore.setState({ tabs: [queryTab("query-a")], activeTabId: "query-a" });
    executeQueryMock.mockReturnValueOnce(deferred<unknown[]>().promise);
    void useResultStore.getState().executeQuery("conn-1", "SELECT * FROM big");

    await useResultStore.getState().cancelActiveQuery();

    expect(cancelQueryMock).toHaveBeenCalledWith("conn-1", undefined);
  });

  it("clears a plan read on another connection along with the grid", () => {
    useResultStore.setState({
      explainResult: makeQueryResult({ query_id: "plan" }),
      explainRequest: { connectionId: "conn-1", sql: "SELECT 1", analyze: false },
      showExplain: true,
    });

    useResultStore.getState().dropForeignResults("conn-2");

    expect(useResultStore.getState().explainResult).toBeNull();
    expect(useResultStore.getState().showExplain).toBe(false);
  });

  it("keeps what was read on the tab's own connection", async () => {
    executeQueryMock.mockResolvedValueOnce([makeQueryResult()]);
    await useResultStore.getState().executeQuery("conn-1", "SELECT 1", undefined, "tab-1");

    useResultStore.getState().dropForeignResults("conn-1");

    expect(useResultStore.getState().results).toHaveLength(1);
  });
});

describe("following the editor store", () => {
  it("drops its subscription when Vite hot-reloads the module", () => {
    // Without it every edit to this file in dev stacked another listener.
    const unsub = vi.fn();
    const subscribe = vi.spyOn(useEditorStore, "subscribe").mockReturnValue(unsub);
    let dispose: (() => void) | undefined;

    followEditorStore({ dispose: (cb) => (dispose = cb) });
    subscribe.mockRestore();
    dispose?.();

    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
