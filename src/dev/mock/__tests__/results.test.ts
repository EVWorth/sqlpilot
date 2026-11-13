import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ColumnFilter,
  ColumnMeta,
  ConnectionInfo,
  QueryResult_Serialize,
  ResultHandle_Serialize,
  ResultWindow_Serialize,
  SortKey,
  SqlValue,
  WireValue,
} from "../../../lib/bindings";
import { storeResult, WINDOW_MAX_CELL_BYTES, WINDOW_MAX_ROWS } from "../handlers/results";
import { call, install, rejection, settle } from "./helpers";

let conn: ConnectionInfo;

const runQuery = (sql: string, session: string | null = null) =>
  settle(call<ResultHandle_Serialize[]>("run_query", { connectionId: conn.id, sql, database: "shop", session }));

const windowOf = (
  resultId: string,
  { offset = 0, count = 100, sort = [], filters = [] }: {
    offset?: number;
    count?: number;
    sort?: SortKey[];
    filters?: ColumnFilter[];
  } = {},
) => call<ResultWindow_Serialize>("result_window", { resultId, offset, count, sort, filters });

const col = (name: string, data_type: string): ColumnMeta => ({
  name,
  data_type,
  nullable: true,
  is_primary_key: false,
});

/** Put rows in the store directly, for the cases the fixture data lacks. */
function stored(columns: ColumnMeta[], rows: SqlValue[][]): string {
  const result: QueryResult_Serialize = {
    query_id: "q",
    statement_index: 0,
    sql: "SELECT 1",
    columns,
    rows,
    rows_affected: rows.length,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
  };
  return storeResult(result).result_id;
}

/** The values of one column of a window. */
const column = (w: ResultWindow_Serialize, index = 0) => w.rows.map((row) => row[index].value);

beforeEach(async () => {
  install("?mock=connected");
  vi.useFakeTimers();
  conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("run_query", () => {
  it("returns a handle without rows, and the rows through result_window", async () => {
    const [whole] = await settle(
      call<QueryResult_Serialize[]>("execute_query", {
        connectionId: conn.id,
        sql: "SELECT * FROM products",
        database: "shop",
        session: null,
      }),
    );
    const [handle] = await runQuery("SELECT * FROM products");

    expect(handle).not.toHaveProperty("rows");
    expect(handle).toMatchObject({
      statement_index: 0,
      sql: "SELECT * FROM products",
      columns: whole.columns,
      row_count: whole.rows.length,
      rows_affected: whole.rows.length,
    });
    expect(handle.row_count).toBeGreaterThan(0);

    const w = await windowOf(handle.result_id, { count: 5 });
    expect(w.row_ids).toEqual([1, 2, 3, 4, 5]);
    expect(w.matching_rows).toBe(handle.row_count);
    expect(w.rows.map((row) => row.map((c) => c.value))).toEqual(whole.rows.slice(0, 5));
    expect(w.rows.flat().every((c) => c.full_len === null)).toBe(true);
  });

  it("gives every statement its own result id", async () => {
    const handles = await runQuery("SELECT * FROM products; SELECT * FROM orders");
    expect(handles.map((h) => h.statement_index)).toEqual([0, 1]);
    expect(new Set(handles.map((h) => h.result_id)).size).toBe(2);
  });

  it("stores nothing for a statement with no rows, so its window is not found", async () => {
    const [handle] = await runQuery("UPDATE orders SET total = 1 WHERE id = 3");
    expect(handle).toMatchObject({ row_count: 0, rows_affected: 1, columns: [] });
    expect(
      await rejection("result_window", { resultId: handle.result_id, offset: 0, count: 10, sort: [], filters: [] }),
    )
      .toBe(`Not found: Result ${handle.result_id}`);
  });

  it("carries the row cap's truncation reason on the handle", async () => {
    const [handle] = await settle(
      call<ResultHandle_Serialize[]>("run_query", {
        connectionId: conn.id,
        sql: "SELECT * FROM products",
        database: "shop",
        limit: 3,
        session: null,
      }),
    );
    expect(handle).toMatchObject({ row_count: 3, truncation_reason: "row_limit" });
    expect((await runQuery("SELECT 1"))[0]).not.toHaveProperty("truncation_reason");
  });

  it("reports a tab session's transaction state on the last handle only", async () => {
    const handles = await runQuery("BEGIN; SELECT 1", "tab-1");
    expect(handles[0]).not.toHaveProperty("transaction");
    expect(handles[1].transaction).toBe("open");
  });

  it("carries the statements that ran before a failure as completedHandles", async () => {
    const error = await settle(
      rejection("run_query", {
        connectionId: conn.id,
        sql: "SELECT * FROM products; SELECT * FROM nope",
        database: "shop",
        session: null,
      }),
    );
    expect(error).toMatchObject({ code: 1146, statementIndex: 1 });
    expect(error).not.toHaveProperty("completedResults");
    const completed = (error as { completedHandles?: ResultHandle_Serialize[] }).completedHandles ?? [];
    expect(completed.map((h) => h.statement_index)).toEqual([0]);
    // Their rows are in the store, to read and to release.
    expect((await windowOf(completed[0].result_id, { count: 1 })).row_ids).toEqual([1]);
  });

  it("leaves completedHandles off when the first statement fails", async () => {
    const error = await settle(
      rejection("run_query", { connectionId: conn.id, sql: "SELECT * FROM nope", database: "shop", session: null }),
    );
    expect(error).toMatchObject({ code: 1146 });
    expect(error).not.toHaveProperty("completedHandles");
  });
});

describe("result_window", () => {
  const letters = () =>
    stored([col("n", "INT"), col("s", "VARCHAR")], [[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]]);

  it("pages by offset and count, and reports every matching row", async () => {
    const id = letters();
    const w = await windowOf(id, { offset: 2, count: 2 });
    expect(w.row_ids).toEqual([3, 4]);
    expect(column(w, 1)).toEqual(["c", "d"]);
    expect(w.matching_rows).toBe(5);
  });

  it("returns no rows past the end or for a count of zero, with the count intact", async () => {
    const id = letters();
    expect(await windowOf(id, { offset: 5 })).toEqual({ row_ids: [], rows: [], matching_rows: 5 });
    expect(await windowOf(id, { count: 0 })).toEqual({ row_ids: [], rows: [], matching_rows: 5 });
  });

  it("returns at most 1,000 rows whatever it is asked for", async () => {
    const id = stored([col("n", "INT")], Array.from({ length: WINDOW_MAX_ROWS + 50 }, (_, i) => [i]));
    const w = await windowOf(id, { count: 5_000 });
    expect(w.rows).toHaveLength(1000);
    expect(w.matching_rows).toBe(1050);
  });

  it("sorts a numeric column by value, including numbers that travel as text", async () => {
    const id = stored([col("total", "DECIMAL"), col("big", "BIGINT")], [
      ["10.5", "9007199254740993"],
      ["9", "9007199254740992"],
      ["100", "-5"],
    ]);
    expect(column(await windowOf(id, { sort: [{ column: 0, descending: false }] }))).toEqual(["9", "10.5", "100"]);
    // Past 2^53, where a double cannot tell the two apart.
    expect(column(await windowOf(id, { sort: [{ column: 1, descending: false }] }), 1))
      .toEqual(["-5", "9007199254740992", "9007199254740993"]);
  });

  it("sorts text without regard to case", async () => {
    const id = stored([col("s", "VARCHAR")], [["banana"], ["Cherry"], ["apple"], ["10"], ["9"]]);
    expect(column(await windowOf(id, { sort: [{ column: 0, descending: false }] })))
      .toEqual(["10", "9", "apple", "banana", "Cherry"]);
    expect(column(await windowOf(id, { sort: [{ column: 0, descending: true }] })))
      .toEqual(["Cherry", "banana", "apple", "9", "10"]);
  });

  it("puts NULL first ascending and last descending", async () => {
    const id = stored([col("n", "INT")], [[2], [null], [1], ["Null"]]);
    const asc = await windowOf(id, { sort: [{ column: 0, descending: false }] });
    expect(column(asc)).toEqual([null, null, 1, 2]);
    expect(asc.row_ids).toEqual([2, 4, 3, 1]);
    const desc = await windowOf(id, { sort: [{ column: 0, descending: true }] });
    expect(column(desc)).toEqual([2, 1, null, null]);
    expect(desc.row_ids).toEqual([1, 3, 2, 4]);
  });

  it("sorts by several keys, and by arrival order where they tie", async () => {
    const id = stored([col("g", "VARCHAR"), col("n", "INT")], [["b", 1], ["a", 2], ["b", 3], ["a", 2], ["B", 3]]);
    const w = await windowOf(id, { sort: [{ column: 0, descending: false }, { column: 1, descending: true }] });
    // "a" rows tie on both keys and keep rows 2, 4 in order; "B" and "b"
    // are one group, by n descending.
    expect(w.row_ids).toEqual([2, 4, 5, 3, 1]);
    // Ties keep arrival order when the key runs descending, too.
    expect((await windowOf(id, { sort: [{ column: 1, descending: true }] })).row_ids).toEqual([3, 5, 2, 4, 1]);
  });

  it("filters before sorting and paging, keeping each row's id", async () => {
    const id = stored([col("name", "VARCHAR"), col("n", "INT")], [
      ["Anna", 5],
      ["bob", 1],
      ["HANNAH", 3],
      [null, 9],
      ["Joanna", 2],
    ]);
    const filters: ColumnFilter[] = [{ column: 0, operator: "contains", value: "ann" }];
    const w = await windowOf(id, { filters, sort: [{ column: 1, descending: false }], offset: 1, count: 1 });
    expect(w.matching_rows).toBe(3);
    expect(w.row_ids).toEqual([3]);
    expect(column(w)).toEqual(["HANNAH"]);
  });

  it("combines filters, compares numbers as numbers, and ignores a filter with no operand", async () => {
    const id = stored([col("name", "VARCHAR"), col("n", "BIGINT")], [["a", "9"], ["b", "10"], [null, "11"], [
      "d",
      "200",
    ]]);
    const w = await windowOf(id, {
      filters: [
        { column: 1, operator: "between", value: "10", value2: "150" },
        { column: 0, operator: "isNotNull", value: "" },
        { column: 0, operator: "contains", value: " " },
        { column: 1, operator: "between", value: "1", value2: null },
      ],
    });
    expect(w.row_ids).toEqual([2]);
    expect(w.matching_rows).toBe(1);
  });

  it("matches a binary cell only as not NULL", async () => {
    const id = stored([col("b", "BLOB")], [[[1, 2, 3]], [null]]);
    expect((await windowOf(id, { filters: [{ column: 0, operator: "isNotNull", value: "" }] })).row_ids).toEqual([1]);
    expect((await windowOf(id, { filters: [{ column: 0, operator: "isNull", value: "" }] })).row_ids).toEqual([2]);
    expect((await windowOf(id, { filters: [{ column: 0, operator: "contains", value: "1" }] })).row_ids).toEqual([]);
  });

  it("cuts text longer than 64 KiB and reports its real length", async () => {
    const exact = "x".repeat(WINDOW_MAX_CELL_BYTES);
    const long = "y".repeat(WINDOW_MAX_CELL_BYTES + 1);
    const id = stored([col("t", "LONGTEXT")], [[exact], [long], ["short"]]);
    const w = await windowOf(id);
    expect(w.rows[0][0]).toEqual({ value: exact, full_len: null });
    expect(w.rows[1][0]).toEqual({ value: "y".repeat(65_536), full_len: 65_537 });
    expect(w.rows[2][0]).toEqual({ value: "short", full_len: null });
  });

  it("measures text in bytes and never cuts inside a character", async () => {
    // 30,000 three-byte characters: 30,000 UTF-16 units, 90,000 bytes.
    const id = stored([col("t", "LONGTEXT")], [["€".repeat(30_000)]]);
    const { value, full_len } = (await windowOf(id)).rows[0][0];
    expect(full_len).toBe(90_000);
    // 65,536 is one byte into the 21,846th character, which is dropped.
    expect(value).toBe("€".repeat(21_845));
  });

  it("sends binary as base64, cut to 64 KiB with its real length", async () => {
    const big = Array.from({ length: WINDOW_MAX_CELL_BYTES + 10 }, (_, i) => i % 256);
    const id = stored([col("b", "BLOB")], [[[0, 255, 16, 104, 105]], [big]]);
    const w = await windowOf(id);
    expect(w.rows[0][0]).toEqual({ value: { bytes: "AP8QaGk=" }, full_len: null });

    const cut = w.rows[1][0];
    expect(cut.full_len).toBe(65_546);
    const bytes = Uint8Array.from(atob((cut.value as { bytes: string }).bytes), (c) => c.charCodeAt(0));
    expect(bytes).toHaveLength(65_536);
    expect([...bytes.slice(254, 258)]).toEqual([254, 255, 0, 1]);
  });

  it("rejects a sort or filter on a column the result does not have", async () => {
    const id = letters();
    const args = { resultId: id, offset: 0, count: 10 };
    expect(await rejection("result_window", { ...args, sort: [{ column: 2, descending: false }], filters: [] }))
      .toBe("Query error: The result has no column 2");
    expect(
      await rejection("result_window", { ...args, sort: [], filters: [{ column: 7, operator: "isNull", value: "" }] }),
    )
      .toBe("Query error: The result has no column 7");
  });

  it("rejects an id the store does not know", async () => {
    expect(await rejection("result_window", { resultId: "nope", offset: 0, count: 1, sort: [], filters: [] }))
      .toBe("Not found: Result nope");
  });
});

describe("result_cell", () => {
  it("returns the whole value a window cut short", async () => {
    const long = "z".repeat(WINDOW_MAX_CELL_BYTES + 100);
    const big = Array.from({ length: WINDOW_MAX_CELL_BYTES + 10 }, (_, i) => i % 256);
    const id = stored([col("t", "LONGTEXT"), col("b", "BLOB"), col("n", "INT")], [["first", [1], null], [
      long,
      big,
      7,
    ]]);

    expect(await call<WireValue>("result_cell", { resultId: id, rowId: 2, column: 0 })).toBe(long);
    const whole = await call<{ bytes: string }>("result_cell", { resultId: id, rowId: 2, column: 1 });
    expect(atob(whole.bytes)).toHaveLength(65_546);
    expect(await call<WireValue>("result_cell", { resultId: id, rowId: 2, column: 2 })).toBe(7);
    expect(await call<WireValue>("result_cell", { resultId: id, rowId: 1, column: 2 })).toBeNull();
  });

  it("finds a row by its id, whatever the window's order was", async () => {
    const id = stored([col("s", "VARCHAR")], [["b"], ["a"]]);
    const w = await windowOf(id, { sort: [{ column: 0, descending: false }] });
    expect(w.row_ids).toEqual([2, 1]);
    expect(await call<WireValue>("result_cell", { resultId: id, rowId: w.row_ids[0], column: 0 })).toBe("a");
  });

  it("rejects an unknown result, row or column", async () => {
    const id = stored([col("s", "VARCHAR")], [["a"]]);
    expect(await rejection("result_cell", { resultId: "nope", rowId: 1, column: 0 })).toBe("Not found: Result nope");
    expect(await rejection("result_cell", { resultId: id, rowId: 2, column: 0 })).toBe(
      `Not found: Row 2 of result ${id}`,
    );
    expect(await rejection("result_cell", { resultId: id, rowId: 0, column: 0 })).toBe(
      `Not found: Row 0 of result ${id}`,
    );
    expect(await rejection("result_cell", { resultId: id, rowId: 1, column: 1 }))
      .toBe(`Not found: Column 1 of result ${id}`);
  });
});

describe("result_release", () => {
  it("frees the ids it is given and ignores the ones it does not know", async () => {
    const kept = stored([col("n", "INT")], [[1]]);
    const freed = stored([col("n", "INT")], [[2]]);

    expect(await call("result_release", { resultIds: [freed, "never-existed"] })).toBeNull();
    expect(await rejection("result_window", { resultId: freed, offset: 0, count: 1, sort: [], filters: [] }))
      .toBe(`Not found: Result ${freed}`);
    expect((await windowOf(kept)).row_ids).toEqual([1]);
    // Releasing twice is not an error.
    expect(await call("result_release", { resultIds: [freed] })).toBeNull();
  });
});

describe("installing the mock again", () => {
  it("forgets the stored results", async () => {
    const id = stored([col("n", "INT")], [[1]]);
    install("?mock=connected");
    expect(await rejection("result_window", { resultId: id, offset: 0, count: 1, sort: [], filters: [] }))
      .toBe(`Not found: Result ${id}`);
  });
});
