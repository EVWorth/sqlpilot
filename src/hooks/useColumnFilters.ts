import { useCallback, useEffect, useMemo, useState } from "react";
import { type ColumnFilter, describeFilter, isActiveFilter } from "../lib/grid-filter";

/**
 * The per-column filters, and the shape TanStack wants them in.
 *
 * Split out of ResultsGrid (#406). The grid owns this state rather than
 * letting TanStack own it, because a filter here is an operator plus an
 * operand and TanStack's value is one opaque thing — the menus need to edit
 * both halves together.
 */

export interface ColumnFilters {
  /** By column name, including half-written ones the menus are still editing. */
  filters: Record<string, ColumnFilter>;
  /** Only the filters that would actually narrow something, for the table. */
  active: { id: string; value: ColumnFilter }[];
  set: (column: string, filter: ColumnFilter | undefined) => void;
  clear: () => void;
  /** Every active filter as a sentence, for a tooltip. */
  describe: () => string;
}

/**
 * @param resetKey changing it clears the filters — a filter is about the rows
 * on screen, and has no meaning once a different query's have replaced them.
 */
export function useColumnFilters(resetKey: string | null): ColumnFilters {
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});

  useEffect(() => setFilters({}), [resetKey]);

  /**
   * A half-written filter is left out rather than applied: opening a menu and
   * picking an operator should not empty the grid before an operand is typed.
   */
  const active = useMemo(
    () =>
      Object.entries(filters)
        .filter(([, f]) => isActiveFilter(f))
        .map(([id, value]) => ({ id, value })),
    [filters],
  );

  const set = useCallback((column: string, filter: ColumnFilter | undefined) => {
    setFilters((prev) => {
      if (!filter) {
        const rest = { ...prev };
        delete rest[column];
        return rest;
      }
      return { ...prev, [column]: filter };
    });
  }, []);

  const clear = useCallback(() => setFilters({}), []);

  const describe = useCallback(
    () => active.map((f) => describeFilter(f.id, f.value)).join("; "),
    [active],
  );

  return { filters, active, set, clear, describe };
}
