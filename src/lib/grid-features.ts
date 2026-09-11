import {
  columnFilteringFeature,
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * v9 requires features to be declared up front rather than bundling every one,
 * so opting in to just what the grid uses keeps the rest — pagination,
 * grouping, row selection — out of the bundle.
 *
 * Module scope: this must be a stable reference across renders. It lives here
 * rather than in ResultsGrid so the column definitions can be typed against it
 * from their own file (#406).
 */
export const gridFeatures = tableFeatures({
  rowSortingFeature,
  // FR-3.1.5: dragging a header changes the display order (#392).
  columnOrderingFeature,
  // FR-3.1.3: per-column filters over the rows already fetched (#391).
  columnFilteringFeature,
  columnSizingFeature,
  columnResizingFeature,
  // Not for hiding columns — row.getVisibleCells() hangs off this feature.
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
});

export type GridFeatures = typeof gridFeatures;
