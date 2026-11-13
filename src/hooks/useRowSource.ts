import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { ColumnFilter } from "../lib/grid-filter";
import { type GridSort, toResultFilters, toSortKeys } from "../lib/grid-sort";
import { type RowSource, rowSourceFor, type RowSourceSnapshot } from "../lib/row-source";
import type { QueryResult } from "../types";

/**
 * The grid's rows, by way of the result's `RowSource`.
 *
 * The grid owns which sort and filters are in force, as it always has (the
 * sort is kept per tab, the filters end with the result); the source owns
 * applying them. This hook is where the one is handed to the other, and where
 * the grid subscribes so it repaints when the view changes or rows arrive.
 */
export function useRowSource(
  result: QueryResult | undefined,
  sort: GridSort,
  /** The filters that would narrow something, by column name. */
  filters: readonly { id: string; value: ColumnFilter }[],
): { source: RowSource; view: RowSourceSnapshot } {
  const source = rowSourceFor(result);
  const view = useSyncExternalStore(source.subscribe, source.getSnapshot);

  // Before paint, so a remounted grid never shows the view another mount left
  // behind. The source ignores a view it already has.
  useLayoutEffect(() => {
    source.setView(toSortKeys(sort, source.columns), toResultFilters(filters, source.columns));
  }, [source, sort, filters]);

  return { source, view };
}

/** How many rows the column widths are judged from. */
export const WIDTH_SAMPLE_ROWS = 300;

interface Widths {
  source: RowSource;
  /** False until the source had a row to measure. */
  settled: boolean;
  revision: number;
  lens: Record<string, number>;
}

/** The longest value per column among `rows` of the source's sample, and the column's name. */
export function measureContent(source: RowSource, limit = WIDTH_SAMPLE_ROWS): Record<string, number> {
  const lens: Record<string, number> = {};
  source.columns.forEach((col) => {
    lens[col.name] = col.name.length;
  });
  for (const row of source.sampleRows(limit)) {
    row.values.forEach((val, idx) => {
      const name = source.columns[idx]?.name;
      if (name === undefined) return;
      const len = String(val ?? "").length;
      if (len > lens[name]) lens[name] = len;
    });
  }
  return lens;
}

function measure(source: RowSource, revision: number): Widths {
  const settled = source.rowCount === 0 || source.sampleRows(1).length > 0;
  return { source, settled, revision, lens: measureContent(source) };
}

/**
 * The longest value per column, for a sensible initial width.
 *
 * From a bounded sample of the rows the source already has, never the whole
 * result: scanning every row would force a source that loads on demand to
 * load everything. Measured once per result, when its first rows are there,
 * and not again, so the columns do not jump as the view is sorted or scrolled.
 */
export function useContentWidths(source: RowSource, revision: number): Record<string, number> {
  const [widths, setWidths] = useState(() => measure(source, revision));
  if (widths.source !== source || (!widths.settled && widths.revision !== revision)) {
    const next = measure(source, revision);
    setWidths(next);
    return next.lens;
  }
  return widths.lens;
}
