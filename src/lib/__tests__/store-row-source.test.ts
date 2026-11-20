import { install } from "@/dev/mock/__tests__/helpers";
import { storeResult } from "@/dev/mock/handlers/results";
import type { ColumnMeta, QueryResult_Serialize, SqlValue } from "@/lib/bindings";
import { createStoreSource, fromWire, ROWS_TOO_LARGE } from "@/lib/store-row-source";
import { api } from "@/lib/tauri-api";
import type { StoredResultRef } from "@/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const col = (name: string, data_type = "VARCHAR"): ColumnMeta => ({
  name,
  data_type,
  nullable: true,
  is_primary_key: false,
});

const COLUMNS = [col("id", "INT"), col("name")];

/** Rows in the mock's store; `id` is 1..n, `name` counts down so sorting reverses them. */
function stored(n: number, columns = COLUMNS, make?: (i: number) => SqlValue[]): StoredResultRef {
  const rows: SqlValue[][] = Array.from(
    { length: n },
    (_, i) => make ? make(i) : [i + 1, `name ${String(n - i).padStart(6, "0")}`],
  );
  const result: QueryResult_Serialize = {
    query_id: "q",
    statement_index: 0,
    sql: "SELECT * FROM t",
    columns,
    rows,
    rows_affected: n,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
  };
  const handle = storeResult(result);
  return { result_id: handle.result_id, row_count: handle.row_count };
}

/** Let the mocked IPC calls and what they set off settle. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  install();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createStoreSource: windows", () => {
  it("knows its size before any read, and loads the visible range in aligned pages", async () => {
    const window = vi.spyOn(api, "resultWindow");
    const source = createStoreSource(stored(2000), COLUMNS);
    expect(source.rowCount).toBe(2000);
    expect(source.getSnapshot().viewCount).toBe(2000);
    expect(source.rowAt(0)).toBeUndefined();

    source.setVisibleRange(250, 280);
    await flush();
    // 30 rows on screen, a screen either side: rows 220..310, pages 1 (200..400).
    expect(window).toHaveBeenCalledTimes(1);
    expect(window.mock.calls[0].slice(1, 3)).toEqual([200, 200]);
    expect(source.rowAt(250)).toEqual({ index: 250, values: [251, "name 001750"], fullLens: null });
    expect(source.rowAt(199)).toBeUndefined();
    expect(source.getSnapshot().revision).toBeGreaterThan(0);
  });

  it("does not ask again for pages it has or is reading", async () => {
    const window = vi.spyOn(api, "resultWindow");
    const source = createStoreSource(stored(1000), COLUMNS);
    source.setVisibleRange(0, 30);
    source.setVisibleRange(0, 30);
    await flush();
    source.setVisibleRange(10, 40);
    await flush();
    expect(window).toHaveBeenCalledTimes(1);
  });

  it("reads consecutive missing pages as one window, at most 1,000 rows", async () => {
    const window = vi.spyOn(api, "resultWindow");
    const source = createStoreSource(stored(5000), COLUMNS);
    // The table layout says every row is on screen.
    source.setVisibleRange(0, 1500);
    await flush();
    const asked = window.mock.calls.map((c) => [c[1], c[2]]);
    // 1,500 rows on screen and as many after: three windows.
    expect(asked).toEqual([[0, 1000], [1000, 1000], [2000, 1000]]);
    expect(source.rowAt(1999)?.values[0]).toBe(2000);
  });

  it("keeps a bounded number of pages, dropping the least recently used", async () => {
    const window = vi.spyOn(api, "resultWindow");
    const source = createStoreSource(stored(1000), COLUMNS, { pageSize: 10, maxPages: 3 });
    // One row on screen, mid-page, so the margin stays inside one page.
    source.setVisibleRange(5, 6); // page 0
    await flush();
    source.setVisibleRange(55, 56); // page 5
    await flush();
    source.setVisibleRange(5, 6); // page 0 again: still cached, now the most recent
    await flush();
    source.setVisibleRange(105, 106); // page 10
    await flush();
    source.setVisibleRange(205, 206); // page 20: evicts page 5
    await flush();
    expect(source.rowAt(5)).toBeDefined();
    expect(source.rowAt(55)).toBeUndefined();
    expect(source.rowAt(205)).toBeDefined();
    expect(window).toHaveBeenCalledTimes(4);
  });

  it("answers a sample from what it has, from the top, and never reads for it", async () => {
    const window = vi.spyOn(api, "resultWindow");
    const source = createStoreSource(stored(1000), COLUMNS);
    expect(source.sampleRows(300)).toEqual([]);
    source.setVisibleRange(0, 10);
    await flush();
    expect(source.sampleRows(300)).toHaveLength(200);
    expect(source.sampleRows(5).map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(window).toHaveBeenCalledTimes(1);
  });

  it("turns base64 binary into bytes and reports cut values' full lengths", async () => {
    const big = "x".repeat(70 * 1024);
    const columns = [col("data", "BLOB"), col("text", "TEXT")];
    const source = createStoreSource(stored(1, columns, () => [[0, 1, 255], big]), columns);
    source.setVisibleRange(0, 1);
    await flush();
    const row = source.rowAt(0);
    expect(row?.values[0]).toEqual([0, 1, 255]);
    expect(row?.fullLens).toEqual([null, big.length]);
    expect(String(row?.values[1]).length).toBeLessThan(big.length);
    expect(await source.cell(0, 1)).toBe(big);
    expect(await source.cell(0, 0)).toEqual([0, 1, 255]);
    expect(fromWire(null)).toBeNull();
    expect(fromWire({ bytes: "AAE=" })).toEqual([0, 1]);
  });
});

describe("createStoreSource: views", () => {
  it("keeps the previous count until the first window of a filtered view says", async () => {
    const source = createStoreSource(stored(500), COLUMNS);
    source.setVisibleRange(0, 20);
    await flush();
    source.setView([], [{ column: 0, operator: "lt", value: "11" }]);
    // Not 0, and not yet 10: the old count stands.
    expect(source.getSnapshot().viewCount).toBe(500);
    expect(source.getSnapshot().filters).toHaveLength(1);
    await flush();
    expect(source.getSnapshot().viewCount).toBe(10);
    expect(source.rowAt(9)?.values[0]).toBe(10);
  });

  it("learns the size of a view whose old count was 0", async () => {
    const source = createStoreSource(stored(100), COLUMNS);
    source.setView([], [{ column: 0, operator: "gt", value: "1000" }]);
    await flush();
    expect(source.getSnapshot().viewCount).toBe(0);
    source.setView([], [{ column: 0, operator: "gt", value: "90" }]);
    await flush();
    expect(source.getSnapshot().viewCount).toBe(10);
  });

  it("drops a window that arrives for a view that is no longer current", async () => {
    let answer: (() => void) | null = null;
    const real = api.resultWindow;
    const window = vi.spyOn(api, "resultWindow").mockImplementationOnce((...args) =>
      new Promise((resolve, reject) => {
        answer = () => void real(...args).then(resolve, reject);
      })
    );
    const source = createStoreSource(stored(300), COLUMNS);
    source.setVisibleRange(0, 10);
    // Sorted before the unsorted window comes back.
    source.setView([{ column: 0, descending: true }], []);
    await flush();
    expect(source.rowAt(0)?.values[0]).toBe(300);
    answer?.();
    await flush();
    expect(source.rowAt(0)?.values[0]).toBe(300);
    expect(window).toHaveBeenCalledTimes(2);
  });

  it("ignores a view it already has", async () => {
    const source = createStoreSource(stored(10), COLUMNS);
    const revision = source.getSnapshot().revision;
    source.setView([], []);
    source.setView([{ column: 9, descending: false }], []);
    expect(source.getSnapshot().revision).toBe(revision);
  });

  it("reads every row of the view in view order", async () => {
    const source = createStoreSource(stored(30), COLUMNS);
    source.setView([{ column: 1, descending: false }], [{ column: 0, operator: "lt", value: "6" }]);
    await flush();
    const rows = await source.allRows();
    expect(rows.map((r) => r[0])).toEqual([5, 4, 3, 2, 1]);
  });

  it("orders, finds and lists rows by the view", async () => {
    const source = createStoreSource(stored(10), COLUMNS);
    source.setView([{ column: 0, descending: true }], []);
    expect(await source.order([0, 5, 9, 5, 42])).toEqual([9, 5, 0]);
    expect(await source.positionOf(9)).toBe(0);
    expect(await source.positionOf(-1)).toBeNull();
    expect(await source.indicesAt(0, 3)).toEqual([9, 8, 7]);
    expect(await source.indicesAt(8, 50)).toEqual([1, 0]);
  });
});

describe("createStoreSource: whole rows", () => {
  it("reads rows in the order asked, in chunks of at most 1,000", async () => {
    const rowsCall = vi.spyOn(api, "resultRows");
    const source = createStoreSource(stored(2500), COLUMNS);
    const indices = Array.from({ length: 2500 }, (_, i) => 2499 - i);
    const rows = await source.rows(indices);
    expect(rows).toHaveLength(2500);
    expect(rows[0][0]).toBe(2500);
    expect(rowsCall.mock.calls.map((c) => c[1].length)).toEqual([1000, 1000, 500]);
  });

  it("halves the chunk when the rows are too large, down to one row", async () => {
    const real = api.resultRows;
    const rowsCall = vi.spyOn(api, "resultRows").mockImplementation((id, ids) =>
      ids.length > 1 ? Promise.reject(new Error(`Query error: ${ROWS_TOO_LARGE}: ...`)) : real(id, ids)
    );
    const source = createStoreSource(stored(4), COLUMNS);
    const rows = await source.rows([0, 1, 2, 3]);
    expect(rows.map((r) => r[0])).toEqual([1, 2, 3, 4]);
    expect(rowsCall.mock.calls.map((c) => c[1].length)).toEqual([4, 2, 1, 1, 1, 1]);
  });

  it("rejects an index that is not in the result", async () => {
    const source = createStoreSource(stored(3), COLUMNS);
    await expect(source.rows([3])).rejects.toThrow(/not in the result/);
    await expect(source.cell(0, 7)).rejects.toThrow(/no column/);
  });
});

describe("createStoreSource: failures", () => {
  it("records a failed read, notifies, and asks again after a wait", async () => {
    vi.useFakeTimers();
    const real = api.resultWindow;
    const window = vi.spyOn(api, "resultWindow").mockRejectedValueOnce(new Error("lost"));
    window.mockImplementation(real);
    const source = createStoreSource(stored(50), COLUMNS, { retryMs: 100 });
    const listener = vi.fn();
    source.subscribe(listener);
    source.setVisibleRange(0, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalled();
    expect(source.rowAt(0)).toBeUndefined();
    // Asked again at once (the grid repaints): still waiting.
    source.setVisibleRange(0, 10);
    expect(window).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(window).toHaveBeenCalledTimes(2);
    expect(source.rowAt(0)?.values[0]).toBe(1);
  });
});

describe("createStoreSource: no rows", () => {
  it("never calls the backend for a result with no rows", async () => {
    const spies = [
      vi.spyOn(api, "resultWindow"),
      vi.spyOn(api, "resultRows"),
      vi.spyOn(api, "resultRowIds"),
      vi.spyOn(api, "resultOrder"),
      vi.spyOn(api, "resultRowPosition"),
      vi.spyOn(api, "resultCell"),
    ];
    const source = createStoreSource({ result_id: "unknown", row_count: 0 }, COLUMNS);
    source.setVisibleRange(0, 10);
    source.setView([{ column: 0, descending: false }], [{ column: 0, operator: "equals", value: "1" }]);
    expect(source.getSnapshot().viewCount).toBe(0);
    expect(await source.allRows()).toEqual([]);
    expect(await source.order([0])).toEqual([]);
    expect(await source.positionOf(0)).toBeNull();
    expect(await source.indicesAt(0, 10)).toEqual([]);
    expect(await source.rows([])).toEqual([]);
    await flush();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("createStoreSource: dispose", () => {
  it("drops the cache and ignores what arrives afterwards", async () => {
    const source = createStoreSource(stored(10), COLUMNS);
    const listener = vi.fn();
    source.subscribe(listener);
    source.setVisibleRange(0, 10);
    source.dispose();
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(source.rowAt(0)).toBeUndefined();
  });
});
