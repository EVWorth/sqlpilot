import type { StoredResultRef } from "../types";
import type { Cell, ColumnMeta, ResultFilter, SortKey, SqlValue, WireValue } from "./bindings";
import type { RowSource, RowSourceSnapshot, SourceRow } from "./row-source";
import { normalizeView, sameFilters, sameSort } from "./row-view";
import { api } from "./tauri-api";

/**
 * A `RowSource` over a result the backend's result store keeps
 * (docs/design/RESULT_STORE.md).
 *
 * The rows stay in the backend. The source reads the windows the grid has on
 * screen, plus a screen either side, in pages of a fixed size, and keeps the
 * last few dozen pages; everything else is a promise answered by the
 * `result_*` commands. Sorting and filtering are the backend's: `setView`
 * only says which view the next reads are for.
 *
 * Row ids in the store count from 1; a source's row index counts from 0, so
 * index = id - 1 at this boundary and nowhere else.
 */

/** Rows per page: what one entry of the cache holds and the unit a read is aligned to. */
export const PAGE_SIZE = 200;
/** Pages kept per source, least recently used dropped first. */
export const MAX_PAGES = 50;
/** `RESULT_WINDOW_MAX_ROWS` in the backend: the most one window returns. */
const WINDOW_MAX_ROWS = 1000;
/** `ROWS_MAX_COUNT` in the backend. */
const ROWS_MAX_COUNT = 1000;
/** `ROW_IDS_MAX_COUNT` in the backend. */
const ROW_IDS_MAX_COUNT = 100_000;
/** `ORDER_MAX_IDS` in the backend. */
const ORDER_MAX_IDS = 1_000_000;
/** How the backend's error for too many bytes in `result_rows` begins (after any prefix). */
export const ROWS_TOO_LARGE = "The rows are too large to return at once";
/** How long a page that failed to load waits before it is asked for again; doubles per failure. */
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export interface StoreSourceOptions {
  /** For tests: rows per page. */
  pageSize?: number;
  /** For tests: pages kept. */
  maxPages?: number;
  /** For tests: the first wait before a failed page is retried. */
  retryMs?: number;
}

function base64ToBytes(text: string): number[] {
  const binary = atob(text);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A value off the wire as the grid holds values: binary arrives as base64 and
 * becomes the array of bytes every grid consumer already handles.
 */
export function fromWire(value: WireValue): SqlValue {
  if (value !== null && typeof value === "object" && "bytes" in value) return base64ToBytes(value.bytes);
  return value;
}

const fromWireRow = (row: readonly WireValue[]): SqlValue[] => row.map(fromWire);

function sourceRow(rowId: number, cells: readonly Cell[]): SourceRow {
  let fullLens: (number | null)[] | null = null;
  const values = cells.map((c, column) => {
    if (c.full_len !== null && c.full_len !== undefined) {
      fullLens ??= new Array<number | null>(cells.length).fill(null);
      fullLens[column] = c.full_len;
    }
    return fromWire(c.value);
  });
  return { index: rowId - 1, values, fullLens };
}

const isTooLarge = (e: unknown) => String(e instanceof Error ? e.message : e).includes(ROWS_TOO_LARGE);

/**
 * A source over the stored result `ref`, whose columns are `columns`.
 *
 * A result with no rows has nothing in the store, and its id is one the store
 * does not know, so a source over it never calls the backend.
 */
export function createStoreSource(
  ref: StoredResultRef,
  columns: readonly ColumnMeta[],
  options: StoreSourceOptions = {},
): RowSource {
  const resultId = ref.result_id;
  const rowCount = ref.row_count;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const retryMs = options.retryMs ?? RETRY_MS;
  const windowPages = Math.max(1, Math.floor(WINDOW_MAX_ROWS / pageSize));

  const listeners = new Set<() => void>();
  let snapshot: RowSourceSnapshot = { viewCount: rowCount, sort: [], filters: [], revision: 0 };
  /** Goes up with every `setView`; a response for an older view is dropped. */
  let generation = 0;
  /** Whether `snapshot.viewCount` is the current view's, or still the previous one's. */
  let countKnown = true;
  /** Pages of the current view, by page number, least recently used first. */
  const pages = new Map<number, SourceRow[]>();
  /** Pages being read for the current view. */
  const inflight = new Set<number>();
  /** Pages whose last read failed, with when they may be asked for again. */
  const failedUntil = new Map<number, number>();
  let backoff = retryMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let range: [number, number] = [0, 0];
  let disposed = false;

  const notify = (partial: Partial<RowSourceSnapshot> = {}) => {
    snapshot = { ...snapshot, ...partial, revision: snapshot.revision + 1 };
    for (const listener of [...listeners]) listener();
  };

  const touch = (page: number) => {
    const rows = pages.get(page);
    if (rows === undefined) return;
    pages.delete(page);
    pages.set(page, rows);
  };

  const evict = (keep: number) => {
    const limit = Math.max(maxPages, keep);
    for (const page of pages.keys()) {
      if (pages.size <= limit) break;
      pages.delete(page);
    }
  };

  const scheduleRetry = (wait: number) => {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      load();
    }, wait);
  };

  /** Read `count` pages from `first`, as one window, for the current view. */
  const fetchPages = (first: number, count: number, keep: number) => {
    const gen = generation;
    const { sort, filters } = snapshot;
    for (let p = first; p < first + count; p++) inflight.add(p);
    api.resultWindow(resultId, first * pageSize, count * pageSize, [...sort], [...filters]).then(
      (window) => {
        if (disposed || gen !== generation) return;
        for (let p = first; p < first + count; p++) {
          inflight.delete(p);
          failedUntil.delete(p);
          const from = (p - first) * pageSize;
          const rows: SourceRow[] = [];
          for (let i = from; i < Math.min(from + pageSize, window.rows.length); i++) {
            rows.push(sourceRow(window.row_ids[i], window.rows[i]));
          }
          pages.delete(p);
          pages.set(p, rows);
        }
        evict(keep);
        backoff = retryMs;
        countKnown = true;
        notify({ viewCount: window.matching_rows });
      },
      () => {
        if (disposed || gen !== generation) return;
        // The rows stay missing; the next look at them asks again, after a
        // wait so a backend that keeps failing is not asked in a tight loop.
        const until = Date.now() + backoff;
        for (let p = first; p < first + count; p++) {
          inflight.delete(p);
          failedUntil.set(p, until);
        }
        scheduleRetry(backoff);
        backoff = Math.min(backoff * 2, MAX_RETRY_MS);
        notify();
      },
    );
  };

  /** Read whatever the visible range, and a screen either side, still lacks. */
  function load() {
    if (disposed || rowCount === 0) return;
    const [start, end] = range;
    const margin = Math.max(end - start, 1);
    const from = Math.max(0, start - margin);
    const to = Math.min(snapshot.viewCount, end + margin);
    const wanted: number[] = [];
    if (to > from) {
      for (let p = Math.floor(from / pageSize); p <= Math.floor((to - 1) / pageSize); p++) wanted.push(p);
    }
    // A view whose size is not known yet: its first window says, wherever
    // the grid is looking.
    if (!countKnown && wanted.length === 0) wanted.push(0);
    for (const p of wanted) touch(p);

    const now = Date.now();
    const missing = wanted.filter((p) => !pages.has(p) && !inflight.has(p) && (failedUntil.get(p) ?? 0) <= now);
    const waiting = wanted.filter((p) => (failedUntil.get(p) ?? 0) > now);
    if (waiting.length > 0) scheduleRetry(Math.max(0, Math.min(...waiting.map((p) => failedUntil.get(p) ?? 0)) - now));

    // Consecutive pages go in one window, up to what one window returns.
    for (let i = 0; i < missing.length;) {
      let n = 1;
      while (i + n < missing.length && n < windowPages && missing[i + n] === missing[i] + n) n++;
      fetchPages(missing[i], n, wanted.length);
      i += n;
    }
  }

  const validIndex = (index: number) => Number.isInteger(index) && index >= 0 && index < rowCount;

  const checkIndex = (index: number) => {
    if (!validIndex(index)) throw new Error(`Row ${index} is not in the result`);
  };

  const clamp = (n: number) => Math.max(0, Math.min(snapshot.viewCount, Math.floor(n)));

  /** Row ids at view positions `[start, end)`, in as many reads as the backend's cap needs. */
  const viewIds = async (
    start: number,
    end: number,
    sort: readonly SortKey[],
    filters: readonly ResultFilter[],
  ): Promise<number[]> => {
    const ids: number[] = [];
    if (rowCount === 0) return ids;
    for (let offset = start; offset < end;) {
      const count = Math.min(ROW_IDS_MAX_COUNT, end - offset);
      const got = await api.resultRowIds(resultId, offset, count, [...sort], [...filters]);
      for (const id of got) ids.push(id);
      if (got.length < count) break;
      offset += got.length;
    }
    return ids;
  };

  /** Whole rows by id, in chunks within the caps; a chunk too large in bytes is halved. */
  const rowsById = async (ids: readonly number[]): Promise<SqlValue[][]> => {
    const out: SqlValue[][] = [];
    let chunk = ROWS_MAX_COUNT;
    for (let at = 0; at < ids.length;) {
      const part = ids.slice(at, at + chunk);
      try {
        const got = await api.resultRows(resultId, part);
        for (const row of got) out.push(fromWireRow(row));
        at += part.length;
      } catch (e) {
        if (!isTooLarge(e) || part.length === 1) throw e;
        chunk = Math.max(1, Math.floor(part.length / 2));
      }
    }
    return out;
  };

  return {
    columns,
    rowCount,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    setView(sort, filters) {
      const next = normalizeView(columns, sort, filters);
      if (sameSort(next.sort, snapshot.sort) && sameFilters(next.filters, snapshot.filters)) return;
      generation += 1;
      pages.clear();
      inflight.clear();
      failedUntil.clear();
      backoff = retryMs;
      // Without filters every row is in the view. With them the count comes
      // with the first window; until then the old one stands, so the grid
      // does not flash empty.
      countKnown = next.filters.length === 0;
      notify({
        sort: next.sort,
        filters: next.filters,
        viewCount: countKnown ? rowCount : snapshot.viewCount,
      });
      load();
    },

    rowAt(position) {
      if (!Number.isInteger(position) || position < 0 || position >= snapshot.viewCount) return undefined;
      return pages.get(Math.floor(position / pageSize))?.[position % pageSize];
    },
    setVisibleRange(start, end) {
      range = [Math.max(0, Math.floor(start)), Math.max(0, Math.floor(end))];
      load();
    },
    sampleRows(limit) {
      const sample: SourceRow[] = [];
      const end = clamp(limit);
      for (let p = 0; p < end; p++) {
        const row = pages.get(Math.floor(p / pageSize))?.[p % pageSize];
        if (row === undefined) break;
        sample.push(row);
      }
      return sample;
    },

    rows: async (indices) => {
      indices.forEach(checkIndex);
      return rowsById(indices.map((i) => i + 1));
    },
    allRows: async () => {
      const { sort, filters } = snapshot;
      return rowsById(await viewIds(0, Number.POSITIVE_INFINITY, sort, filters));
    },
    cell: async (index, column) => {
      checkIndex(index);
      if (columns[column] === undefined) throw new Error(`The result has no column ${column}`);
      return fromWire(await api.resultCell(resultId, index + 1, column));
    },

    order: async (indices) => {
      const ids = [...new Set(indices)].filter(validIndex).map((i) => i + 1);
      if (ids.length === 0) return [];
      const { sort, filters } = snapshot;
      if (ids.length <= ORDER_MAX_IDS) {
        return (await api.resultOrder(resultId, ids, [...sort], [...filters])).map((id) => id - 1);
      }
      // More than one call may order: read the view's ids and keep the wanted ones.
      const wanted = new Set(ids);
      const all = await viewIds(0, Number.POSITIVE_INFINITY, sort, filters);
      return all.filter((id) => wanted.has(id)).map((id) => id - 1);
    },
    positionOf: async (index) => {
      if (!validIndex(index)) return null;
      const { sort, filters } = snapshot;
      return api.resultRowPosition(resultId, index + 1, [...sort], [...filters]);
    },
    indicesAt: async (start, end) => {
      const { sort, filters } = snapshot;
      const ids = await viewIds(clamp(start), clamp(end), sort, filters);
      return ids.map((id) => id - 1);
    },

    dispose() {
      disposed = true;
      listeners.clear();
      pages.clear();
      inflight.clear();
      failedUntil.clear();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}

/** One source per stored result, so a remounted grid finds its pages and view again. */
const byRef = new WeakMap<StoredResultRef, RowSource>();
/** The same sources by store id, for `disposeStoreSources`. */
const byId = new Map<string, RowSource>();

/** The source for a stored result, made on first use. */
export function storeSourceFor(ref: StoredResultRef, columns: readonly ColumnMeta[]): RowSource {
  let source = byRef.get(ref);
  if (!source) {
    source = createStoreSource(ref, columns);
    byRef.set(ref, source);
    if (ref.row_count > 0) byId.set(ref.result_id, source);
  }
  return source;
}

/** Stop the sources over these stored results; they are being released. */
export function disposeStoreSources(resultIds: Iterable<string>): void {
  for (const id of resultIds) {
    byId.get(id)?.dispose();
    byId.delete(id);
  }
}
