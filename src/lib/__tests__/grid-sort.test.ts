import { describe, expect, it } from "vitest";
import type { ColumnMeta } from "../bindings";
import { toggleSort, toResultFilters, toSortKeys } from "../grid-sort";

const col = (name: string): ColumnMeta => ({ name, data_type: "int", nullable: true, is_primary_key: false });

describe("toggleSort", () => {
  it("cycles a plain click: ascending, descending, unsorted", () => {
    const asc = toggleSort([], "id", false);
    expect(asc).toEqual([{ id: "id", desc: false }]);
    const desc = toggleSort(asc, "id", false);
    expect(desc).toEqual([{ id: "id", desc: true }]);
    expect(toggleSort(desc, "id", false)).toEqual([]);
  });

  it("replaces the sort on a plain click of another column", () => {
    expect(toggleSort([{ id: "id", desc: true }], "name", false)).toEqual([{ id: "name", desc: false }]);
  });

  it("collapses a multi-sort to the clicked column on a plain click", () => {
    const multi = [{ id: "dept", desc: false }, { id: "hired", desc: false }];
    expect(toggleSort(multi, "dept", false)).toEqual([{ id: "dept", desc: true }]);
    expect(toggleSort(multi, "name", false)).toEqual([{ id: "name", desc: false }]);
    expect(toggleSort([{ id: "dept", desc: true }, { id: "hired", desc: false }], "dept", false)).toEqual([]);
  });

  it("adds a further key with Shift, keeping the order the keys were added in (#392)", () => {
    const one = toggleSort([], "dept", true);
    expect(one).toEqual([{ id: "dept", desc: false }]);
    expect(toggleSort(one, "hired", true)).toEqual([{ id: "dept", desc: false }, { id: "hired", desc: false }]);
  });

  it("cycles a key in place with Shift, and drops it after descending", () => {
    const two = [{ id: "dept", desc: false }, { id: "hired", desc: false }];
    const flipped = toggleSort(two, "dept", true);
    expect(flipped).toEqual([{ id: "dept", desc: true }, { id: "hired", desc: false }]);
    expect(toggleSort(flipped, "dept", true)).toEqual([{ id: "hired", desc: false }]);
  });

  it("does not change the sort it was given", () => {
    const sort = [{ id: "dept", desc: false }];
    toggleSort(sort, "dept", true);
    expect(sort).toEqual([{ id: "dept", desc: false }]);
  });
});

describe("toSortKeys and toResultFilters", () => {
  const columns = [col("id"), col("name")];

  it("names columns by their position in the result", () => {
    expect(toSortKeys([{ id: "name", desc: true }, { id: "id", desc: false }], columns)).toEqual([
      { column: 1, descending: true },
      { column: 0, descending: false },
    ]);
    expect(toResultFilters([{ id: "name", value: { operator: "between", value: "a", value2: "c" } }], columns))
      .toEqual([{ column: 1, operator: "between", value: "a", value2: "c" }]);
  });

  it("drops what names a column the result does not have", () => {
    // The sort is kept by name across a re-run, which may select other columns.
    expect(toSortKeys([{ id: "gone", desc: false }, { id: "id", desc: true }], columns)).toEqual([
      { column: 0, descending: true },
    ]);
    expect(toResultFilters([{ id: "gone", value: { operator: "isNull", value: "" } }], columns)).toEqual([]);
  });

  it("sends no upper bound as null", () => {
    expect(toResultFilters([{ id: "id", value: { operator: "gt", value: "3" } }], columns)).toEqual([
      { column: 0, operator: "gt", value: "3", value2: null },
    ]);
  });
});
