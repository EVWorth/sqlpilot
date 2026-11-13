import {
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * v9 requires features to be declared up front rather than bundling every one,
 * so opting in to just what the grid uses keeps the rest out of the bundle.
 *
 * What the grid uses TanStack for is its columns: their widths, resizing by
 * drag, and their order. The rows are not TanStack's: they come from the
 * result's row source (`row-source.ts`), which also sorts and filters them,
 * because the rows may not be in the webview to sort.
 *
 * Module scope: this must be a stable reference across renders. It lives here
 * rather than in ResultsGrid so the column definitions can be typed against it
 * from their own file (#406).
 */
export const gridFeatures = tableFeatures({
  // FR-3.1.5: dragging a header changes the display order (#392).
  columnOrderingFeature,
  columnSizingFeature,
  columnResizingFeature,
});

export type GridFeatures = typeof gridFeatures;
