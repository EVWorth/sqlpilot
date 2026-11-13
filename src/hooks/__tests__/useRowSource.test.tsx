import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeSource } from "../../lib/__tests__/fake-row-source";
import type { GridSort } from "../../lib/grid-sort";
import { createArraySource, EMPTY_ROW_SOURCE, rowSourceFor } from "../../lib/row-source";
import type { QueryResult, SqlValue } from "../../types";
import { measureContent, useContentWidths, useRowSource, WIDTH_SAMPLE_ROWS } from "../useRowSource";

function makeResult(rows: SqlValue[][] = [[1, "cy"], [2, "ada"], [3, "bob"]]): QueryResult {
  return {
    columns: [
      { name: "id", data_type: "int", nullable: false, is_primary_key: true },
      { name: "name", data_type: "varchar", nullable: true, is_primary_key: false },
    ],
    rows,
    sql: "SELECT * FROM users",
  } as unknown as QueryResult;
}

const NO_FILTERS: never[] = [];

describe("useRowSource", () => {
  it("hands the grid's sort and filters to the result's source, by column position", () => {
    const result = makeResult();
    const sort: GridSort = [{ id: "name", desc: false }];
    const { result: hook } = renderHook(() =>
      useRowSource(result, sort, [{ id: "id", value: { operator: "gt", value: "1" } }])
    );

    expect(hook.current.source).toBe(rowSourceFor(result));
    expect(hook.current.view.sort).toEqual([{ column: 1, descending: false }]);
    expect(hook.current.view.filters).toEqual([{ column: 0, operator: "gt", value: "1", value2: null }]);
    expect(hook.current.view.viewCount).toBe(2);
    expect(hook.current.source.rowAt(0)?.values).toEqual([2, "ada"]);
  });

  it("follows the sort as it changes", () => {
    const result = makeResult();
    const { result: hook, rerender } = renderHook(({ sort }) => useRowSource(result, sort, NO_FILTERS), {
      initialProps: { sort: [] as GridSort },
    });
    expect(hook.current.source.rowAt(0)?.index).toBe(0);

    rerender({ sort: [{ id: "name", desc: true }] });
    expect(hook.current.view.sort).toEqual([{ column: 1, descending: true }]);
    expect(hook.current.source.rowAt(0)?.index).toBe(0);
    expect(hook.current.source.rowAt(2)?.index).toBe(1);
  });

  it("puts a remounted grid's own view on a source another mount left sorted and filtered", () => {
    // One source per result, so its view outlives the grid; what the grid
    // shows after a tab switch is still the grid's to say (grid-memory).
    const result = makeResult();
    rowSourceFor(result).setView([{ column: 0, descending: true }], [{ column: 1, operator: "contains", value: "a" }]);

    const kept: GridSort = [{ id: "name", desc: false }];
    const { result: hook } = renderHook(() => useRowSource(result, kept, NO_FILTERS));

    expect(hook.current.view).toMatchObject({ viewCount: 3, sort: [{ column: 1, descending: false }], filters: [] });
  });

  it("ignores a sort key for a column the result does not have", () => {
    const { result: hook } = renderHook(() => useRowSource(makeResult(), [{ id: "gone", desc: false }], NO_FILTERS));
    expect(hook.current.view.sort).toEqual([]);
  });

  it("has an empty source when there is no result", () => {
    const { result: hook } = renderHook(() => useRowSource(undefined, [], NO_FILTERS));
    expect(hook.current.source).toBe(EMPTY_ROW_SOURCE);
    expect(hook.current.view.viewCount).toBe(0);
  });

  it("re-renders when the source says rows arrived", () => {
    const result = makeResult();
    const first = rowSourceFor(result);
    let renders = 0;
    const { result: hook } = renderHook(() => {
      renders++;
      return useRowSource(result, [], NO_FILTERS);
    });
    const before = renders;
    const revision = hook.current.view.revision;

    // The in-memory source has every row; a change of view is what it reports.
    act(() => first.setView([{ column: 1, descending: false }], [{ column: 0, operator: "gt", value: "1" }]));

    expect(renders).toBeGreaterThan(before);
    expect(hook.current.view.revision).toBeGreaterThan(revision);
  });
});

describe("the column width sample", () => {
  it("measures the longest value per column, and the column's own name", () => {
    const source = createArraySource(makeResult([[1, "a"], [22222222, "abcdef"], [3, null]]));
    expect(measureContent(source)).toEqual({ id: 8, name: 6 });
    expect(measureContent(createArraySource(makeResult([[1, "a"]])))).toEqual({ id: 2, name: 4 });
  });

  it("looks at a bounded number of rows, however many the result has", () => {
    const rows = Array.from({ length: WIDTH_SAMPLE_ROWS + 50 }, (_, i): SqlValue[] => [i, "x"]);
    // The widest value is past the sample, so it is not what the width is from.
    rows[WIDTH_SAMPLE_ROWS + 10] = [0, "a value far wider than any in the sample"];
    rows[WIDTH_SAMPLE_ROWS - 1] = [0, "the widest sampled"];
    expect(measureContent(createArraySource(makeResult(rows))).name).toBe("the widest sampled".length);
  });

  it("uses only rows the source already has, and never asks for more", () => {
    const rows = Array.from({ length: 1000 }, (_, i): SqlValue[] => [i, `name-${i}`]);
    const fake = createFakeSource(makeResult(rows), { held: true });
    fake.deliver(0, 5);

    expect(measureContent(fake)).toEqual({ id: 2, name: 6 });
    expect(fake.asked).toEqual([]);
  });

  it("waits for the first rows, then keeps its widths as more arrive", () => {
    const rows: SqlValue[][] = [[1, "short"], [2, "a much longer name than that"]];
    const fake = createFakeSource(makeResult(rows));
    const { result: hook, rerender } = renderHook(() => useContentWidths(fake, fake.getSnapshot().revision));
    // Nothing to measure yet: the header alone.
    expect(hook.current).toEqual({ id: 2, name: 4 });

    act(() => fake.deliver(0, 1));
    rerender();
    expect(hook.current).toEqual({ id: 2, name: 5 });
    const settled = hook.current;

    // A longer value arriving later does not make the columns jump.
    act(() => fake.deliver());
    rerender();
    expect(hook.current).toBe(settled);
  });

  it("measures again for another result", () => {
    const a = createArraySource(makeResult([[1, "abcdefgh"]]));
    const b = createArraySource(makeResult([[1, "abc"]]));
    const { result: hook, rerender } = renderHook(({ source }) => useContentWidths(source, 0), {
      initialProps: { source: a },
    });
    expect(hook.current.name).toBe(8);
    rerender({ source: b });
    expect(hook.current.name).toBe(4);
  });
});
