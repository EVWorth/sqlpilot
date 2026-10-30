import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryError, SqliteQueryResult } from "../../../lib/bindings";
import { call, install, settle } from "./helpers";

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
});
