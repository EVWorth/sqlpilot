import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QueryError,
  ResultHandle_Serialize,
  ResultWindow_Serialize,
  SqliteQueryResult,
  WireValue,
} from "../../../lib/bindings";
import { call, install, rejection, settle } from "./helpers";

describe("sqlite_execute", () => {
  let id: string;
  beforeEach(async () => {
    install("?mock");
    vi.useFakeTimers();
    id = await settle(call<string>("sqlite_open", { path: "/tmp/sqlpilot-mock/app.db" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns one result per statement, each with its own text", async () => {
    const results = await settle(
      call<SqliteQueryResult[]>("sqlite_execute", { connectionId: id, sql: "SELECT 'a;b'; SELECT 2" }),
    );
    expect(results.map((r) => [r.statement_index, r.sql])).toEqual([[0, "SELECT 'a;b'"], [1, "SELECT 2"]]);
  });

  it("caps rows at the limit and pages from the offset (#933)", async () => {
    const all = await settle(
      call<SqliteQueryResult[]>("sqlite_execute", { connectionId: id, sql: "SELECT * FROM notes" }),
    );
    expect(all[0].rows.length).toBeGreaterThan(3);
    expect(all[0].rows_truncated).toBe(false);

    const [page] = await settle(
      call<SqliteQueryResult[]>("sqlite_execute", {
        connectionId: id,
        sql: "SELECT * FROM notes",
        limit: 2,
        offset: 1,
      }),
    );
    expect(page.rows).toEqual(all[0].rows.slice(1, 3));
    expect(page.rows_truncated).toBe(true);
    expect(page.truncation_reason).toBe("row_limit");
  });

  it("reports a failing second statement with what ran before it", async () => {
    const pending = call("sqlite_execute", { connectionId: id, sql: "SELECT 1; SELECT * FROM missing" });
    const failure = settle(pending).catch((e: unknown) => e);
    const e = (await failure) as QueryError;
    expect(e.statementIndex).toBe(1);
    expect(e.message).toMatch(/no such table: missing/);
    expect(e.completedResults?.map((r) => r.sql)).toEqual(["SELECT 1"]);
  });
  // #935: one connection per file, shared by every tab on it.
  describe("transactions", () => {
    const run = (sql: string) => settle(call<SqliteQueryResult[]>("sqlite_execute", { connectionId: id, sql }));
    const failed = (sql: string) =>
      settle(call("sqlite_execute", { connectionId: id, sql })).catch((e: unknown) => e as QueryError);

    it("reports the connection inside BEGIN ... COMMIT after each statement", async () => {
      const opened = await run("BEGIN; UPDATE notes SET title = 'x' WHERE id = 1");
      expect(opened.map((r) => r.in_transaction)).toEqual([true, true]);
      expect((await run("SELECT 1"))[0].in_transaction).toBe(true);
      expect((await run("COMMIT"))[0].in_transaction).toBe(false);
      await run("BEGIN");
      expect((await run("ROLLBACK"))[0].in_transaction).toBe(false);
    });

    it("refuses to nest BEGIN or to end what is not open, as SQLite does", async () => {
      expect(await failed("COMMIT")).toMatchObject({ message: "cannot commit - no transaction is active" });
      await run("BEGIN");
      expect(await failed("BEGIN")).toMatchObject({ statementIndex: 0, transaction: "open" });
      await run("ROLLBACK");
    });

    it("says whether one is still open after a failure", async () => {
      const e = await failed("BEGIN; SELECT * FROM missing");
      expect(e).toMatchObject({ statementIndex: 1, transaction: "open" });
      expect(e.completedResults?.[0].transaction).toBe("open");
      await run("ROLLBACK");
      expect(await failed("SELECT * FROM missing")).toMatchObject({ transaction: "none" });
    });

    it("ends with the connection", async () => {
      await run("BEGIN");
      await settle(call("sqlite_close", { connectionId: id }));
      id = await settle(call<string>("sqlite_open", { path: "/tmp/sqlpilot-mock/app.db" }));
      expect((await run("SELECT 1"))[0].in_transaction).toBe(false);
    });
  });
});

describe("sqlite_run_query", () => {
  let id: string;
  beforeEach(async () => {
    install("?mock");
    vi.useFakeTimers();
    id = await settle(call<string>("sqlite_open", { path: "/tmp/sqlpilot-mock/app.db" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const execute = (sql: string, page: { limit?: number; offset?: number } = {}) =>
    settle(call<SqliteQueryResult[]>("sqlite_execute", { connectionId: id, sql, ...page }));
  const run = (sql: string, page: { limit?: number; offset?: number } = {}) =>
    settle(call<ResultHandle_Serialize[]>("sqlite_run_query", { connectionId: id, sql, ...page }));
  const failed = (sql: string) =>
    settle(call("sqlite_run_query", { connectionId: id, sql })).catch((e: unknown) => e as QueryError);
  const rowsOf = (resultId: string, rowIds: number[]) => call<WireValue[][]>("result_rows", { resultId, rowIds });

  it("returns a handle without rows, and the rows sqlite_execute shows through the result store", async () => {
    const [whole] = await execute("SELECT * FROM notes");
    const [handle] = await run("SELECT * FROM notes");

    expect(handle).not.toHaveProperty("rows");
    expect(handle).toMatchObject({
      statement_index: 0,
      sql: "SELECT * FROM notes",
      columns: whole.columns,
      row_count: whole.rows.length,
      // SQLite's change count, which a SELECT leaves at 0.
      rows_affected: 0,
      transaction: "none",
    });
    expect(handle).not.toHaveProperty("truncation_reason");

    const w = await call<ResultWindow_Serialize>("result_window", {
      resultId: handle.result_id,
      offset: 0,
      count: 3,
      sort: [],
      filters: [],
    });
    expect(w.matching_rows).toBe(whole.rows.length);
    expect(w.rows.map((row) => row.map((c) => c.value))).toEqual(whole.rows.slice(0, 3));
    expect(await rowsOf(handle.result_id, [2, 1])).toEqual([whole.rows[1], whole.rows[0]]);
  });

  it("gives every statement its own handle and result id", async () => {
    const handles = await run("SELECT 'a;b'; SELECT * FROM settings");
    expect(handles.map((h) => [h.statement_index, h.sql])).toEqual([
      [0, "SELECT 'a;b'"],
      [1, "SELECT * FROM settings"],
    ]);
    expect(new Set(handles.map((h) => h.result_id)).size).toBe(2);
  });

  it("applies the limit and offset as sqlite_execute does, with the reason on the handle", async () => {
    const [whole] = await execute("SELECT * FROM notes");
    const [handle] = await run("SELECT * FROM notes", { limit: 2, offset: 1 });
    expect(handle).toMatchObject({ row_count: 2, truncation_reason: "row_limit" });
    expect(await rowsOf(handle.result_id, [1, 2])).toEqual(whole.rows.slice(1, 3));
  });

  it("stores nothing for a statement with no rows, and reports what it changed", async () => {
    const [handle] = await run("UPDATE notes SET title = 'x' WHERE id = 1");
    expect(handle).toMatchObject({ row_count: 0, rows_affected: 1, columns: [] });
    expect(await rejection("result_rows", { resultId: handle.result_id, rowIds: [] }))
      .toBe(`Not found: Result ${handle.result_id}`);
  });

  it("keeps the columns of a result set with no rows", async () => {
    const [handle] = await run("SELECT * FROM notes LIMIT 0");
    expect(handle.row_count).toBe(0);
    expect(handle.columns.map((c) => c.name)).toEqual(["id", "title", "body", "created_at"]);
    expect(
      await rejection("result_row_ids", { resultId: handle.result_id, offset: 0, count: 0, sort: [], filters: [] }),
    )
      .toBe(`Not found: Result ${handle.result_id}`);
  });

  it("carries the connection's transaction state on every handle", async () => {
    const opened = await run("BEGIN; SELECT 1");
    expect(opened.map((h) => h.transaction)).toEqual(["open", "open"]);
    expect((await run("ROLLBACK; SELECT 1")).map((h) => h.transaction)).toEqual(["none", "none"]);
  });

  it("carries the statements that ran before a failure as completedHandles", async () => {
    const e = await failed("BEGIN; SELECT * FROM settings; SELECT * FROM missing");
    expect(e).toMatchObject({ statementIndex: 2, transaction: "open" });
    expect(e.message).toMatch(/no such table: missing/);
    expect(e).not.toHaveProperty("completedResults");
    const completed = e.completedHandles ?? [];
    expect(completed.map((h) => [h.statement_index, h.transaction])).toEqual([[0, "open"], [1, "open"]]);
    expect(completed[1].row_count).toBeGreaterThan(0);
    // Their rows are in the store, to read and to release.
    expect(await rowsOf(completed[1].result_id, [1])).toEqual([["theme", "dark"]]);
    expect(await call("result_release", { resultIds: completed.map((h) => h.result_id) })).toBeNull();
    expect(await rejection("result_rows", { resultId: completed[1].result_id, rowIds: [1] }))
      .toBe(`Not found: Result ${completed[1].result_id}`);
    await run("ROLLBACK");
  });

  it("leaves completedHandles off when the first statement fails", async () => {
    const e = await failed("SELECT * FROM missing");
    expect(e).toMatchObject({ statementIndex: 0, transaction: "none" });
    expect(e).not.toHaveProperty("completedHandles");
  });

  it("rejects a connection that is not open", async () => {
    expect(await rejection("sqlite_run_query", { connectionId: "nope", sql: "SELECT 1" }))
      .toBe("Not found: SQLite connection not found: nope");
  });
});
