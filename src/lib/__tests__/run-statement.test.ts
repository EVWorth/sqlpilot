import { beforeEach, describe, expect, it, vi } from "vitest";

const executeQuery = vi.hoisted(() => vi.fn());
const addEntry = vi.hoisted(() => vi.fn());
const activeConnections = vi.hoisted(() => ({
  value: [] as { id: string; name: string; database?: string | null }[],
}));

vi.mock("../tauri-api", () => ({
  api: { executeQuery },
  CommandError: class CommandError extends Error {
    code?: number;
    sqlState?: string;
    constructor(message: string, fields?: { code?: number; sqlState?: string }) {
      super(message);
      if (fields?.code != null) this.code = fields.code;
      if (fields?.sqlState != null) this.sqlState = fields.sqlState;
    }
  },
}));

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: { getState: () => ({ activeConnections: activeConnections.value }) },
}));

vi.mock("../../stores/historyStore", () => ({
  useHistoryStore: { getState: () => ({ addEntry }) },
}));

import { runStatement, USER_ORIGINS } from "../run-statement";

function result(overrides = {}) {
  return { query_id: "q", statement_index: 0, sql: "SELECT 1", rows: [["a"]], ...overrides };
}

describe("runStatement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQuery.mockResolvedValue([result()]);
    activeConnections.value = [{ id: "conn-1", name: "prod", database: "app" }];
  });

  it("records the statement with its origin", async () => {
    await runStatement({ connectionId: "conn-1", sql: "UPDATE t SET a = 1", origin: "grid" });

    expect(addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "grid", connectionName: "prod", status: "success" }),
    );
  });

  it("records one entry per statement", async () => {
    executeQuery.mockResolvedValue([
      result({ sql: "SELECT 1" }),
      result({ sql: "SELECT 2", rows: [["b"], ["c"]] }),
    ]);

    await runStatement({ connectionId: "conn-1", sql: "SELECT 1; SELECT 2", origin: "import" });

    expect(addEntry.mock.calls.map(([e]) => [e.sql, e.rowCount])).toEqual([
      ["SELECT 1", 1],
      ["SELECT 2", 2],
    ]);
  });

  it("still records a statement that produced no result set", async () => {
    // A SET or a DDL statement ran, so it belongs in history.
    executeQuery.mockResolvedValue([]);

    await runStatement({ connectionId: "conn-1", sql: "SET @x = 1", origin: "editor" });

    expect(addEntry).toHaveBeenCalledWith(expect.objectContaining({ sql: "SET @x = 1" }));
  });

  it("counts nothing when a result reports no rows", async () => {
    // A result from a write reports a count and no `rows` array at all.
    executeQuery.mockResolvedValue([{ query_id: "q", statement_index: 0, sql: "DELETE FROM t" }]);

    await runStatement({ connectionId: "conn-1", sql: "DELETE FROM t", origin: "grid" });

    expect(addEntry).toHaveBeenCalledWith(expect.objectContaining({ rowCount: 0 }));
  });

  it("records a failure with the driver's code", async () => {
    const { CommandError } = await import("../tauri-api");
    executeQuery.mockRejectedValue(new CommandError("nope", { code: 1146, sqlState: "42S02" }));

    await expect(
      runStatement({ connectionId: "conn-1", sql: "SELECT 1", origin: "admin" }),
    ).rejects.toThrow("nope");

    expect(addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", errorCode: 1146, origin: "admin" }),
    );
  });

  it("rethrows so the caller still sees the failure", async () => {
    executeQuery.mockRejectedValue(new Error("boom"));
    await expect(
      runStatement({ connectionId: "conn-1", sql: "SELECT 1", origin: "grid" }),
    ).rejects.toThrow("boom");
  });

  it("records nothing for a failure with no live connection", async () => {
    activeConnections.value = [];
    executeQuery.mockRejectedValue(new Error("connection not found"));

    await expect(
      runStatement({ connectionId: "gone", sql: "SELECT 1", origin: "grid" }),
    ).rejects.toThrow();

    expect(addEntry).not.toHaveBeenCalled();
  });

  it("does not fail the statement when recording throws", async () => {
    // The statement ran. Reporting a recording failure as a query failure
    // would tell the caller to roll back something that already succeeded.
    addEntry.mockImplementation(() => {
      throw new Error("history is broken");
    });

    await expect(
      runStatement({ connectionId: "conn-1", sql: "SELECT 1", origin: "grid" }),
    ).resolves.toHaveLength(1);
  });

  it("keeps import, restore and internal out of the default view", () => {
    expect(USER_ORIGINS).not.toContain("import");
    expect(USER_ORIGINS).not.toContain("restore");
    expect(USER_ORIGINS).not.toContain("internal");
    expect(USER_ORIGINS).toContain("editor");
    expect(USER_ORIGINS).toContain("grid");
  });
});
