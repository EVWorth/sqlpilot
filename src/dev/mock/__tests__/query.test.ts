import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo, QueryResult_Serialize } from "../../../lib/bindings";
import { call, install, rejection, settle } from "./helpers";

let conn: ConnectionInfo;

const run = (sql: string, session: string | null = null) =>
  settle(call<QueryResult_Serialize[]>("execute_query", { connectionId: conn.id, sql, database: "shop", session }));

describe("execute_query", () => {
  beforeEach(async () => {
    install("?mock=connected");
    vi.useFakeTimers();
    conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("carries the statements that ran before a failure as completedResults", async () => {
    const error = await settle(
      rejection("execute_query", {
        connectionId: conn.id,
        sql: "SELECT 1; SELECT 2; SELECT * FROM nope",
        database: "shop",
        session: null,
      }),
    );
    expect(error).toMatchObject({ code: 1146, statementIndex: 2 });
    const completed = (error as { completedResults?: QueryResult_Serialize[] }).completedResults;
    expect(completed?.map((r) => r.statement_index)).toEqual([0, 1]);
  });

  it("leaves completedResults off when the first statement fails", async () => {
    const error = await settle(
      rejection("execute_query", { connectionId: conn.id, sql: "SELECT * FROM nope", database: "shop", session: null }),
    );
    expect(error).not.toHaveProperty("completedResults");
  });

  it("reports a tab session's transaction state on the last result only", async () => {
    const opened = await run("BEGIN; UPDATE orders SET total = 1 WHERE id = 3", "tab-1");
    expect(opened[0].transaction).toBeUndefined();
    expect(opened[1].transaction).toBe("open");
    expect((await run("COMMIT", "tab-1"))[0].transaction).toBe("none");
    // No session, no transaction state.
    expect((await run("SELECT 1"))[0].transaction).toBeUndefined();
  });

  it("reports a tab session's transaction state on a failure too", async () => {
    const failed = (sql: string, session: string | null) =>
      settle(rejection("execute_query", { connectionId: conn.id, sql, database: "shop", session }));

    const error = await failed("BEGIN; SELECT * FROM nope", "tab-2");
    expect(error).toMatchObject({ statementIndex: 1, transaction: "open" });

    await run("ROLLBACK", "tab-2");
    expect(await failed("SELECT * FROM nope", "tab-2")).toMatchObject({ transaction: "none" });
    // No session, no transaction state.
    expect(await failed("BEGIN; SELECT * FROM nope", null)).not.toHaveProperty("transaction");
  });
});
