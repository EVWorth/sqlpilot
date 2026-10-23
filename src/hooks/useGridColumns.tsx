import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { GridCell } from "../components/grid/GridCell";
import { type GridFeatures } from "../lib/grid-features";
import { type ColumnFilter, matchesFilter } from "../lib/grid-filter";
import type { QueryResult } from "../types";

/**
 * One TanStack column definition per result column.
 *
 * Split out of ResultsGrid (#406). Every column renders through the same
 * GridCell component, which reads the editing state from GridCellContext. The
 * definitions therefore depend only on the result, and a click or an edit does
 * not rebuild them — rebuilding them gave every cell a new component type and
 * remounted the whole grid on each render (#841).
 */

export type { CellViewerRequest } from "../components/grid/GridCell";

export interface UseGridColumnsOptions {
  result: QueryResult | undefined;
  /** Longest value per column, for a sensible initial width. */
  maxContentLen: Record<string, number>;
}

export function useGridColumns({ result: activeResult, maxContentLen }: UseGridColumnsOptions) {
  return useMemo<ColumnDef<GridFeatures, Record<string, unknown>>[]>(() => {
    if (!activeResult) return [];

    return activeResult.columns.map((col) => ({
      id: col.name,
      accessorKey: col.name,
      header: col.name,
      // The filter value is our own ColumnFilter rather than a bare string,
      // because an operator and an operand cannot be carried by one (#391).
      filterFn: (row, columnId, value) => matchesFilter(row.getValue(columnId), value as ColumnFilter),
      cell: GridCell,
      size: Math.max(80, Math.min(350, Math.min(maxContentLen[col.name] ?? 5, 30) * 9 + 40)),
    }));
  }, [activeResult, maxContentLen]);
}
