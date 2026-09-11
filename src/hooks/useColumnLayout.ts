import { useCallback, useEffect, useMemo, useState } from "react";
import { applyOrder, layoutKey, moveColumn, readLayout, writeLayout } from "../lib/grid-layout";
import type { ColumnMeta } from "../types";

/**
 * The order the grid's columns are shown in, and where it is remembered.
 *
 * Split out of ResultsGrid, which had grown to hold the column order, the
 * filters, the row count, the save handler, the context menu and two render
 * paths at once (#406). This is the piece that answers "which column goes
 * where", and nothing in it needs the grid rendered to be tested.
 */

export interface ColumnLayout {
  /** Column ids in display order, for TanStack's `columnOrder` state. */
  columnOrder: string[];
  setColumnOrder: React.Dispatch<React.SetStateAction<string[]>>;
  /** The result's columns in display order, for anything laid out by hand. */
  orderedColumns: ColumnMeta[];
  /** A stable id for this result shape, also used to reset per-result state. */
  layoutId: string | null;
  /** True when the display order is not the order the query returned. */
  isReordered: boolean;
  moveColumn: (from: string, to: string) => void;
  reset: () => void;
}

export function useColumnLayout(
  connectionId: string | null | undefined,
  database: string | null | undefined,
  columns: ColumnMeta[] | undefined,
): ColumnLayout {
  const [columnOrder, setColumnOrder] = useState<string[]>([]);

  // Joined rather than kept as an array: a caller that builds its column list
  // inline hands this a new array on every render, and an effect keyed on
  // array identity would then reset the order, re-render, and do it again
  // forever. The names are what actually matter, and a string compares by
  // value.
  const joined = columns?.map((c) => c.name).join("\u0000") ?? "";
  const names = useMemo(() => (joined === "" ? [] : joined.split("\u0000")), [joined]);

  const layoutId = useMemo(
    () => layoutKey(connectionId, database, names),
    [connectionId, database, names],
  );

  useEffect(() => {
    if (names.length === 0) {
      setColumnOrder([]);
      return;
    }
    setColumnOrder(applyOrder(readLayout(layoutId)?.columnOrder ?? [], names));
  }, [layoutId, names]);

  const move = useCallback((from: string, to: string) => {
    setColumnOrder((prev) => {
      const next = moveColumn(prev.length > 0 ? prev : names, from, to);
      writeLayout(layoutId, { columnOrder: next });
      return next;
    });
  }, [layoutId, names]);

  const reset = useCallback(() => {
    setColumnOrder(names);
    writeLayout(layoutId, { columnOrder: names });
  }, [layoutId, names]);

  /**
   * Pending insert rows are rendered from this rather than from the raw
   * result: they are laid out cell by cell to sit under the headers, so
   * iterating the query's own order would put every value under the wrong
   * column as soon as one was dragged (#392).
   */
  const orderedColumns = useMemo(() => {
    const cols = columns ?? [];
    if (columnOrder.length === 0) return cols;
    const byName = new Map(cols.map((c) => [c.name, c]));
    return columnOrder.map((name) => byName.get(name)).filter((c) => c !== undefined);
  }, [columns, columnOrder]);

  const isReordered = useMemo(
    () => columnOrder.length === names.length && columnOrder.some((n, i) => n !== names[i]),
    [columnOrder, names],
  );

  return {
    columnOrder,
    setColumnOrder,
    orderedColumns,
    layoutId,
    isReordered,
    moveColumn: move,
    reset,
  };
}
