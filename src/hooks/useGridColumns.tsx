import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { type GridFeatures } from "../lib/grid-features";
import type { ResultMeta } from "../lib/row-source";

/**
 * One TanStack column definition per result column.
 *
 * Split out of ResultsGrid (#406). TanStack keeps the columns' widths and
 * order; it does not see the rows, so a definition is a name and a starting
 * width and depends only on the result.
 */

export type { CellViewerRequest } from "../components/grid/GridCell";

export interface UseGridColumnsOptions {
  result: ResultMeta | undefined;
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
      size: Math.max(80, Math.min(350, Math.min(maxContentLen[col.name] ?? 5, 30) * 9 + 40)),
    }));
  }, [activeResult, maxContentLen]);
}
