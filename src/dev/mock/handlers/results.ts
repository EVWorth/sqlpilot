// Results the backend keeps: `run_query` leaves the rows here and hands back
// a handle; the grid reads them a window at a time
// (docs/design/RESULT_STORE.md).
//
// The real store is a SQLite file. This one is a map of the rows the mock's
// `execute_query` logic produced, read back the way the store's commands
// answer: filtered, sorted, cut to a window, long cells cut short, binary as
// base64.

import type {
  Cell_Serialize,
  ColumnMeta,
  QueryResult_Serialize,
  ResultFilter as WireFilter,
  ResultHandle_Serialize,
  ResultWindow_Serialize,
  SortKey,
  SqlValue,
  WireValue,
} from "../../../lib/bindings";
import { type ColumnFilter, isActiveFilter, matchesFilter } from "../../../lib/grid-filter";
import { isNumericSqlType } from "../../../lib/sql-types";
import { fail, type Handlers } from "../router";
import { newId } from "../state";

/** `RESULT_WINDOW_MAX_ROWS` in the backend. */
export const WINDOW_MAX_ROWS = 1000;
/** `RESULT_WINDOW_MAX_CELL_BYTES` in the backend. */
export const WINDOW_MAX_CELL_BYTES = 64 * 1024;

interface StoredResult {
  columns: ColumnMeta[];
  /** In arrival order: the row with id `n` is `rows[n - 1]`. */
  rows: SqlValue[][];
}

const stored = new Map<string, StoredResult>();

/** Forget every stored result, as a fresh app run does. */
export function resetResults(): void {
  stored.clear();
}

/**
 * Keep a result's rows and describe it by a handle.
 *
 * As in the backend, a result with no rows stores nothing: its handle has a
 * fresh id the store does not know, and no columns, since the real ones are
 * read from the first row.
 */
export function storeResult(r: QueryResult_Serialize): ResultHandle_Serialize {
  const result_id = newId("result");
  const hasRows = r.rows.length > 0;
  if (hasRows) stored.set(result_id, { columns: r.columns, rows: r.rows });
  return {
    result_id,
    statement_index: r.statement_index,
    sql: r.sql,
    columns: hasRows ? r.columns : [],
    row_count: r.rows.length,
    rows_affected: r.rows_affected,
    execution_time_ms: r.execution_time_ms,
    warnings: r.warnings,
    // Left out when unset, as serde's skip_serializing_if does.
    ...(r.truncation_reason ? { truncation_reason: r.truncation_reason } : {}),
    ...(r.transaction ? { transaction: r.transaction } : {}),
  };
}

function lookup(resultId: unknown): StoredResult {
  return stored.get(String(resultId)) ?? fail(`Not found: Result ${String(resultId)}`);
}

function checkColumn(result: StoredResult, column: number): ColumnMeta {
  return result.columns[column] ?? fail(`Query error: The result has no column ${column}`);
}

// ---------------------------------------------------------------- values

const isNull = (v: SqlValue): v is null | "Null" => v === null || v === "Null";

function base64(bytes: readonly number[]): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(binary);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A value in its wire form, whole. */
function wire(v: SqlValue): WireValue {
  if (isNull(v)) return null;
  return Array.isArray(v) ? { bytes: base64(v) } : v;
}

/** A value as a window carries it: text and binary cut to `limit` bytes. */
function cell(v: SqlValue, limit: number): Cell_Serialize {
  if (Array.isArray(v)) {
    return v.length > limit
      ? { value: { bytes: base64(v.slice(0, limit)) }, full_len: v.length }
      : { value: wire(v), full_len: null };
  }
  // A string of n UTF-16 units is at least n bytes and at most 3n.
  if (typeof v === "string" && v.length * 3 > limit) {
    const bytes = encoder.encode(v);
    if (bytes.length > limit) {
      // The cut is in bytes and may land inside a character; the partial
      // character is dropped, as the backend does.
      let end = limit;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      return { value: decoder.decode(bytes.subarray(0, end)), full_len: bytes.length };
    }
  }
  return { value: wire(v), full_len: null };
}

// ---------------------------------------------------------------- filter

/**
 * The backend's filter is the grid's (`grid-filter.ts`), so the grid's is
 * what runs here. Binary is the one case it adds: a binary cell is not NULL
 * and matches nothing else.
 */
function passes(v: SqlValue, filter: ColumnFilter): boolean {
  if (isNull(v)) return matchesFilter(null, filter);
  if (Array.isArray(v)) return filter.operator === "isNotNull";
  return matchesFilter(v, filter);
}

interface ActiveFilter {
  column: number;
  filter: ColumnFilter;
}

function activeFilters(result: StoredResult, filters: WireFilter[]): ActiveFilter[] {
  const active: ActiveFilter[] = [];
  for (const f of filters) {
    const filter: ColumnFilter = { operator: f.operator, value: f.value, value2: f.value2 ?? undefined };
    if (!isActiveFilter(filter)) continue;
    checkColumn(result, f.column);
    active.push({ column: f.column, filter });
  }
  return active;
}

// ---------------------------------------------------------------- sort

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
function compareCells(a: SqlValue, b: SqlValue, numeric: boolean): number {
  if (isNull(a) || isNull(b)) return Number(isNull(b)) - Number(isNull(a));
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

// ---------------------------------------------------------------- handlers

const wholeNumber = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : 0);

export const resultHandlers: Handlers = {
  result_window: (args): ResultWindow_Serialize => {
    const result = lookup(args.resultId);
    const filters = activeFilters(result, (args.filters as WireFilter[] | undefined) ?? []);
    const sort = ((args.sort as SortKey[] | undefined) ?? []).map((key) => ({
      column: key.column,
      descending: key.descending,
      numeric: isNumericSqlType(checkColumn(result, key.column).data_type),
    }));

    // Positions in arrival order; a row's id is its position plus one.
    let positions = result.rows.map((_, i) => i);
    if (filters.length > 0) {
      positions = positions.filter((i) => filters.every((f) => passes(result.rows[i][f.column], f.filter)));
    }
    if (sort.length > 0) {
      positions.sort((x, y) => {
        for (const key of sort) {
          const c = compareCells(result.rows[x][key.column], result.rows[y][key.column], key.numeric);
          if (c !== 0) return key.descending ? -c : c;
        }
        // Arrival order settles ties, whichever way the keys run.
        return x - y;
      });
    }

    const offset = wholeNumber(args.offset);
    const count = Math.min(wholeNumber(args.count), WINDOW_MAX_ROWS);
    const page = positions.slice(offset, offset + count);
    return {
      row_ids: page.map((i) => i + 1),
      rows: page.map((i) => result.rows[i].map((v) => cell(v, WINDOW_MAX_CELL_BYTES))),
      matching_rows: positions.length,
    };
  },

  result_cell: (args): WireValue => {
    const result = lookup(args.resultId);
    const resultId = String(args.resultId);
    const column = Number(args.column);
    if (!result.columns[column]) fail(`Not found: Column ${column} of result ${resultId}`);
    const row = result.rows[Number(args.rowId) - 1]
      ?? fail(`Not found: Row ${String(args.rowId)} of result ${resultId}`);
    return wire(row[column]);
  },

  result_release: (args): null => {
    // Ids the store does not know are ignored, as in the backend.
    for (const id of (args.resultIds as string[] | undefined) ?? []) stored.delete(id);
    return null;
  },
};
