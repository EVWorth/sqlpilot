import type { ColumnMeta, SortKey, SqlValue } from "./bindings";
import { isNumericSqlType } from "./sql-types";

/**
 * How a result's rows are ordered when the grid sorts them.
 *
 * These are the rules of the backend's result store
 * (docs/design/RESULT_STORE.md), which sorts with SQLite. They live here once
 * so the in-memory row source (`row-source.ts`) and the mock backend
 * (`dev/mock/handlers/results.ts`) cannot drift from each other: a result
 * sorts the same whether its rows are in the webview or in the store.
 *
 * - NULL sorts before everything ascending, so after everything descending.
 * - A numeric column (by its declared type) sorts by value, including the
 *   BIGINT and DECIMAL values that travel as text.
 * - Text sorts regardless of case.
 * - The row's place in the result settles ties, whichever way the keys run.
 */

/** NULL as the grid has it, and as the Rust enum's unit variant serializes. */
export const isNullValue = (v: SqlValue): v is null | "Null" => v === null || v === "Null";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const order = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** Text regardless of case, then by code unit so the order is fixed. */
const compareText = (a: string, b: string) => order(a.toLowerCase(), b.toLowerCase()) || order(a, b);

const INTEGER = /^-?\d+$/;

/** By value. BIGINT travels as text and is compared exactly, not as a double. */
function compareNumbers(a: number | string | boolean, b: number | string | boolean): number {
  if (typeof a === "string" && typeof b === "string" && INTEGER.test(a) && INTEGER.test(b)) {
    return order(BigInt(a), BigInt(b));
  }
  return sign(Number(a) - Number(b));
}

const isNumber = (v: number | string | boolean) =>
  typeof v !== "string" || (v.trim() !== "" && Number.isFinite(Number(v)));

function compareBytes(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Two cells of one column, ascending. NULL first; then, in a numeric column,
 * numbers by value before anything that is not one; in any other column
 * numbers, then text, then binary, as SQLite orders its storage classes.
 */
export function compareCells(a: SqlValue, b: SqlValue, numeric: boolean): number {
  if (isNullValue(a) || isNullValue(b)) return Number(isNullValue(b)) - Number(isNullValue(a));
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) ? compareBytes(a, b) : Array.isArray(a) ? 1 : -1;
  }
  if (numeric) {
    const [na, nb] = [isNumber(a), isNumber(b)];
    if (na && nb) return compareNumbers(a, b) || order(String(a), String(b));
    if (na !== nb) return na ? -1 : 1;
    return compareText(String(a), String(b));
  }
  const [ta, tb] = [typeof a === "string", typeof b === "string"];
  if (ta && tb) return compareText(String(a), String(b));
  if (ta !== tb) return ta ? 1 : -1;
  return compareNumbers(a, b);
}

/**
 * A comparison of two row positions under `sort`, for `Array.prototype.sort`.
 *
 * Keys apply in order; a key naming a column the result does not have is
 * skipped. Rows equal under every key keep the order the server returned them
 * in, ascending or descending.
 */
export function rowComparator(
  rows: readonly (readonly SqlValue[])[],
  columns: readonly ColumnMeta[],
  sort: readonly SortKey[],
): (x: number, y: number) => number {
  const keys = sort
    .filter((key) => columns[key.column] !== undefined)
    .map((key) => ({
      column: key.column,
      descending: key.descending,
      numeric: isNumericSqlType(columns[key.column].data_type),
    }));
  return (x, y) => {
    for (const key of keys) {
      const c = compareCells(rows[x][key.column], rows[y][key.column], key.numeric);
      if (c !== 0) return key.descending ? -c : c;
    }
    return x - y;
  };
}
