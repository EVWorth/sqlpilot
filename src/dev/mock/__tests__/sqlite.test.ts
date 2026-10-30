import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryError, SqliteQueryResult } from "../../../lib/bindings";
import { splitSqliteStatements } from "../handlers/sqlite";
import { call, install, settle } from "./helpers";

describe("splitSqliteStatements (#928)", () => {
  it("splits on semicolons and keeps an unterminated last statement", () => {
    expect(splitSqliteStatements("CREATE TABLE a(x); CREATE TABLE b(y);\nSELECT 1")).toEqual([
      "CREATE TABLE a(x)",
      "CREATE TABLE b(y)",
      "SELECT 1",
    ]);
  });

  it("does not split inside strings, quoted names or comments", () => {
    expect(
      splitSqliteStatements("INSERT INTO t VALUES ('a;b', 'it''s; x'); SELECT \"p;q\", [r;s] /* ; */ FROM t -- ;\n;"),
    ).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s; x')",
      "SELECT \"p;q\", [r;s] /* ; */ FROM t -- ;",
    ]);
  });

  it("keeps a trigger body whole", () => {
    const parts = splitSqliteStatements(
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET x = CASE WHEN x THEN 1 END;\n  DELETE FROM u;\nEND;\nSELECT 1;",
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^CREATE TRIGGER tr[\s\S]*END$/);
    expect(parts[1]).toBe("SELECT 1");
  });

  it("drops pieces with only comments in them", () => {
    expect(splitSqliteStatements(";; -- note\n/* more */; SELECT 1;;")).toEqual(["SELECT 1"]);
  });
});

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

  it("reports a failing second statement with what ran before it", async () => {
    const pending = call("sqlite_execute", { connectionId: id, sql: "SELECT 1; SELECT * FROM missing" });
    const failure = settle(pending).catch((e: unknown) => e);
    const e = (await failure) as QueryError;
    expect(e.statementIndex).toBe(1);
    expect(e.message).toMatch(/no such table: missing/);
    expect(e.completedResults?.map((r) => r.sql)).toEqual(["SELECT 1"]);
  });
});
