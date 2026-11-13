import type { ColumnMeta, QueryResult, ResultFilter, SortKey, SqlValue } from "./bindings";
import { type ColumnFilter, isActiveFilter, matchesFilter } from "./grid-filter";
import { rowComparator } from "./result-compare";

/**
 * The one way the results grid reads a result's rows
 * (docs/design/RESULT_STORE.md).
 *
 * The grid, its hooks, the viewers and the agent's result context go through
 * a `RowSource` and never index a `rows` array. Today the only source is
 * `createArraySource`, over rows the webview holds. The next one reads windows
 * from the backend's result store, so every method here is written for a
 * source whose rows are mostly not loaded:
 *
 * - painting is synchronous and may find a row missing (`rowAt`);
 * - anything that needs values it may not have is a promise;
 * - sorting and filtering are the source's job (`setView`), because a source
 *   without the rows cannot leave them to the component.
 *
 * Two numbers name a row and they are not interchangeable:
 *
 * - its **index**: the 0-based position in the result as the server returned
 *   it. This is the row's identity. Selections, pending edits (negative for
 *   inserts, which no source knows about) and the focused cell are keyed by
 *   it, and it does not change when the view is sorted or filtered.
 * - its **position**: where it is in the current view, 0 at the top. It
 *   changes with every `setView`.
 */

/** A result without its rows: what the grid may read directly. */
export type ResultMeta = Omit<QueryResult, "rows">;

/** One row, as far as the source has it. */
export interface SourceRow {
  /** The row's identity: its 0-based position in the result as returned. */
  readonly index: number;
  /** One value per result column. A long value may be cut short; see `fullLens`. */
  readonly values: readonly SqlValue[];
  /**
   * Per column, the full length in bytes of a value that was cut short, as
   * `full_len` of the bindings' `Cell`; null for a value that is whole. Null
   * for the row when none of its cells is cut. A cut value is for painting
   * only: get the whole one from `cell` or `rows` before showing it in the
   * viewer, copying it or editing it.
   */
  readonly fullLens: readonly (number | null)[] | null;
}

/** What `useSyncExternalStore` reads. A new object whenever anything changed. */
export interface RowSourceSnapshot {
  /** Rows left after the current filters: how many positions the view has. */
  readonly viewCount: number;
  readonly sort: readonly SortKey[];
  /** The filters in force; ones that would narrow nothing are left out. */
  readonly filters: readonly ResultFilter[];
  /** Goes up when rows arrive or the view changes. */
  readonly revision: number;
}

export interface RowSource {
  readonly columns: readonly ColumnMeta[];
  /** Rows in the result, whatever the filters. */
  readonly rowCount: number;

  /** Called back when rows arrive or the view changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The current state; the same object until something changes. */
  getSnapshot(): RowSourceSnapshot;

  /**
   * Sort and filter the view. Columns are positions in `columns`; a key or
   * filter for a column the result lacks, or a filter that would narrow
   * nothing, is dropped. Setting the view it already has does nothing.
   */
  setView(sort: readonly SortKey[], filters: readonly ResultFilter[]): void;

  /** The row at a view position, or undefined when it is not loaded (yet). Never loads. */
  rowAt(position: number): SourceRow | undefined;
  /** Say which positions are on screen, `[start, end)`, so they can be loaded. */
  setVisibleRange(start: number, end: number): void;
  /**
   * Up to `limit` rows the source already has, from the top of the view.
   * Never loads; an empty answer means nothing has arrived. For sizing
   * columns from a sample rather than the whole result.
   */
  sampleRows(limit: number): readonly SourceRow[];

  /** The rows with these indices, in the order asked, every value whole. Rejects for an index not in the result. */
  rows(indices: readonly number[]): Promise<SqlValue[][]>;
  /** Every row of the view, in view order, every value whole. */
  allRows(): Promise<SqlValue[][]>;
  /** One whole value. */
  cell(index: number, column: number): Promise<SqlValue>;

  /** Those of `indices` that are in the view, in view order. */
  order(indices: readonly number[]): Promise<number[]>;
  /** Where a row is in the view, or null when the filters hide it. */
  positionOf(index: number): Promise<number | null>;
  /** The indices of the rows at view positions `[start, end)`, clamped to the view. */
  indicesAt(start: number, end: number): Promise<number[]>;
}

const sameSort = (a: readonly SortKey[], b: readonly SortKey[]) =>
  a.length === b.length && a.every((k, i) => k.column === b[i].column && k.descending === b[i].descending);

const sameFilters = (a: readonly ResultFilter[], b: readonly ResultFilter[]) =>
  a.length === b.length
  && a.every((f, i) =>
    f.column === b[i].column && f.operator === b[i].operator && f.value === b[i].value
    && (f.value2 ?? null) === (b[i].value2 ?? null)
  );

const toColumnFilter = (f: ResultFilter): ColumnFilter => ({
  operator: f.operator,
  value: f.value,
  value2: f.value2 ?? undefined,
});

/**
 * Drop what cannot apply, so two views that show the same rows compare equal.
 * Shared by every source: it is what makes `setView` idempotent.
 */
export function normalizeView(
  columns: readonly ColumnMeta[],
  sort: readonly SortKey[],
  filters: readonly ResultFilter[],
): { sort: SortKey[]; filters: ResultFilter[] } {
  return {
    sort: sort.filter((k) => columns[k.column] !== undefined),
    filters: filters.filter((f) => columns[f.column] !== undefined && isActiveFilter(toColumnFilter(f))),
  };
}

/**
 * A source over rows the webview already holds.
 *
 * It never cuts a value and never has a row missing; its promises resolve at
 * once. The rows are read in place: nothing is copied per row.
 */
export function createArraySource(result: QueryResult): RowSource {
  const { columns, rows } = result;
  const listeners = new Set<() => void>();
  /** Indices in view order; null while the view is the result as returned. */
  let view: number[] | null = null;
  /** Position by index, -1 when filtered out. Built when first asked for. */
  let positions: Int32Array | null = null;
  let snapshot: RowSourceSnapshot = { viewCount: rows.length, sort: [], filters: [], revision: 0 };

  const indexAt = (position: number): number | undefined => {
    if (!Number.isInteger(position) || position < 0 || position >= snapshot.viewCount) return undefined;
    return view ? view[position] : position;
  };

  const positionOfSync = (index: number): number | null => {
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
    if (!view) return index;
    if (!positions) {
      positions = new Int32Array(rows.length).fill(-1);
      for (let p = 0; p < view.length; p++) positions[view[p]] = p;
    }
    const position = positions[index];
    return position < 0 ? null : position;
  };

  const whole = (index: number): SqlValue[] => {
    const row = rows[index];
    if (!Number.isInteger(index) || row === undefined) throw new Error(`Row ${index} is not in the result`);
    return row;
  };

  const clamp = (n: number) => Math.max(0, Math.min(snapshot.viewCount, Math.floor(n)));

  return {
    columns,
    rowCount: rows.length,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    setView(sort, filters) {
      const next = normalizeView(columns, sort, filters);
      if (sameSort(next.sort, snapshot.sort) && sameFilters(next.filters, snapshot.filters)) return;

      if (next.sort.length === 0 && next.filters.length === 0) {
        view = null;
      } else {
        const active = next.filters.map((f) => ({ column: f.column, filter: toColumnFilter(f) }));
        const kept: number[] = [];
        for (let i = 0; i < rows.length; i++) {
          if (active.every((f) => matchesFilter(rows[i][f.column], f.filter))) kept.push(i);
        }
        if (next.sort.length > 0) kept.sort(rowComparator(rows, columns, next.sort));
        view = kept;
      }
      positions = null;
      snapshot = {
        viewCount: view ? view.length : rows.length,
        sort: next.sort,
        filters: next.filters,
        revision: snapshot.revision + 1,
      };
      for (const listener of [...listeners]) listener();
    },

    rowAt(position) {
      const index = indexAt(position);
      return index === undefined ? undefined : { index, values: rows[index], fullLens: null };
    },
    setVisibleRange() {
      // Every row is already here.
    },
    sampleRows(limit) {
      const sample: SourceRow[] = [];
      const end = clamp(limit);
      for (let p = 0; p < end; p++) {
        const index = view ? view[p] : p;
        sample.push({ index, values: rows[index], fullLens: null });
      }
      return sample;
    },

    rows: async (indices) => indices.map(whole),
    allRows: async () => (view ? view.map((i) => rows[i]) : rows.slice()),
    cell: async (index, column) => {
      const value = whole(index)[column];
      if (value === undefined) throw new Error(`The result has no column ${column}`);
      return value;
    },

    order: async (indices) => {
      const placed: [number, number][] = [];
      for (const index of new Set(indices)) {
        const position = positionOfSync(index);
        if (position !== null) placed.push([position, index]);
      }
      return placed.sort((a, b) => a[0] - b[0]).map(([, index]) => index);
    },
    positionOf: async (index) => positionOfSync(index),
    indicesAt: async (start, end) => {
      const [from, to] = [clamp(start), clamp(end)];
      if (view) return view.slice(from, to);
      return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
    },
  };
}

const EMPTY_RESULT: QueryResult = {
  query_id: "",
  statement_index: 0,
  sql: "",
  columns: [],
  rows: [],
  rows_affected: 0,
  execution_time_ms: 0,
  warnings: [],
  rows_truncated: false,
};

/** The source for "no result": no columns and no rows. */
export const EMPTY_ROW_SOURCE: RowSource = createArraySource(EMPTY_RESULT);

const sources = new WeakMap<QueryResult, RowSource>();

/**
 * The source for a result: one per result object, for as long as the object
 * lives. The grid is remounted per editor tab, and a source made per mount
 * would sort and filter the same rows again on every tab switch.
 */
export function rowSourceFor(result: QueryResult | undefined): RowSource {
  if (!result) return EMPTY_ROW_SOURCE;
  let source = sources.get(result);
  if (!source) {
    source = createArraySource(result);
    sources.set(result, source);
  }
  return source;
}

/** Every index of a result, in the order the server returned the rows. */
export function allIndices(source: RowSource): number[] {
  return Array.from({ length: source.rowCount }, (_, i) => i);
}
