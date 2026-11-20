import { describe, expect, it } from "vitest";
import type { ColumnMeta, SqlValue } from "../bindings";
import { compareCells, isNullValue, rowComparator } from "../result-compare";

// The result store's sort rules (docs/design/RESULT_STORE.md), shared by the
// in-memory row source and the mock backend.

const col = (name: string, data_type: string): ColumnMeta => ({
  name,
  data_type,
  nullable: true,
  is_primary_key: false,
});

const sorted = (values: SqlValue[], numeric: boolean) => [...values].sort((a, b) => compareCells(a, b, numeric));

describe("compareCells", () => {
  it("puts NULL before every value, in both of its spellings", () => {
    expect(sorted([3, null, -1, "Null", 0], true).slice(0, 2).every(isNullValue)).toBe(true);
    expect(sorted(["b", null, ""], false)).toEqual([null, "", "b"]);
    expect(compareCells(null, null, false)).toBe(0);
    expect(compareCells(null, "Null", true)).toBe(0);
  });

  it("orders a numeric column by value, not by its text", () => {
    expect(sorted([10, 9, 100, -2], true)).toEqual([-2, 9, 10, 100]);
    // DECIMAL travels as text.
    expect(sorted(["10.5", "9", "100", "-3.25"], true)).toEqual(["-3.25", "9", "10.5", "100"]);
  });

  it("compares BIGINT text exactly, beyond what a double can tell apart", () => {
    const a = "9007199254740993";
    const b = "9007199254740992";
    expect(Number(a)).toBe(Number(b));
    expect(compareCells(a, b, true)).toBe(1);
    expect(sorted([a, "-9007199254740993", b], true)).toEqual(["-9007199254740993", b, a]);
  });

  it("puts what is not a number after the numbers in a numeric column", () => {
    expect(sorted(["abc", 2, "", "1"], true)).toEqual(["1", 2, "", "abc"]);
  });

  it("orders text without regard to case, then by code unit so the order is fixed", () => {
    expect(sorted(["b", "A", "a", "B"], false)).toEqual(["A", "a", "B", "b"]);
    expect(sorted(["Zebra", "apple", "Mango"], false)).toEqual(["apple", "Mango", "Zebra"]);
  });

  it("orders text as text in a column that is not numeric", () => {
    // Plain text order, not natural order: "item10" is before "item2".
    expect(sorted(["item2", "item10", "item1"], false)).toEqual(["item1", "item10", "item2"]);
    expect(sorted(["10", "9"], false)).toEqual(["10", "9"]);
  });

  it("orders numbers, then text, then binary in a column of mixed values", () => {
    expect(sorted(["a", [1], 5, true, null], false)).toEqual([null, true, 5, "a", [1]]);
  });

  it("orders binary byte by byte, a prefix first", () => {
    expect(sorted([[2], [1, 9], [1]], false)).toEqual([[1], [1, 9], [2]]);
  });
});

describe("rowComparator", () => {
  const columns = [col("dept", "varchar"), col("salary", "int")];
  const rows: SqlValue[][] = [
    ["ops", 50],
    ["dev", 70],
    ["ops", 90],
    ["dev", null],
    ["Dev", 70],
  ];
  const order = (sort: { column: number; descending: boolean }[]) =>
    rows.map((_, i) => i).sort(rowComparator(rows, columns, sort));

  it("applies the keys in order", () => {
    // dept ascending ("Dev" before "dev": same letters, then by code unit),
    // salary descending within each, so its NULL comes last.
    expect(order([{ column: 0, descending: false }, { column: 1, descending: true }])).toEqual([4, 1, 3, 2, 0]);
  });

  it("puts NULL first ascending and last descending", () => {
    expect(order([{ column: 1, descending: false }])[0]).toBe(3);
    expect(order([{ column: 1, descending: true }])[4]).toBe(3);
  });

  it("settles ties by the order the rows arrived in, whichever way the key runs", () => {
    // Rows 1 and 4 both have 70.
    expect(order([{ column: 1, descending: false }])).toEqual([3, 0, 1, 4, 2]);
    expect(order([{ column: 1, descending: true }])).toEqual([2, 1, 4, 0, 3]);
  });

  it("skips a key for a column the result does not have", () => {
    expect(order([{ column: 7, descending: true }])).toEqual([0, 1, 2, 3, 4]);
    expect(order([{ column: 7, descending: true }, { column: 1, descending: true }])).toEqual([2, 1, 4, 0, 3]);
  });

  it("leaves the rows as they arrived with no keys", () => {
    expect(order([])).toEqual([0, 1, 2, 3, 4]);
  });
});
