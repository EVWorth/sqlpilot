import type { QueryResult, SqlValue } from "../bindings";
import { createArraySource, type RowSource, type RowSourceSnapshot, type SourceRow } from "../row-source";

/**
 * A row source that behaves like one reading from the backend: rows are not
 * there until they are delivered, long values are painted cut short, and the
 * promises do not resolve until the test lets them.
 *
 * It sorts and filters with the real in-memory source underneath, so a test
 * can check what the grid does while rows are missing without restating the
 * view rules.
 */
export interface FakeRowSource extends RowSource {
  /** Make the rows at view positions `[start, end)` available; all of them by default. */
  deliver(start?: number, end?: number): void;
  /** Stop answering the promise-returning methods until `release`. */
  hold(): void;
  /** Answer everything held, and everything asked from now on. */
  release(): void;
  /** Make the promise-returning methods reject with this, until set back to null. */
  failWith(error: Error | null): void;
  /** Every `[start, end)` the grid said was on screen. */
  readonly visibleRanges: [number, number][];
  /** Every `setView` call, as given. */
  readonly views: { sort: unknown; filters: unknown }[];
  /** The promise-returning methods called, by name, in order. */
  readonly asked: string[];
}

export interface FakeRowSourceOptions {
  /** How many rows are there from the start, from the top of the view. Default: none. */
  loaded?: number;
  /** Text and binary longer than this are painted cut to it. Default: never cut. */
  cutAt?: number;
  /** Start with the promises held. */
  held?: boolean;
}

const encoder = new TextEncoder();

export function createFakeSource(result: QueryResult, options: FakeRowSourceOptions = {}): FakeRowSource {
  const inner = createArraySource(result);
  const { cutAt } = options;
  const listeners = new Set<() => void>();
  const delivered = new Set<number>();
  let deliveries = 0;
  let snapshot: RowSourceSnapshot | null = null;
  let held = options.held ?? false;
  let failure: Error | null = null;
  let waiting: (() => void)[] = [];

  const notify = () => {
    snapshot = null;
    for (const listener of [...listeners]) listener();
  };
  inner.subscribe(() => {
    // Another view: what was loaded was loaded for the old one.
    delivered.clear();
    notify();
  });

  const cut = (row: SourceRow): SourceRow => {
    if (cutAt === undefined) return row;
    const fullLens: (number | null)[] = row.values.map(() => null);
    const values = row.values.map((v: SqlValue, i): SqlValue => {
      if (typeof v === "string" && v.length > cutAt) {
        fullLens[i] = encoder.encode(v).length;
        return v.slice(0, cutAt);
      }
      if (Array.isArray(v) && v.length > cutAt) {
        fullLens[i] = v.length;
        return v.slice(0, cutAt);
      }
      return v;
    });
    return fullLens.some((n) => n !== null) ? { index: row.index, values, fullLens } : row;
  };

  const gate = async (name: string) => {
    asked.push(name);
    if (held) await new Promise<void>((resolve) => waiting.push(resolve));
    if (failure) throw failure;
  };

  const visibleRanges: [number, number][] = [];
  const views: { sort: unknown; filters: unknown }[] = [];
  const asked: string[] = [];

  const source: FakeRowSource = {
    columns: inner.columns,
    rowCount: inner.rowCount,
    visibleRanges,
    views,
    asked,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      const base = inner.getSnapshot();
      snapshot ??= { ...base, revision: base.revision + deliveries };
      return snapshot;
    },
    setView(sort, filters) {
      views.push({ sort, filters });
      inner.setView(sort, filters);
    },
    rowAt(position) {
      if (!delivered.has(position)) return undefined;
      const row = inner.rowAt(position);
      return row && cut(row);
    },
    setVisibleRange(start, end) {
      visibleRanges.push([start, end]);
    },
    sampleRows(limit) {
      const sample: SourceRow[] = [];
      for (let p = 0; p < inner.getSnapshot().viewCount && sample.length < limit; p++) {
        const row = source.rowAt(p);
        if (row) sample.push(row);
      }
      return sample;
    },

    rows: async (indices) => (await gate("rows"), inner.rows(indices)),
    allRows: async () => (await gate("allRows"), inner.allRows()),
    cell: async (index, column) => (await gate("cell"), inner.cell(index, column)),
    order: async (indices) => (await gate("order"), inner.order(indices)),
    positionOf: async (index) => (await gate("positionOf"), inner.positionOf(index)),
    indicesAt: async (start, end) => (await gate("indicesAt"), inner.indicesAt(start, end)),

    deliver(start = 0, end = inner.getSnapshot().viewCount) {
      for (let p = start; p < end; p++) delivered.add(p);
      deliveries++;
      notify();
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
      const resolve = waiting;
      waiting = [];
      for (const r of resolve) r();
    },
    failWith(error) {
      failure = error;
    },
  };

  if (options.loaded) source.deliver(0, options.loaded);
  return source;
}
