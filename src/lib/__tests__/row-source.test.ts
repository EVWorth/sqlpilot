import { describe, expect, it, vi } from "vitest";
import type { ColumnMeta, QueryResult, SqlValue } from "../bindings";
import { allIndices, createArraySource, EMPTY_ROW_SOURCE, normalizeView, rowSourceFor } from "../row-source";
import { createFakeSource } from "./fake-row-source";

const col = (name: string, data_type: string): ColumnMeta => ({
  name,
  data_type,
  nullable: true,
  is_primary_key: false,
});

function makeResult(rows?: SqlValue[][]): QueryResult {
  return {
    query_id: "q",
    statement_index: 0,
    sql: "SELECT * FROM staff",
    columns: [col("id", "int"), col("name", "varchar"), col("salary", "decimal")],
    rows: rows ?? [
      [1, "cy", "100"],
      [2, "Ada", "9"],
      [3, "bob", null],
      [4, "ada", "10.5"],
    ],
    rows_affected: 0,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
  };
}

const asc = (column: number) => ({ column, descending: false });
const desc = (column: number) => ({ column, descending: true });

/** The indices in view order, read the way the grid paints. */
const painted = (source: ReturnType<typeof createArraySource>) =>
  Array.from({ length: source.getSnapshot().viewCount }, (_, p) => source.rowAt(p)?.index);

describe("createArraySource", () => {
  it("starts as the result the server returned", () => {
    const source = createArraySource(makeResult());
    expect(source.rowCount).toBe(4);
    expect(source.columns.map((c) => c.name)).toEqual(["id", "name", "salary"]);
    expect(source.getSnapshot()).toMatchObject({ viewCount: 4, sort: [], filters: [] });
    expect(painted(source)).toEqual([0, 1, 2, 3]);
  });

  it("paints a row as its index, its values in place, and nothing cut", () => {
    const result = makeResult();
    const row = createArraySource(result).rowAt(1);
    expect(row).toEqual({ index: 1, values: [2, "Ada", "9"], fullLens: null });
    // The result's own row, not a copy of it.
    expect(row?.values).toBe(result.rows[1]);
  });

  it("has no row outside the view", () => {
    const source = createArraySource(makeResult());
    expect(source.rowAt(-1)).toBeUndefined();
    expect(source.rowAt(4)).toBeUndefined();
    expect(source.rowAt(1.5)).toBeUndefined();
    source.setView([], [{ column: 1, operator: "contains", value: "ada" }]);
    expect(source.rowAt(2)).toBeUndefined();
  });

  describe("sorting", () => {
    it("sorts text without regard to case", () => {
      const source = createArraySource(makeResult());
      source.setView([asc(1)], []);
      expect(painted(source)).toEqual([1, 3, 2, 0]);
      source.setView([desc(1)], []);
      expect(painted(source)).toEqual([0, 2, 3, 1]);
    });

    it("sorts a numeric column by value, NULL first ascending and last descending", () => {
      const source = createArraySource(makeResult());
      source.setView([asc(2)], []);
      expect(painted(source)).toEqual([2, 1, 3, 0]);
      source.setView([desc(2)], []);
      expect(painted(source)).toEqual([0, 3, 1, 2]);
    });

    it("sorts by several keys in order, and by arrival where they tie", () => {
      const source = createArraySource(makeResult([
        [1, "ops", "5"],
        [2, "dev", "7"],
        [3, "ops", "9"],
        [4, "dev", "7"],
      ]));
      source.setView([asc(1), desc(2)], []);
      expect(painted(source)).toEqual([1, 3, 2, 0]);
    });

    it("keeps each row's index, whatever position it is painted at", () => {
      const source = createArraySource(makeResult());
      source.setView([asc(1)], []);
      expect(source.rowAt(0)).toMatchObject({ index: 1, values: [2, "Ada", "9"] });
      expect(source.rowAt(3)).toMatchObject({ index: 0, values: [1, "cy", "100"] });
    });

    it("goes back to arrival order when the sort is cleared", () => {
      const source = createArraySource(makeResult());
      source.setView([desc(0)], []);
      source.setView([], []);
      expect(painted(source)).toEqual([0, 1, 2, 3]);
    });
  });

  describe("filtering", () => {
    it("keeps the rows that pass every filter, and counts them", () => {
      const source = createArraySource(makeResult());
      source.setView([], [{ column: 1, operator: "contains", value: "ada" }]);
      expect(painted(source)).toEqual([1, 3]);
      expect(source.getSnapshot().viewCount).toBe(2);
      expect(source.rowCount).toBe(4);

      source.setView([], [
        { column: 1, operator: "contains", value: "ada" },
        { column: 2, operator: "gt", value: "10" },
      ]);
      expect(painted(source)).toEqual([3]);
    });

    it("uses the grid's own filter rules, NULL included", () => {
      const source = createArraySource(makeResult());
      source.setView([], [{ column: 2, operator: "isNull", value: "" }]);
      expect(painted(source)).toEqual([2]);
      // NULL passes nothing but isNull, as in SQL.
      source.setView([], [{ column: 2, operator: "notEquals", value: "9" }]);
      expect(painted(source)).toEqual([0, 3]);
      source.setView([], [{ column: 2, operator: "between", value: "9", value2: "50" }]);
      expect(painted(source)).toEqual([1, 3]);
    });

    it("filters, then sorts what is left", () => {
      const source = createArraySource(makeResult());
      source.setView([desc(0)], [{ column: 1, operator: "contains", value: "ada" }]);
      expect(painted(source)).toEqual([3, 1]);
    });

    it("leaves out a filter that would narrow nothing, and one for a missing column", () => {
      const source = createArraySource(makeResult());
      source.setView([asc(9)], [
        { column: 1, operator: "contains", value: "  " },
        { column: 2, operator: "between", value: "1", value2: null },
        { column: 9, operator: "isNull", value: "" },
      ]);
      expect(source.getSnapshot()).toMatchObject({ viewCount: 4, sort: [], filters: [] });
    });
  });

  describe("subscription", () => {
    it("tells subscribers when the view changes, with a new snapshot", () => {
      const source = createArraySource(makeResult());
      const listener = vi.fn();
      const before = source.getSnapshot();
      source.subscribe(listener);

      source.setView([asc(1)], []);

      expect(listener).toHaveBeenCalledTimes(1);
      const after = source.getSnapshot();
      expect(after).not.toBe(before);
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.sort).toEqual([asc(1)]);
    });

    it("keeps the same snapshot, and says nothing, when the view is set to what it is", () => {
      const source = createArraySource(makeResult());
      source.setView([asc(1)], [{ column: 1, operator: "contains", value: "a" }]);
      const listener = vi.fn();
      source.subscribe(listener);
      const before = source.getSnapshot();

      // New arrays, the same view; and a filter that is not active changes nothing.
      source.setView([asc(1)], [
        { column: 1, operator: "contains", value: "a", value2: null },
        { column: 0, operator: "equals", value: "" },
      ]);

      expect(listener).not.toHaveBeenCalled();
      expect(source.getSnapshot()).toBe(before);
    });

    it("stops telling a subscriber that left", () => {
      const source = createArraySource(makeResult());
      const listener = vi.fn();
      const unsubscribe = source.subscribe(listener);
      unsubscribe();
      source.setView([asc(1)], []);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("asynchronous access", () => {
    it("returns rows by index, in the order asked, whatever the view", async () => {
      const source = createArraySource(makeResult());
      source.setView([asc(1)], [{ column: 1, operator: "contains", value: "ada" }]);
      expect(await source.rows([2, 0])).toEqual([[3, "bob", null], [1, "cy", "100"]]);
      expect(await source.rows([])).toEqual([]);
    });

    it("rejects for a row that is not in the result", async () => {
      const source = createArraySource(makeResult());
      await expect(source.rows([0, 4])).rejects.toThrow("Row 4 is not in the result");
      await expect(source.rows([-1])).rejects.toThrow("Row -1 is not in the result");
      await expect(source.cell(9, 0)).rejects.toThrow("Row 9 is not in the result");
      await expect(source.cell(0, 9)).rejects.toThrow("no column 9");
    });

    it("returns one cell", async () => {
      const source = createArraySource(makeResult());
      expect(await source.cell(3, 1)).toBe("ada");
      expect(await source.cell(2, 2)).toBeNull();
    });

    it("returns every row of the view, in view order", async () => {
      const source = createArraySource(makeResult());
      expect(await source.allRows()).toEqual(makeResult().rows);
      source.setView([desc(0)], [{ column: 1, operator: "contains", value: "ada" }]);
      expect(await source.allRows()).toEqual([[4, "ada", "10.5"], [2, "Ada", "9"]]);
    });

    it("puts a set of indices in view order, leaving out the ones filtered away", async () => {
      const source = createArraySource(makeResult());
      expect(await source.order([3, 0, 2])).toEqual([0, 2, 3]);
      source.setView([asc(1)], []);
      expect(await source.order([0, 2, 3, 3])).toEqual([3, 2, 0]);
      source.setView([asc(1)], [{ column: 1, operator: "contains", value: "ada" }]);
      expect(await source.order([0, 1, 2, 3, 99])).toEqual([1, 3]);
    });

    it("says where a row is in the view, or that it is not in it", async () => {
      const source = createArraySource(makeResult());
      expect(await source.positionOf(2)).toBe(2);
      source.setView([asc(1)], [{ column: 1, operator: "contains", value: "ada" }]);
      expect(await source.positionOf(3)).toBe(1);
      expect(await source.positionOf(0)).toBeNull();
      expect(await source.positionOf(42)).toBeNull();
      // And again after the view changes: nothing stale is kept.
      source.setView([desc(1)], []);
      expect(await source.positionOf(0)).toBe(0);
    });

    it("returns the indices at a range of positions, clamped to the view", async () => {
      const source = createArraySource(makeResult());
      expect(await source.indicesAt(1, 3)).toEqual([1, 2]);
      expect(await source.indicesAt(-5, 99)).toEqual([0, 1, 2, 3]);
      expect(await source.indicesAt(3, 1)).toEqual([]);
      source.setView([asc(1)], []);
      expect(await source.indicesAt(0, 2)).toEqual([1, 3]);
      expect(await source.indicesAt(3, 9)).toEqual([0]);
    });
  });

  it("samples from the top of the view, no more than asked", () => {
    const source = createArraySource(makeResult());
    expect(source.sampleRows(2).map((r) => r.index)).toEqual([0, 1]);
    expect(source.sampleRows(99)).toHaveLength(4);
    source.setView([asc(1)], []);
    expect(source.sampleRows(1).map((r) => r.index)).toEqual([1]);
  });

  it("takes the range on screen without needing it", () => {
    const source = createArraySource(makeResult());
    expect(() => source.setVisibleRange(0, 2)).not.toThrow();
    expect(painted(source)).toEqual([0, 1, 2, 3]);
  });
});

describe("rowSourceFor", () => {
  it("gives one source per result object, so its view outlives a remount", () => {
    const result = makeResult();
    const source = rowSourceFor(result);
    source.setView([asc(1)], []);
    expect(rowSourceFor(result)).toBe(source);
    expect(rowSourceFor(result).getSnapshot().sort).toEqual([asc(1)]);
  });

  it("gives another result another source, equal rows or not", () => {
    expect(rowSourceFor(makeResult())).not.toBe(rowSourceFor(makeResult()));
  });

  it("gives the empty source for no result", () => {
    expect(rowSourceFor(undefined)).toBe(EMPTY_ROW_SOURCE);
    expect(EMPTY_ROW_SOURCE.rowCount).toBe(0);
    expect(EMPTY_ROW_SOURCE.getSnapshot().viewCount).toBe(0);
  });

  it("lists every index of a result", () => {
    expect(allIndices(rowSourceFor(makeResult()))).toEqual([0, 1, 2, 3]);
  });
});

describe("normalizeView", () => {
  it("keeps what applies", () => {
    const columns = makeResult().columns;
    expect(normalizeView(columns, [asc(0), desc(5)], [{ column: 0, operator: "isNotNull", value: "" }])).toEqual({
      sort: [asc(0)],
      filters: [{ column: 0, operator: "isNotNull", value: "" }],
    });
  });
});

// The stand-in for a source that reads from the backend, which the grid's
// tests are written against. It has to behave as the interface says.
describe("the fake source the grid's tests use", () => {
  it("has no row until one is delivered, and says so when it is", () => {
    const source = createFakeSource(makeResult());
    const listener = vi.fn();
    source.subscribe(listener);
    const before = source.getSnapshot();
    expect(source.rowAt(0)).toBeUndefined();
    expect(source.sampleRows(10)).toEqual([]);
    expect(before.viewCount).toBe(4);

    source.deliver(0, 2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).not.toBe(before);
    expect(source.rowAt(1)?.index).toBe(1);
    expect(source.rowAt(2)).toBeUndefined();
  });

  it("forgets what it had when the view changes", () => {
    const source = createFakeSource(makeResult(), { loaded: 4 });
    source.setView([asc(1)], []);
    expect(source.rowAt(0)).toBeUndefined();
    source.deliver();
    expect(source.rowAt(0)?.index).toBe(1);
  });

  it("paints a long value cut, with its full length, and returns it whole when asked", async () => {
    const source = createFakeSource(makeResult([[1, "a long name", [1, 2, 3, 4, 5]]]), { loaded: 1, cutAt: 4 });
    expect(source.rowAt(0)).toEqual({ index: 0, values: [1, "a lo", [1, 2, 3, 4]], fullLens: [null, 11, 5] });
    expect(await source.cell(0, 1)).toBe("a long name");
    expect(await source.rows([0])).toEqual([[1, "a long name", [1, 2, 3, 4, 5]]]);
  });

  it("holds its answers until released", async () => {
    const source = createFakeSource(makeResult(), { held: true });
    const done = vi.fn();
    void source.rows([0]).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    source.release();
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith([[1, "cy", "100"]]));
  });
});
