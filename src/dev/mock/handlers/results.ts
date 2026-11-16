// Results the backend keeps: `run_query` leaves the rows here and hands back
// a handle; the grid reads them a window at a time
// (docs/design/RESULT_STORE.md).
//
// The real store is a SQLite file. This one is a map of the rows the mock's
// `execute_query` logic produced, read back the way the store's commands
// answer: filtered, sorted, cut to a window, long cells cut short, binary as
// base64. `sqlite_run_query` (handlers/sqlite.ts) leaves its rows here too.

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
import { isNullValue, rowComparator } from "../../../lib/result-compare";
import { type Args, fail, type Handlers } from "../router";
import { newId } from "../state";

/** `RESULT_WINDOW_MAX_ROWS` in the backend. */
export const WINDOW_MAX_ROWS = 1000;
/** `RESULT_WINDOW_MAX_CELL_BYTES` in the backend. */
export const WINDOW_MAX_CELL_BYTES = 64 * 1024;
/** `ROW_IDS_MAX_COUNT` in the backend. */
export const ROW_IDS_MAX_COUNT = 100_000;
/** `ORDER_MAX_IDS` in the backend. */
export const ORDER_MAX_IDS = 1_000_000;
/** `ROWS_MAX_COUNT` in the backend. */
export const ROWS_MAX_COUNT = 1000;
/** `ROWS_MAX_BYTES` in the backend. */
export const ROWS_MAX_BYTES = 64 * 1024 * 1024;
/** `ROWS_TOO_LARGE` in the backend: how its error for the bytes starts. */
export const ROWS_TOO_LARGE = "The rows are too large to return at once";

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

const isNull = isNullValue;

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

// ---------------------------------------------------------------- handlers

const wholeNumber = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : 0);

/**
 * A view: the row positions (id minus one) the filters keep, in the order
 * the sort gives. Every command that takes `sort` and `filters` reads this,
 * so they cannot disagree about which row is where.
 */
function viewOf(result: StoredResult, args: Args): number[] {
  const filters = activeFilters(result, (args.filters as WireFilter[] | undefined) ?? []);
  const sort = (args.sort as SortKey[] | undefined) ?? [];
  for (const key of sort) checkColumn(result, key.column);

  // Positions in arrival order; a row's id is its position plus one.
  let positions = result.rows.map((_, i) => i);
  if (filters.length > 0) {
    positions = positions.filter((i) => filters.every((f) => passes(result.rows[i][f.column], f.filter)));
  }
  // The grid's in-memory rows sort by the same rules (`result-compare.ts`).
  if (sort.length > 0) positions.sort(rowComparator(result.rows, result.columns, sort));
  return positions;
}

const idList = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : []);

/** What a row counts for against `ROWS_MAX_BYTES`, as the backend counts it. */
function rowBytes(row: SqlValue[]): number {
  let bytes = 0;
  for (const v of row) {
    bytes += typeof v === "string" && v !== "Null" ? encoder.encode(v).length : Array.isArray(v) ? v.length : 8;
  }
  return bytes;
}

export const resultHandlers: Handlers = {
  result_window: (args): ResultWindow_Serialize => {
    const result = lookup(args.resultId);
    const positions = viewOf(result, args);
    const offset = wholeNumber(args.offset);
    const count = Math.min(wholeNumber(args.count), WINDOW_MAX_ROWS);
    const page = positions.slice(offset, offset + count);
    return {
      row_ids: page.map((i) => i + 1),
      rows: page.map((i) => result.rows[i].map((v) => cell(v, WINDOW_MAX_CELL_BYTES))),
      matching_rows: positions.length,
    };
  },

  result_row_ids: (args): number[] => {
    const positions = viewOf(lookup(args.resultId), args);
    const offset = wholeNumber(args.offset);
    const count = Math.min(wholeNumber(args.count), ROW_IDS_MAX_COUNT);
    return positions.slice(offset, offset + count).map((i) => i + 1);
  },

  result_row_position: (args): number | null => {
    const result = lookup(args.resultId);
    const positions = viewOf(result, args);
    const rowId = Number(args.rowId);
    // Row 0 and a row past the end are in no view; neither is an error.
    if (!Number.isInteger(rowId) || rowId < 1 || rowId > result.rows.length) return null;
    const at = positions.indexOf(rowId - 1);
    return at === -1 ? null : at;
  },

  result_order: (args): number[] => {
    const rowIds = idList(args.rowIds);
    // Checked before the result is looked up, as in the backend.
    if (rowIds.length > ORDER_MAX_IDS) {
      fail(
        `Query error: Too many rows to put in order at once: ${rowIds.length} (the limit is ${ORDER_MAX_IDS})`,
      );
    }
    const positions = viewOf(lookup(args.resultId), args);
    const wanted = new Set(rowIds);
    return positions.map((i) => i + 1).filter((id) => wanted.has(id));
  },

  result_rows: (args): WireValue[][] => {
    const rowIds = idList(args.rowIds);
    if (rowIds.length > ROWS_MAX_COUNT) {
      fail(`Query error: Too many rows asked for at once: ${rowIds.length} (the limit is ${ROWS_MAX_COUNT})`);
    }
    const result = lookup(args.resultId);
    const out: WireValue[][] = [];
    // A row asked for twice is counted twice, since it is sent twice.
    const sizes = new Map<number, number>();
    let bytes = 0;
    for (const rowId of rowIds) {
      const row = (Number.isInteger(rowId) ? result.rows[rowId - 1] : undefined)
        ?? fail(`Not found: Row ${rowId} of result ${String(args.resultId)}`);
      const size = sizes.get(rowId) ?? rowBytes(row);
      sizes.set(rowId, size);
      // The first row is returned whatever its size.
      if (out.length > 0 && bytes + size > ROWS_MAX_BYTES) {
        fail(
          `Query error: ${ROWS_TOO_LARGE}: the first ${out.length} of the ${rowIds.length} rows asked for already `
            + `hold ${bytes} bytes and the limit is ${ROWS_MAX_BYTES}. Ask for fewer rows at a time.`,
        );
      }
      bytes += size;
      out.push(row.map(wire));
    }
    return out;
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
