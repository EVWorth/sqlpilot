import { flexRender, type Header } from "@tanstack/react-table";
import type { ColumnFilters } from "../../hooks/useColumnFilters";
import type { ColumnLayout } from "../../hooks/useColumnLayout";
import type { GridFeatures } from "../../lib/grid-features";
import type { GridSort } from "../../lib/grid-sort";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import { GridHeaderCell } from "./GridHeaderCell";

/**
 * Every column header, for whichever of the grid's two layouts is drawing.
 *
 * The header markup existed twice — once for the virtualized path, once for
 * the plain table — and the copies drifted, so anything added to one silently
 * went missing above 5000 rows, which is where nobody looks (#392, #406). Only
 * the element and the sizing differ; the props are identical, and they are
 * many enough that keeping two copies in step by hand was never going to work.
 */

export type DragState = { dragging: string | null; over: string | null };

export interface GridHeaderRowProps {
  headers: Header<GridFeatures, Record<string, unknown>>[];
  /** `th` for the plain table, `div` for the virtualized flex layout. */
  as: "th" | "div";
  /** The sort keys in order; more than one decides whether priority is shown. */
  sort: GridSort;
  /** A header was clicked, or Enter pressed on it; `multi` when Shift was held. */
  onSort: (columnId: string, multi: boolean) => void;
  columnTypes: Record<string, string>;
  numericColumns: ReadonlySet<string>;
  /** Longest value per column, for the virtualized layout's minimum width. */
  maxContentLen: Record<string, number>;
  filters: ColumnFilters;
  layout: ColumnLayout;
  drag: DragState;
  onDragStateChange: (next: Partial<DragState>) => void;
  onAutoSize: (columnId: string) => void;
}

export function GridHeaderRow({
  headers,
  as,
  sort,
  onSort,
  columnTypes,
  numericColumns,
  maxContentLen,
  filters,
  layout,
  drag,
  onDragStateChange,
  onAutoSize,
}: GridHeaderRowProps) {
  return (
    <>
      {headers.map((header) => {
        const id = header.column.id;
        // The flex layout needs a floor so a narrow column does not collapse;
        // the table sizes from the header itself.
        const minWidth = Math.max(50, Math.min(maxContentLen[id] ?? 5, 20) * 7 + 30);
        const sortAt = sort.findIndex((k) => k.id === id);
        return (
          <GridHeaderCell
            as={as}
            key={header.id}
            columnId={id}
            label={flexRender(header.column.columnDef.header, header.getContext())}
            sortDirection={sortAt < 0 ? false : sort[sortAt].desc ? "desc" : "asc"}
            sortIndex={sortAt + 1}
            showSortPriority={sort.length > 1}
            dataType={columnTypes[id]}
            numeric={numericColumns.has(id)}
            canResize={header.column.getCanResize()}
            isResizing={header.column.getIsResizing()}
            onSort={(e) => onSort(id, e.shiftKey)}
            onResizeStart={(e) => header.getResizeHandler()(e)}
            onAutoSize={() => onAutoSize(id)}
            filterMenu={
              <ColumnFilterMenu
                column={id}
                dataType={columnTypes[id]}
                filter={filters.filters[id]}
                onChange={(next) => filters.set(id, next)}
              />
            }
            onDropColumn={(from) => layout.moveColumn(from, id)}
            isDropTarget={drag.over === id && drag.dragging !== id}
            onDragStateChange={onDragStateChange}
            className={as === "div" ? "group flex items-center gap-1" : "group"}
            style={as === "div"
              ? { flex: `1 1 ${header.getSize()}px`, minWidth }
              : { width: header.getSize() }}
          />
        );
      })}
    </>
  );
}
